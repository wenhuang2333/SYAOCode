/**
 * Capability registry tests: I4 (risk never from the peer) and routing
 * (trust → health → cost, no fallback across trust tiers).
 */

import { describe, expect, it } from 'vitest';
import { buildTestStores, fixedClock } from './helpers.js';
import { InMemoryCapabilityRegistry, COST_LABEL, LOGICAL_ID_LABEL, TENANT_LABEL } from '../src/governance/registry.js';
import { CanonicalError } from '../src/ir/errors.js';
import type { Capability, CapabilityProvider, DiscoveredCapability, RegistryEntry, TrustTier } from '../src/ir/types.js';

const TENANT = 'ten_a';
/** "now" for providers that are alive right now (TTL is measured from here). */
const NOW = new Date().toISOString();

function provider(overrides: Partial<CapabilityProvider> & { id: string }): CapabilityProvider {
  return {
    protocol: 'mcp',
    endpoint: `https://${overrides.id}.example/`,
    trust: 'verified',
    health: 'healthy',
    ttlMs: 60_000,
    lastSeenAt: NOW,
    ...overrides,
  };
}

function entry(overrides: {
  id: string;
  provider: CapabilityProvider;
  risk?: Capability['risk'];
  labels?: Record<string, string>;
  kind?: Capability['kind'];
}): RegistryEntry {
  const capability: Capability = {
    id: overrides.id,
    kind: overrides.kind ?? 'tool',
    protocol: overrides.provider.protocol,
    displayName: overrides.id,
    risk: overrides.risk ?? 'read',
    sideEffect: 'none',
    dataClass: 'internal',
    visibility: 'full',
    reversible: true,
    provider: overrides.provider,
  };
  return { capability, labels: overrides.labels ?? {} };
}

function discovered(overrides: Partial<DiscoveredCapability> = {}): DiscoveredCapability {
  return {
    id: 'mcp://github/tool/create_issue',
    kind: 'tool',
    displayName: 'create_issue',
    declaredRisk: 'read',
    ...overrides,
  };
}

async function expectCanonicalError(promise: Promise<unknown>, kind: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(CanonicalError);
  await promise.catch((error: unknown) => {
    expect((error as CanonicalError).kind).toBe(kind);
  });
}

describe('registerDiscovered and I4', () => {
  it('ignores the peer-declared risk and uses the registry default', async () => {
    const registry = new InMemoryCapabilityRegistry({ defaults: { risk: 'write', sideEffect: 'non_idempotent', dataClass: 'confidential' } });
    const [capability] = await registry.registerDiscovered(
      { id: 'github', protocol: 'mcp', endpoint: 'https://github.example/', trust: 'verified', ttlMs: 60_000 },
      [discovered({ declaredRisk: 'read' })],
    );
    expect(capability?.risk).toBe('write');
    expect(capability?.sideEffect).toBe('non_idempotent');
    expect(capability?.dataClass).toBe('confidential');
  });

  it('records the declared risk as an advisory label only', async () => {
    const registry = new InMemoryCapabilityRegistry({ defaults: { risk: 'write' } });
    await registry.registerDiscovered(
      { id: 'github', protocol: 'mcp', endpoint: 'https://github.example/', trust: 'verified', ttlMs: 60_000 },
      [discovered({ declaredRisk: 'read' })],
    );
    const stored = await registry.get('mcp://github/tool/create_issue');
    expect(stored?.capability.risk).toBe('write');
    expect(stored?.labels['peer.declaredRisk']).toBe('read');
    expect(stored?.labels['registry.riskSource']).toBe('registry-default');
  });

  it('lets an explicit override win over the registry default', async () => {
    const registry = new InMemoryCapabilityRegistry({ defaults: { risk: 'write' } });
    const [capability] = await registry.registerDiscovered(
      { id: 'github', protocol: 'mcp', endpoint: 'https://github.example/', trust: 'verified', ttlMs: 60_000 },
      [discovered({ declaredRisk: 'spend' })],
      { risk: 'spend' },
    );
    expect(capability?.risk).toBe('spend');
    const stored = await registry.get('mcp://github/tool/create_issue');
    expect(stored?.labels['registry.riskSource']).toBe('explicit');
  });

  it('falls back to a conservative risk when nothing is configured', async () => {
    const registry = new InMemoryCapabilityRegistry();
    const [capability] = await registry.registerDiscovered(
      { id: 'rogue', protocol: 'mcp', endpoint: 'https://rogue.example/', trust: 'untrusted', ttlMs: 60_000 },
      [discovered({ declaredRisk: 'read' })],
    );
    expect(capability?.risk).toBe('execute');
    expect(capability?.sideEffect).toBe('non_idempotent');
    expect(capability?.reversible).toBe(false);
  });

  it('never promotes a peer-declared risk even when it claims to be harmless', async () => {
    const registry = new InMemoryCapabilityRegistry({ defaults: { risk: 'execute' } });
    const [capability] = await registry.registerDiscovered(
      { id: 'rogue', protocol: 'mcp', endpoint: 'https://rogue.example/', trust: 'untrusted', ttlMs: 60_000 },
      [discovered({ declaredRisk: 'read', annotations: { 'risk': 'read' } })],
    );
    expect(capability?.risk).toBe('execute');
  });
});

describe('routing', () => {
  const LOGICAL = 'logical://search';

  /** Register one provider of the same logical capability under a distinct id. */
  async function addProvider(
    registry: InMemoryCapabilityRegistry,
    opts: { id: string; trust: TrustTier; protocol?: 'mcp' | 'a2a' | 'acp' | 'local'; health?: CapabilityProvider['health']; cost?: number; version?: string },
  ): Promise<string> {
    const protocol = opts.protocol ?? 'mcp';
    const id = protocol === 'a2a' ? `a2a://${opts.id}/skill/search` : `mcp://${opts.id}/tool/search`;
    await registry.register(
      entry({
        id,
        kind: protocol === 'a2a' ? 'agent_skill' : 'tool',
        provider: provider({
          id: opts.id,
          protocol,
          trust: opts.trust,
          ...(opts.health !== undefined ? { health: opts.health } : {}),
          ...(opts.version !== undefined ? { version: opts.version } : {}),
        }),
        labels: { [LOGICAL_ID_LABEL]: LOGICAL, ...(opts.cost !== undefined ? { [COST_LABEL]: String(opts.cost) } : {}) },
      }),
    );
    return id;
  }

  it('prefers the highest trust tier', async () => {
    const registry = new InMemoryCapabilityRegistry();
    await addProvider(registry, { id: 'a', trust: 'untrusted' });
    await addProvider(registry, { id: 'b', trust: 'first_party' });
    await addProvider(registry, { id: 'c', trust: 'verified' });
    const resolved = await registry.resolve(LOGICAL, { tenantId: TENANT });
    expect(resolved.provider.id).toBe('b');
  });

  it('never falls back across trust tiers', async () => {
    const registry = new InMemoryCapabilityRegistry();
    await addProvider(registry, { id: 'a', trust: 'untrusted' });
    await addProvider(registry, { id: 'b', trust: 'first_party' });
    const resolved = await registry.resolve(LOGICAL, { tenantId: TENANT, requireTrust: 'verified' });
    expect(resolved.provider.id).toBe('b');
    await expectCanonicalError(registry.resolve(LOGICAL, { tenantId: TENANT, requireTrust: 'verified', excludeProviders: ['b'] }), 'unsupported_capability');
  });

  it('prefers a healthy provider over a degraded one', async () => {
    const registry = new InMemoryCapabilityRegistry();
    await addProvider(registry, { id: 'a', trust: 'verified', health: 'degraded' });
    await addProvider(registry, { id: 'b', trust: 'verified', health: 'healthy' });
    expect((await registry.resolve(LOGICAL, { tenantId: TENANT })).provider.id).toBe('b');
  });

  it('drops a provider that is down', async () => {
    const registry = new InMemoryCapabilityRegistry();
    await addProvider(registry, { id: 'a', trust: 'first_party' });
    await addProvider(registry, { id: 'b', trust: 'verified' });
    await registry.markHealth('a', 'down');
    expect((await registry.resolve(LOGICAL, { tenantId: TENANT })).provider.id).toBe('b');
    await registry.markHealth('b', 'down');
    await expectCanonicalError(registry.resolve(LOGICAL, { tenantId: TENANT }), 'unsupported_capability');
  });

  it('prefers the cheaper provider when trust and health tie', async () => {
    const registry = new InMemoryCapabilityRegistry();
    await addProvider(registry, { id: 'a', trust: 'verified', cost: 0.5 });
    await addProvider(registry, { id: 'b', trust: 'verified', cost: 0.05 });
    expect((await registry.resolve(LOGICAL, { tenantId: TENANT })).provider.id).toBe('b');
  });

  it('enforces maxCostUsd', async () => {
    const registry = new InMemoryCapabilityRegistry();
    await addProvider(registry, { id: 'a', trust: 'verified', cost: 5 });
    await addProvider(registry, { id: 'b', trust: 'verified', cost: 0.05 });
    expect((await registry.resolve(LOGICAL, { tenantId: TENANT, maxCostUsd: 1 })).provider.id).toBe('b');
    await expectCanonicalError(registry.resolve(LOGICAL, { tenantId: TENANT, maxCostUsd: 0.001 }), 'unsupported_capability');
  });

  it('honours protocol preference when several tiers are equal', async () => {
    const registry = new InMemoryCapabilityRegistry();
    await addProvider(registry, { id: 'a', trust: 'verified', protocol: 'mcp' });
    await addProvider(registry, { id: 'b', trust: 'verified', protocol: 'a2a' });
    expect((await registry.resolve(LOGICAL, { tenantId: TENANT, protocolPreference: ['a2a'] })).provider.id).toBe('b');
    expect((await registry.resolve(LOGICAL, { tenantId: TENANT, protocolPreference: ['mcp'] })).provider.id).toBe('a');
  });

  it('enforces version and provider exclusions', async () => {
    const registry = new InMemoryCapabilityRegistry();
    await addProvider(registry, { id: 'a', trust: 'verified', version: '1.2.3' });
    expect((await registry.resolve(LOGICAL, { tenantId: TENANT, requireVersion: '1.2' })).provider.id).toBe('a');
    await expectCanonicalError(registry.resolve(LOGICAL, { tenantId: TENANT, requireVersion: '2.0' }), 'unsupported_capability');
    await expectCanonicalError(registry.resolve(LOGICAL, { tenantId: TENANT, excludeProviders: ['a'] }), 'unsupported_capability');
  });

  it('throws capability_not_found for an unknown capability', async () => {
    const registry = new InMemoryCapabilityRegistry();
    await expectCanonicalError(registry.resolve('logical://nope', { tenantId: TENANT }), 'capability_not_found');
  });

  it('treats an expired TTL as down', async () => {
    const clock = fixedClock('2026-01-01T00:00:00.000Z');
    const registry = new InMemoryCapabilityRegistry({ now: clock.now });
    await registry.register(
      entry({
        id: 'mcp://a/tool/search',
        provider: provider({ id: 'a', trust: 'verified', ttlMs: 1000, lastSeenAt: clock.now() }),
        labels: { [LOGICAL_ID_LABEL]: LOGICAL },
      }),
    );
    expect((await registry.resolve(LOGICAL, { tenantId: TENANT })).provider.id).toBe('a');
    clock.advance(5000);
    await expectCanonicalError(registry.resolve(LOGICAL, { tenantId: TENANT }), 'unsupported_capability');
  });
});

describe('tenant scoping (I8)', () => {
  it('hides a tenant-scoped capability from other tenants', async () => {
    const registry = new InMemoryCapabilityRegistry();
    await registry.register(entry({ id: 'mcp://private/tool/x', provider: provider({ id: 'a' }), labels: { [TENANT_LABEL]: 'ten_b' } }));
    expect(await registry.get('mcp://private/tool/x')).toBeDefined();
    await expectCanonicalError(registry.resolve('mcp://private/tool/x', { tenantId: TENANT }), 'capability_not_found');
    expect((await registry.list({ tenantId: TENANT })).length).toBe(0);
    expect((await registry.list({ tenantId: 'ten_b' })).length).toBe(1);
  });
});

describe('listing and removal', () => {
  it('filters by kind, protocol and free text', async () => {
    const registry = new InMemoryCapabilityRegistry();
    await registry.register(entry({ id: 'mcp://a/tool/one', provider: provider({ id: 'a' }), kind: 'tool' }));
    await registry.register(entry({ id: 'mcp://a/prompt/two', provider: provider({ id: 'a' }), kind: 'prompt' }));
    await registry.register(entry({ id: 'a2a://b/skill/three', provider: provider({ id: 'b', protocol: 'a2a' }), kind: 'agent_skill' }));
    expect((await registry.list({ kind: 'tool' })).map((c) => c.id)).toEqual(['mcp://a/tool/one']);
    expect((await registry.list({ protocol: 'a2a' })).map((c) => c.id)).toEqual(['a2a://b/skill/three']);
    expect((await registry.list({ q: 'THREE' })).map((c) => c.id)).toEqual(['a2a://b/skill/three']);
  });

  it('removes a capability', async () => {
    const registry = new InMemoryCapabilityRegistry();
    await registry.register(entry({ id: 'mcp://a/tool/one', provider: provider({ id: 'a' }) }));
    await registry.remove('mcp://a/tool/one');
    expect(await registry.get('mcp://a/tool/one')).toBeUndefined();
    expect(await registry.list()).toEqual([]);
  });

  it('is wired into the store bundle', async () => {
    const { registry } = buildTestStores();
    const [capability] = await registry.registerDiscovered(
      { id: 'github', protocol: 'mcp', endpoint: 'https://github.example/', trust: 'first_party', ttlMs: 60_000 },
      [discovered()],
    );
    expect(capability?.id).toBe('mcp://github/tool/create_issue');
    const resolved = await registry.resolve('mcp://github/tool/create_issue', { tenantId: TENANT });
    expect(resolved.endpoint).toBe('https://github.example/');
  });
});
