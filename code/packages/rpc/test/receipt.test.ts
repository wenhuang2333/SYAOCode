/**
 * Receipt chain + evidence sealer tests (C6 / I7).
 */

import { describe, expect, it } from 'vitest';
import { chainHash } from '@syaocode/core';
import { buildTestStores, fixedClock, makeApproval, makeReceipt, makeTask, T0, T1, T2 } from './helpers.js';
import { MemoryReceiptStore, HashChainEvidenceSealer, GENESIS_HASH, receiptBody, recomputeReceiptHash } from '../src/governance/receipts.js';
import { canonicalJson } from '../src/ir/schemas.js';
import type { BudgetAccount, BudgetReservation, EvidenceBundle, Receipt } from '../src/ir/types.js';

const TENANT = 'ten_a';

function harness(clock = fixedClock()) {
  const stores = buildTestStores({ now: clock.now });
  return { stores, clock, receipts: stores.receipts, sealer: stores.evidence };
}

async function seedTask(stores: ReturnType<typeof buildTestStores>, state: 'working' | 'completed' | 'failed' = 'working'): Promise<void> {
  await stores.tasks.create(makeTask({ state, updatedAt: T2 }));
}

function checkOf(bundle: EvidenceBundle, name: string): { ok: boolean; detail?: string } | undefined {
  return bundle.verification.checks.find((check) => check.name === name);
}

describe('MemoryReceiptStore chain', () => {
  it('seals the first link without prevHash, using core chainHash semantics', async () => {
    const { receipts } = harness();
    const sealed = await receipts.put(makeReceipt());
    expect(sealed.prevHash).toBeUndefined();
    expect('prevHash' in sealed).toBe(false);
    expect(sealed.hash).toBe(chainHash(GENESIS_HASH, canonicalJson(receiptBody(sealed))));
  });

  it('links each receipt to the previous hash', async () => {
    const { receipts } = harness();
    const first = await receipts.put(makeReceipt());
    const second = await receipts.put(makeReceipt({ id: 'rcpt_2', invocationId: 'inv_2' }));
    const third = await receipts.put(makeReceipt({ id: 'rcpt_3', invocationId: 'inv_3' }));
    expect(second.prevHash).toBe(first.hash);
    expect(third.prevHash).toBe(second.hash);
    expect(second.hash).toBe(chainHash(first.hash, canonicalJson(receiptBody(second))));
    expect((await receipts.head('task_1'))?.id).toBe('rcpt_3');
    expect((await receipts.listByTask('task_1')).map((r) => r.id)).toEqual(['rcpt_1', 'rcpt_2', 'rcpt_3']);
  });

  it('rejects a duplicate id (append-only)', async () => {
    const { receipts } = harness();
    await receipts.put(makeReceipt());
    await expect(receipts.put(makeReceipt())).rejects.toThrow(/already exists/);
  });

  it('rejects joining another tenant chain (I8)', async () => {
    const { receipts } = harness();
    await receipts.put(makeReceipt());
    await expect(receipts.put(makeReceipt({ id: 'rcpt_2', tenantId: 'ten_b' }))).rejects.toThrow(/another tenant/);
  });

  it('scopes reads by tenant when asked', async () => {
    const { receipts } = harness();
    await receipts.put(makeReceipt());
    expect(await receipts.get('rcpt_1', 'ten_b')).toBeUndefined();
    expect(await receipts.get('rcpt_1', TENANT)).toBeDefined();
    expect(await receipts.listByTask('task_1', 'ten_b')).toEqual([]);
  });

  it('keeps a separate chain per task', async () => {
    const { receipts } = harness();
    const a = await receipts.put(makeReceipt());
    const b = await receipts.put(makeReceipt({ id: 'rcpt_b', taskId: 'task_2' }));
    expect(b.prevHash).toBeUndefined();
    expect(await receipts.head('task_1')).toEqual(a);
    expect((await receipts.listByTask('task_2')).map((r) => r.id)).toEqual(['rcpt_b']);
  });
});

describe('EvidenceSealer', () => {
  it('seals a verified bundle for a completed task', async () => {
    const { stores, sealer } = harness();
    await seedTask(stores, 'completed');
    await stores.receipts.put(makeReceipt());
    const bundle = await sealer.seal('task_1');
    expect(bundle.tenantId).toBe(TENANT);
    expect(bundle.receipts).toHaveLength(1);
    expect(bundle.policySnapshots.map((s) => s.revision)).toEqual(['pol_1']);
    expect(bundle.verification.verdict).toBe('verified');
    expect(bundle.verification.checks.every((c) => c.ok)).toBe(true);
    const verified = await sealer.verify(bundle);
    expect(verified.ok).toBe(true);
    expect(verified.checks.map((c) => c.name)).toContain('receipts.hash');
  });

  it('recomputes every link and detects a tampered receipt', async () => {
    const { stores, sealer } = harness();
    await seedTask(stores, 'working');
    await stores.receipts.put(makeReceipt());
    await stores.receipts.put(makeReceipt({ id: 'rcpt_2', invocationId: 'inv_2' }));

    const live = await sealer.seal('task_1');
    expect(live.verification.verdict).toBe('verified');

    const tampered: EvidenceBundle = structuredClone(live);
    tampered.receipts[1]!.outputHash = 'forged';
    const result = await sealer.verify(tampered);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === 'receipts.hash')?.ok).toBe(false);
  });

  it('detects a broken chain link', async () => {
    const { stores, sealer } = harness();
    await seedTask(stores);
    await stores.receipts.put(makeReceipt());
    await stores.receipts.put(makeReceipt({ id: 'rcpt_2', invocationId: 'inv_2' }));
    const live = await sealer.seal('task_1');

    const broken: EvidenceBundle = structuredClone(live);
    broken.receipts[1]!.prevHash = 'not-the-head';
    const result = await sealer.verify(broken);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === 'receipts.chain')?.ok).toBe(false);
  });

  it('detects a dropped receipt in the middle of the chain', async () => {
    const { stores, sealer } = harness();
    await seedTask(stores);
    for (const id of ['rcpt_1', 'rcpt_2', 'rcpt_3']) await stores.receipts.put(makeReceipt({ id, invocationId: `inv_${id}` }));
    const live = await sealer.seal('task_1');
    const dropped: EvidenceBundle = structuredClone(live);
    dropped.receipts.splice(1, 1);
    const result = await sealer.verify(dropped);
    expect(result.ok).toBe(false);
  });

  it('requires an allowed approval for an ask-decision', async () => {
    const { stores, sealer } = harness();
    await seedTask(stores, 'completed');
    await stores.receipts.put(
      makeReceipt({ policy: { revision: 'pol_1', decisionId: 'dec_1', effect: 'ask', obligations: [] } }),
    );
    const missing = await sealer.seal('task_1');
    expect(missing.verification.verdict).toBe('failed');
    expect(checkOf(missing, 'approvals.present')?.ok).toBe(false);

    await stores.approvals.insert(makeApproval({ state: 'allowed', revision: 2 }));
    await stores.receipts.put(
      makeReceipt({
        id: 'rcpt_2',
        invocationId: 'inv_2',
        approvals: ['apr_1'],
        policy: { revision: 'pol_1', decisionId: 'dec_1', effect: 'ask', obligations: [] },
      }),
    );
    const withApproval = await sealer.seal('task_1');
    // The first receipt still lacks its approval, so the bundle stays failed.
    expect(checkOf(withApproval, 'approvals.present')?.ok).toBe(false);

    const clean = harness();
    await seedTask(clean.stores, 'completed');
    await clean.stores.approvals.insert(makeApproval({ state: 'allowed', revision: 2 }));
    await clean.stores.receipts.put(
      makeReceipt({ approvals: ['apr_1'], policy: { revision: 'pol_1', decisionId: 'dec_1', effect: 'ask', obligations: [] } }),
    );
    const ok = await clean.sealer.seal('task_1');
    expect(checkOf(ok, 'approvals.present')?.ok).toBe(true);
    expect(ok.verification.verdict).toBe('verified');
  });

  it('rejects an approval that is not allowed', async () => {
    const { stores, sealer } = harness();
    await seedTask(stores, 'completed');
    await stores.approvals.insert(makeApproval({ state: 'denied', revision: 2 }));
    await stores.receipts.put(
      makeReceipt({ approvals: ['apr_1'], policy: { revision: 'pol_1', decisionId: 'dec_1', effect: 'ask', obligations: [] } }),
    );
    const bundle = await sealer.seal('task_1');
    expect(checkOf(bundle, 'approvals.present')?.ok).toBe(false);
    expect(checkOf(bundle, 'approvals.present')?.detail).toMatch(/state denied/);
  });

  it('checks artifact refs against the receipts', async () => {
    const { stores, sealer } = harness();
    await seedTask(stores, 'completed');
    await stores.receipts.put(makeReceipt({ artifacts: [{ id: 'art_1', hash: 'abc' }] }));
    const live = await sealer.seal('task_1');
    expect(checkOf(live, 'artifacts.hash')?.ok).toBe(true);

    const forged: EvidenceBundle = structuredClone(live);
    forged.artifacts = [{ id: 'art_9', hash: 'zzz' }];
    const result = await sealer.verify(forged);
    expect(result.checks.find((c) => c.name === 'artifacts.hash')?.ok).toBe(false);
  });

  it('reports unverified when a task has no receipts', async () => {
    const { stores, sealer } = harness();
    await seedTask(stores);
    const bundle = await sealer.seal('task_1');
    expect(bundle.verification.verdict).toBe('unverified');
    expect(checkOf(bundle, 'receipts.present')?.ok).toBe(false);
    const result = await sealer.verify(bundle);
    expect(result.ok).toBe(false);
  });

  it('flags a terminal task whose last receipt is still in flight', async () => {
    const { stores, sealer } = harness();
    await seedTask(stores, 'completed');
    await stores.receipts.put(makeReceipt({ outcome: 'running' }));
    const bundle = await sealer.seal('task_1');
    expect(checkOf(bundle, 'task.terminal')?.ok).toBe(false);
    expect(checkOf(bundle, 'task.terminal')?.detail).toMatch(/in flight/);
  });

  it('flags a completed task with no successful receipt', async () => {
    const { stores, sealer } = harness();
    await seedTask(stores, 'completed');
    await stores.receipts.put(makeReceipt({ outcome: 'failed' }));
    const bundle = await sealer.seal('task_1');
    expect(checkOf(bundle, 'task.terminal')?.ok).toBe(false);
    expect(checkOf(bundle, 'task.terminal')?.detail).toMatch(/no receipt outcome matches/);
  });

  it('accepts a failed task with a failed receipt', async () => {
    const { stores, sealer } = harness();
    await seedTask(stores, 'failed');
    await stores.receipts.put(makeReceipt({ outcome: 'failed' }));
    const bundle = await sealer.seal('task_1');
    expect(checkOf(bundle, 'task.terminal')?.ok).toBe(true);
  });

  it('checks that budget reservations were settled', async () => {
    const account: BudgetAccount = {
      id: 'bud_1', tenantId: TENANT, currency: 'USD', reservedUsd: 1, spentUsd: 0,
      tokensUsed: 0, timeUsedMs: 0, toolCallsUsed: 0, state: 'active',
    };
    const held: BudgetReservation = {
      id: 'rsv_1', accountId: 'bud_1', accountChain: ['bud_1'], estimate: { usd: 1 },
      createdAt: T0, expiresAt: T2, state: 'held',
    };
    const { stores, sealer } = harness();
    await seedTask(stores, 'completed');
    await stores.tasks.put(makeTask({ state: 'completed', createdAt: T0, updatedAt: T1 }));
    await stores.receipts.put(makeReceipt());
    await stores.budget.put(account);
    await stores.budget.putReservation(held);

    const unsettled = await sealer.seal('task_1');
    expect(checkOf(unsettled, 'budget.settled')?.ok).toBe(false);
    expect(checkOf(unsettled, 'budget.settled')?.detail).toMatch(/still held/);

    await stores.budget.putReservation({ ...held, state: 'settled', settledUsd: 1 });
    const settled = await sealer.seal('task_1');
    expect(checkOf(settled, 'budget.settled')?.ok).toBe(true);
  });

  it('binds the bundle with rootHash and detects a content swap', async () => {
    const { stores, sealer } = harness();
    await seedTask(stores, 'completed');
    await stores.receipts.put(makeReceipt());
    const bundle = await sealer.seal('task_1');
    expect(bundle.rootHash).toMatch(/^[0-9a-f]{64}$/);

    const swapped: EvidenceBundle = structuredClone(bundle);
    swapped.createdAt = '2030-01-01T00:00:00.000Z';
    const result = await sealer.verify(swapped);
    expect(result.checks.find((c) => c.name === 'rootHash')?.ok).toBe(false);
  });

  it('works standalone without task/budget probes', async () => {
    const store = new MemoryReceiptStore({ hash: { sha256: (text) => chainHash('', text) } });
    const sealedA = await store.put(makeReceipt());
    expect(recomputeReceiptHash({ sha256: (text) => chainHash('', text) }, sealedA, GENESIS_HASH)).toBe(sealedA.hash);
    const sealer = new HashChainEvidenceSealer({ hash: { sha256: (text) => chainHash('', text) }, receipts: store });
    const bundle = await sealer.seal('task_1');
    expect(bundle.receipts).toHaveLength(1);
    expect((await sealer.verify(bundle)).ok).toBe(true);
  });
});
