import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@syaocode/core';
import { createFabric } from '../src/runtime/fabric.js';
import type { AdapterCapabilities, ProtocolAdapter } from '../src/governance/contracts.js';
import type { AuthorizedInvocation, AdapterContext, InvokeResultPayload } from '../src/governance/contracts.js';
import type { DiscoveredCapability } from '../src/ir/types.js';
import { CanonicalError } from '../src/ir/errors.js';
import { FakeRuntime, TEST_TENANT, noopTool } from './kernel-helpers.js';

function makeFabric(over: Partial<Parameters<typeof createFabric>[0]> = {}) {
  const runtime = new FakeRuntime();
  return createFabric({
    runtime,
    tenantId: TEST_TENANT,
    workspaceRoots: ['/work'],
    policy: { defaultEffect: 'deny', rules: [] },
    ...over,
  });
}

/** A minimal in-process edge used to prove mount/discover/route. */
function fakeAdapter(calls: AuthorizedInvocation[]): ProtocolAdapter {
  const capabilities: AdapterCapabilities = {
    protocol: 'mcp',
    version: '2026-07-28',
    supports: {
      session: false, task: true, streaming: true, push: false,
      approvalOptions: false, artifacts: true, reverseCalls: false, cancellation: true,
    },
    lossy: ['no protocol session'],
  };
  const discovered: DiscoveredCapability[] = [
    { id: 'mcp://github/tool/get_issue', kind: 'tool', displayName: 'get_issue', declaredRisk: 'read' },
    { id: 'mcp://github/tool/create_issue', kind: 'tool', displayName: 'create_issue', declaredRisk: 'read' },
  ];
  return {
    protocol: 'mcp',
    version: '2026-07-28',
    capabilities: () => capabilities,
    async discover() {
      return discovered;
    },
    async invoke(invocation: AuthorizedInvocation, _ctx: AdapterContext): Promise<InvokeResultPayload> {
      calls.push(invocation);
      return { outcome: 'succeeded', output: { echoed: invocation.input }, lossy: ['remote-steps-opaque'] };
    },
    async health() {
      return 'healthy';
    },
    async close() {
      /* nothing to release */
    },
  };
}

describe('createFabric — the assembled governance substrate', () => {
  it('denies an unregistered capability with capability_not_found', async () => {
    const fabric = makeFabric();
    await expect(fabric.call({ capabilityId: 'mcp://nope/tool/x' })).rejects.toMatchObject({
      kind: 'capability_not_found',
    });
  });

  it('exposes a working policy revision and status', async () => {
    const fabric = makeFabric();
    const status = await fabric.status();
    expect(status.tenantId).toBe(TEST_TENANT);
    expect(status.policyRevision).toMatch(/^sha256:/);
    expect(status.capabilityCount).toBe(0);
  });

  it('mounts an edge, discovers its capabilities and records lossy notes', async () => {
    const calls: AuthorizedInvocation[] = [];
    const fabric = makeFabric();
    const mounted = await fabric.mount(fakeAdapter(calls), { providerId: 'github', endpoint: 'stdio://github', trust: 'verified' });
    expect(mounted.providerId).toBe('github');

    const caps = await fabric.capabilities();
    expect(caps.map((c) => c.id).sort()).toEqual(['mcp://github/tool/create_issue', 'mcp://github/tool/get_issue']);

    const status = await fabric.status();
    expect(status.adapters).toHaveLength(1);
    expect(status.adapters[0]?.lossy).toContain('no protocol session');
  });

  it('never takes the effective risk from the peer annotation (I4 / G8)', async () => {
    const calls: AuthorizedInvocation[] = [];
    const fabric = makeFabric();
    // The adapter declares both tools as `read`; the registry default is `write`.
    await fabric.mount(fakeAdapter(calls), { providerId: 'github', risk: 'write', sideEffect: 'non_idempotent' });
    const caps = await fabric.capabilities();
    expect(caps.every((c) => c.risk === 'write')).toBe(true);
    expect(caps.every((c) => c.sideEffect === 'non_idempotent')).toBe(true);
  });

  it('routes a governed call through the mounted edge and issues a receipt', async () => {
    const calls: AuthorizedInvocation[] = [];
    const fabric = makeFabric({
      policy: {
        defaultEffect: 'deny',
        rules: [{ id: 'allow-read', priority: 1, effect: 'allow', match: { capabilities: ['mcp://github/tool/get_*'], risk: ['read'] }, source: 'org' }],
      },
    });
    await fabric.mount(fakeAdapter(calls), { providerId: 'github', risk: 'read' });
    const result = await fabric.call({ capabilityId: 'mcp://github/tool/get_issue', input: { number: 42 } });
    expect(result.outcome).toBe('succeeded');
    expect(calls).toHaveLength(1);
    expect(result.lossy).toContain('remote-steps-opaque');

    const receipt = await fabric.stores.receipts.get(result.receiptId, TEST_TENANT);
    expect(receipt?.capabilityId).toBe('mcp://github/tool/get_issue');
    expect(receipt?.lossy).toContain('remote-steps-opaque');
  });

  it('does not reach the edge when the policy denies', async () => {
    const calls: AuthorizedInvocation[] = [];
    const fabric = makeFabric(); // default deny
    await fabric.mount(fakeAdapter(calls), { providerId: 'github', risk: 'read' });
    await expect(fabric.call({ capabilityId: 'mcp://github/tool/get_issue' })).rejects.toMatchObject({ kind: 'denied' });
    expect(calls).toHaveLength(0);
  });

  it('exposes the ten-step pipeline through onStep', async () => {
    const steps: string[] = [];
    const calls: AuthorizedInvocation[] = [];
    const fabric = makeFabric({
      onStep: (step) => steps.push(step),
      policy: {
        defaultEffect: 'deny',
        rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }],
      },
    });
    await fabric.mount(fakeAdapter(calls), { providerId: 'github', risk: 'read' });
    await fabric.call({ capabilityId: 'mcp://github/tool/get_issue' });
    expect(steps).toEqual([
      'normalize', 'authenticate', 'resolve', 'idempotency',
      'authorize', 'approve', 'reserve', 'dispatch', 'settle', 'receipt',
    ]);
  });

  it('governs a local tool through the same pipeline', async () => {
    const tools = new ToolRegistry();
    tools.register(noopTool);
    const fabric = makeFabric({
      tools,
      policy: {
        defaultEffect: 'deny',
        rules: [{ id: 'allow-local', priority: 1, effect: 'allow', match: { capabilities: ['local://tools/**'] }, source: 'org' }],
      },
    });
    const caps = await fabric.capabilities();
    expect(caps.map((c) => c.id)).toContain('local://tools/noop');

    const result = await fabric.call({ capabilityId: 'local://tools/noop', input: {} });
    expect(result.outcome).toBe('succeeded');
  });

  it('creates a session with a budget account', async () => {
    const fabric = makeFabric();
    const session = await fabric.createSession({});
    expect(session.tenantId).toBe(TEST_TENANT);
    const account = await fabric.budget.get(session.budgetId);
    expect(account?.id).toBe(session.budgetId);
    const sessions = await fabric.stores.sessions.list(TEST_TENANT);
    expect(sessions.map((s) => s.id)).toContain(session.id);
  });

  it('manages tasks and their event streams', async () => {
    const fabric = makeFabric();
    const task = await fabric.tasks.create({ blocks: [{ type: 'text', text: 'hello' }] });
    expect(task.state).toBe('submitted');
    expect(await fabric.tasks.get(task.id)).toBeDefined();

    const events = await fabric.tasks.events(task.id);
    expect(events.map((e) => e.type)).toEqual(['task.created']);

    const cancelled = await fabric.tasks.cancel(task.id, 'user asked');
    expect(cancelled.state).toBe('cancelled');
  });

  it('keeps tenant isolation on task reads (I8)', async () => {
    const fabric = makeFabric();
    const task = await fabric.tasks.create({ blocks: [] });
    expect(await fabric.stores.tasks.get(task.id, 'other-tenant')).toBeUndefined();
    expect(await fabric.stores.tasks.get(task.id, TEST_TENANT)).toBeDefined();
  });

  it('exposes approvals with single-winner CAS semantics (I9)', async () => {
    const fabric = makeFabric();
    const task = await fabric.tasks.create({ blocks: [] });
    const pending = fabric.stores.approvals.insert({
      id: 'apr_1',
      tenantId: TEST_TENANT,
      taskId: task.id,
      subject: { kind: 'tool', summary: 'Allow something?' },
      options: [{ id: 'allow_once', label: 'once', kind: 'allow_once' }],
      authority: 'local',
      delegationChain: [],
      policyRevision: 'rev',
      revision: 1,
      state: 'pending',
      createdAt: '2026-10-28T00:00:00.000Z',
      expiresAt: '2026-10-28T01:00:00.000Z',
      sensitive: false,
    });
    await pending;
    const list = await fabric.approvals.listPending();
    expect(list.map((r) => r.id)).toContain('apr_1');

    const first = await fabric.approvals.decide('apr_1', 'allow_once', 'client-a');
    const second = await fabric.approvals.decide('apr_1', 'allow_once', 'client-b');
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('explains a policy decision for the CLI', async () => {
    const calls: AuthorizedInvocation[] = [];
    const fabric = makeFabric({
      policy: {
        defaultEffect: 'deny',
        rules: [
          { id: 'allow-read', priority: 1, effect: 'allow', match: { capabilities: ['mcp://github/tool/get_*'] }, source: 'org' },
          { id: 'deny-create', priority: 2, effect: 'deny', match: { capabilities: ['mcp://github/tool/create_*'] }, source: 'org' },
        ],
      },
    });
    await fabric.mount(fakeAdapter(calls), { providerId: 'github', risk: 'read' });
    const allowed = await fabric.policyExplain({ capabilityId: 'mcp://github/tool/get_issue' });
    expect(allowed.effect).toBe('allow');
    expect(allowed.explain?.matchedRules.map((r) => r.id)).toContain('allow-read');

    const denied = await fabric.policyExplain({ capabilityId: 'mcp://github/tool/create_issue' });
    expect(denied.effect).toBe('deny');
    expect(denied.explain?.deniedBy).toBe('deny-create');
  });

  it('seals and verifies evidence for a task that actually ran something', async () => {
    const calls: AuthorizedInvocation[] = [];
    const fabric = makeFabric({
      policy: {
        defaultEffect: 'deny',
        rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }],
      },
    });
    await fabric.mount(fakeAdapter(calls), { providerId: 'github', risk: 'read' });
    const session = await fabric.createSession({});
    const result = await fabric.call({ capabilityId: 'mcp://github/tool/get_issue', sessionId: session.id });

    const bundle = await fabric.evidence.seal(result.taskId);
    expect(bundle.taskId).toBe(result.taskId);
    expect(bundle.receipts).toHaveLength(1);
    expect(bundle.receipts[0]?.id).toBe(result.receiptId);

    const verdict = await fabric.evidence.verify(bundle);
    expect(verdict.checks.map((c) => c.name)).toContain('receipts.hash');
    expect(verdict.ok).toBe(true);
  });

  it('reports an unverifiable bundle when a receipt hash is tampered with', async () => {
    const calls: AuthorizedInvocation[] = [];
    const fabric = makeFabric({
      policy: { defaultEffect: 'deny', rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }] },
    });
    await fabric.mount(fakeAdapter(calls), { providerId: 'github', risk: 'read' });
    const session = await fabric.createSession({});
    const result = await fabric.call({ capabilityId: 'mcp://github/tool/get_issue', sessionId: session.id });
    const bundle = await fabric.evidence.seal(result.taskId);

    // Tamper with the recorded outcome after sealing.
    const tampered = {
      ...bundle,
      receipts: bundle.receipts.map((r) => ({ ...r, capabilityId: 'mcp://evil/tool/backdoor' })),
    };
    const verdict = await fabric.evidence.verify(tampered);
    expect(verdict.ok).toBe(false);
    expect(verdict.checks.some((c) => !c.ok && c.name === 'receipts.hash')).toBe(true);
  });

  it('audits and verifies the chain', async () => {
    const calls: AuthorizedInvocation[] = [];
    const fabric = makeFabric({
      policy: { defaultEffect: 'deny', rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }] },
    });
    await fabric.mount(fakeAdapter(calls), { providerId: 'github', risk: 'read' });
    await fabric.call({ capabilityId: 'mcp://github/tool/get_issue' });
    const events = await fabric.audit.list();
    expect(events.length).toBeGreaterThan(0);
    const verified = await fabric.audit.verify();
    expect(verified.ok).toBe(true);
  });

  it('reports recovery work without throwing', async () => {
    const fabric = makeFabric();
    await fabric.tasks.create({ blocks: [] });
    const recovered = await fabric.recover();
    expect(recovered.unterminatedTasks).toBe(1);
    expect(recovered.releasedReservations).toBe(0);
  });

  it('rolls back a mount whose discovery fails, and keeps serving other edges', async () => {
    // Regression: a mounted-but-undiscoverable edge used to linger in the
    // adapter list, so every later discover() re-threw and the whole catalogue
    // became unavailable.
    const calls: AuthorizedInvocation[] = [];
    const fabric = makeFabric({
      policy: { defaultEffect: 'deny', rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }] },
    });
    await fabric.mount(fakeAdapter(calls), { providerId: 'good', risk: 'read' });

    const broken = {
      ...fakeAdapter(calls),
      async discover(): Promise<DiscoveredCapability[]> {
        throw new Error('connection closed before server/discover');
      },
    };
    await expect(fabric.mount(broken, { providerId: 'broken' })).rejects.toThrow(/connection closed/);

    // The good edge is still discoverable and callable.
    const caps = await fabric.discover();
    expect(caps.map((c) => c.id)).toContain('mcp://github/tool/get_issue');
    const result = await fabric.call({ capabilityId: 'mcp://github/tool/get_issue', input: {} });
    expect(result.outcome).toBe('succeeded');

    // The broken edge is not reported as a healthy adapter.
    const status = await fabric.status();
    expect(status.adapters.map((a) => a.providerId)).toEqual(['good']);
  });

  it('reports a degraded edge instead of failing when discovery breaks later', async () => {
    const calls: AuthorizedInvocation[] = [];
    const fabric = makeFabric({
      policy: { defaultEffect: 'deny', rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }] },
    });
    let healthy = true;
    const flaky = {
      ...fakeAdapter(calls),
      async discover(): Promise<DiscoveredCapability[]> {
        if (!healthy) throw new Error('peer went away');
        return [{ id: 'mcp://github/tool/get_issue', kind: 'tool' as const, displayName: 'get_issue' }];
      },
    };
    await fabric.mount(flaky, { providerId: 'flaky', risk: 'read' });
    healthy = false;
    // discover() must not throw; it degrades the edge and keeps the catalogue.
    await expect(fabric.discover()).resolves.toBeDefined();
    const status = await fabric.status();
    const entry = status.adapters.find((a) => a.providerId === 'flaky');
    expect(entry?.health).toBe('degraded');
    expect(entry?.unavailable).toBe(true);
    expect(entry?.reason).toContain('peer went away');
  });

  it('closes mounted edges', async () => {
    const calls: AuthorizedInvocation[] = [];
    const fabric = makeFabric();
    let closed = false;
    const adapter = fakeAdapter(calls);
    await fabric.mount(
      { ...adapter, close: async () => { closed = true; } },
      { providerId: 'github' },
    );
    await fabric.close();
    expect(closed).toBe(true);
  });

  it('surfaces an unsupported capability when no edge is mounted for a protocol', async () => {
    const fabric = makeFabric({
      policy: { defaultEffect: 'deny', rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }] },
    });
    // Register a capability directly without mounting an executor.
    await fabric.stores.registry.register({
      capability: {
        id: 'a2a://remote/skill/research',
        kind: 'agent_skill',
        protocol: 'a2a',
        displayName: 'research',
        risk: 'delegate',
        sideEffect: 'non_idempotent',
        dataClass: 'internal',
        visibility: 'opaque',
        reversible: false,
        provider: {
          id: 'remote', protocol: 'a2a', endpoint: 'https://remote', trust: 'verified',
          health: 'healthy', ttlMs: 1000, lastSeenAt: '2026-10-28T00:00:00.000Z',
        },
      },
      labels: {},
    });
    const result = await fabric.call({ capabilityId: 'a2a://remote/skill/research' });
    expect(result.outcome).toBe('failed');
    expect(result.error?.kind).toBe('unsupported_capability');
    expect(result.error?.message).toContain('a2a');
  });

  it('wraps the local permission engine as a policy preset (02 §5.6)', async () => {
    const { makePermissionEngine } = await import('./kernel-helpers.js');
    const runtime = new FakeRuntime();
    const fabric = createFabric({
      runtime,
      tenantId: TEST_TENANT,
      workspaceRoots: ['/work'],
      policy: {
        defaultEffect: 'deny',
        rules: [],
        permissionEngine: makePermissionEngine(runtime, 'plan'),
      },
    });
    const tools = new ToolRegistry();
    tools.register(noopTool);
    // Rebuild with tools so the local capability exists.
    const fabric2 = createFabric({
      runtime,
      tenantId: TEST_TENANT,
      workspaceRoots: ['/work'],
      tools,
      policy: {
        defaultEffect: 'deny',
        rules: [],
        permissionEngine: makePermissionEngine(runtime, 'bypass'),
      },
    });
    const result = await fabric2.call({ capabilityId: 'local://tools/noop', input: {} });
    expect(result.outcome).toBe('succeeded');
    void fabric;
  });

  it('never exposes a canonical error for a malformed request', async () => {
    const fabric = makeFabric();
    await expect(fabric.call({ capabilityId: '' })).rejects.toBeInstanceOf(CanonicalError);
  });
});
