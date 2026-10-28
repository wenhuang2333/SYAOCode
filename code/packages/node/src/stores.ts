import { sha256Hex, type Runtime } from '@syaocode/core';

/**
 * File-backed governance stores for the Agent RPC kernel (03 §3.5).
 *
 * The store interfaces themselves live in `@syaocode/rpc`; the host owns the
 * *durability*. These implementations are written against the same record
 * shapes but stay structurally typed so `@syaocode/node` keeps a single
 * dependency (`@syaocode/core`) and the governance kernel keeps ownership of
 * its own contracts.
 *
 * Every store goes through `Runtime.fs`, so a host can swap the filesystem
 * for a memory implementation without touching the kernel.
 */

export interface FileStoreOptions {
  runtime: Runtime;
  /** Directory that holds the JSON files. */
  dir: string;
}

// ── task store ────────────────────────────────────────────────────────────

/** Minimum shape a task record must have to be stored and listed. */
export interface TaskRecord {
  id: string;
  tenantId: string;
  state: string;
  sessionId?: string;
}

/** States that end a task; used by `listUnterminated` (crash recovery). */
export const DEFAULT_TERMINAL_TASK_STATES: readonly string[] = [
  'completed',
  'failed',
  'cancelled',
  'rejected',
  'expired',
];

export interface TaskListFilter {
  tenantId: string;
  sessionId?: string;
  state?: string;
  limit?: number;
}

export interface FileTaskStore<T extends TaskRecord> {
  create(task: T): Promise<void>;
  get(taskId: string, tenantId: string): Promise<T | undefined>;
  put(task: T): Promise<void>;
  list(filter: TaskListFilter): Promise<T[]>;
  /** Tasks that never reached a terminal state (crash recovery). */
  listUnterminated(tenantId: string): Promise<T[]>;
  delete(taskId: string, tenantId: string): Promise<void>;
}

export interface FileTaskStoreOptions extends FileStoreOptions {
  terminalStates?: readonly string[];
}

export function createFileTaskStore<T extends TaskRecord>(
  opts: FileTaskStoreOptions,
): FileTaskStore<T> {
  const terminal = opts.terminalStates ?? DEFAULT_TERMINAL_TASK_STATES;
  const path = (taskId: string): string => `${opts.dir}/${encodeId(taskId)}.json`;

  const write = async (task: T): Promise<void> => {
    await opts.runtime.fs.mkdir(opts.dir, { recursive: true });
    await opts.runtime.fs.writeFile(path(task.id), JSON.stringify(task));
  };

  const read = async (taskId: string): Promise<T | undefined> => {
    const file = path(taskId);
    if (!(await opts.runtime.fs.exists(file))) return undefined;
    try {
      return JSON.parse(await opts.runtime.fs.readFile(file)) as T;
    } catch {
      return undefined;
    }
  };

  const readAll = async (): Promise<T[]> => {
    if (!(await opts.runtime.fs.exists(opts.dir))) return [];
    const files = (await opts.runtime.fs.readdir(opts.dir)).filter((e) => e.isFile && e.name.endsWith('.json'));
    const out: T[] = [];
    for (const f of files) {
      try {
        out.push(JSON.parse(await opts.runtime.fs.readFile(`${opts.dir}/${f.name}`)) as T);
      } catch {
        /* skip a corrupt record */
      }
    }
    return out;
  };

  return {
    async create(task: T): Promise<void> {
      await write(task);
    },
    async get(taskId: string, tenantId: string): Promise<T | undefined> {
      const task = await read(taskId);
      if (task === undefined || task.tenantId !== tenantId) return undefined;
      return task;
    },
    async put(task: T): Promise<void> {
      await write(task);
    },
    async list(filter: TaskListFilter): Promise<T[]> {
      const all = (await readAll()).filter((t) => t.tenantId === filter.tenantId);
      const filtered = all.filter(
        (t) =>
          (filter.sessionId === undefined || t.sessionId === filter.sessionId) &&
          (filter.state === undefined || t.state === filter.state),
      );
      filtered.sort((a, b) => a.id.localeCompare(b.id));
      return filter.limit === undefined ? filtered : filtered.slice(0, filter.limit);
    },
    async listUnterminated(tenantId: string): Promise<T[]> {
      const all = (await readAll()).filter((t) => t.tenantId === tenantId);
      return all.filter((t) => !terminal.includes(t.state));
    },
    async delete(taskId: string, tenantId: string): Promise<void> {
      const task = await read(taskId);
      if (task === undefined || task.tenantId !== tenantId) return;
      await opts.runtime.fs.unlink(path(taskId));
    },
  };
}

// ── budget store ──────────────────────────────────────────────────────────

export interface BudgetAccountRecord {
  id: string;
  tenantId: string;
  reservedUsd: number;
  spentUsd: number;
}

export interface BudgetReservationRecord {
  id: string;
  accountId: string;
  state: string;
}

export interface BudgetReservationFilter {
  state?: string;
  accountId?: string;
}

export interface FileBudgetStore<A extends BudgetAccountRecord, R extends BudgetReservationRecord> {
  get(id: string): Promise<A | undefined>;
  put(account: A): Promise<void>;
  list(tenantId: string): Promise<A[]>;
  getReservation(id: string): Promise<R | undefined>;
  putReservation(reservation: R): Promise<void>;
  listReservations(filter?: BudgetReservationFilter): Promise<R[]>;
}

export function createFileBudgetStore<
  A extends BudgetAccountRecord,
  R extends BudgetReservationRecord,
>(opts: FileStoreOptions): FileBudgetStore<A, R> {
  const accountsDir = `${opts.dir}/accounts`;
  const reservationsDir = `${opts.dir}/reservations`;
  const accountPath = (id: string): string => `${accountsDir}/${encodeId(id)}.json`;
  const reservationPath = (id: string): string => `${reservationsDir}/${encodeId(id)}.json`;

  const readJson = async <T>(file: string): Promise<T | undefined> => {
    if (!(await opts.runtime.fs.exists(file))) return undefined;
    try {
      return JSON.parse(await opts.runtime.fs.readFile(file)) as T;
    } catch {
      return undefined;
    }
  };

  const readDir = async <T>(dir: string): Promise<T[]> => {
    if (!(await opts.runtime.fs.exists(dir))) return [];
    const files = (await opts.runtime.fs.readdir(dir)).filter((e) => e.isFile && e.name.endsWith('.json'));
    const out: T[] = [];
    for (const f of files) {
      const parsed = await readJson<T>(`${dir}/${f.name}`);
      if (parsed !== undefined) out.push(parsed);
    }
    return out;
  };

  return {
    async get(id: string): Promise<A | undefined> {
      return readJson<A>(accountPath(id));
    },
    async put(account: A): Promise<void> {
      await opts.runtime.fs.mkdir(accountsDir, { recursive: true });
      await opts.runtime.fs.writeFile(accountPath(account.id), JSON.stringify(account));
    },
    async list(tenantId: string): Promise<A[]> {
      const all = await readDir<A>(accountsDir);
      return all.filter((a) => a.tenantId === tenantId);
    },
    async getReservation(id: string): Promise<R | undefined> {
      return readJson<R>(reservationPath(id));
    },
    async putReservation(reservation: R): Promise<void> {
      await opts.runtime.fs.mkdir(reservationsDir, { recursive: true });
      await opts.runtime.fs.writeFile(reservationPath(reservation.id), JSON.stringify(reservation));
    },
    async listReservations(filter?: BudgetReservationFilter): Promise<R[]> {
      const all = await readDir<R>(reservationsDir);
      return all.filter(
        (r) =>
          (filter?.state === undefined || r.state === filter.state) &&
          (filter?.accountId === undefined || r.accountId === filter.accountId),
      );
    },
  };
}

// ── idempotency store ─────────────────────────────────────────────────────

export interface IdempotencyRecordShape {
  key: string;
  requestHash: string;
  state: string;
  createdAt: string;
  expiresAt: string;
}

export type IdempotencyBeginResult<T> =
  | { kind: 'new'; record: T }
  | { kind: 'replay'; record: T }
  | { kind: 'in_flight'; record: T }
  | { kind: 'conflict'; record: T };

export interface FileIdempotencyStore<T extends IdempotencyRecordShape> {
  /** Atomic begin; decides new/replay/in_flight/conflict from key + hash. */
  begin(key: string, requestHash: string, ttlMs?: number): Promise<IdempotencyBeginResult<T>>;
  get(key: string): Promise<T | undefined>;
  complete(key: string, result: unknown, resultRef?: string): Promise<void>;
  fail(key: string, error: unknown): Promise<void>;
}

export interface FileIdempotencyStoreOptions extends FileStoreOptions {
  /** ISO clock; defaults to `runtime.clock.now()`. */
  now?: () => string;
  defaultTtlMs?: number;
}

export function createFileIdempotencyStore<T extends IdempotencyRecordShape>(
  opts: FileIdempotencyStoreOptions,
): FileIdempotencyStore<T> {
  const now = opts.now ?? (() => new Date(opts.runtime.clock.now()).toISOString());
  const defaultTtl = opts.defaultTtlMs ?? 24 * 60 * 60 * 1000;
  const path = (key: string): string => `${opts.dir}/${encodeId(key)}.json`;

  const read = async (key: string): Promise<T | undefined> => {
    const file = path(key);
    if (!(await opts.runtime.fs.exists(file))) return undefined;
    try {
      return JSON.parse(await opts.runtime.fs.readFile(file)) as T;
    } catch {
      return undefined;
    }
  };

  const write = async (record: T): Promise<void> => {
    await opts.runtime.fs.mkdir(opts.dir, { recursive: true });
    await opts.runtime.fs.writeFile(path(record.key), JSON.stringify(record));
  };

  return {
    async begin(key: string, requestHash: string, ttlMs?: number): Promise<IdempotencyBeginResult<T>> {
      const existing = await read(key);
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash) return { kind: 'conflict', record: existing };
        if (existing.state === 'completed') return { kind: 'replay', record: existing };
        if (existing.state === 'in_flight') return { kind: 'in_flight', record: existing };
        // A failed record may be retried with the same key.
      }
      const createdAt = now();
      const expiresAt = new Date(Date.parse(createdAt) + (ttlMs ?? defaultTtl)).toISOString();
      const record = {
        ...(existing ?? {}),
        key,
        requestHash,
        state: 'in_flight',
        createdAt: existing?.createdAt ?? createdAt,
        expiresAt,
      } as unknown as T;
      await write(record);
      return { kind: 'new', record };
    },
    async get(key: string): Promise<T | undefined> {
      return read(key);
    },
    async complete(key: string, result: unknown, resultRef?: string): Promise<void> {
      const existing = await read(key);
      if (existing === undefined) return;
      await write({
        ...existing,
        state: 'completed',
        result,
        ...(resultRef !== undefined ? { resultRef } : {}),
      } as unknown as T);
    },
    async fail(key: string, error: unknown): Promise<void> {
      const existing = await read(key);
      if (existing === undefined) return;
      await write({ ...existing, state: 'failed', error } as unknown as T);
    },
  };
}

// ── audit store ───────────────────────────────────────────────────────────

export interface AuditEventShape {
  id: string;
  ts: string;
  tenantId: string;
  action: string;
  outcome: string;
  prevHash: string;
  hash: string;
}

export interface AuditFilter {
  tenantId?: string;
  from?: string;
  limit?: number;
}

export interface FileAuditStore<E extends AuditEventShape> {
  /** Append with the hash chain link; the store owns `prevHash`/`hash`. */
  append(event: Omit<E, 'prevHash' | 'hash'>): Promise<E>;
  list(filter?: AuditFilter): Promise<E[]>;
  /** Recompute the chain and report the first broken link. */
  verify(tenantId: string): Promise<{ ok: boolean; checked: number; brokenAt?: string }>;
}

export interface FileAuditStoreOptions extends FileStoreOptions {
  /** SHA-256 provider; defaults to core's dependency-free implementation. */
  sha256?: (text: string) => string;
  now?: () => string;
}

export function createFileAuditStore<E extends AuditEventShape>(
  opts: FileAuditStoreOptions,
): FileAuditStore<E> {
  const sha256 = opts.sha256 ?? ((text: string) => opts.runtime.hash?.sha256(text) ?? sha256Hex(text));
  const now = opts.now ?? (() => new Date(opts.runtime.clock.now()).toISOString());
  const path = (tenantId: string): string => `${opts.dir}/${encodeId(tenantId)}.jsonl`;

  const readAll = async (tenantId: string): Promise<E[]> => {
    const file = path(tenantId);
    if (!(await opts.runtime.fs.exists(file))) return [];
    const raw = await opts.runtime.fs.readFile(file);
    const out: E[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as E);
      } catch {
        /* skip a corrupt line; verify() reports the break */
      }
    }
    return out;
  };

  return {
    async append(event: Omit<E, 'prevHash' | 'hash'>): Promise<E> {
      const tenantId = event.tenantId;
      const existing = await readAll(tenantId);
      const prevHash = existing.length === 0 ? '' : (existing[existing.length - 1]?.hash ?? '');
      const body = { ...event, prevHash };
      const hash = sha256(canonicalJson(body));
      const stored = { ...body, hash } as E;
      await opts.runtime.fs.mkdir(opts.dir, { recursive: true });
      await opts.runtime.fs.appendFile(path(tenantId), `${JSON.stringify(stored)}\n`);
      return stored;
    },
    async list(filter?: AuditFilter): Promise<E[]> {
      const tenantId = filter?.tenantId;
      if (tenantId === undefined) {
        // Without a tenant the caller cannot see other tenants' chains.
        return [];
      }
      const all = await readAll(tenantId);
      const filtered =
        filter?.from === undefined ? all : all.filter((e) => e.ts >= (filter.from as string));
      return filter?.limit === undefined ? filtered : filtered.slice(0, filter.limit);
    },
    async verify(tenantId: string): Promise<{ ok: boolean; checked: number; brokenAt?: string }> {
      const all = await readAll(tenantId);
      let prev = '';
      for (const e of all) {
        const body = { ...e, hash: undefined } as unknown as Record<string, unknown>;
        delete body.hash;
        const expected = sha256(canonicalJson(body));
        if (e.prevHash !== prev || e.hash !== expected) {
          return { ok: false, checked: all.indexOf(e), brokenAt: e.id };
        }
        prev = e.hash;
      }
      return { ok: true, checked: all.length };
    },
  };
}

// ── helpers ───────────────────────────────────────────────────────────────

/** File-system safe id: only characters that survive every path check. */
function encodeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Deterministic JSON (key order independent) for hashing. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
