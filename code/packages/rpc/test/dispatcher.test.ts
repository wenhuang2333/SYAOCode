import { describe, expect, it } from 'vitest';
import { GovernanceDispatcher } from '../src/governance/dispatcher.js';
import { ApprovalBrokerImpl } from '../src/governance/approval.js';
import { BudgetLedgerImpl } from '../src/governance/budget.js';
import { MemoryIdempotencyStore } from '../src/governance/idempotency.js';
import { RulePolicyEngine } from '../src/governance/policy.js';
import { emptyBundle, withRevision } from '../src/governance/policy-bundle.js';
import { CanonicalError } from '../src/ir/errors.js';
import type { AuthorizedInvocation, DispatchContext, InvokeResultPayload } from '../src/governance/contracts.js';
import type { Capability, PolicyRule as Rule, Principal } from '../src/ir/types.js';
import {
  FakeApprovalStore,
  FakeBudgetStore,
  FakeRuntime,
  FakeTaskStore,
  TEST_NOW,
  TEST_TENANT,
  hasher,
  makeStores,
  stubAudit,
  stubEvents,
  stubIdentity,
  stubReceipts,
} from './kernel-helpers.js';

const principal: Principal = {
  id: 'user:alice',
  kind: 'user',
  tenantId: TEST_TENANT,
  scopes: [],
  trustTier: 'verified',
};

function capability(over: Partial<Capability> = {}): Capability {
  return {
    id: 'mcp://github/tool/get_issue',
    kind: 'tool',
    protocol: 'mcp',
    displayName: 'get_issue',
    risk: 'read',
    sideEffect: 'none',
    dataClass: 'internal',
    visibility: 'full',
    reversible: true,
    provider: {
      id: 'github',
      protocol: 'mcp',
      endpoint: 'stdio://github',
      trust: 'verified',
      health: 'healthy',
      ttlMs: 1000,
      lastSeenAt: TEST_NOW,
    },
    ...over,
  };
}

interface Harness {
  dispatcher: GovernanceDispatcher;
  calls: AuthorizedInvocation[];
  receipts: import('../src/ir/types.js').Receipt[];
  audit: import('../src/ir/types.js').AuditEvent[];
  events: import('../src/ir/types.js').CanonicalEvent[];
  approvals: ApprovalBrokerImpl;
}

async function makeHarness(opts: {
  rules?: Rule[];
  defaultEffect?: 'allow' | 'deny' | 'ask';
  execute?: (inv: AuthorizedInvocation, ctx: DispatchContext) => Promise<InvokeResultPayload>;
  presentApproval?: (record: import('../src/ir/types.js').ApprovalRecord) => void;
  limitUsd?: number;
  cap?: Capability;
} = {}): Promise<Harness> {
  const runtime = new FakeRuntime();
  const stores = makeStores();
  const receipts: import('../src/ir/types.js').Receipt[] = [];
  const audit: import('../src/ir/types.js').AuditEvent[] = [];
  const events: import('../src/ir/types.js').CanonicalEvent[] = [];
  const calls: AuthorizedInvocation[] = [];

  const receiptStore = {
    async put(draft: Omit<import('../src/ir/types.js').Receipt, 'hash' | 'prevHash'>) {
      const receipt = { ...draft, hash: hasher.sha256(JSON.stringify(draft)) } as import('../src/ir/types.js').Receipt;
      receipts.push(receipt);
      return receipt;
    },
    async get(id: string) {
      return receipts.find((r) => r.id === id);
    },
    async listByTask(taskId: string) {
      return receipts.filter((r) => r.taskId === taskId);
    },
    async head(taskId: string) {
      return receipts.filter((r) => r.taskId === taskId).at(-1);
    },
  };
  const auditStore = {
    async append(event: Omit<import('../src/ir/types.js').AuditEvent, 'prevHash' | 'hash' | 'id'>) {
      const row = { ...event, id: `aud_${audit.length + 1}`, prevHash: '', hash: 'h' } as import('../src/ir/types.js').AuditEvent;
      audit.push(row);
      return row;
    },
    async list() {
      return audit;
    },
    async verify() {
      return { ok: true, checked: audit.length };
    },
    async checkpoint(tenantId: string) {
      return { tenantId, at: TEST_NOW, count: audit.length, lastHash: 'h', checkpointHash: 'c' };
    },
  };
  const eventLog = {
    async append(event: Omit<import('../src/ir/types.js').CanonicalEvent, 'seq' | 'eventId' | 'ts' | 'schemaVersion'> & { schemaVersion?: 1; ts?: string }) {
      const seq = events.filter((e) => e.taskId === event.taskId).length + 1;
      const row = { schemaVersion: 1 as const, eventId: `evt_${seq}`, seq, ts: TEST_NOW, ...event } as import('../src/ir/types.js').CanonicalEvent;
      events.push(row);
      return row;
    },
    async list(taskId: string, afterSeq = 0) {
      return events.filter((e) => e.taskId === taskId && e.seq > afterSeq);
    },
    async snapshot(taskId: string) {
      return { lastSeq: events.filter((e) => e.taskId === taskId).length };
    },
  };

  const rules = opts.rules ?? [];
  const policy = new RulePolicyEngine({
    bundle: withRevision(hasher, {
      schemaVersion: 1,
      tenantId: TEST_TENANT,
      defaultEffect: opts.defaultEffect ?? 'deny',
      rules,
    }),
    ids: runtime.ids,
    now: () => TEST_NOW,
  });

  const approvals = new ApprovalBrokerImpl({
    store: new FakeApprovalStore(),
    ids: runtime.ids,
    now: () => TEST_NOW,
    defaultTimeoutMs: 50,
    ...(opts.presentApproval !== undefined ? { present: opts.presentApproval } : {}),
  });

  const budget = new BudgetLedgerImpl({
    store: new FakeBudgetStore(),
    ids: runtime.ids,
    now: () => TEST_NOW,
  });
  await budget.ensureAccount({
    id: 'default',
    tenantId: TEST_TENANT,
    currency: 'USD',
    state: 'active',
    ...(opts.limitUsd !== undefined ? { limitUsd: opts.limitUsd } : {}),
  });

  const cap = opts.cap ?? capability();
  const dispatcher = new GovernanceDispatcher({
    kernel: { runtime, hash: hasher, ids: runtime.ids, logger: runtime.logger },
    policy,
    approvals,
    budget,
    idempotency: new MemoryIdempotencyStore({ ids: runtime.ids, now: () => TEST_NOW }),
    receipts: receiptStore,
    audit: auditStore,
    registry: {
      async register() {/* no-op */},
      async registerDiscovered() { return []; },
      async get() { return undefined; },
      async resolve() { return { capability: cap, provider: cap.provider, endpoint: cap.provider.endpoint }; },
      async list() { return []; },
      async markHealth() {/* no-op */},
      async remove() {/* no-op */},
    },
    identity: stubIdentity(),
    tasks: new FakeTaskStore(),
    sessions: stores.sessions,
    events: eventLog,
    async execute(invocation) {
      calls.push(invocation);
      if (opts.execute !== undefined) return opts.execute(invocation, { cwd: '/work', workspaceRoots: ['/work'] });
      return { outcome: 'succeeded', output: { number: 42 } };
    },
  });

  return { dispatcher, calls, receipts, audit, events, approvals };
}

const ctx: DispatchContext = { cwd: '/work', workspaceRoots: ['/work'] };
const req = {
  principal,
  capabilityId: 'mcp://github/tool/get_issue',
  input: { number: 42 },
  protocol: 'mcp' as const,
  direction: 'outbound' as const,
};

describe('GovernanceDispatcher — the ten-step pipeline (02 §4)', () => {
  it('denies without dispatching when the policy denies (I2)', async () => {
    const h = await makeHarness();
    await expect(h.dispatcher.invoke(req, ctx)).rejects.toBeInstanceOf(CanonicalError);
    expect(h.calls).toHaveLength(0);
    // A denial is evidence: exactly one terminal receipt with outcome 'denied'
    // (I5). The peer was never touched, but the refusal is recorded.
    expect(h.receipts).toHaveLength(1);
    expect(h.receipts[0]?.outcome).toBe('denied');
  });

  it('writes a receipt for every non-dispatch outcome (I5)', async () => {
    // budget exhausted
    const budgetDenied = await makeHarness({
      rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }],
      limitUsd: 0.1,
    });
    await expect(budgetDenied.dispatcher.invoke(req, { ...ctx, estimate: { usd: 10 } })).rejects.toMatchObject({ kind: 'budget_exceeded' });
    expect(budgetDenied.receipts).toHaveLength(1);
    expect(budgetDenied.calls).toHaveLength(0);

    // approval refused
    const approvalDenied = await makeHarness({
      rules: [{ id: 'ask', priority: 1, effect: 'ask', match: { capabilities: ['**'] }, source: 'org' }],
    });
    await expect(approvalDenied.dispatcher.invoke(req, ctx)).rejects.toMatchObject({ kind: 'denied' });
    expect(approvalDenied.receipts).toHaveLength(1);
    expect(approvalDenied.receipts[0]?.outcome).toBe('denied');
    expect(approvalDenied.calls).toHaveLength(0);

    // unsupported obligation
    const obligationDenied = await makeHarness({
      rules: [{
        id: 'allow-with-sandbox',
        priority: 1,
        effect: 'allow',
        match: { capabilities: ['**'] },
        source: 'org',
        obligations: [{ type: 'sandbox', level: 'container' }],
      }],
    });
    await expect(obligationDenied.dispatcher.invoke(req, ctx)).rejects.toMatchObject({ kind: 'unsupported_obligation' });
    expect(obligationDenied.receipts).toHaveLength(1);
    expect(obligationDenied.calls).toHaveLength(0);
  });

  it('honours require_approval even when the policy allows (obligation is hard)', async () => {
    let presented = 0;
    const h = await makeHarness({
      rules: [{
        id: 'allow-but-ask',
        priority: 1,
        effect: 'allow',
        match: { capabilities: ['**'] },
        source: 'org',
        obligations: [{ type: 'require_approval' }],
      }],
      presentApproval: () => {
        presented += 1;
      },
    });
    // No authority answers -> the call must NOT dispatch.
    await expect(h.dispatcher.invoke(req, ctx)).rejects.toMatchObject({ kind: 'denied' });
    expect(presented).toBe(1);
    expect(h.calls).toHaveLength(0);
  });

  it('rejects a principal from another tenant (I1)', async () => {
    const h = await makeHarness({
      rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }],
    });
    await expect(
      h.dispatcher.invoke({ ...req, principal: { ...principal, tenantId: 'tenant-victim' } }, ctx),
    ).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(h.calls).toHaveLength(0);
  });

  it('dispatches and issues exactly one receipt when allowed (I5)', async () => {
    const h = await makeHarness({ rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }] });
    const result = await h.dispatcher.invoke(req, ctx);
    expect(result.outcome).toBe('succeeded');
    expect(h.calls).toHaveLength(1);
    expect(h.receipts).toHaveLength(1);
    expect(h.receipts[0]?.outcome).toBe('succeeded');
    expect(h.receipts[0]?.capabilityId).toBe('mcp://github/tool/get_issue');
    expect(result.receiptId).toBe(h.receipts[0]?.id);
  });

  it('never dispatches an `ask` without an approval (I3)', async () => {
    const h = await makeHarness({ rules: [{ id: 'ask', priority: 1, effect: 'ask', match: { capabilities: ['**'] }, source: 'org' }] });
    await expect(h.dispatcher.invoke(req, ctx)).rejects.toBeInstanceOf(CanonicalError);
    expect(h.calls).toHaveLength(0);
  });

  it('dispatches after the approval is granted', async () => {
    let broker: ApprovalBrokerImpl | undefined;
    const h = await makeHarness({
      rules: [{ id: 'ask', priority: 1, effect: 'ask', match: { capabilities: ['**'] }, source: 'org' }],
      presentApproval: (record) => {
        void broker?.decide(record.id, record.revision, { optionId: 'allow_once', by: 'tester' });
      },
    });
    broker = h.approvals;
    const result = await h.dispatcher.invoke(req, ctx);
    expect(result.outcome).toBe('succeeded');
    expect(result.approvalIds).toHaveLength(1);
    expect(h.receipts[0]?.approvals).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
  });

  it('reserves the budget before dispatching and settles afterwards', async () => {
    const h = await makeHarness({
      rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }],
      limitUsd: 5,
    });
    await h.dispatcher.invoke({ ...req }, { ...ctx, estimate: { usd: 1 } });
    // The executor only ever sees an already-reserved invocation (I6).
    expect(h.calls[0]?.reservationId).toBeDefined();
    const events = h.events.map((e) => e.type);
    expect(events).toContain('budget.reserved');
    expect(events).toContain('budget.settled');
    expect(events.indexOf('budget.reserved')).toBeLessThan(events.indexOf('invocation.started'));
  });

  it('refuses to dispatch when the budget is exhausted (I6)', async () => {
    const h = await makeHarness({
      rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }],
      limitUsd: 0.1,
    });
    await expect(h.dispatcher.invoke(req, { ...ctx, estimate: { usd: 10 } })).rejects.toMatchObject({ kind: 'budget_exceeded' });
    expect(h.calls).toHaveLength(0);
  });

  it('replays a completed idempotent request without dispatching again', async () => {
    const h = await makeHarness({ rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }] });
    const first = await h.dispatcher.invoke({ ...req, idempotencyKey: 'k1' }, ctx);
    const second = await h.dispatcher.invoke({ ...req, idempotencyKey: 'k1' }, ctx);
    expect(h.calls).toHaveLength(1);
    expect(second.replayed).toBe(true);
    expect(second.receiptId).toBe(first.receiptId);
  });

  it('rejects the same idempotency key with a different payload', async () => {
    const h = await makeHarness({ rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }] });
    await h.dispatcher.invoke({ ...req, idempotencyKey: 'k1' }, ctx);
    await expect(h.dispatcher.invoke({ ...req, idempotencyKey: 'k1', input: { number: 43 } }, ctx)).rejects.toMatchObject({
      kind: 'idempotency_conflict',
    });
    expect(h.calls).toHaveLength(1);
  });

  it('marks an unknown outcome as indeterminate and never retries it (P5)', async () => {
    const h = await makeHarness({
      rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }],
      cap: capability({ sideEffect: 'non_idempotent' }),
      execute: async () => ({
        outcome: 'indeterminate',
        error: { kind: 'indeterminate', message: 'the request was sent but no result came back', retryable: false },
      }),
    });
    const result = await h.dispatcher.invoke(req, ctx);
    expect(result.outcome).toBe('indeterminate');
    expect(result.error?.kind).toBe('indeterminate');
    expect(h.calls).toHaveLength(1); // no automatic retry
    expect(h.receipts[0]?.outcome).toBe('indeterminate');
  });

  it('reports a timeout as timed_out and still issues a receipt', async () => {
    const h = await makeHarness({
      rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }],
      execute: async () => ({
        outcome: 'timed_out',
        error: { kind: 'timed_out', message: 'deadline exceeded', retryable: true },
      }),
    });
    const result = await h.dispatcher.invoke(req, ctx);
    expect(result.outcome).toBe('timed_out');
    expect(h.receipts).toHaveLength(1);
  });

  it('writes an audit trail for the decision and the invocation', async () => {
    const h = await makeHarness({ rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }] });
    await h.dispatcher.invoke(req, ctx);
    const actions = h.audit.map((a) => a.action);
    expect(actions).toContain('policy.decide');
    expect(actions).toContain('invocation.succeeded');
    expect(h.audit.every((a) => a.tenantId === TEST_TENANT)).toBe(true);
  });

  it('emits the canonical event sequence for a successful call', async () => {
    const h = await makeHarness({ rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }] });
    await h.dispatcher.invoke(req, ctx);
    const types = h.events.map((e) => e.type);
    expect(types).toContain('task.created');
    expect(types).toContain('invocation.started');
    expect(types).toContain('receipt.issued');
    // The event sequence per task must be gap-free (replay contract).
    const seqs = h.events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it('refuses an unknown capability before touching the policy or the peer', async () => {
    const runtime = new FakeRuntime();
    const dispatcher = new GovernanceDispatcher({
      kernel: { runtime, hash: hasher, ids: runtime.ids, logger: runtime.logger },
      policy: new RulePolicyEngine({ bundle: emptyBundle(hasher, TEST_TENANT), ids: runtime.ids, now: () => TEST_NOW }),
      approvals: new ApprovalBrokerImpl({ store: new FakeApprovalStore(), ids: runtime.ids, now: () => TEST_NOW }),
      budget: new BudgetLedgerImpl({ store: new FakeBudgetStore(), ids: runtime.ids, now: () => TEST_NOW }),
      idempotency: new MemoryIdempotencyStore({ ids: runtime.ids, now: () => TEST_NOW }),
      receipts: stubReceipts(),
      audit: stubAudit(),
      registry: {
        async register() {/* no-op */},
        async registerDiscovered() { return []; },
        async get() { return undefined; },
        async resolve() { throw new CanonicalError({ kind: 'capability_not_found', message: 'nope' }); },
        async list() { return []; },
        async markHealth() {/* no-op */},
        async remove() {/* no-op */},
      },
      identity: stubIdentity(),
      tasks: new FakeTaskStore(),
      sessions: makeStores().sessions,
      events: stubEvents(),
      async execute() {
        throw new Error('must not execute');
      },
    });
    await expect(dispatcher.invoke(req, ctx)).rejects.toMatchObject({ kind: 'capability_not_found' });
  });

  it('cancels pending approvals when a task is cancelled (02 §9.3)', async () => {
    const h = await makeHarness({ rules: [{ id: 'ask', priority: 1, effect: 'ask', match: { capabilities: ['**'] }, source: 'org' }] });
    const task = await h.dispatcher.createTask({ sessionId: 'ses_1', tenantId: TEST_TENANT, principal, blocks: [] });
    const pending = h.approvals.request({
      tenantId: TEST_TENANT,
      taskId: task.id,
      subject: { kind: 'tool', summary: 'x' },
      authority: 'local',
      policyRevision: 'rev',
    });
    await new Promise((r) => setTimeout(r, 0));
    await h.dispatcher.cancelTask(task.id, 'user cancelled', TEST_TENANT);
    expect((await pending).state).toBe('cancelled');
  });
});
