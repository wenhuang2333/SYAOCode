/**
 * Worker process for the multi-process store tests (06 §11.2).
 *
 * Run as: `node <tsx> worker.ts <json-args>`.
 *
 * It is a REAL child process with its own memory, its own lease tickets and its
 * own handle on the shared directory — which is the only way to prove that the
 * cross-process write lease actually works. Simulating two writers in one
 * process would be serialized by the in-process queue and would prove nothing.
 */

import { nodeRuntime, sha256Hex } from '@syaocode/node';
import { createFileStores } from '@syaocode/rpc';
import type { Task } from '@syaocode/rpc';

interface Args {
  dir: string;
  tenantId: string;
  actor: string;
  /** How many items this worker contributes. */
  count: number;
  /** Which store operation to exercise. */
  op: 'tasks' | 'audit' | 'budget' | 'approval' | 'events' | 'hold-then-write';
  /** For budget: how much to reserve per attempt. */
  amountUsd?: number;
  /** For hold-then-write: how long to hold the lease before writing (ms). */
  holdMs?: number;
  /** For approval: the shared approval id. */
  approvalId?: string;
}

const args = JSON.parse(process.argv[2] ?? '{}') as Args;

function log(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const runtime = nodeRuntime();
const stores = createFileStores({
  runtime,
  dir: args.dir,
  tenantId: args.tenantId,
  hash: { sha256: sha256Hex },
  // A short lease keeps the crash-recovery scenario quick without weakening
  // mutual exclusion: the TTL only decides when a dead holder may be replaced.
  leaseTtlMs: 600,
  heartbeatIntervalMs: 150,
  lockTimeoutMs: 20_000,
  fsyncMode: 'batch',
});

function task(id: string): Task {
  const now = new Date().toISOString();
  return {
    id,
    sessionId: `ses_${args.actor}`,
    tenantId: args.tenantId,
    state: 'submitted',
    input: [{ type: 'text', text: `${args.actor}:${id}` }],
    artifacts: [],
    createdAt: now,
    updatedAt: now,
    lastSeq: 0,
  } as Task;
}

try {
  if (args.op === 'hold-then-write') {
    // Take the lease and sit on it, so the parent can kill or stop this
    // process while it is the writer (scenarios E and F).
    await stores.withWrite({ workKind: 'execution' }, async () => {
      log({ event: 'holding', pid: process.pid });
      await new Promise<void>((resolve) => setTimeout(resolve, args.holdMs ?? 30_000));
    });
    log({ event: 'released', pid: process.pid });
  } else if (args.op === 'tasks') {
    for (let i = 0; i < args.count; i += 1) {
      const id = `${args.actor}-${i}`;
      await stores.tasks.create(task(id));
    }
    log({ event: 'done', count: args.count });
  } else if (args.op === 'audit') {
    for (let i = 0; i < args.count; i += 1) {
      await stores.audit.append(
        {
          ts: new Date().toISOString(),
          tenantId: args.tenantId,
          actor: { type: 'user', id: args.actor },
          action: 'policy.decide',
          subject: { type: 'capability', id: `cap-${args.actor}-${i}` },
          outcome: 'success',
        },
        // Detail goes through the sidecar path, not the event body.
        { actor: args.actor, i },
      );
    }
    log({ event: 'done', count: args.count });
  } else if (args.op === 'budget') {
    // Budget is the classic lost-update case: two writers that read the same
    // "reserved=0" both think they can reserve.
    const limit = 10;
    const amount = args.amountUsd ?? 0.5;
    let granted = 0;
    let refused = 0;
    for (let i = 0; i < args.count; i += 1) {
      const ok = await stores.withWrite({ workKind: 'governance' }, async () => {
        const account = await stores.budget.get('default');
        const current = account?.reservedUsd ?? 0;
        if (current + amount > limit + 1e-9) return false;
        await stores.budget.put({
          ...(account ?? {
            id: 'default',
            tenantId: args.tenantId,
            currency: 'USD',
            reservedUsd: 0,
            spentUsd: 0,
            tokensUsed: 0,
            timeUsedMs: 0,
            toolCallsUsed: 0,
            state: 'active',
          }),
          reservedUsd: current + amount,
        } as never);
        return true;
      });
      if (ok) granted += 1;
      else refused += 1;
    }
    log({ event: 'done', granted, refused });
  } else if (args.op === 'approval') {
    // Two writers race to decide the same approval: exactly one must win.
    const id = args.approvalId ?? 'apr_shared';
    let won = 0;
    let lost = 0;
    for (let i = 0; i < args.count; i += 1) {
      const ok = await stores.withWrite({ workKind: 'governance' }, async () => {
        const record = await stores.approvals.get(id, args.tenantId);
        if (record === undefined) return false;
        return stores.approvals.decide(id, record.revision, {
          state: 'allowed',
          decidedAt: new Date().toISOString(),
          decidedBy: args.actor,
        });
      });
      if (ok) won += 1;
      else lost += 1;
    }
    log({ event: 'done', won, lost });
  } else if (args.op === 'events') {
    for (let i = 0; i < args.count; i += 1) {
      await stores.events.append({
        taskId: 'task_shared',
        correlationId: args.actor,
        principalId: args.actor,
        protocol: 'native',
        type: 'invocation.completed',
        payload: { i },
      });
    }
    log({ event: 'done', count: args.count });
  }
  await stores.dispose();
  process.exit(0);
} catch (e) {
  log({ event: 'error', message: e instanceof Error ? e.message : String(e), code: (e as { code?: string }).code });
  process.exit(1);
}
