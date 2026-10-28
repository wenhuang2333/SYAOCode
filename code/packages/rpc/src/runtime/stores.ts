/**
 * Pluggable storage面 — the default in-memory implementations (02 §3, ADR-R3).
 *
 * Every store here is tenant-scoped (I8): a query always carries the tenant, a
 * cross-tenant read returns `undefined`, and a cross-tenant write is rejected.
 * Rows are copied in and out so a caller can never mutate stored state through
 * a returned reference (the kernel is otherwise a shared mutable graph).
 *
 * Host-agnostic: no `node:` imports; ids and the ISO clock are injected.
 */

import { sha256Hex, type IdGenerator } from '@syaocode/core';
import type {
  ApprovalRecord,
  BudgetAccount,
  BudgetReservation,
  IdempotencyRecord,
  Session,
  Task,
} from '../ir/types.js';
import { assertApprovalTransition, isTaskTerminal } from '../ir/states.js';
import type {
  ApprovalStore,
  AuditStore,
  BudgetStore,
  EventLog,
  FabricStores,
  Hasher,
  IdempotencyStore,
  MemoryStoresOptions,
  ReceiptStore,
  SessionStore,
  TaskStore,
} from '../governance/contracts.js';
import { MemoryIdempotencyStore } from '../governance/idempotency.js';
import { MemoryEventLog } from './eventlog.js';
import { deepClone } from './projection.js';
import { MemoryReceiptStore, HashChainEvidenceSealer } from '../governance/receipts.js';
import { MemoryAuditStore } from '../governance/audit.js';
import { InMemoryCapabilityRegistry } from '../governance/registry.js';
import { LocalIdentityService } from '../governance/identity.js';

// ── shared helpers ────────────────────────────────────────────────────────

/**
 * The SHA-256 hasher a Node host injects into `KernelContext.hash`.
 *
 * `contentHash` (FNV-1a) is explicitly forbidden for audit/evidence chains (C6).
 */
export const sha256Hasher: Hasher = { sha256: (text: string) => sha256Hex(text) };

export { deepClone };

/** Drop explicit `undefined`s so exactOptionalPropertyTypes objects stay clean. */
function definedOnly<T extends object>(patch: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) out[key] = value;
  return out as Partial<T>;
}

function byCreatedAtThenId<T extends { createdAt: string; id: string }>(a: T, b: T): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ── tasks ─────────────────────────────────────────────────────────────────

export class MemoryTaskStore implements TaskStore {
  private readonly rows = new Map<string, Task>();

  /** Load persisted rows without re-validating (see `createFileStores`). */
  hydrate(tasks: readonly Task[]): void {
    for (const task of tasks) this.rows.set(task.id, deepClone(task));
  }

  /** Every row, for a persistence layer to snapshot. */
  dump(): Task[] {
    return [...this.rows.values()].map((task) => deepClone(task));
  }

  async create(task: Task): Promise<void> {
    if (this.rows.has(task.id)) throw new Error(`task ${task.id} already exists`);
    this.rows.set(task.id, deepClone(task));
  }

  async get(taskId: string, tenantId: string): Promise<Task | undefined> {
    const task = this.rows.get(taskId);
    if (task === undefined || task.tenantId !== tenantId) return undefined;
    return deepClone(task);
  }

  async put(task: Task): Promise<void> {
    const existing = this.rows.get(task.id);
    if (existing !== undefined && existing.tenantId !== task.tenantId) {
      throw new Error(`task ${task.id} belongs to another tenant (I8)`);
    }
    this.rows.set(task.id, deepClone(task));
  }

  async list(filter: { tenantId: string; sessionId?: string; state?: Task['state']; limit?: number }): Promise<Task[]> {
    const out = [...this.rows.values()]
      .filter((task) => task.tenantId === filter.tenantId)
      .filter((task) => filter.sessionId === undefined || task.sessionId === filter.sessionId)
      .filter((task) => filter.state === undefined || task.state === filter.state)
      .sort(byCreatedAtThenId);
    return (filter.limit !== undefined ? out.slice(0, Math.max(0, filter.limit)) : out).map(deepClone);
  }

  async listUnterminated(tenantId: string): Promise<Task[]> {
    return [...this.rows.values()]
      .filter((task) => task.tenantId === tenantId && !isTaskTerminal(task.state))
      .sort(byCreatedAtThenId)
      .map(deepClone);
  }

  async delete(taskId: string, tenantId: string): Promise<void> {
    const task = this.rows.get(taskId);
    if (task !== undefined && task.tenantId === tenantId) this.rows.delete(taskId);
  }
}

// ── sessions ──────────────────────────────────────────────────────────────

export class MemorySessionStore implements SessionStore {
  private readonly rows = new Map<string, Session>();

  hydrate(sessions: readonly Session[]): void {
    for (const session of sessions) this.rows.set(session.id, deepClone(session));
  }

  dump(): Session[] {
    return [...this.rows.values()].map((session) => deepClone(session));
  }

  async create(session: Session): Promise<void> {
    if (this.rows.has(session.id)) throw new Error(`session ${session.id} already exists`);
    this.rows.set(session.id, deepClone(session));
  }

  async get(sessionId: string, tenantId: string): Promise<Session | undefined> {
    const session = this.rows.get(sessionId);
    if (session === undefined || session.tenantId !== tenantId) return undefined;
    return deepClone(session);
  }

  async put(session: Session): Promise<void> {
    const existing = this.rows.get(session.id);
    if (existing !== undefined && existing.tenantId !== session.tenantId) {
      throw new Error(`session ${session.id} belongs to another tenant (I8)`);
    }
    this.rows.set(session.id, deepClone(session));
  }

  async list(tenantId: string): Promise<Session[]> {
    return [...this.rows.values()]
      .filter((session) => session.tenantId === tenantId)
      .sort(byCreatedAtThenId)
      .map(deepClone);
  }
}

// ── approvals ─────────────────────────────────────────────────────────────

export class MemoryApprovalStore implements ApprovalStore {
  private readonly rows = new Map<string, ApprovalRecord>();

  hydrate(records: readonly ApprovalRecord[]): void {
    for (const record of records) this.rows.set(record.id, deepClone(record));
  }

  dump(): ApprovalRecord[] {
    return [...this.rows.values()].map((record) => deepClone(record));
  }

  async insert(record: ApprovalRecord): Promise<void> {
    if (this.rows.has(record.id)) throw new Error(`approval ${record.id} already exists`);
    this.rows.set(record.id, deepClone(record));
  }

  /**
   * The frozen `ApprovalStore` interface has no tenant argument, so the
   * optional one here is how a caller opts into the I8 check.
   */
  async get(id: string, tenantId?: string): Promise<ApprovalRecord | undefined> {
    const record = this.rows.get(id);
    if (record === undefined) return undefined;
    if (tenantId !== undefined && record.tenantId !== tenantId) return undefined;
    return deepClone(record);
  }

  async list(filter?: { tenantId?: string; taskId?: string; state?: ApprovalRecord['state'] }): Promise<ApprovalRecord[]> {
    return [...this.rows.values()]
      .filter((r) => filter?.tenantId === undefined || r.tenantId === filter.tenantId)
      .filter((r) => filter?.taskId === undefined || r.taskId === filter.taskId)
      .filter((r) => filter?.state === undefined || r.state === filter.state)
      .sort(byCreatedAtThenId)
      .map(deepClone);
  }

  /** CAS on `revision`; the state change must be a legal approval transition. */
  async decide(id: string, expectedRevision: number, patch: Partial<ApprovalRecord>): Promise<boolean> {
    const record = this.rows.get(id);
    if (record === undefined || record.revision !== expectedRevision) return false;
    const clean = definedOnly(patch);
    if (clean.state !== undefined && clean.state !== record.state) {
      assertApprovalTransition(record.state, clean.state);
    }
    this.rows.set(id, { ...record, ...clean, revision: record.revision + 1 });
    return true;
  }

  async expire(nowIso: string): Promise<number> {
    let expired = 0;
    for (const [id, record] of this.rows) {
      if (record.state !== 'pending') continue;
      if (Date.parse(record.expiresAt) > Date.parse(nowIso)) continue;
      this.rows.set(id, {
        ...record,
        state: 'expired',
        revision: record.revision + 1,
        decidedAt: nowIso,
        decisionReason: 'expired',
      });
      expired += 1;
    }
    return expired;
  }
}

// ── budget ────────────────────────────────────────────────────────────────

export class MemoryBudgetStore implements BudgetStore {
  private readonly accounts = new Map<string, BudgetAccount>();
  private readonly reservations = new Map<string, BudgetReservation>();

  hydrate(state: { accounts?: readonly BudgetAccount[]; reservations?: readonly BudgetReservation[] }): void {
    for (const account of state.accounts ?? []) this.accounts.set(account.id, deepClone(account));
    for (const reservation of state.reservations ?? []) this.reservations.set(reservation.id, deepClone(reservation));
  }

  dump(): { accounts: BudgetAccount[]; reservations: BudgetReservation[] } {
    return {
      accounts: [...this.accounts.values()].map((account) => deepClone(account)),
      reservations: [...this.reservations.values()].map((reservation) => deepClone(reservation)),
    };
  }

  async get(id: string, tenantId?: string): Promise<BudgetAccount | undefined> {
    const account = this.accounts.get(id);
    if (account === undefined) return undefined;
    if (tenantId !== undefined && account.tenantId !== tenantId) return undefined;
    return deepClone(account);
  }

  async put(account: BudgetAccount): Promise<void> {
    const existing = this.accounts.get(account.id);
    if (existing !== undefined && existing.tenantId !== account.tenantId) {
      throw new Error(`budget account ${account.id} belongs to another tenant (I8)`);
    }
    this.accounts.set(account.id, deepClone(account));
  }

  async list(tenantId: string): Promise<BudgetAccount[]> {
    return [...this.accounts.values()]
      .filter((account) => account.tenantId === tenantId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(deepClone);
  }

  async getReservation(id: string): Promise<BudgetReservation | undefined> {
    const reservation = this.reservations.get(id);
    return reservation === undefined ? undefined : deepClone(reservation);
  }

  async putReservation(reservation: BudgetReservation): Promise<void> {
    this.reservations.set(reservation.id, deepClone(reservation));
  }

  async listReservations(filter?: { state?: BudgetReservation['state']; accountId?: string }): Promise<BudgetReservation[]> {
    return [...this.reservations.values()]
      .filter((r) => filter?.state === undefined || r.state === filter.state)
      .filter((r) => filter?.accountId === undefined || r.accountId === filter.accountId)
      .sort(byCreatedAtThenId)
      .map(deepClone);
  }
}

// ── bundle ────────────────────────────────────────────────────────────────

/**
 * The default single-process storage面. All eleven components share one id
 * generator, one ISO clock and one hasher, so chains and ids stay consistent.
 */
export function createMemoryStores(opts: MemoryStoresOptions): FabricStores {
  const { ids, now, hash } = opts;

  const tasks: TaskStore = new MemoryTaskStore();
  const sessions: SessionStore = new MemorySessionStore();
  const approvals: ApprovalStore = new MemoryApprovalStore();
  const budget: BudgetStore = new MemoryBudgetStore();
  const idempotency: IdempotencyStore = new MemoryIdempotencyStore({ ids, now });
  const receipts: ReceiptStore = new MemoryReceiptStore({ hash });
  const audit: AuditStore = new MemoryAuditStore({ hash, ids, now, ...(opts.checkpointEvery !== undefined ? { checkpointEvery: opts.checkpointEvery } : {}) });
  const events: EventLog = new MemoryEventLog({ ids, now });
  const registry = new InMemoryCapabilityRegistry({ now });
  const identity = new LocalIdentityService({ hash, ids, now });
  const evidence = new HashChainEvidenceSealer({ hash, receipts, approvals, tasks, budget, audit, now });

  return { tasks, sessions, approvals, budget, idempotency, receipts, audit, events, registry, identity, evidence };
}

export type { IdempotencyRecord };
export { MemoryIdempotencyStore };
