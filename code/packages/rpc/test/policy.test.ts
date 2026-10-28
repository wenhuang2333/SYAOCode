import { describe, expect, it } from 'vitest';
import { RulePolicyEngine } from '../src/governance/policy.js';
import { computeRevision, emptyBundle, layerBundles, withRevision } from '../src/governance/policy-bundle.js';
import type { PolicyInput, PolicyRule } from '../src/ir/types.js';
import { TEST_NOW, TEST_TENANT, hasher } from './kernel-helpers.js';

function input(over: Partial<PolicyInput> & { capabilityId?: string; risk?: PolicyInput['capability']['risk'] } = {}): PolicyInput {
  const capability = {
    id: over.capabilityId ?? 'mcp://github/tool/get_issue',
    kind: 'tool' as const,
    protocol: 'mcp' as const,
    displayName: 'get_issue',
    risk: over.risk ?? ('read' as const),
    sideEffect: 'none' as const,
    dataClass: 'internal' as const,
    visibility: 'full' as const,
    reversible: true,
    provider: {
      id: 'github',
      protocol: 'mcp' as const,
      endpoint: 'stdio://github',
      trust: 'verified' as const,
      health: 'healthy' as const,
      ttlMs: 1000,
      lastSeenAt: TEST_NOW,
    },
  };
  const principal = over.principal ?? { id: 'user:alice', kind: 'user' as const, tenantId: TEST_TENANT, scopes: [], trustTier: 'verified' as const };
  const session = over.session ?? {
    id: 'ses_1',
    tenantId: TEST_TENANT,
    principal,
    protocolBinding: 'native' as const,
    workspaceRoots: ['/work'],
    policyRevision: 'rev',
    budgetId: 'default',
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    state: 'open' as const,
    approvalAuthority: 'local' as const,
  };
  return {
    principal,
    session,
    capability: over.capability ?? capability,
    input: over.input ?? { number: 42 },
    inputHash: 'hash',
    context: {
      protocol: 'mcp',
      direction: 'outbound',
      workspaceRoots: ['/work'],
      cwd: '/work',
      now: TEST_NOW,
      trust: 'verified',
      dataClass: 'internal',
    },
    budget: { accountId: 'default' },
    approvalHistory: [],
  };
}

function engine(rules: PolicyRule[], defaultEffect: 'allow' | 'deny' = 'deny') {
  let n = 0;
  return new RulePolicyEngine({
    bundle: withRevision(hasher, { schemaVersion: 1, tenantId: TEST_TENANT, defaultEffect, rules }),
    ids: { next: (p) => `${p}_${(n += 1)}` },
    now: () => TEST_NOW,
  });
}

describe('RulePolicyEngine composition (02 §5.4)', () => {
  it('denies by default when nothing matches', async () => {
    const decision = await engine([]).evaluate(input());
    expect(decision.effect).toBe('deny');
    expect(decision.policyRevision).toMatch(/^sha256:/);
  });

  it('allows when a matching allow rule exists', async () => {
    const decision = await engine([
      { id: 'read-repo', priority: 10, effect: 'allow', match: { capabilities: ['mcp://github/tool/get_*'], risk: ['read'] }, source: 'org' },
    ]).evaluate(input());
    expect(decision.effect).toBe('allow');
  });

  it('lets an explicit deny veto an allow regardless of priority (I4)', async () => {
    const decision = await engine([
      { id: 'allow-all', priority: 1, effect: 'allow', match: { capabilities: ['mcp://github/**'] }, source: 'org' },
      { id: 'deny-one', priority: 999, effect: 'deny', match: { capabilities: ['mcp://github/tool/get_issue'] }, source: 'session' },
    ]).evaluate(input());
    expect(decision.effect).toBe('deny');
    expect(decision.reason).toContain('deny-one');
  });

  it('prefers ask over allow at the same level', async () => {
    const decision = await engine([
      { id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['mcp://github/**'] }, source: 'org' },
      { id: 'ask', priority: 50, effect: 'ask', match: { capabilities: ['mcp://github/tool/get_issue'] }, source: 'org' },
    ]).evaluate(input());
    expect(decision.effect).toBe('ask');
  });

  it('unions the obligations of every matching rule (strictest wins)', async () => {
    const decision = await engine([
      { id: 'a', priority: 1, effect: 'allow', match: { capabilities: ['mcp://github/**'] }, source: 'org', obligations: [{ type: 'audit_level', level: 'full' }] },
      { id: 'b', priority: 2, effect: 'allow', match: { capabilities: ['mcp://github/**'] }, source: 'org', obligations: [{ type: 'redact', classes: ['secret'] }] },
    ]).evaluate(input());
    expect(decision.obligations.map((o) => o.type).sort()).toEqual(['audit_level', 'redact']);
  });

  it('matches on risk, dataClass, protocol and direction', async () => {
    const e = engine([
      { id: 'net-only', priority: 1, effect: 'allow', match: { protocols: ['mcp'], risk: ['network'], directions: ['outbound'] }, source: 'org' },
    ]);
    expect((await e.evaluate(input({ risk: 'network' }))).effect).toBe('allow');
    expect((await e.evaluate(input({ risk: 'read' }))).effect).toBe('deny');
  });

  it('matches on path and command from the invocation input', async () => {
    const e = engine([
      { id: 'tmp-only', priority: 1, effect: 'allow', match: { paths: ['/work/**'] }, source: 'org' },
      { id: 'danger', priority: 1, effect: 'deny', match: { commands: ['rm -rf *'] }, source: 'org' },
    ]);
    const cap = input().capability;
    expect((await e.evaluate(input({ capability: { ...cap, id: 'acp://zed/fs/write_text_file', kind: 'fs' }, input: { path: '/work/a.ts' } }))).effect).toBe('allow');
    expect((await e.evaluate(input({ capability: { ...cap, id: 'local://tools/bash', kind: 'terminal' }, input: { command: 'rm -rf /' } }))).effect).toBe('deny');
  });

  it('caches allow decisions but never caches ask or deny (02 §5.4 step 7)', async () => {
    let evaluations = 0;
    const rules: PolicyRule[] = [
      { id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['mcp://github/**'] }, source: 'org' },
    ];
    const e = new RulePolicyEngine({
      bundle: withRevision(hasher, { schemaVersion: 1, tenantId: TEST_TENANT, defaultEffect: 'deny', rules }),
      ids: { next: (p) => `${p}_1` },
      now: () => TEST_NOW,
    });
    const spy = input();
    await e.evaluate(spy);
    evaluations += 1;
    const d2 = await e.evaluate(spy);
    expect(d2.effect).toBe('allow');
    expect(evaluations).toBe(1); // second call was served from cache

    // An ask decision is never cached.
    const askEngine = engine([{ id: 'ask', priority: 1, effect: 'ask', match: { capabilities: ['**'] }, source: 'org' }]);
    expect((await askEngine.evaluate(input())).effect).toBe('ask');
    expect((await askEngine.explain(input())).explain?.askedBy).toBe('ask');
  });

  it('explain reports the matched rules, the denier and the runner-up', async () => {
    const e = engine([
      { id: 'allow-all', priority: 5, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' },
      { id: 'deny-issue', priority: 9, effect: 'deny', match: { capabilities: ['mcp://github/tool/get_issue'] }, source: 'org' },
    ]);
    const decision = await e.explain(input());
    const trace = decision.explain;
    expect(trace).toBeDefined();
    expect(trace?.deniedBy).toBe('deny-issue');
    expect(trace?.matchedRules.map((r) => r.id).sort()).toEqual(['allow-all', 'deny-issue']);
    expect(trace?.revision).toBe(decision.policyRevision);
  });

  it('invalidate() drops the cache after a hot bundle swap', async () => {
    const e = engine([{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }]);
    expect((await e.evaluate(input())).effect).toBe('allow');
    e.setBundle(withRevision(hasher, { schemaVersion: 1, tenantId: TEST_TENANT, defaultEffect: 'deny', rules: [] }));
    expect((await e.evaluate(input())).effect).toBe('deny');
  });
});

describe('policy bundles (02 §5.5)', () => {
  it('is revision-stable and follows content changes', () => {
    const a = emptyBundle(hasher, TEST_TENANT);
    const b = emptyBundle(hasher, TEST_TENANT);
    expect(a.revision).toBe(b.revision);
    const c = withRevision(hasher, { ...a, defaultEffect: 'allow' });
    expect(c.revision).not.toBe(a.revision);
  });

  it('excludes the revision field from its own digest (idempotent re-stamping)', () => {
    const a = emptyBundle(hasher, TEST_TENANT);
    expect(computeRevision(hasher, a)).toBe(a.revision);
    expect(withRevision(hasher, a).revision).toBe(a.revision);
  });

  it('layers rules while keeping the base default effect', () => {
    const org = withRevision(hasher, {
      schemaVersion: 1,
      tenantId: TEST_TENANT,
      defaultEffect: 'deny',
      rules: [{ id: 'org-allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' as const }],
    });
    const project = withRevision(hasher, {
      schemaVersion: 1,
      tenantId: TEST_TENANT,
      defaultEffect: 'allow', // must NOT widen the base
      rules: [{ id: 'proj-deny', priority: 2, effect: 'deny', match: { capabilities: ['mcp://danger/**'] }, source: 'project' as const }],
    });
    const merged = layerBundles({ hasher, tenantId: TEST_TENANT, org, project });
    expect(merged.defaultEffect).toBe('deny');
    expect(merged.rules.map((r) => r.id)).toEqual(['org-allow', 'proj-deny']);
  });
});
