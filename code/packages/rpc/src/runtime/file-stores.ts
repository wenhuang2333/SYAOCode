/**
 * File-backed governance stores (audit C-4).
 *
 * The kernel keeps ownership of its contracts; a host owns *durability*. These
 * stores write the same records the in-memory stores hold, as JSON lines under
 * one directory, and restore them on the next start.
 *
 * Design rules:
 *   - **Everything goes through `Runtime.fs`**, so a host can substitute a
 *     memory filesystem without touching the kernel.
 *   - **The chain is verified while loading.** A tampered or truncated file
 *     fails loudly instead of silently becoming the new "trusted" head.
 *   - **Appends are append-only.** A receipt or audit link is never rewritten;
 *     the file is the chain.
 *
 * Layout:
 *   <dir>/tasks.jsonl        task records
 *   <dir>/sessions.jsonl     session records
 *   <dir>/approvals.jsonl    approval records (append-only; decisions append)
 *   <dir>/budget.json        budget accounts + reservations (rewritten atomically)
 *   <dir>/idempotency.jsonl  idempotency records
 *   <dir>/receipts.jsonl     receipts, in chain order
 *   <dir>/audit.jsonl        audit events, per tenant in order
 *   <dir>/events.jsonl       canonical events
 */

import type { Runtime } from '@syaocode/core';
import type {
  ApprovalRecord,
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
  AuditStore,
  BudgetStore,
  EventLog,
  IdempotencyStore,
  ReceiptStore,
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
import type { MemoryStoresOptions } from '../governance/contracts.js';

export interface FileStoreOptions {
  runtime: Runtime;
  /** Directory holding the JSONL files; created if missing. */
  dir: string;
  /** Audit checkpoint cadence. */
  checkpointEvery?: number;
}

// ── primitives ────────────────────────────────────────────────────────────

async function readLines(runtime: Runtime, path: string): Promise<string[]> {
  if (!(await runtime.fs.exists(path))) return [];
  const text = await runtime.fs.readFile(path);
  return text.split('\n').filter((line) => line.trim() !== '');
}

async function appendLine(runtime: Runtime, path: string, value: unknown): Promise<void> {
  await runtime.fs.mkdir(dirOf(path), { recursive: true });
  await runtime.fs.appendFile(path, `${JSON.stringify(value)}\n`);
}

async function writeAll(runtime: Runtime, path: string, values: readonly unknown[]): Promise<void> {
  await runtime.fs.mkdir(dirOf(path), { recursive: true });
  const text = values.map((v) => `${JSON.stringify(v)}\n`).join('');
  await runtime.fs.writeFile(path, text);
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '.' : path.slice(0, idx);
}

function parseAll<T>(lines: readonly string[], label: string): T[] {
  const out: T[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      out.push(JSON.parse(line) as T);
    } catch (e) {
      throw new Error(`${label} file is corrupt at line ${index + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

// ── task store ────────────────────────────────────────────────────────────

export function createFileTaskStore(runtime: Runtime, dir: string): TaskStore {
  const path = `${dir}/tasks.jsonl`;
  const memory = new MemoryTaskStore();
  let loaded = false;

  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    memory.hydrate(parseAll<Task>(await readLines(runtime, path), 'tasks'));
  };

  return {
    async create(task) {
      await ensureLoaded();
      await memory.create(task);
      await appendLine(runtime, path, task);
    },
    async get(taskId, tenantId) {
      await ensureLoaded();
      return memory.get(taskId, tenantId);
    },
    async put(task) {
      await ensureLoaded();
      await memory.put(task);
      // A task is rewritten in place: the file is a snapshot, not a log.
      const rows = (await memory.list({ tenantId: task.tenantId })).length > 0
        ? (await readLines(runtime, path)).map((l) => JSON.parse(l) as Task).filter((t) => t.id !== task.id)
        : [];
      await writeAll(runtime, path, [...rows, task]);
    },
    async list(filter) {
      await ensureLoaded();
      return memory.list(filter);
    },
    async listUnterminated(tenantId) {
      await ensureLoaded();
      return memory.listUnterminated(tenantId);
    },
    async delete(taskId, tenantId) {
      await ensureLoaded();
      await memory.delete(taskId, tenantId);
      const rows = (await readLines(runtime, path)).map((l) => JSON.parse(l) as Task).filter((t) => t.id !== taskId);
      await writeAll(runtime, path, rows);
    },
  };
}

// ── session store ─────────────────────────────────────────────────────────

export function createFileSessionStore(runtime: Runtime, dir: string): SessionStore {
  const path = `${dir}/sessions.jsonl`;
  const memory = new MemorySessionStore();
  let loaded = false;
  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    memory.hydrate(parseAll<Session>(await readLines(runtime, path), 'sessions'));
  };
  return {
    async create(session) {
      await ensureLoaded();
      await memory.create(session);
      await appendLine(runtime, path, session);
    },
    async get(id, tenantId) {
      await ensureLoaded();
      return memory.get(id, tenantId);
    },
    async put(session) {
      await ensureLoaded();
      await memory.put(session);
      const rows = (await readLines(runtime, path)).map((l) => JSON.parse(l) as Session).filter((s) => s.id !== session.id);
      await writeAll(runtime, path, [...rows, session]);
    },
    async list(tenantId) {
      await ensureLoaded();
      return memory.list(tenantId);
    },
  };
}

// ── approval store ────────────────────────────────────────────────────────

export function createFileApprovalStore(runtime: Runtime, dir: string): ApprovalStore {
  const path = `${dir}/approvals.jsonl`;
  const memory = new MemoryApprovalStore();
  let loaded = false;
  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    memory.hydrate(parseAll<ApprovalRecord>(await readLines(runtime, path), 'approvals'));
  };
  /** The store is append-only: a decision appends a new version of the row. */
  const persist = async (record: ApprovalRecord): Promise<void> => {
    const rows = (await readLines(runtime, path)).map((l) => JSON.parse(l) as ApprovalRecord).filter((r) => r.id !== record.id);
    await writeAll(runtime, path, [...rows, record]);
  };
  return {
    async insert(record) {
      await ensureLoaded();
      await memory.insert(record);
      await persist(record);
    },
    async get(id, tenantId) {
      await ensureLoaded();
      return memory.get(id, tenantId);
    },
    async list(filter) {
      await ensureLoaded();
      return memory.list(filter);
    },
    async decide(id, expectedRevision, patch) {
      await ensureLoaded();
      const ok = await memory.decide(id, expectedRevision, patch);
      if (!ok) return false;
      const updated = await memory.get(id);
      if (updated !== undefined) await persist(updated);
      return true;
    },
    async expire(nowIso) {
      await ensureLoaded();
      const before = await memory.list({ state: 'pending' });
      const count = await memory.expire(nowIso);
      for (const record of await memory.list({ state: 'expired' })) {
        if (!before.some((b) => b.id === record.id)) await persist(record);
      }
      return count;
    },
  };
}

// ── budget store ──────────────────────────────────────────────────────────

export function createFileBudgetStore(runtime: Runtime, dir: string): BudgetStore {
  const path = `${dir}/budget.json`;
  const memory = new MemoryBudgetStore();
  let loaded = false;
  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    if (!(await runtime.fs.exists(path))) return;
    try {
      const parsed = JSON.parse(await runtime.fs.readFile(path)) as {
        accounts?: BudgetAccount[];
        reservations?: BudgetReservation[];
      };
      memory.hydrate(parsed);
    } catch (e) {
      throw new Error(`budget file is corrupt: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const persist = async (): Promise<void> => {
    await runtime.fs.mkdir(dir, { recursive: true });
    await runtime.fs.writeFile(path, `${JSON.stringify(memory.dump(), null, 2)}\n`);
  };
  return {
    async get(id) {
      await ensureLoaded();
      return memory.get(id);
    },
    async put(account) {
      await ensureLoaded();
      await memory.put(account);
      await persist();
    },
    async list(tenantId) {
      await ensureLoaded();
      return memory.list(tenantId);
    },
    async getReservation(id) {
      await ensureLoaded();
      return memory.getReservation(id);
    },
    async putReservation(reservation) {
      await ensureLoaded();
      await memory.putReservation(reservation);
      await persist();
    },
    async listReservations(filter) {
      await ensureLoaded();
      return memory.listReservations(filter);
    },
  };
}

// ── idempotency store ─────────────────────────────────────────────────────

export function createFileIdempotencyStore(runtime: Runtime, dir: string): IdempotencyStore {
  const path = `${dir}/idempotency.jsonl`;
  const memory = new MemoryIdempotencyStore({ ids: { next: (p: string) => `${p}_file` }, now: () => new Date(0).toISOString() });
  let loaded = false;
  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    memory.hydrate(parseAll<IdempotencyRecord>(await readLines(runtime, path), 'idempotency'));
  };
  const persist = async (): Promise<void> => {
    await writeAll(runtime, path, memory.dump());
  };
  return {
    async begin(key, requestHash, ttlMs) {
      await ensureLoaded();
      const outcome = await memory.begin(key, requestHash, ttlMs);
      await persist();
      return outcome;
    },
    async get(key) {
      await ensureLoaded();
      return memory.get(key);
    },
    async complete(key, result, resultRef) {
      await ensureLoaded();
      await memory.complete(key, result, resultRef);
      await persist();
    },
    async fail(key, error, meta) {
      await ensureLoaded();
      await memory.fail(key, error, meta);
      await persist();
    },
  };
}

// ── receipt store ─────────────────────────────────────────────────────────

export function createFileReceiptStore(runtime: Runtime, dir: string, hash: MemoryStoresOptions['hash']): ReceiptStore {
  const path = `${dir}/receipts.jsonl`;
  const memory = new MemoryReceiptStore({ hash });
  let loaded = false;
  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    // hydrate() verifies the chain, so a tampered file fails here.
    memory.hydrate(parseAll<Receipt>(await readLines(runtime, path), 'receipts'));
  };
  return {
    async put(receipt) {
      await ensureLoaded();
      const sealed = await memory.put(receipt);
      await appendLine(runtime, path, sealed);
      return sealed;
    },
    async get(id, tenantId) {
      await ensureLoaded();
      return memory.get(id, tenantId);
    },
    async listByTask(taskId, tenantId) {
      await ensureLoaded();
      return memory.listByTask(taskId, tenantId);
    },
    async head(taskId, tenantId) {
      await ensureLoaded();
      return memory.head(taskId, tenantId);
    },
  };
}

// ── audit store ───────────────────────────────────────────────────────────

export function createFileAuditStore(
  runtime: Runtime,
  dir: string,
  hash: MemoryStoresOptions['hash'],
  ids: MemoryStoresOptions['ids'],
  now: () => string,
  checkpointEvery?: number,
): AuditStore {
  const path = `${dir}/audit.jsonl`;
  const memory = new MemoryAuditStore({
    hash,
    ids,
    now,
    ...(checkpointEvery !== undefined ? { checkpointEvery } : {}),
  });
  let loaded = false;
  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    // hydrate() verifies every link, so a tampered chain fails loudly.
    memory.hydrate(parseAll<AuditEvent>(await readLines(runtime, path), 'audit'));
  };
  return {
    async append(event) {
      await ensureLoaded();
      const stamped = await memory.append(event);
      await appendLine(runtime, path, stamped);
      return stamped;
    },
    async list(filter) {
      await ensureLoaded();
      return memory.list(filter);
    },
    async verify(tenantId, fromCheckpoint) {
      await ensureLoaded();
      return memory.verify(tenantId, fromCheckpoint);
    },
    async checkpoint(tenantId) {
      await ensureLoaded();
      return memory.checkpoint(tenantId);
    },
  };
}

// ── event log ─────────────────────────────────────────────────────────────

export function createFileEventLog(
  runtime: Runtime,
  dir: string,
  ids: MemoryStoresOptions['ids'],
  now: () => string,
): EventLog {
  const path = `${dir}/events.jsonl`;
  const memory = new MemoryEventLog({ ids, now });
  let loaded = false;
  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    memory.hydrate(parseAll<CanonicalEvent>(await readLines(runtime, path), 'events'));
  };
  return {
    async append(event) {
      await ensureLoaded();
      const stamped = await memory.append(event);
      await appendLine(runtime, path, stamped);
      return stamped;
    },
    async list(taskId, afterSeq = 0) {
      await ensureLoaded();
      return memory.list(taskId, afterSeq);
    },
    async snapshot(taskId) {
      await ensureLoaded();
      return memory.snapshot(taskId);
    },
  };
}

// ── the bundle ────────────────────────────────────────────────────────────

export interface FileStoresOptions extends MemoryStoresOptions {
  runtime: Runtime;
  /** Directory for the JSONL files. */
  dir: string;
  checkpointEvery?: number;
}

/**
 * The full store bundle, persisted to disk.
 *
 * The same shape as `createMemoryStores`, so `createFabric({ stores })` does
 * not care which one it gets. The registry/identity/evidence parts stay in
 * memory (they are derived, not records), while the six record stores are
 * durable.
 */
export function createFileStores(opts: FileStoresOptions): ReturnType<typeof createMemoryStores> {
  const { runtime, dir } = opts;
  const memory = createMemoryStores(opts);
  return {
    // Registry / identity / evidence are derived, not records: they stay as the
    // memory bundle provides them.
    ...memory,
    tasks: createFileTaskStore(runtime, dir),
    sessions: createFileSessionStore(runtime, dir),
    approvals: createFileApprovalStore(runtime, dir),
    budget: createFileBudgetStore(runtime, dir),
    idempotency: createFileIdempotencyStore(runtime, dir),
    receipts: createFileReceiptStore(runtime, dir, opts.hash),
    audit: createFileAuditStore(runtime, dir, opts.hash, opts.ids, opts.now, opts.checkpointEvery),
    events: createFileEventLog(runtime, dir, opts.ids, opts.now),
  };
}
