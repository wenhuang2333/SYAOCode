import { describe, expect, it } from 'vitest';
import { BudgetExceededError, BudgetLedgerImpl } from '../src/governance/budget.js';
import { FakeBudgetStore, TEST_NOW, TEST_TENANT } from './kernel-helpers.js';

function makeLedger() {
  const store = new FakeBudgetStore();
  let n = 0;
  const ledger = new BudgetLedgerImpl({
    store,
    ids: { next: (p: string) => `${p}_${(n += 1)}` },
    now: () => TEST_NOW,
    maxPerInvocationUsd: 0.5,
  });
  return { ledger, store };
}

async function seed(ledger: BudgetLedgerImpl, limitUsd?: number) {
  await ledger.ensureAccount({ id: 'tenant', tenantId: TEST_TENANT, currency: 'USD', state: 'active', ...(limitUsd !== undefined ? { limitUsd } : {}) });
  await ledger.ensureAccount({ id: 'task', tenantId: TEST_TENANT, parentId: 'tenant', currency: 'USD', state: 'active' });
}

describe('BudgetLedger (02 §7)', () => {
  it('reserves across the whole ancestor chain', async () => {
    const { ledger } = makeLedger();
    await seed(ledger, 10);
    const reservation = await ledger.reserve({ accountId: 'task', estimate: { usd: 1 } });
    expect(reservation.accountChain).toEqual(['tenant', 'task']);
    const tenant = await ledger.get('tenant');
    const task = await ledger.get('task');
    expect(tenant?.reservedUsd).toBe(1);
    expect(task?.reservedUsd).toBe(1);
  });

  it('refuses a reservation that would exceed a limit (I6)', async () => {
    const { ledger } = makeLedger();
    await seed(ledger, 1);
    await expect(ledger.reserve({ accountId: 'task', estimate: { usd: 2 } })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('refuses a reservation when an ANCESTOR is exhausted, not just the task account', async () => {
    const { ledger } = makeLedger();
    await ledger.ensureAccount({ id: 'tenant', tenantId: TEST_TENANT, currency: 'USD', state: 'active', limitUsd: 0.5 });
    await ledger.ensureAccount({ id: 'task', tenantId: TEST_TENANT, parentId: 'tenant', currency: 'USD', state: 'active' });
    await expect(ledger.reserve({ accountId: 'task', estimate: { usd: 1 } })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('settles the actual cost and releases the difference', async () => {
    const { ledger } = makeLedger();
    await seed(ledger, 10);
    const reservation = await ledger.reserve({ accountId: 'task', estimate: { usd: 1 } });
    const settled = await ledger.settle(reservation.id, { costUsd: 0.25 });
    expect(settled.state).toBe('settled');
    expect(settled.settledUsd).toBe(0.25);
    const tenant = await ledger.get('tenant');
    expect(tenant?.reservedUsd).toBe(0);
    expect(tenant?.spentUsd).toBeCloseTo(0.25, 6);
  });

  it('settles idempotently (a repeated settle does not double-charge)', async () => {
    const { ledger } = makeLedger();
    await seed(ledger, 10);
    const reservation = await ledger.reserve({ accountId: 'task', estimate: { usd: 1 } });
    await ledger.settle(reservation.id, { costUsd: 0.5 });
    await ledger.settle(reservation.id, { costUsd: 0.5 });
    const tenant = await ledger.get('tenant');
    expect(tenant?.spentUsd).toBeCloseTo(0.5, 6);
  });

  it('uses maxPerInvocationUsd only when the estimate is unknown (02 §7.2)', async () => {
    const { ledger } = makeLedger();
    await seed(ledger, 10);
    // No estimate supplied → the conservative per-invocation ceiling is held.
    expect((await ledger.reserve({ accountId: 'task' })).estimate.usd).toBe(0.5);
    // A concrete estimate is honoured, never silently clamped.
    expect((await ledger.reserve({ accountId: 'task', estimate: { usd: 0.75 } })).estimate.usd).toBe(0.75);
  });

  it('freezes the account when the actual cost exceeds the limit (§7.2)', async () => {
    const { ledger } = makeLedger();
    await seed(ledger, 1);
    const reservation = await ledger.reserve({ accountId: 'task', estimate: { usd: 1 } });
    await ledger.settle(reservation.id, { costUsd: 2 });
    const tenant = await ledger.get('tenant');
    expect(tenant?.state).toBe('frozen');
    // A frozen account refuses new reservations.
    await expect(ledger.reserve({ accountId: 'task', estimate: { usd: 0.1 } })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('releases a hold without spending (§7 crash recovery)', async () => {
    const { ledger } = makeLedger();
    await seed(ledger, 10);
    const reservation = await ledger.reserve({ accountId: 'task', estimate: { usd: 1 } });
    const released = await ledger.release(reservation.id);
    expect(released.state).toBe('released');
    expect((await ledger.get('tenant'))?.reservedUsd).toBe(0);
    expect((await ledger.get('tenant'))?.spentUsd).toBe(0);
  });

  it('recoverExpired releases holds past their TTL', async () => {
    const { ledger } = makeLedger();
    await seed(ledger, 10);
    await ledger.reserve({ accountId: 'task', estimate: { usd: 1 }, ttlMs: 1000 });
    expect(await ledger.recoverExpired(TEST_NOW)).toBe(0); // not expired yet
    expect(await ledger.recoverExpired(new Date(Date.parse(TEST_NOW) + 2000).toISOString())).toBe(1);
    expect((await ledger.get('tenant'))?.reservedUsd).toBe(0);
  });

  it('canAfford is a non-binding probe', async () => {
    const { ledger } = makeLedger();
    await seed(ledger, 1);
    expect(await ledger.canAfford('task', { usd: 0.5 })).toBe(true);
    expect(await ledger.canAfford('task', { usd: 5 })).toBe(false);
    // The probe must not reserve anything.
    expect((await ledger.get('tenant'))?.reservedUsd).toBe(0);
  });

  it('rejects a reservation on an unknown account', async () => {
    const { ledger } = makeLedger();
    await expect(ledger.reserve({ accountId: 'nope', estimate: { usd: 1 } })).rejects.toThrow(/does not exist/);
  });

  it('enforces the token and tool-call limits', async () => {
    const { ledger } = makeLedger();
    await ledger.ensureAccount({ id: 'tenant', tenantId: TEST_TENANT, currency: 'USD', state: 'active', tokenLimit: 100 });
    await ledger.ensureAccount({ id: 'task', tenantId: TEST_TENANT, parentId: 'tenant', currency: 'USD', state: 'active' });
    expect(await ledger.canAfford('task', { usd: 0, tokens: 50 })).toBe(true);
    expect(await ledger.canAfford('task', { usd: 0, tokens: 500 })).toBe(false);
  });
});
