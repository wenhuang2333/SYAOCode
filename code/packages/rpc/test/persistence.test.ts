/**
 * Persistence (audit C-4).
 *
 * The kernel kept every record in memory, so a new CLI process could not see
 * what the previous one did — "auditable" was an interface, not a capability.
 * These tests prove that the file-backed store bundle restores what a previous
 * process wrote, and that a tampered chain is refused rather than trusted.
 */

import { describe, expect, it } from 'vitest';
import { createFabric } from '../src/runtime/fabric.js';
import { createFileStores } from '../src/runtime/file-stores.js';
import { FakeRuntime, TEST_TENANT, hasher } from './kernel-helpers.js';
import type { Receipt } from '../src/ir/types.js';

function dirFor(name: string): string {
  return `/tmp/syao-persist-${name}`;
}

describe('file-backed stores (C-4)', () => {
  it('a task, its receipt and its audit links survive a restart', async () => {
    const runtime = new FakeRuntime();
    const dir = dirFor('restart');
    const ids = { next: (p: string) => `${p}_${Math.floor(Math.random() * 1e9).toString(36)}` };
    const now = () => '2026-10-28T00:00:00.000Z';

    // ── process 1: run one governed call ──────────────────────────────
    const stores1 = createFileStores({ runtime, dir, ids, now, hash: hasher });
    const fabric1 = createFabric({
      runtime,
      tenantId: TEST_TENANT,
      workspaceRoots: ['/work'],
      stores: stores1,
      policy: {
        defaultEffect: 'deny',
        rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }],
      },
    });
    await fabric1.mount(
      {
        protocol: 'mcp',
        version: '2026-07-28',
        capabilities: () => ({
          protocol: 'mcp', version: '2026-07-28',
          supports: { session: false, task: true, streaming: false, push: false, approvalOptions: false, artifacts: false, reverseCalls: false, cancellation: false },
          lossy: [],
        }),
        async discover() {
          return [{ id: 'mcp://demo/tool/echo', kind: 'tool' as const, displayName: 'echo' }];
        },
        async invoke() {
          return { outcome: 'succeeded' as const, output: { echoed: true } };
        },
        async health() {
          return 'healthy' as const;
        },
        async close() {
          /* nothing */
        },
      },
      { providerId: 'demo', risk: 'read' },
    );
    const result = await fabric1.call({ capabilityId: 'mcp://demo/tool/echo', input: { msg: 'hi' } });
    expect(result.outcome).toBe('succeeded');

    // ── process 2: a fresh store bundle over the same directory ───────
    const stores2 = createFileStores({ runtime, dir, ids, now, hash: hasher });
    const fabric2 = createFabric({
      runtime,
      tenantId: TEST_TENANT,
      workspaceRoots: ['/work'],
      stores: stores2,
      policy: { defaultEffect: 'deny', rules: [] },
    });

    // The receipt is there.
    const receipt = await fabric2.stores.receipts.get(result.receiptId, TEST_TENANT);
    expect(receipt).toBeDefined();
    expect(receipt?.capabilityId).toBe('mcp://demo/tool/echo');

    // The task is there.
    const task = await fabric2.stores.tasks.get(result.taskId, TEST_TENANT);
    expect(task).toBeDefined();

    // The audit chain is there AND still verifies.
    const audit = await fabric2.audit.list();
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.map((e) => e.action)).toContain('policy.decide');
    expect(audit.map((e) => e.action)).toContain('invocation.succeeded');
    const verified = await fabric2.audit.verify(TEST_TENANT);
    expect(verified.ok).toBe(true);
    expect(verified.checked).toBe(audit.length);
  });

  it('the budget account and its reservation survive a restart', async () => {
    const runtime = new FakeRuntime();
    const dir = dirFor('budget');
    const ids = { next: (p: string) => `${p}_${Math.floor(Math.random() * 1e9).toString(36)}` };
    const now = () => '2026-10-28T00:00:00.000Z';

    const stores1 = createFileStores({ runtime, dir, ids, now, hash: hasher });
    await stores1.budget.put({
      id: 'default', tenantId: TEST_TENANT, currency: 'USD', reservedUsd: 0, spentUsd: 0.25,
      tokensUsed: 0, timeUsedMs: 0, toolCallsUsed: 1, state: 'active',
    });

    const stores2 = createFileStores({ runtime, dir, ids, now, hash: hasher });
    const account = await stores2.budget.get('default');
    expect(account?.spentUsd).toBeCloseTo(0.25, 6);
    expect(account?.toolCallsUsed).toBe(1);
  });

  it('the event log continues a task sequence without a gap after a restart', async () => {
    const runtime = new FakeRuntime();
    const dir = dirFor('events');
    const ids = { next: (p: string) => `${p}_${Math.floor(Math.random() * 1e9).toString(36)}` };
    const now = () => '2026-10-28T00:00:00.000Z';

    const stores1 = createFileStores({ runtime, dir, ids, now, hash: hasher });
    await stores1.events.append({
      taskId: 'task_x', correlationId: 'c', principalId: 'user:local', protocol: 'native',
      type: 'task.created', payload: { state: 'submitted' },
    });

    const stores2 = createFileStores({ runtime, dir, ids, now, hash: hasher });
    const before = await stores2.events.list('task_x');
    expect(before).toHaveLength(1);
    await stores2.events.append({
      taskId: 'task_x', correlationId: 'c', principalId: 'user:local', protocol: 'native',
      type: 'task.state_changed', payload: { state: 'working' },
    });
    const after = await stores2.events.list('task_x');
    // Gap-free: the sequence continues from the restored row.
    expect(after.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('refuses a tampered receipt chain instead of trusting it', async () => {
    const runtime = new FakeRuntime();
    const dir = dirFor('tamper');
    const ids = { next: (p: string) => `${p}_${Math.floor(Math.random() * 1e9).toString(36)}` };
    const now = () => '2026-10-28T00:00:00.000Z';

    const stores1 = createFileStores({ runtime, dir, ids, now, hash: hasher });
    const receipts = stores1.receipts;
    const first = await receipts.put({
      id: 'rcpt_1', tenantId: TEST_TENANT, taskId: 'task_x', invocationId: 'inv_1',
      protocol: 'mcp', capabilityId: 'c', principalId: 'user:local', delegationChain: [],
      outcome: 'succeeded', inputHash: 'h', artifacts: [], approvals: [],
      policy: { revision: 'r', decisionId: 'd', effect: 'allow', obligations: [] },
      timing: { queuedAt: now(), startedAt: now(), endedAt: now() },
      visibility: 'full',
    });
    await receipts.put({
      id: 'rcpt_2', tenantId: TEST_TENANT, taskId: 'task_x', invocationId: 'inv_2',
      protocol: 'mcp', capabilityId: 'c', principalId: 'user:local', delegationChain: [],
      outcome: 'succeeded', inputHash: 'h', artifacts: [], approvals: [],
      policy: { revision: 'r', decisionId: 'd', effect: 'allow', obligations: [] },
      timing: { queuedAt: now(), startedAt: now(), endedAt: now() },
      visibility: 'full',
    });
    expect(first.hash).not.toBe('');

    // Tamper with the first link.
    const path = `${dir}/receipts.jsonl`;
    const lines = (await runtime.fs.readFile(path)).split('\n').filter((l) => l.trim() !== '');
    const rows = lines.map((l) => JSON.parse(l) as Receipt);
    rows[0]!.inputHash = 'tampered';
    await runtime.fs.writeFile(path, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

    // A fresh bundle must refuse the chain, not adopt the tampered head.
    const stores2 = createFileStores({ runtime, dir, ids, now, hash: hasher });
    await expect(stores2.receipts.listByTask('task_x', TEST_TENANT)).rejects.toThrow(
      /does not match its own hash/,
    );
  });

  it('refuses a tampered audit chain instead of trusting it', async () => {
    const runtime = new FakeRuntime();
    const dir = dirFor('audit-tamper');
    const ids = { next: (p: string) => `${p}_${Math.floor(Math.random() * 1e9).toString(36)}` };
    const now = () => '2026-10-28T00:00:00.000Z';

    const stores1 = createFileStores({ runtime, dir, ids, now, hash: hasher });
    await stores1.audit.append({
      ts: now(), tenantId: TEST_TENANT, actor: { type: 'user', id: 'user:local' },
      action: 'policy.decide', subject: { type: 'capability', id: 'c' }, outcome: 'success',
    });
    await stores1.audit.append({
      ts: now(), tenantId: TEST_TENANT, actor: { type: 'user', id: 'user:local' },
      action: 'invocation.succeeded', subject: { type: 'invocation', id: 'i' }, outcome: 'success',
    });

    const path = `${dir}/audit.jsonl`;
    const lines = (await runtime.fs.readFile(path)).split('\n').filter((l) => l.trim() !== '');
    const rows = lines.map((l) => JSON.parse(l) as { prevHash: string });
    rows[1]!.prevHash = 'tampered';
    await runtime.fs.writeFile(path, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

    const stores2 = createFileStores({ runtime, dir, ids, now, hash: hasher });
    await expect(stores2.audit.list({ tenantId: TEST_TENANT })).rejects.toThrow(/broken/);
  });
});
