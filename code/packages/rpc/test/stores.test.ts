/**
 * Storage面 tests: in-memory stores, tenant isolation (I8), CAS semantics.
 */

import { describe, expect, it } from 'vitest';
import { buildTestStores, fixedClock, makeApproval, makeTask, T0, T2 } from './helpers.js';
import type { BudgetAccount, BudgetReservation, Session } from '../src/ir/types.js';

const TENANT_A = 'ten_a';
const TENANT_B = 'ten_b';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'ses_1',
    tenantId: TENANT_A,
    principal: { id: 'prn_alice', kind: 'user', tenantId: TENANT_A, scopes: [], trustTier: 'first_party' },
    protocolBinding: 'native',
    workspaceRoots: ['/work'],
    policyRevision: 'pol_1',
    budgetId: 'bud_1',
    createdAt: T0,
    updatedAt: T0,
    state: 'open',
    approvalAuthority: 'local',
    ...overrides,
  };
}

function makeAccount(overrides: Partial<BudgetAccount> = {}): BudgetAccount {
  return {
    id: 'bud_1',
    tenantId: TENANT_A,
    currency: 'USD',
    reservedUsd: 0,
    spentUsd: 0,
    tokensUsed: 0,
    timeUsedMs: 0,
    toolCallsUsed: 0,
    state: 'active',
    ...overrides,
  };
}

function makeReservation(overrides: Partial<BudgetReservation> = {}): BudgetReservation {
  return {
    id: 'rsv_1',
    accountId: 'bud_1',
    accountChain: ['bud_1'],
    estimate: { usd: 1 },
    createdAt: T0,
    expiresAt: T2,
    state: 'held',
    ...overrides,
  };
}

describe('createMemoryStores', () => {
  it('exposes all eleven fabric components', () => {
    const stores = buildTestStores();
    expect(Object.keys(stores).sort()).toEqual([
      'approvals', 'audit', 'budget', 'events', 'evidence',
      'idempotency', 'identity', 'receipts', 'registry', 'sessions', 'tasks',
    ]);
  });
});

describe('MemoryTaskStore', () => {
  it('creates and reads a task back', async () => {
    const { tasks } = buildTestStores();
    await tasks.create(makeTask());
    const found = await tasks.get('task_1', TENANT_A);
    expect(found?.id).toBe('task_1');
    expect(found?.state).toBe('submitted');
  });

  it('returns copies, so callers cannot mutate stored rows', async () => {
    const { tasks } = buildTestStores();
    await tasks.create(makeTask());
    const first = await tasks.get('task_1', TENANT_A);
    first!.state = 'completed';
    first!.artifacts.push({ id: 'art_1', hash: 'h' });
    const second = await tasks.get('task_1', TENANT_A);
    expect(second?.state).toBe('submitted');
    expect(second?.artifacts).toEqual([]);
  });

  it('never returns another tenant row (I8)', async () => {
    const { tasks } = buildTestStores();
    await tasks.create(makeTask());
    expect(await tasks.get('task_1', TENANT_B)).toBeUndefined();
    expect(await tasks.list({ tenantId: TENANT_B })).toEqual([]);
  });

  it('rejects a put that would move a task across tenants (I8)', async () => {
    const { tasks } = buildTestStores();
    await tasks.create(makeTask());
    await expect(tasks.put(makeTask({ tenantId: TENANT_B }))).rejects.toThrow(/another tenant/);
  });

  it('rejects a duplicate create', async () => {
    const { tasks } = buildTestStores();
    await tasks.create(makeTask());
    await expect(tasks.create(makeTask())).rejects.toThrow(/already exists/);
  });

  it('filters by session, state and limit', async () => {
    const { tasks } = buildTestStores();
    await tasks.create(makeTask({ id: 'task_1', sessionId: 'ses_1', state: 'submitted', createdAt: T0 }));
    await tasks.create(makeTask({ id: 'task_2', sessionId: 'ses_1', state: 'working', createdAt: T2 }));
    await tasks.create(makeTask({ id: 'task_3', sessionId: 'ses_2', state: 'submitted', createdAt: T2 }));
    expect((await tasks.list({ tenantId: TENANT_A, sessionId: 'ses_1' })).map((t) => t.id)).toEqual(['task_1', 'task_2']);
    expect((await tasks.list({ tenantId: TENANT_A, state: 'submitted' })).map((t) => t.id)).toEqual(['task_1', 'task_3']);
    expect((await tasks.list({ tenantId: TENANT_A, limit: 2 })).map((t) => t.id)).toEqual(['task_1', 'task_2']);
  });

  it('lists only unterminated tasks for crash recovery', async () => {
    const { tasks } = buildTestStores();
    await tasks.create(makeTask({ id: 'task_1', state: 'working' }));
    await tasks.create(makeTask({ id: 'task_2', state: 'completed' }));
    await tasks.create(makeTask({ id: 'task_3', state: 'cancelled' }));
    expect((await tasks.listUnterminated(TENANT_A)).map((t) => t.id)).toEqual(['task_1']);
  });

  it('deletes only within the owning tenant', async () => {
    const { tasks } = buildTestStores();
    await tasks.create(makeTask());
    await tasks.delete('task_1', TENANT_B);
    expect(await tasks.get('task_1', TENANT_A)).toBeDefined();
    await tasks.delete('task_1', TENANT_A);
    expect(await tasks.get('task_1', TENANT_A)).toBeUndefined();
  });
});

describe('MemorySessionStore', () => {
  it('round-trips a session and scopes reads by tenant', async () => {
    const { sessions } = buildTestStores();
    await sessions.create(makeSession());
    expect((await sessions.get('ses_1', TENANT_A))?.state).toBe('open');
    expect(await sessions.get('ses_1', TENANT_B)).toBeUndefined();
    expect(await sessions.list(TENANT_B)).toEqual([]);
    await sessions.put(makeSession({ state: 'closed' }));
    expect((await sessions.get('ses_1', TENANT_A))?.state).toBe('closed');
    expect(await sessions.list(TENANT_A)).toHaveLength(1);
  });
});

describe('MemoryApprovalStore', () => {
  it('inserts, gets and lists with filters', async () => {
    const { approvals } = buildTestStores();
    await approvals.insert(makeApproval());
    await approvals.insert(makeApproval({ id: 'apr_2', tenantId: TENANT_B }));
    expect((await approvals.get('apr_1'))?.id).toBe('apr_1');
    expect(await approvals.list({ tenantId: TENANT_A })).toHaveLength(1);
    expect(await approvals.list({ tenantId: TENANT_B })).toHaveLength(1);
    expect(await approvals.list({ state: 'pending' })).toHaveLength(2);
  });

  it('decides with compare-and-set on revision', async () => {
    const { approvals } = buildTestStores();
    await approvals.insert(makeApproval());
    expect(await approvals.decide('apr_1', 99, { state: 'allowed' })).toBe(false);
    expect(await approvals.decide('apr_1', 1, { state: 'allowed', decidedBy: 'prn_alice' })).toBe(true);
    const record = await approvals.get('apr_1');
    expect(record?.state).toBe('allowed');
    expect(record?.revision).toBe(2);
    expect(record?.decidedBy).toBe('prn_alice');
    // A second decision on a stale revision is refused.
    expect(await approvals.decide('apr_1', 1, { state: 'denied' })).toBe(false);
  });

  it('throws on an illegal approval transition', async () => {
    const { approvals } = buildTestStores();
    await approvals.insert(makeApproval());
    await approvals.decide('apr_1', 1, { state: 'denied' });
    await expect(approvals.decide('apr_1', 2, { state: 'allowed' })).rejects.toThrow(/illegal approval transition/);
  });

  it('expires only pending records past expiresAt', async () => {
    const { approvals } = buildTestStores();
    await approvals.insert(makeApproval({ id: 'apr_old', expiresAt: '2025-12-31T00:00:00.000Z' }));
    await approvals.insert(makeApproval({ id: 'apr_live', expiresAt: T2 }));
    await approvals.insert(makeApproval({ id: 'apr_done', expiresAt: '2025-12-31T00:00:00.000Z', state: 'allowed', revision: 2 }));
    expect(await approvals.expire(T0)).toBe(1);
    expect((await approvals.get('apr_old'))?.state).toBe('expired');
    expect((await approvals.get('apr_live'))?.state).toBe('pending');
    expect((await approvals.get('apr_done'))?.state).toBe('allowed');
  });
});

describe('MemoryBudgetStore', () => {
  it('scopes accounts by tenant and round-trips reservations', async () => {
    const { budget } = buildTestStores();
    await budget.put(makeAccount());
    await budget.put(makeAccount({ id: 'bud_2', tenantId: TENANT_B }));
    expect((await budget.get('bud_1'))?.tenantId).toBe(TENANT_A);
    expect((await budget.list(TENANT_A)).map((a) => a.id)).toEqual(['bud_1']);
    expect(await budget.list(TENANT_B)).toHaveLength(1);

    await budget.putReservation(makeReservation());
    await budget.putReservation(makeReservation({ id: 'rsv_2', state: 'settled', accountId: 'bud_2' }));
    expect((await budget.getReservation('rsv_1'))?.state).toBe('held');
    expect((await budget.listReservations({ state: 'held' })).map((r) => r.id)).toEqual(['rsv_1']);
    expect((await budget.listReservations({ accountId: 'bud_2' })).map((r) => r.id)).toEqual(['rsv_2']);
    expect(await budget.listReservations()).toHaveLength(2);
  });

  it('rejects moving an account across tenants (I8)', async () => {
    const { budget } = buildTestStores();
    await budget.put(makeAccount());
    await expect(budget.put(makeAccount({ tenantId: TENANT_B }))).rejects.toThrow(/another tenant/);
  });
});

describe('idempotency wiring', () => {
  it('walks new → in_flight → replay → conflict', async () => {
    const clock = fixedClock();
    const { idempotency } = buildTestStores({ now: clock.now });
    expect((await idempotency.begin('k', 'hash-1')).kind).toBe('new');
    expect((await idempotency.begin('k', 'hash-1')).kind).toBe('in_flight');
    expect((await idempotency.begin('k', 'hash-2')).kind).toBe('conflict');
    await idempotency.complete('k', { ok: true });
    expect((await idempotency.begin('k', 'hash-1')).kind).toBe('replay');
  });
});
