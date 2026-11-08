/**
 * File-backed governance stores with cross-process write safety (06 §3–§6).
 *
 * The kernel keeps ownership of its contracts; a host owns *durability*. These
 * stores write the same records the in-memory stores hold, under one tenant
 * directory, and restore them on the next start.
 *
 * Design rules, each of which exists because its absence corrupts data:
 *
 *   - **One writer per tenant directory.** Every mutation runs inside
 *     `acquireWriteLease` (see `lock.ts`). Without it, two CLI processes
 *     "read everything → change → rewrite everything" over each other: lost
 *     tasks, double-spent budget, a forked audit chain.
 *   - **Re-read after acquiring.** A cached snapshot plus another writer is a
 *     guaranteed stale overwrite. Every write reloads the file it is about to
 *     modify, inside the lease, and only then applies the change (W2).
 *   - **Atomic replace.** Rewrite-type files go tmp → fsync → rename → fsync
 *     the directory, so a reader sees the complete old file or the complete
 *     new one, never a half-written one (W3).
 *   - **Append-only files tolerate a torn tail.** A crash mid-append can leave
 *     one incomplete last line; that line is ignored on read and never
 *     silently "repaired" (W4).
 *   - **Everything goes through `Runtime.fs`**, so a host can substitute a
 *     memory filesystem without touching the kernel.
 *
 * Layout:
 *   <dir>/.write/...         lease, epoch, queue, metrics (see lock.ts)
 *   <dir>/tasks.jsonl        task records
 *   <dir>/sessions.jsonl     session records
 *   <dir>/approvals.jsonl    approval records
 *   <dir>/budget.json        budget accounts + reservations
 *   <dir>/idempotency.jsonl  idempotency records
 *   <dir>/receipts.jsonl     receipts, in chain order
 *   <dir>/audit.jsonl        audit events, per tenant in order
 *   <dir>/audit-details/     detailHash sidecars
 *   <dir>/events.jsonl       canonical events
 */

import { LIWENError } from '@liwencode/core';
import type { Runtime } from '@liwencode/core';
import type {
  ApprovalRecord,
  AuditDetailSidecar,
  AuditEvent,
  BudgetAccount,
  BudgetReservation,
  CanonicalEvent,
  IdempotencyRecord,
  Receipt,
  Session,
  Task,
} from '../ir/types.js';
import type {
  ApprovalStore,
  AuditDetailStore,
  AuditStore,
  BudgetStore,
  EventLog,
  IdempotencyStore,
  MemoryStoresOptions,
  ReceiptStore,
  SecretRedactor,
  SessionStore,
  TaskStore,
} from '../governance/contracts.js';
import {
  MemoryApprovalStore,
  MemoryBudgetStore,
  MemoryTaskStore,
  MemorySessionStore,
  createMemoryStores,
} from './stores.js';
import { MemoryEventLog } from './eventlog.js';
import { MemoryReceiptStore } from '../governance/receipts.js';
import { MemoryAuditStore } from '../governance/audit.js';
import { MemoryIdempotencyStore } from '../governance/idempotency.js';
import {
  acquireWriteLease,
  readEpoch,
  readLeaseOwner,
  readLeaseQueue,
  type WriteIntent,
  type WriteLease,
} from './lock.js';

/** Single record ceiling; a larger line could never be read back reliably (06 §6.3). */
export const DEFAULT_MAX_RECORD_BYTES = 1_048_576;

export type FsyncMode = 'always' | 'batch' | 'never';

export interface FileStoreOptions {
  runtime: Runtime;
  /** Directory holding the JSONL files; created if missing. */
  dir: string;
  /** The tenant this directory belongs to. Defaults to `default`. */
  tenantId?: string;
  /** Lease wait budget (W8). */
  lockTimeoutMs?: number;
  /** How long a holder may go without a heartbeat before takeover. */
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  agingMs?: number;
  /** `batch` (default) flushes on release; `always` after every record. */
  fsyncMode?: FsyncMode;
  /** Audit checkpoint cadence (by append count). */
  checkpointEvery?: number;
  /** Audit checkpoint cadence (by wall-clock time). */
  checkpointIntervalMs?: number;
  /** Redactor applied to audit details before hashing (06 §8.2). */
  redactor?: SecretRedactor;
  maxRecordBytes?: number;
  /** Hash provider; a host must inject a real one (SHA-256). */
  hash?: { sha256(text: string): string };
  /** Id generator for audit/event ids. */
  ids?: { next(prefix: string): string };
  /** Wall-clock source for stored timestamps; defaults to the runtime clock. */
  now?: () => string;
}

/** Historical name for {@link FileStoreOptions} (kept for host compatibility). */
export type FileStoresOptions = FileStoreOptions;

export interface LeaseStatus {
  holder:
    | { leaseId: string; pid: number | undefined; epoch: number; heartbeatAt: string; ttlMs: number; ageMs: number }
    | undefined;
  epoch: number;
  queue: { ticketId: string; seq: number; priority: number; workKind: string; enqueuedAt: string }[];
}

export interface FileStoreBundle {
  tasks: TaskStore;
  sessions: SessionStore;
  approvals: ApprovalStore;
  budget: BudgetStore;
  idempotency: IdempotencyStore;
  receipts: ReceiptStore;
  audit: AuditStore;
  events: EventLog;
  /**
   * Run a group of writes under ONE lease.
   *
   * This is the only way to make a multi-file write group coherent: budget,
   * receipt, audit, event and task state all land while nobody else can
   * write. Calling a store method directly still takes a lease of its own, so
   * an isolated write is safe too — it just is not grouped.
   */
  withWrite<T>(intent: WriteIntent, fn: (lease: WriteLease) => Promise<T>): Promise<T>;
  /** Who is writing, what is queued, and how far the epoch has advanced. */
  leaseStatus(): Promise<LeaseStatus>;
  /** Flush pending writes; call before the runtime goes away. */
  dispose(): Promise<void>;
}

// ── primitives ────────────────────────────────────────────────────────────

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '.' : path.slice(0, idx);
}

/** A stable signature for "has this file changed since I last read it?". */
async function statSig(runtime: Runtime, path: string): Promise<string> {
  try {
    const st = await runtime.fs.stat(path);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '∅';
  }
}

/**
 * Read a JSONL file, tolerating exactly one kind of damage: an incomplete
 * final line left by a crash mid-append (W4).
 *
 * Damage anywhere else is a hard failure: silently dropping a middle record
 * would make a chain look shorter than it is, which is worse than refusing.
 */
async function readRecords<T>(
  runtime: Runtime,
  path: string,
  label: string,
  maxRecordBytes: number,
): Promise<T[]> {
  if (!(await runtime.fs.exists(path))) return [];
  const text = await runtime.fs.readFile(path);
  if (text === '') return [];
  const lines = text.split('\n');
  const out: T[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    if (line.length > maxRecordBytes) {
      throw new LIWENError({
        code: 'SY-SRV-006',
        message: `${label} record at line ${i + 1} exceeds ${maxRecordBytes} bytes`,
      });
    }
    try {
      out.push(JSON.parse(line) as T);
    } catch (e) {
      const isLast = i === lines.length - 1 || (i === lines.length - 2 && lines[lines.length - 1] === '');
      if (isLast) {
        // Torn tail from a crash: ignore it. The next append starts a fresh
        // line, so nothing is lost beyond the record that never completed.
        break;
      }
      throw new LIWENError({
        code: 'SY-SRV-006',
        message: `${label} file is corrupt at line ${i + 1}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return out;
}

interface Ctx {
  runtime: Runtime;
  dir: string;
  tenantId: string;
  fsyncMode: FsyncMode;
  maxRecordBytes: number;
  dirty: Set<string>;
  /** Recovery must finish before any read or write observes the directory. */
  ready: Promise<void>;
  flush(): Promise<void>;
  withWrite<T>(intent: WriteIntent, fn: (lease: WriteLease) => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}

/** Replace a file atomically so a reader never sees a partial write (W3). */
async function writeRecordsAtomic(ctx: Ctx, path: string, rows: readonly unknown[], lease: WriteLease): Promise<void> {
  await lease.assertHeld();
  await ctx.runtime.fs.mkdir(dirOf(path), { recursive: true });
  const text = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
  const tmp = `${path}.tmp.${process.pid}.${lease.epoch}`;
  await ctx.runtime.fs.writeFile(tmp, text);
  if (ctx.fsyncMode !== 'never') await ctx.runtime.fs.fsyncFile?.(tmp);
  await ctx.runtime.fs.rename(tmp, path);
  if (ctx.fsyncMode === 'always') await ctx.runtime.fs.fsyncDir?.(dirOf(path));
  else ctx.dirty.add(path);
}

/** Append one complete line, refusing anything that could not be read back. */
async function appendRecord(ctx: Ctx, path: string, value: unknown, lease: WriteLease): Promise<void> {
  await lease.assertHeld();
  const line = `${JSON.stringify(value)}\n`;
  if (line.length > ctx.maxRecordBytes) {
    throw new LIWENError({
      code: 'SY-SRV-006',
      message: `${path}: record of ${line.length} bytes exceeds ${ctx.maxRecordBytes}`,
    });
  }
  await ctx.runtime.fs.mkdir(dirOf(path), { recursive: true });
  await ctx.runtime.fs.appendFile(path, line);
  if (ctx.fsyncMode === 'always') await ctx.runtime.fs.fsyncFile?.(path);
  else ctx.dirty.add(path);
}

/**
 * Track a file's signature so a read can skip the parse when nothing changed.
 *
 * Reads never take the lease (W10): they may observe the previous instant's
 * snapshot, which is fine, but they must not block writers.
 */
function makeRefresher<T>(
  ctx: Ctx,
  path: string,
  label: string,
  memory: { reset(): void; hydrate(rows: readonly T[]): void },
): { refresh(): Promise<void> } {
  let sig: string | undefined;
  return {
    async refresh(): Promise<void> {
      await ctx.ready;
      const next = await statSig(ctx.runtime, path);
      if (next === sig) return;
      const rows = await readRecords<T>(ctx.runtime, path, label, ctx.maxRecordBytes);
      memory.reset();
      memory.hydrate(rows);
      sig = next;
    },
  };
}

// ── file-backed audit detail sidecars (06 §8.2) ───────────────────────────

class FileAuditDetailStore implements AuditDetailStore {
  constructor(private readonly ctx: Ctx) {}

  private pathFor(hash: string): string {
    // Content-addressed, but the tenant is part of the path so one tenant can
    // never read another's payload (I8).
    const safe = hash.replace(/^sha256:/, '').replace(/[^a-f0-9]/gi, '');
    return `${this.ctx.dir}/audit-details/${this.ctx.tenantId}/${safe}.json`;
  }

  async put(sidecar: AuditDetailSidecar): Promise<void> {
    const path = this.pathFor(sidecar.hash);
    await this.ctx.runtime.fs.mkdir(dirOf(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    await this.ctx.runtime.fs.writeFile(tmp, `${JSON.stringify(sidecar)}\n`);
    await this.ctx.runtime.fs.rename(tmp, path);
  }

  async get(hash: string, tenantId?: string): Promise<AuditDetailSidecar | undefined> {
    if (tenantId !== undefined && tenantId !== this.ctx.tenantId) return undefined;
    try {
      return JSON.parse(await this.ctx.runtime.fs.readFile(this.pathFor(hash))) as AuditDetailSidecar;
    } catch {
      return undefined;
    }
  }

  async prune(hash: string, tenantId?: string): Promise<boolean> {
    if (tenantId !== undefined && tenantId !== this.ctx.tenantId) return false;
    try {
      await this.ctx.runtime.fs.unlink(this.pathFor(hash));
      return true;
    } catch {
      return false;
    }
  }
}

// ── the bundle ────────────────────────────────────────────────────────────

export function createFileStores(opts: FileStoreOptions): FileStoreBundle {
  const { runtime, dir } = opts;
  const tenantId = opts.tenantId ?? 'default';
  const fsyncMode = opts.fsyncMode ?? 'batch';
  const maxRecordBytes = opts.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  const hash = opts.hash ?? defaultHash;
  const ids = opts.ids ?? defaultIds;
  const now = opts.now ?? ((): string => new Date(runtime.clock.now()).toISOString());

  // One writer per process, too: the cross-process lease serializes processes,
  // and this chain serializes concurrent calls inside one. Without it two
  // callbacks could interleave on the same in-memory mirror.
  let chain: Promise<unknown> = Promise.resolve();
  /**
   * The lease of the write group currently running in this process.
   *
   * A store method called INSIDE `withWrite` (the normal case: a group that
   * touches budget + receipt + audit + task) must reuse the group's lease.
   * Acquiring a second lease would queue behind the group's own serialization
   * and deadlock — which is what the multi-process budget test caught.
   */
  let activeLease: WriteLease | undefined;
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ── recovery: heal what a crashed writer left behind (06 §3.9) ──────────
  //
  // Two leftovers matter:
  //   1. a `.tmp.*` file was never renamed, so it is not data — delete it;
  //   2. an append file can end in a half-written line. Ignoring it is not
  //      enough: the NEXT append would concatenate onto it and destroy that
  //      record too. The file is truncated to its last complete line.
  const appendPaths = [
    `${dir}/tasks.jsonl`,
    `${dir}/sessions.jsonl`,
    `${dir}/approvals.jsonl`,
    `${dir}/idempotency.jsonl`,
    `${dir}/receipts.jsonl`,
    `${dir}/audit.jsonl`,
    `${dir}/events.jsonl`,
  ];
  const ready = (async (): Promise<void> => {
    try {
      const entries = await runtime.fs.readdir(dir);
      for (const entry of entries) {
        if (entry.isFile && entry.name.includes('.tmp.')) {
          await runtime.fs.unlink(`${dir}/${entry.name}`).catch(() => undefined);
        }
      }
      for (const path of appendPaths) {
        if (!(await runtime.fs.exists(path))) continue;
        const text = await runtime.fs.readFile(path);
        if (text === '' || text.endsWith('\n')) continue;
        const cut = text.lastIndexOf('\n');
        const keep = cut < 0 ? '' : text.slice(0, cut + 1);
        const tmp = `${path}.tmp.${process.pid}.repair`;
        await runtime.fs.writeFile(tmp, keep);
        await runtime.fs.rename(tmp, path);
      }
    } catch {
      // A missing directory is not an error: it is created on first write.
    }
  })();

  const dirty = new Set<string>();
  const ctx: Ctx = {
    runtime,
    dir,
    tenantId,
    fsyncMode,
    maxRecordBytes,
    dirty,
    ready,
    async flush(): Promise<void> {
      if (dirty.size === 0) return;
      const paths = [...dirty];
      dirty.clear();
      for (const path of paths) {
        await runtime.fs.fsyncFile?.(path).catch(() => undefined);
        await runtime.fs.fsyncDir?.(dirOf(path)).catch(() => undefined);
      }
    },
    async withWrite<T>(intent: WriteIntent, fn: (lease: WriteLease) => Promise<T>): Promise<T> {
      // Re-entrant: join the group that is already running.
      if (activeLease !== undefined) return fn(activeLease);
      return serialize(async () => {
        await ctx.ready;
        const lease = await acquireWriteLease({
          runtime,
          dir,
          tenantId,
          intent,
          ...(opts.lockTimeoutMs !== undefined ? { lockTimeoutMs: opts.lockTimeoutMs } : {}),
          ...(opts.leaseTtlMs !== undefined ? { leaseTtlMs: opts.leaseTtlMs } : {}),
          ...(opts.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: opts.heartbeatIntervalMs } : {}),
          ...(opts.agingMs !== undefined ? { agingMs: opts.agingMs } : {}),
        });
        activeLease = lease;
        try {
          return await fn(lease);
        } finally {
          activeLease = undefined;
          // Flush before releasing: the next writer must see settled data.
          await ctx.flush().catch(() => undefined);
          await lease.release();
        }
      });
    },
    async dispose(): Promise<void> {
      await ctx.flush().catch(() => undefined);
    },
  };

  // ── tasks ───────────────────────────────────────────────────────────────
  const tasksPath = `${dir}/tasks.jsonl`;
  const taskMemory = new MemoryTaskStore();
  const tasksRefresh = makeRefresher<Task>(ctx, tasksPath, 'tasks', taskMemory);
  const tasks: TaskStore = {
    async create(task) {
      await ctx.withWrite({ workKind: 'governance' }, async (lease) => {
        await tasksRefresh.refresh();
        await taskMemory.create(task);
        await writeRecordsAtomic(ctx, tasksPath, taskMemory.dump(), lease);
      });
    },
    async get(taskId, tid) {
      await tasksRefresh.refresh();
      return taskMemory.get(taskId, tid);
    },
    async put(task) {
      await ctx.withWrite({ workKind: 'execution' }, async (lease) => {
        await tasksRefresh.refresh();
        await taskMemory.put(task);
        await writeRecordsAtomic(ctx, tasksPath, taskMemory.dump(), lease);
      });
    },
    async list(filter) {
      await tasksRefresh.refresh();
      return taskMemory.list(filter);
    },
    async listUnterminated(tid) {
      await tasksRefresh.refresh();
      return taskMemory.listUnterminated(tid);
    },
    async delete(taskId, tid) {
      await ctx.withWrite({ workKind: 'execution' }, async (lease) => {
        await tasksRefresh.refresh();
        await taskMemory.delete(taskId, tid);
        await writeRecordsAtomic(ctx, tasksPath, taskMemory.dump(), lease);
      });
    },
  };

  // ── sessions ────────────────────────────────────────────────────────────
  const sessionsPath = `${dir}/sessions.jsonl`;
  const sessionMemory = new MemorySessionStore();
  const sessionsRefresh = makeRefresher<Session>(ctx, sessionsPath, 'sessions', sessionMemory);
  const sessions: SessionStore = {
    async create(session) {
      await ctx.withWrite({ workKind: 'execution' }, async (lease) => {
        await sessionsRefresh.refresh();
        await sessionMemory.create(session);
        await writeRecordsAtomic(ctx, sessionsPath, sessionMemory.dump(), lease);
      });
    },
    async get(id, tid) {
      await sessionsRefresh.refresh();
      return sessionMemory.get(id, tid);
    },
    async put(session) {
      await ctx.withWrite({ workKind: 'execution' }, async (lease) => {
        await sessionsRefresh.refresh();
        await sessionMemory.put(session);
        await writeRecordsAtomic(ctx, sessionsPath, sessionMemory.dump(), lease);
      });
    },
    async list(tid) {
      await sessionsRefresh.refresh();
      return sessionMemory.list(tid);
    },
  };

  // ── approvals ───────────────────────────────────────────────────────────
  const approvalsPath = `${dir}/approvals.jsonl`;
  const approvalMemory = new MemoryApprovalStore();
  const approvalsRefresh = makeRefresher<ApprovalRecord>(ctx, approvalsPath, 'approvals', approvalMemory);
  const approvals: ApprovalStore = {
    async insert(record) {
      await ctx.withWrite({ workKind: 'governance' }, async (lease) => {
        await approvalsRefresh.refresh();
        await approvalMemory.insert(record);
        await writeRecordsAtomic(ctx, approvalsPath, approvalMemory.dump(), lease);
      });
    },
    async get(id, tid) {
      await approvalsRefresh.refresh();
      return approvalMemory.get(id, tid);
    },
    async list(filter) {
      await approvalsRefresh.refresh();
      return approvalMemory.list(filter);
    },
    async decide(id, expectedRevision, patch) {
      return ctx.withWrite({ workKind: 'governance' }, async (lease) => {
        await approvalsRefresh.refresh();
        const ok = await approvalMemory.decide(id, expectedRevision, patch);
        if (ok) await writeRecordsAtomic(ctx, approvalsPath, approvalMemory.dump(), lease);
        return ok;
      });
    },
    async expire(nowIso) {
      return ctx.withWrite({ workKind: 'governance' }, async (lease) => {
        await approvalsRefresh.refresh();
        const count = await approvalMemory.expire(nowIso);
        if (count > 0) await writeRecordsAtomic(ctx, approvalsPath, approvalMemory.dump(), lease);
        return count;
      });
    },
  };

  // ── budget ──────────────────────────────────────────────────────────────
  const budgetPath = `${dir}/budget.json`;
  const budgetMemory = new MemoryBudgetStore();
  let budgetSig: string | undefined;
  const budgetRefresh = async (): Promise<void> => {
    await ready;
    const next = await statSig(runtime, budgetPath);
    if (next === budgetSig) return;
    let parsed: { accounts?: BudgetAccount[]; reservations?: BudgetReservation[] } = {};
    if (await runtime.fs.exists(budgetPath)) {
      try {
        parsed = JSON.parse(await runtime.fs.readFile(budgetPath)) as typeof parsed;
      } catch (e) {
        throw new LIWENError({
          code: 'SY-SRV-006',
          message: `budget file is corrupt: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
    budgetMemory.reset();
    budgetMemory.hydrate(parsed);
    budgetSig = next;
  };
  const budgetCommit = async (lease: WriteLease): Promise<void> => {
    await lease.assertHeld();
    await runtime.fs.mkdir(dir, { recursive: true });
    const tmp = `${budgetPath}.tmp.${process.pid}.${lease.epoch}`;
    await runtime.fs.writeFile(tmp, `${JSON.stringify(budgetMemory.dump(), null, 2)}\n`);
    if (fsyncMode !== 'never') await runtime.fs.fsyncFile?.(tmp);
    await runtime.fs.rename(tmp, budgetPath);
    if (fsyncMode === 'always') await runtime.fs.fsyncDir?.(dir);
    else dirty.add(budgetPath);
    budgetSig = await statSig(runtime, budgetPath);
  };
  const budget: BudgetStore = {
    async get(id) {
      await budgetRefresh();
      return budgetMemory.get(id);
    },
    async put(account) {
      await ctx.withWrite({ workKind: 'governance' }, async (lease) => {
        await budgetRefresh();
        await budgetMemory.put(account);
        await budgetCommit(lease);
      });
    },
    async list(tid) {
      await budgetRefresh();
      return budgetMemory.list(tid);
    },
    async getReservation(id) {
      await budgetRefresh();
      return budgetMemory.getReservation(id);
    },
    async putReservation(reservation) {
      await ctx.withWrite({ workKind: 'governance' }, async (lease) => {
        await budgetRefresh();
        await budgetMemory.putReservation(reservation);
        await budgetCommit(lease);
      });
    },
    async listReservations(filter) {
      await budgetRefresh();
      return budgetMemory.listReservations(filter);
    },
  };

  // ── idempotency ─────────────────────────────────────────────────────────
  const idemPath = `${dir}/idempotency.jsonl`;
  const idemMemory = new MemoryIdempotencyStore({
    ids: { next: (p: string) => `${p}_file` },
    now,
  });
  const idemRefresh = makeRefresher<IdempotencyRecord>(ctx, idemPath, 'idempotency', idemMemory);
  const idemCommit = async (lease: WriteLease): Promise<void> => {
    await writeRecordsAtomic(ctx, idemPath, idemMemory.dump(), lease);
  };
  const idempotency: IdempotencyStore = {
    async begin(key, requestHash, ttlMs) {
      return ctx.withWrite({ workKind: 'governance' }, async (lease) => {
        await idemRefresh.refresh();
        const outcome = await idemMemory.begin(key, requestHash, ttlMs);
        await idemCommit(lease);
        return outcome;
      });
    },
    async get(key) {
      await idemRefresh.refresh();
      return idemMemory.get(key);
    },
    async complete(key, result, resultRef) {
      await ctx.withWrite({ workKind: 'governance' }, async (lease) => {
        await idemRefresh.refresh();
        await idemMemory.complete(key, result, resultRef);
        await idemCommit(lease);
      });
    },
    async fail(key, error, meta) {
      await ctx.withWrite({ workKind: 'governance' }, async (lease) => {
        await idemRefresh.refresh();
        await idemMemory.fail(key, error, meta);
        await idemCommit(lease);
      });
    },
  };

  // ── receipts ────────────────────────────────────────────────────────────
  const receiptsPath = `${dir}/receipts.jsonl`;
  const receiptMemory = new MemoryReceiptStore({ hash });
  const receiptsRefresh = makeRefresher<Receipt>(ctx, receiptsPath, 'receipts', receiptMemory);
  const receipts: ReceiptStore = {
    async put(receipt) {
      return ctx.withWrite({ workKind: 'evidence', reason: 'receipt.seal' }, async (lease) => {
        await receiptsRefresh.refresh();
        const sealed = await receiptMemory.put(receipt);
        await appendRecord(ctx, receiptsPath, sealed, lease);
        return sealed;
      });
    },
    async get(id, tid) {
      await receiptsRefresh.refresh();
      return receiptMemory.get(id, tid);
    },
    async listByTask(taskId, tid) {
      await receiptsRefresh.refresh();
      return receiptMemory.listByTask(taskId, tid);
    },
    async head(taskId, tid) {
      await receiptsRefresh.refresh();
      return receiptMemory.head(taskId, tid);
    },
  };

  // ── audit ───────────────────────────────────────────────────────────────
  const auditPath = `${dir}/audit.jsonl`;
  const auditMemory = new MemoryAuditStore({
    hash,
    ids,
    now: () => new Date(runtime.clock.now()).toISOString(),
    detailStore: new FileAuditDetailStore(ctx),
    ...(opts.checkpointEvery !== undefined ? { checkpointEvery: opts.checkpointEvery } : {}),
    ...(opts.checkpointIntervalMs !== undefined ? { checkpointIntervalMs: opts.checkpointIntervalMs } : {}),
  });
  if (opts.redactor !== undefined) auditMemory.setRedactor(opts.redactor);
  const auditRefresh = makeRefresher<AuditEvent>(ctx, auditPath, 'audit', auditMemory);
  const audit: AuditStore = {
    async append(event, detail, detailOptions) {
      return ctx.withWrite(
        { workKind: 'evidence', reason: event.action === 'policy.decide' ? 'policy.decide' : 'audit.append' },
        async (lease) => {
          await auditRefresh.refresh();
          const stamped = await auditMemory.append(event, detail, detailOptions);
          await appendRecord(ctx, auditPath, stamped, lease);
          return stamped;
        },
      );
    },
    async list(filter) {
      await auditRefresh.refresh();
      return auditMemory.list(filter);
    },
    async verify(tid, verifyOpts) {
      await auditRefresh.refresh();
      return auditMemory.verify(tid, verifyOpts);
    },
    async checkpoint(tid) {
      return ctx.withWrite({ workKind: 'maintenance' }, async () => {
        await auditRefresh.refresh();
        return auditMemory.checkpoint(tid);
      });
    },
  };

  // ── events ──────────────────────────────────────────────────────────────
  const eventsPath = `${dir}/events.jsonl`;
  const eventMemory = new MemoryEventLog({ ids, now });
  const eventsRefresh = makeRefresher<CanonicalEvent>(ctx, eventsPath, 'events', eventMemory);
  const events: EventLog = {
    async append(event) {
      return ctx.withWrite({ workKind: 'execution' }, async (lease) => {
        await eventsRefresh.refresh();
        const stamped = await eventMemory.append(event);
        await appendRecord(ctx, eventsPath, stamped, lease);
        return stamped;
      });
    },
    async list(taskId, afterSeq = 0) {
      await eventsRefresh.refresh();
      return eventMemory.list(taskId, afterSeq);
    },
    async snapshot(taskId) {
      await eventsRefresh.refresh();
      return eventMemory.snapshot(taskId);
    },
  };

  return {
    tasks,
    sessions,
    approvals,
    budget,
    idempotency,
    receipts,
    audit,
    events,
    withWrite: ctx.withWrite,
    async leaseStatus(): Promise<LeaseStatus> {
      await ready;
      const owner = await readLeaseOwner(runtime, dir);
      const epoch = await readEpoch(runtime, dir);
      const queue = await readLeaseQueue(runtime, dir);
      return {
        holder:
          owner === undefined
            ? undefined
            : {
                leaseId: owner.leaseId,
                pid: owner.pid,
                epoch: owner.epoch,
                heartbeatAt: owner.heartbeatAt,
                ttlMs: owner.ttlMs,
                ageMs: runtime.clock.now() - Date.parse(owner.heartbeatAt),
              },
        epoch,
        queue: queue.map((t) => ({
          ticketId: t.ticketId,
          seq: t.seq,
          priority: t.priority,
          workKind: t.workKind,
          enqueuedAt: t.enqueuedAt,
        })),
      };
    },
    dispose: ctx.dispose,
  };
}

// ── compatibility wrappers ────────────────────────────────────────────────
//
// These existed before the bundle did. They stay so a host can take a single
// store; each one builds a bundle and hands back its slice. The lease is
// shared inside the bundle, so the slices still serialize against each other.

function slice<T>(opts: FileStoreOptions, pick: (bundle: FileStoreBundle) => T): T {
  return pick(createFileStores(opts));
}

export function createFileTaskStore(runtime: Runtime, dir: string, extra: Partial<FileStoreOptions> = {}): TaskStore {
  return slice({ runtime, dir, ...extra }, (b) => b.tasks);
}

export function createFileSessionStore(runtime: Runtime, dir: string, extra: Partial<FileStoreOptions> = {}): SessionStore {
  return slice({ runtime, dir, ...extra }, (b) => b.sessions);
}

export function createFileApprovalStore(runtime: Runtime, dir: string, extra: Partial<FileStoreOptions> = {}): ApprovalStore {
  return slice({ runtime, dir, ...extra }, (b) => b.approvals);
}

export function createFileBudgetStore(runtime: Runtime, dir: string, extra: Partial<FileStoreOptions> = {}): BudgetStore {
  return slice({ runtime, dir, ...extra }, (b) => b.budget);
}

export function createFileIdempotencyStore(runtime: Runtime, dir: string, extra: Partial<FileStoreOptions> = {}): IdempotencyStore {
  return slice({ runtime, dir, ...extra }, (b) => b.idempotency);
}

export function createFileReceiptStore(runtime: Runtime, dir: string, extra: Partial<FileStoreOptions> = {}): ReceiptStore {
  return slice({ runtime, dir, ...extra }, (b) => b.receipts);
}

export function createFileAuditStore(runtime: Runtime, dir: string, extra: Partial<FileStoreOptions> = {}): AuditStore {
  return slice({ runtime, dir, ...extra }, (b) => b.audit);
}

export function createFileEventLog(runtime: Runtime, dir: string, extra: Partial<FileStoreOptions> = {}): EventLog {
  return slice({ runtime, dir, ...extra }, (b) => b.events);
}

// Defaults kept local so this module has no hidden dependency on a host.
const defaultHash = {
  sha256(text: string): string {
    // FNV-1a is NOT a cryptographic hash; it exists only so the module can be
    // constructed without a host. A real host always injects `hash`.
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0').repeat(8).slice(0, 64);
  },
};

let defaultIdSeq = 0;
const defaultIds = {
  next(prefix: string): string {
    defaultIdSeq += 1;
    return `${prefix}_${process.pid.toString(36)}_${defaultIdSeq.toString(36)}`;
  },
};

/** The bundle plus the derived (non-persisted) stores. */
export function createFileStoreBundle(
  opts: FileStoreOptions & MemoryStoresOptions,
): FileStoreBundle & ReturnType<typeof createMemoryStores> {
  const memory = createMemoryStores(opts);
  const files = createFileStores(opts);
  return { ...memory, ...files };
}
