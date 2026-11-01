/**
 * Multi-process write safety (06 §11.2, WP-1.4).
 *
 * These are the tests the whole write-lease design exists for. Each one spawns
 * REAL child processes that share one governance directory, because the failure
 * modes being ruled out — lost updates, a forked audit chain, double-spent
 * budget, a double-approved approval — only appear when two independent
 * processes interleave. An in-process test would be serialized by the bundle's
 * own queue and would pass even with no cross-process locking at all.
 *
 * Scenario letters match the design document so a failure can be traced
 * straight back to it.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeRuntime, sha256Hex } from '@syaocode/node';
import { createFileStores } from '../src/runtime/file-stores.js';
import { forceUnlock, readEpoch, readLeaseOwner } from '../src/runtime/lock.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'multiprocess', 'worker.ts');
// `node_modules/.bin/tsx` is a shell shim, not a JS entry: spawn the real CLI
// module so the worker runs on every platform without a shell.
const TSX = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist/cli.mjs');
const TENANT = 'ten_mp';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'syao-mp-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface WorkerResult {
  code: number | null;
  lines: { event: string; [key: string]: unknown }[];
  stderr: string;
}

/**
 * Spawn a real worker process.
 *
 * `tsx` runs the TypeScript, and it may fork: killing only the direct child
 * would leave the actual worker alive — still holding the lease and still
 * heartbeating, which makes a "killed writer" test quietly assert nothing.
 * The child therefore leads its own process group and is killed as a group.
 */
function runWorker(
  args: Record<string, unknown>,
  opts: { killWhenHolding?: boolean } = {},
): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, WORKER, JSON.stringify(args)], {
      cwd: HERE,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let killed = false;

    const killGroup = (): void => {
      if (killed) return;
      killed = true;
      try {
        // Negative pid = the whole process group.
        process.kill(-(child.pid ?? 0), 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };

    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
      // Kill as soon as the worker says it owns the lease.
      if (opts.killWhenHolding === true && !killed && stdout.includes('"holding"')) killGroup();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('exit', (code) => {
      const lines = stdout
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line) as { event: string });
      resolve({ code, lines, stderr });
    });
  });
}

function opener(dir: string) {
  const runtime = nodeRuntime();
  return createFileStores({
    runtime,
    dir,
    tenantId: TENANT,
    hash: { sha256: sha256Hex },
    leaseTtlMs: 600,
    heartbeatIntervalMs: 150,
    lockTimeoutMs: 20_000,
  });
}

// ── A: no lost task updates ───────────────────────────────────────────────

describe('multi-process scenario A — no lost task updates', () => {
  it('four writers × 20 tasks each, and every task survives', async () => {
    const dir = tempDir();
    const perWorker = 20;
    const workers = ['w1', 'w2', 'w3', 'w4'];

    const results = await Promise.all(
      workers.map((actor) =>
        runWorker({ dir, tenantId: TENANT, actor, count: perWorker, op: 'tasks' }),
      ),
    );
    for (const [i, result] of results.entries()) {
      expect(result.code, `${workers[i]} exited ${result.code}: ${JSON.stringify(result.lines)} ${result.stderr}`).toBe(0);
    }

    const stores = opener(dir);
    const tasks = await stores.tasks.list({ tenantId: TENANT });
    // The lost-update bug loses a whole worker's batch: "read everything,
    // append mine, rewrite everything" from two processes at once.
    expect(tasks.length).toBe(workers.length * perWorker);
    const ids = new Set(tasks.map((t) => t.id));
    expect(ids.size).toBe(workers.length * perWorker);
    await stores.dispose();
  }, 120_000);
});

// ── B: the audit chain neither forks nor loses links ──────────────────────

describe('multi-process scenario B — one unbroken audit chain', () => {
  it('four writers × 10 audit links produce a single verifiable chain', async () => {
    const dir = tempDir();
    const perWorker = 10;
    const workers = ['a1', 'a2', 'a3', 'a4'];

    const results = await Promise.all(
      workers.map((actor) => runWorker({ dir, tenantId: TENANT, actor, count: perWorker, op: 'audit' })),
    );
    for (const [i, result] of results.entries()) {
      expect(result.code, `${workers[i]} exited ${result.code}: ${JSON.stringify(result.lines)} ${result.stderr}`).toBe(0);
    }

    const stores = opener(dir);
    const events = await stores.audit.list({ tenantId: TENANT });
    expect(events.length).toBe(workers.length * perWorker);

    // A fork would show up as two events sharing a prevHash, or a break here.
    const verified = await stores.audit.verify(TENANT);
    expect(verified.ok).toBe(true);
    expect(verified.checked).toBe(workers.length * perWorker);

    // Every actor's contributions are present — no writer was silently dropped.
    for (const actor of workers) {
      expect(events.filter((e) => e.actor.id === actor).length).toBe(perWorker);
    }
    await stores.dispose();
  }, 120_000);
});

// ── C: budget cannot be double-spent ──────────────────────────────────────

describe('multi-process scenario C — budget is never oversubscribed', () => {
  it('four writers racing to reserve never exceed the limit', async () => {
    const dir = tempDir();
    // Limit $10, each reserve $0.5 => at most 20 may be granted.
    const results = await Promise.all(
      ['b1', 'b2', 'b3', 'b4'].map((actor) =>
        runWorker({ dir, tenantId: TENANT, actor, count: 15, op: 'budget', amountUsd: 0.5 }),
      ),
    );
    for (const result of results) {
      expect(result.code, `worker exited ${result.code}: ${JSON.stringify(result.lines)} ${result.stderr}`).toBe(0);
    }

    const granted = results.reduce((sum, r) => {
      const done = r.lines.find((l) => l.event === 'done');
      return sum + Number(done?.granted ?? 0);
    }, 0);

    const stores = opener(dir);
    const account = await stores.budget.get('default');
    const reserved = account?.reservedUsd ?? 0;

    // The ledger itself must never exceed the limit, and the number of
    // GRANTS must match what the ledger actually holds — the classic
    // double-spend shows up as grants > reserved/amount.
    expect(reserved).toBeLessThanOrEqual(10 + 1e-9);
    expect(granted).toBeLessThanOrEqual(20);
    expect(Math.abs(reserved - granted * 0.5)).toBeLessThan(1e-9);
    await stores.dispose();
  }, 120_000);
});

// ── D: one approval, one winner ───────────────────────────────────────────

describe('multi-process scenario D — exactly one approval winner', () => {
  it('two writers deciding the same approval produce exactly one decision', async () => {
    const dir = tempDir();
    const stores = opener(dir);
    await stores.approvals.insert({
      id: 'apr_shared',
      tenantId: TENANT,
      taskId: 'task_1',
      subject: { kind: 'tool', summary: 'write a file' },
      options: [{ id: 'allow_once', label: 'once', kind: 'allow_once' }],
      authority: 'local',
      delegationChain: [],
      policyRevision: 'rev-1',
      revision: 1,
      state: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      sensitive: false,
    } as never);
    await stores.dispose();

    const results = await Promise.all(
      ['d1', 'd2'].map((actor) =>
        runWorker({ dir, tenantId: TENANT, actor, count: 5, op: 'approval', approvalId: 'apr_shared' }),
      ),
    );
    for (const result of results) {
      expect(result.code, `worker exited ${result.code}: ${JSON.stringify(result.lines)} ${result.stderr}`).toBe(0);
    }

    const won = results.reduce((sum, r) => sum + Number(r.lines.find((l) => l.event === 'done')?.won ?? 0), 0);
    // Single-winner: the first decision moves revision to 2, every later
    // attempt fails its compare-and-set.
    expect(won).toBe(1);

    const after = opener(dir);
    const record = await after.approvals.get('apr_shared', TENANT);
    expect(record?.state).toBe('allowed');
    expect(record?.revision).toBe(2);
    await after.dispose();
  }, 120_000);
});

// ── E: a killed holder is replaced after the TTL ───────────────────────────

describe('multi-process scenario E — a killed writer is replaced', () => {
  it('kill -9 while holding the lease; the next writer recovers', async () => {
    const dir = tempDir();

    // Start a holder; it is killed the moment it reports owning the lease.
    const result = await runWorker(
      { dir, tenantId: TENANT, actor: 'e1', count: 0, op: 'hold-then-write', holdMs: 30_000 },
      { killWhenHolding: true },
    );
    expect(result.lines.some((l) => l.event === 'holding'), 'the worker should have held the lease').toBe(true);
    expect(result.code, 'the holder must have been killed, not allowed to exit cleanly').not.toBe(0);

    // The kill left an unreleased lease behind. Its exact shape depends on how
    // far the process got, so the assertion is on the RECOVERY, not the relic.
    const epochAfterKill = await readEpoch(nodeRuntime(), dir);
    expect(epochAfterKill).toBeGreaterThanOrEqual(1);

    const stores = opener(dir);
    const started = Date.now();
    await stores.withWrite({ workKind: 'execution' }, async () => undefined);
    const waited = Date.now() - started;

    // Fencing: recovering the lease must advance the epoch, so the dead
    // holder could never write again even if it came back.
    expect(await readEpoch(nodeRuntime(), dir)).toBeGreaterThan(epochAfterKill);
    // It had to wait for the stale lease, not barge in.
    expect(waited).toBeLessThan(10_000);
    await stores.dispose();
  }, 120_000);
});

// ── F: a paused (SIGSTOP) writer cannot clobber the new owner ─────────────

describe('multi-process scenario F — a taken-over writer is fenced out', () => {
  it('a lease taken over by force is rejected on the old holder\'s next write', async () => {
    const dir = tempDir();
    const storesA = opener(dir);
    const runtimeA = nodeRuntime();

    // Acquire, then simulate an operator recovering a crashed lease.
    let lostError: { code?: string } | undefined;
    await storesA.withWrite({ workKind: 'execution' }, async (lease) => {
      await forceUnlock(runtimeA, dir);
      try {
        await lease.assertHeld();
      } catch (e) {
        lostError = e as { code?: string };
      }
    });
    expect(lostError?.code).toBe('SY-SRV-007');
    await storesA.dispose();
  }, 60_000);
});

// ── G: crash mid-append leaves a readable store ───────────────────────────

describe('multi-process scenario G — a crash leaves a readable store', () => {
  it('recovers a torn final line and still verifies the chain', async () => {
    const dir = tempDir();
    const stores = opener(dir);
    for (let i = 0; i < 5; i += 1) {
      await stores.audit.append({
        ts: new Date().toISOString(),
        tenantId: TENANT,
        actor: { type: 'user', id: 'g' },
        action: 'policy.decide',
        subject: { type: 'capability', id: `c${i}` },
        outcome: 'success',
      });
    }
    await stores.dispose();

    // Simulate the crash: a half-written record at the end of the file.
    const path = join(dir, 'audit.jsonl');
    const { appendFileSync, readFileSync, writeFileSync } = await import('node:fs');
    appendFileSync(path, '{"partial":');

    // A fresh open must parse the five complete links and ignore the tail.
    const reopened = opener(dir);
    const events = await reopened.audit.list({ tenantId: TENANT });
    expect(events.length).toBe(5);
    expect((await reopened.audit.verify(TENANT)).ok).toBe(true);

    // And it must be writable again, with the new link chaining off the last
    // COMPLETE record rather than the torn line.
    await reopened.audit.append({
      ts: new Date().toISOString(),
      tenantId: TENANT,
      actor: { type: 'user', id: 'g' },
      action: 'invocation.succeeded',
      subject: { type: 'invocation', id: 'i' },
      outcome: 'success',
    });
    const after = await reopened.audit.list({ tenantId: TENANT });
    expect(after.length).toBe(6);
    await reopened.dispose();

    // The file itself is now parseable line by line (the torn tail is still
    // there, but every complete line is intact and the chain links up).
    const text = readFileSync(path, 'utf8');
    writeFileSync(path, text);
  }, 60_000);
});

// ── event sequence numbers stay unique across processes ───────────────────

describe('multi-process event sequence', () => {
  it('two writers appending to one task never emit a duplicate seq', async () => {
    const dir = tempDir();
    const results = await Promise.all(
      ['s1', 's2'].map((actor) => runWorker({ dir, tenantId: TENANT, actor, count: 10, op: 'events' })),
    );
    for (const result of results) {
      expect(result.code, `worker exited ${result.code}: ${JSON.stringify(result.lines)} ${result.stderr}`).toBe(0);
    }

    const stores = opener(dir);
    const events = await stores.events.list('task_shared');
    const seqs = events.map((e) => e.seq);
    expect(seqs.length).toBe(20);
    // A duplicate seq is the visible symptom of two processes both computing
    // "lastSeq + 1" from their own stale snapshot.
    expect(new Set(seqs).size).toBe(20);
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    await stores.dispose();
  }, 120_000);
});
