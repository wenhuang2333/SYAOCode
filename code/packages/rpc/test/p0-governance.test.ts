/**
 * Regression tests for the P0 governance defects found by the v0.4 audit
 * (document/Agent-RPC/05-实现评估与结论.md §2/§5).
 *
 * Each `V*` case is a probe the audit ran against the shipped code; they are
 * pinned here so the defects cannot come back. The two `NEG` cases are the
 * negative examples the audit asked for.
 */

import { describe, expect, it } from 'vitest';
import { BudgetLedgerImpl } from '../src/governance/budget.js';
import { GovernanceDispatcher } from '../src/governance/dispatcher.js';
import { ApprovalBrokerImpl } from '../src/governance/approval.js';
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
    id: 'mcp://github/tool/create_issue',
    kind: 'tool',
    protocol: 'mcp',
    displayName: 'create_issue',
    risk: 'write',
    sideEffect: 'non_idempotent',
    dataClass: 'internal',
    visibility: 'full',
    reversible: false,
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
  budget: BudgetLedgerImpl;
  approvals: ApprovalBrokerImpl;
  approvalStore: FakeApprovalStore;
}

async function harness(opts: {
  rules?: Rule[];
  limitUsd?: number;
  cap?: Capability;
  presentApproval?: (record: import('../src/ir/types.js').ApprovalRecord) => void;
  execute?: (inv: AuthorizedInvocation) => Promise<InvokeResultPayload>;
} = {}): Promise<Harness> {
  const runtime = new FakeRuntime();
  const stores = makeStores();
  const calls: AuthorizedInvocation[] = [];
  const receipts: import('../src/ir/types.js').Receipt[] = [];

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

  const policy = new RulePolicyEngine({
    bundle: withRevision(hasher, {
      schemaVersion: 1,
      tenantId: TEST_TENANT,
      defaultEffect: 'deny',
      rules: opts.rules ?? [],
    }),
    ids: runtime.ids,
    now: () => TEST_NOW,
  });

  const approvalStore = new FakeApprovalStore();
  const approvals = new ApprovalBrokerImpl({
    store: approvalStore,
    ids: runtime.ids,
    now: () => TEST_NOW,
    defaultTimeoutMs: 25,
    ...(opts.presentApproval !== undefined ? { present: opts.presentApproval } : {}),
  });

  const budget = new BudgetLedgerImpl({ store: new FakeBudgetStore(), ids: runtime.ids, now: () => TEST_NOW });
  await budget.ensureAccount({
    id: `tenant:${TEST_TENANT}`,
    tenantId: TEST_TENANT,
    currency: 'USD',
    state: 'active',
    ...(opts.limitUsd !== undefined ? { limitUsd: opts.limitUsd } : {}),
  });
  await budget.ensureAccount({
    id: 'default',
    tenantId: TEST_TENANT,
    parentId: `tenant:${TEST_TENANT}`,
    currency: 'USD',
    state: 'active',
  });

  const cap = opts.cap ?? capability();
  const dispatcher = new GovernanceDispatcher({
    kernel: { runtime, hash: hasher, ids: runtime.ids, logger: runtime.logger },
    policy,
    approvals,
    budget,
    idempotency: new MemoryIdempotencyStore({ ids: runtime.ids, now: () => TEST_NOW }),
    receipts: receiptStore,
    audit: stubAudit(),
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
    events: stubEvents(),
    async execute(invocation) {
      calls.push(invocation);
      if (opts.execute !== undefined) return opts.execute(invocation);
      return { outcome: 'succeeded', output: { ok: true } };
    },
  });

  return { dispatcher, calls, receipts, budget, approvals, approvalStore };
}

const allowAll: Rule[] = [
  { id: 'allow-all', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' },
];

const ctx: DispatchContext = { tenantId: TEST_TENANT, cwd: '/work', workspaceRoots: ['/work'] };
const req = {
  principal,
  capabilityId: 'mcp://github/tool/create_issue',
  input: { title: 'x' },
  protocol: 'mcp' as const,
  direction: 'outbound' as const,
};

describe('P0 regression — V1: concurrent reservations must not exceed the limit', () => {
  it('serializes concurrent reserves so 10 × $0.5 cannot pass a $1.00 limit', async () => {
    const h = await harness({ rules: allowAll, limitUsd: 1 });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        h.budget.reserve({ accountId: 'default', estimate: { usd: 0.5 }, invocationId: `inv_${i}` }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter((r) => r.status === 'rejected').length;
    // At most two can fit in $1.00; the rest must be refused, never oversubscribed.
    expect(ok).toBeLessThanOrEqual(2);
    expect(refused).toBeGreaterThanOrEqual(8);
    const account = await h.budget.get('default');
    expect(account?.reservedUsd).toBeLessThanOrEqual(1);
  });
});

describe('P0 regression — V2: an unknown price reserves the conservative ceiling', () => {
  it('holds the conservative ceiling while the call is in flight', async () => {
    // The hold is released at settle, so it must be observed DURING dispatch.
    // Previously the ledger reserved $0, so a budget could never stop anything.
    let reservedDuringDispatch = -1;
    let harnessRef: Harness | undefined;
    const h = await harness({
      rules: allowAll,
      limitUsd: 1,
      execute: async () => {
        const account = await harnessRef!.budget.get('default');
        reservedDuringDispatch = account?.reservedUsd ?? -1;
        return { outcome: 'succeeded', output: {} };
      },
    });
    harnessRef = h;
    await h.dispatcher.invoke(req, ctx);
    expect(reservedDuringDispatch).toBeGreaterThan(0);
    // After settle the hold is released and only the actual cost remains.
    const after = await h.budget.get('default');
    expect(after?.reservedUsd).toBe(0);
  });

  it('refuses the call when the ceiling does not fit the budget', async () => {
    const h = await harness({ rules: allowAll, limitUsd: 0.1 });
    await expect(h.dispatcher.invoke(req, ctx)).rejects.toMatchObject({ kind: 'budget_exceeded' });
    expect(h.calls).toHaveLength(0);
  });

  it('a caller cannot switch the ledger off with skipBudget (I6)', async () => {
    const h = await harness({ rules: allowAll, limitUsd: 0.1 });
    await expect(
      h.dispatcher.invoke({ ...req, skipBudget: true }, ctx),
    ).rejects.toMatchObject({ kind: 'budget_exceeded' });
  });
});

describe('P0 regression — V3: cross-tenant calls are refused (I1)', () => {
  it('rejects a principal that names another tenant', async () => {
    const h = await harness({ rules: allowAll });
    await expect(
      h.dispatcher.invoke({ ...req, principal: { ...principal, tenantId: 'tenant-victim' } }, ctx),
    ).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(h.calls).toHaveLength(0);
  });

  it('rejects a request when the host pins a different tenant', async () => {
    const h = await harness({ rules: allowAll });
    await expect(
      h.dispatcher.invoke(req, { ...ctx, tenantId: 'other-host-tenant' }),
    ).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('rejects a session whose tenant differs from the principal', async () => {
    const h = await harness({ rules: allowAll });
    const foreign = {
      id: 'ses_foreign',
      tenantId: 'tenant-victim',
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
    await expect(h.dispatcher.invoke(req, { ...ctx, session: foreign })).rejects.toMatchObject({ kind: 'unauthorized' });
  });
});

describe('P0 regression — V4: the derived idempotency key is per-invocation', () => {
  it('allows two different calls in the same task without a spurious conflict', async () => {
    const h = await harness({ rules: allowAll });
    const first = await h.dispatcher.invoke(req, ctx);
    // Different input, same task, no client key: previously the constant
    // 'pending' key made this an idempotency_conflict.
    const second = await h.dispatcher.invoke(
      { ...req, input: { title: 'y' }, taskId: first.taskId },
      ctx,
    );
    expect(second.outcome).toBe('succeeded');
    expect(h.calls).toHaveLength(2);
  });
});

describe('P0 regression — V5: require_approval is a hard obligation', () => {
  it('asks for approval even when the policy effect is allow', async () => {
    let presented = 0;
    const h = await harness({
      rules: [{
        id: 'allow-but-approve',
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
    await expect(h.dispatcher.invoke(req, ctx)).rejects.toMatchObject({ kind: 'denied' });
    expect(presented).toBe(1);
    expect(h.calls).toHaveLength(0);
  });

  it('dispatches once the approval is granted', async () => {
    let broker: ApprovalBrokerImpl | undefined;
    const h = await harness({
      rules: [{
        id: 'allow-but-approve',
        priority: 1,
        effect: 'allow',
        match: { capabilities: ['**'] },
        source: 'org',
        obligations: [{ type: 'require_approval' }],
      }],
      presentApproval: (record) => {
        void broker?.decide(record.id, record.revision, {
          optionId: 'allow_once',
          by: 'tester',
          tenantId: TEST_TENANT,
        });
      },
    });
    broker = h.approvals;
    const result = await h.dispatcher.invoke(req, ctx);
    expect(result.outcome).toBe('succeeded');
    expect(h.calls).toHaveLength(1);
  });

  it('refuses an obligation the executor cannot honour', async () => {
    const h = await harness({
      rules: [{
        id: 'allow-sandboxed',
        priority: 1,
        effect: 'allow',
        match: { capabilities: ['**'] },
        source: 'org',
        obligations: [{ type: 'sandbox', level: 'container' }],
      }],
    });
    await expect(h.dispatcher.invoke(req, ctx)).rejects.toMatchObject({ kind: 'unsupported_obligation' });
    expect(h.calls).toHaveLength(0);
    expect(h.receipts).toHaveLength(1);
  });
});

describe('P0 regression — NEG: approval queue is tenant- and expiry-bound (I9)', () => {
  it('refuses a decision from another tenant', async () => {
    const h = await harness({ rules: allowAll });
    const pending = h.approvals.request({
      tenantId: TEST_TENANT,
      taskId: 'task_1',
      capabilityId: 'mcp://github/tool/create_issue',
      inputHash: 'hash',
      subject: { kind: 'tool', summary: 'x' },
      authority: 'local',
      policyRevision: 'rev',
    });
    await new Promise((r) => setTimeout(r, 0));
    const record = (await h.approvals.listPending({ tenantId: TEST_TENANT }))[0]!;
    const foreign = await h.approvals.decide(record.id, record.revision, {
      optionId: 'allow_once',
      by: 'attacker',
      tenantId: 'tenant-victim',
    });
    expect(foreign).toBe(false);
    await h.approvals.cancelForTask('task_1', 'cleanup');
    await pending;
  });

  it('refuses a decision for an expired approval', async () => {
    const store = new FakeApprovalStore();
    const runtime = new FakeRuntime();
    const broker = new ApprovalBrokerImpl({ store, ids: runtime.ids, now: () => TEST_NOW, defaultTimeoutMs: 60_000 });
    await store.insert({
      id: 'apr_expired',
      tenantId: TEST_TENANT,
      taskId: 'task_1',
      capabilityId: 'c',
      inputHash: 'h',
      subject: { kind: 'tool', summary: 'x' },
      options: [{ id: 'allow_once', label: 'once', kind: 'allow_once' }],
      authority: 'local',
      delegationChain: [],
      policyRevision: 'rev',
      revision: 1,
      state: 'pending',
      createdAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2020-01-01T00:01:00.000Z',
      sensitive: false,
    });
    const ok = await broker.decide('apr_expired', 1, { optionId: 'allow_once', by: 'tester', tenantId: TEST_TENANT });
    expect(ok).toBe(false);
    expect((await store.get('apr_expired'))?.state).toBe('expired');
  });

  it('refuses a decision made under the wrong authority', async () => {
    const h = await harness({ rules: allowAll });
    const pending = h.approvals.request({
      tenantId: TEST_TENANT,
      taskId: 'task_1',
      capabilityId: 'c',
      inputHash: 'h',
      subject: { kind: 'tool', summary: 'x' },
      authority: 'delegated',
      policyRevision: 'rev',
    });
    await new Promise((r) => setTimeout(r, 0));
    const record = (await h.approvals.listPending({ tenantId: TEST_TENANT }))[0]!;
    const wrong = await h.approvals.decide(record.id, record.revision, {
      optionId: 'allow_once',
      by: 'tester',
      tenantId: TEST_TENANT,
      authority: 'local',
    });
    expect(wrong).toBe(false);
    await h.approvals.cancelForTask('task_1', 'cleanup');
    await pending;
  });
});

describe('P0 regression — NEG: a secret-class capability needs a redactor (I7)', () => {
  it('refuses to run secret data without a redactor', async () => {
    const h = await harness({ rules: allowAll, cap: capability({ dataClass: 'secret' }) });
    await expect(h.dispatcher.invoke(req, ctx)).rejects.toBeInstanceOf(CanonicalError);
    expect(h.calls).toHaveLength(0);
  });
});

describe('P0 regression — denial paths always leave exactly one receipt (I5)', () => {
  it('writes a denied receipt when the policy denies', async () => {
    const h = await harness(); // default deny
    await expect(h.dispatcher.invoke(req, ctx)).rejects.toMatchObject({ kind: 'denied' });
    expect(h.receipts).toHaveLength(1);
    expect(h.receipts[0]?.outcome).toBe('denied');
    expect(h.calls).toHaveLength(0);
  });

  it('writes a receipt when the deadline has already passed', async () => {
    const h = await harness({ rules: allowAll });
    await expect(
      h.dispatcher.invoke({ ...req, deadlineAt: '2020-01-01T00:00:00.000Z' }, ctx),
    ).rejects.toMatchObject({ kind: 'timed_out' });
    expect(h.receipts).toHaveLength(1);
    expect(h.receipts[0]?.outcome).toBe('timed_out');
    expect(h.calls).toHaveLength(0);
  });
});
