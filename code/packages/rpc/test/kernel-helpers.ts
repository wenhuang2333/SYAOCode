/**
 * Shared builders for the Lead-owned kernel tests.
 *
 * Kept separate from test/helpers.ts (owned by the runtime workstream) so the
 * two suites can evolve independently while sharing one FakeRuntime.
 */

import { PermissionEngine, type Runtime, type Tool } from '@syaocode/core';
import { sha256Hex } from '@syaocode/core';
import type {
  ApprovalStore,
  AuditStore,
  BudgetStore,
  CapabilityRegistry,
  EventLog,
  EvidenceSealer,
  FabricStores,
  Hasher,
  IdentityService,
  IdempotencyStore,
  ReceiptStore,
  SessionStore,
  TaskStore,
} from '../src/governance/contracts.js';
import type { ApprovalRecord, BudgetAccount, BudgetReservation, Task } from '../src/ir/types.js';
import { parseCanonical, approvalRecordSchema, budgetAccountSchema, budgetReservationSchema, taskSchema } from '../src/ir/schemas.js';
import { deterministicIds } from '../src/ir/ids.js';

export const TEST_TENANT = 'acme';
export const TEST_NOW = '2026-10-28T00:00:00.000Z';

export const hasher: Hasher = { sha256: sha256Hex };

/** Minimal in-memory Runtime with a controllable clock. */
export class FakeRuntime implements Runtime {
  clockValue = Date.parse(TEST_NOW);
  readonly files = new Map<string, string>();

  readonly fs = {
    readFile: async (path: string): Promise<string> => {
      const v = this.files.get(path);
      if (v === undefined) throw new Error(`ENOENT ${path}`);
      return v;
    },
    writeFile: async (path: string, data: string): Promise<void> => {
      this.files.set(path, data);
    },
    appendFile: async (path: string, data: string): Promise<void> => {
      this.files.set(path, `${this.files.get(path) ?? ''}${data}`);
    },
    stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
    readdir: async () => [],
    realpath: async (path: string): Promise<string> => path,
    mkdir: async (): Promise<void> => undefined,
    rmdir: async (): Promise<void> => undefined,
    unlink: async (path: string): Promise<void> => {
      this.files.delete(path);
    },
    exists: async (path: string): Promise<boolean> => this.files.has(path),
  };

  readonly shell = {
    spawn: () => {
      throw new Error('fake runtime cannot spawn processes');
    },
  };

  readonly http = {
    fetch: async () => {
      throw new Error('fake runtime has no network');
    },
  };

  readonly clock = {
    now: (): number => this.clockValue,
    sleep: async (ms: number): Promise<void> => {
      this.clockValue += ms;
    },
  };

  readonly logger = {
    log: (): void => undefined,
  };

  readonly env = {
    get: (name: string): string | undefined => (name === 'HOME' ? '/home/tester' : undefined),
  };

  readonly ids = deterministicIds();

  advance(ms: number): void {
    this.clockValue += ms;
  }
}

// ── tiny in-memory stores (kernel tests only) ─────────────────────────────

export class FakeTaskStore implements TaskStore {
  readonly rows = new Map<string, Task>();

  async create(task: Task): Promise<void> {
    this.rows.set(task.id, task);
  }
  async get(taskId: string, tenantId: string): Promise<Task | undefined> {
    const t = this.rows.get(taskId);
    return t !== undefined && t.tenantId === tenantId ? t : undefined;
  }
  async put(task: Task): Promise<void> {
    this.rows.set(task.id, task);
  }
  async list(filter: { tenantId: string; sessionId?: string; state?: Task['state']; limit?: number }): Promise<Task[]> {
    let out = [...this.rows.values()].filter((t) => t.tenantId === filter.tenantId);
    if (filter.sessionId !== undefined) out = out.filter((t) => t.sessionId === filter.sessionId);
    if (filter.state !== undefined) out = out.filter((t) => t.state === filter.state);
    return filter.limit !== undefined ? out.slice(0, filter.limit) : out;
  }
  async listUnterminated(tenantId: string): Promise<Task[]> {
    const terminal = new Set(['completed', 'failed', 'cancelled', 'rejected', 'expired']);
    return [...this.rows.values()].filter((t) => t.tenantId === tenantId && !terminal.has(t.state));
  }
  async delete(taskId: string): Promise<void> {
    this.rows.delete(taskId);
  }
}

export class FakeSessionStore implements SessionStore {
  readonly rows = new Map<string, import('../src/ir/types.js').Session>();
  async create(s: import('../src/ir/types.js').Session): Promise<void> {
    this.rows.set(s.id, s);
  }
  async get(id: string, tenantId: string) {
    const s = this.rows.get(id);
    return s !== undefined && s.tenantId === tenantId ? s : undefined;
  }
  async put(s: import('../src/ir/types.js').Session): Promise<void> {
    this.rows.set(s.id, s);
  }
  async list(tenantId: string) {
    return [...this.rows.values()].filter((s) => s.tenantId === tenantId);
  }
}

export class FakeApprovalStore implements ApprovalStore {
  readonly rows = new Map<string, ApprovalRecord>();

  async insert(record: ApprovalRecord): Promise<void> {
    this.rows.set(record.id, record);
  }
  async get(id: string): Promise<ApprovalRecord | undefined> {
    return this.rows.get(id);
  }
  async list(filter?: { tenantId?: string; taskId?: string; state?: ApprovalRecord['state'] }): Promise<ApprovalRecord[]> {
    let out = [...this.rows.values()];
    if (filter?.tenantId !== undefined) out = out.filter((r) => r.tenantId === filter.tenantId);
    if (filter?.taskId !== undefined) out = out.filter((r) => r.taskId === filter.taskId);
    if (filter?.state !== undefined) out = out.filter((r) => r.state === filter.state);
    return out;
  }
  async decide(id: string, expectedRevision: number, patch: Partial<ApprovalRecord>): Promise<boolean> {
    const current = this.rows.get(id);
    if (current === undefined) return false;
    // CAS: the revision must still be the one the decider observed.
    if (current.revision !== expectedRevision) return false;
    const next = parseCanonical<ApprovalRecord>(approvalRecordSchema, { ...current, ...patch }, 'approval');
    this.rows.set(id, next);
    return true;
  }
  async expire(nowIso: string): Promise<number> {
    let n = 0;
    for (const [id, rec] of this.rows) {
      if (rec.state === 'pending' && Date.parse(rec.expiresAt) <= Date.parse(nowIso)) {
        this.rows.set(id, { ...rec, state: 'expired' });
        n += 1;
      }
    }
    return n;
  }
}

export class FakeBudgetStore implements BudgetStore {
  readonly accounts = new Map<string, BudgetAccount>();
  readonly reservations = new Map<string, BudgetReservation>();

  async get(id: string) {
    return this.accounts.get(id);
  }
  async put(account: BudgetAccount): Promise<void> {
    this.accounts.set(account.id, parseCanonical<BudgetAccount>(budgetAccountSchema, account, 'account'));
  }
  async list(tenantId: string) {
    return [...this.accounts.values()].filter((a) => a.tenantId === tenantId);
  }
  async getReservation(id: string) {
    return this.reservations.get(id);
  }
  async putReservation(r: BudgetReservation): Promise<void> {
    this.reservations.set(r.id, parseCanonical<BudgetReservation>(budgetReservationSchema, r, 'reservation'));
  }
  async listReservations(filter?: { state?: BudgetReservation['state']; accountId?: string }) {
    let out = [...this.reservations.values()];
    if (filter?.state !== undefined) out = out.filter((r) => r.state === filter.state);
    if (filter?.accountId !== undefined) out = out.filter((r) => r.accountId === filter.accountId);
    return out;
  }
}

// ── pass-through stubs for stores a given test does not exercise ─────────

export function stubReceipts(): ReceiptStore {
  const rows: import('../src/ir/types.js').Receipt[] = [];
  return {
    async put(draft) {
      const receipt = { ...draft, hash: hasher.sha256(JSON.stringify(draft)) } as import('../src/ir/types.js').Receipt;
      rows.push(receipt);
      return receipt;
    },
    async get(id) {
      return rows.find((r) => r.id === id);
    },
    async listByTask(taskId) {
      return rows.filter((r) => r.taskId === taskId);
    },
    async head(taskId) {
      return rows.filter((r) => r.taskId === taskId).at(-1);
    },
  };
}

export function stubAudit(): AuditStore {
  const rows: import('../src/ir/types.js').AuditEvent[] = [];
  return {
    async append(event) {
      const row = { ...event, id: `aud_${rows.length + 1}`, prevHash: '', hash: 'h' } as import('../src/ir/types.js').AuditEvent;
      rows.push(row);
      return row;
    },
    async list() {
      return rows;
    },
    async verify() {
      return { ok: true, checked: rows.length };
    },
    async checkpoint(tenantId) {
      return { tenantId, at: TEST_NOW, count: rows.length, lastHash: 'h', checkpointHash: 'c' };
    },
  };
}

export function stubEvents(): EventLog {
  const rows: import('../src/ir/types.js').CanonicalEvent[] = [];
  const seqs = new Map<string, number>();
  return {
    async append(event) {
      const seq = (seqs.get(event.taskId) ?? 0) + 1;
      seqs.set(event.taskId, seq);
      const row = {
        schemaVersion: 1,
        eventId: `evt_${seq}_${rows.length}`,
        seq,
        ts: TEST_NOW,
        ...event,
      } as import('../src/ir/types.js').CanonicalEvent;
      rows.push(row);
      return row;
    },
    async list(taskId, afterSeq = 0) {
      return rows.filter((r) => r.taskId === taskId && r.seq > afterSeq);
    },
    async snapshot(taskId) {
      return { lastSeq: seqs.get(taskId) ?? 0 };
    },
  };
}

export function stubIdentity(): IdentityService {
  return {
    async authenticate() {
      return {
        principal: { id: 'user:local', kind: 'user', tenantId: TEST_TENANT, scopes: [], trustTier: 'verified' },
        delegationChain: [],
      };
    },
    async issueDelegation(token) {
      return { ...token, id: 'del_1', signature: 'sig' };
    },
    async verifyDelegation() {
      throw new Error('not used in this test');
    },
  };
}

export function stubEvidence(): EvidenceSealer {
  return {
    async seal(taskId) {
      return {
        schemaVersion: 1,
        taskId,
        tenantId: TEST_TENANT,
        createdAt: TEST_NOW,
        receipts: [],
        approvals: [],
        policySnapshots: [],
        artifacts: [],
        verification: { verdict: 'unverified', checks: [] },
        rootHash: 'root',
      };
    },
    async verify() {
      return { ok: true, checks: [] };
    },
  };
}

export function stubIdempotency(): IdempotencyStore {
  const rows = new Map<string, import('../src/ir/types.js').IdempotencyRecord>();
  return {
    async begin(key, hash) {
      const existing = rows.get(key);
      if (existing !== undefined) {
        if (existing.requestHash !== hash) return { kind: 'conflict', record: existing };
        if (existing.state === 'completed') return { kind: 'replay', record: existing };
        return { kind: 'in_flight', record: existing };
      }
      const record = { key, requestHash: hash, state: 'in_flight' as const, createdAt: TEST_NOW, expiresAt: '2099-01-01T00:00:00.000Z' };
      rows.set(key, record);
      return { kind: 'new', record };
    },
    async get(key) {
      return rows.get(key);
    },
    async complete(key, result, resultRef) {
      const r = rows.get(key);
      if (r !== undefined) rows.set(key, { ...r, state: 'completed', result, ...(resultRef !== undefined ? { resultRef } : {}) });
    },
    async fail(key, error) {
      const r = rows.get(key);
      if (r !== undefined) rows.set(key, { ...r, state: 'failed', error });
    },
  };
}

/** A stub registry whose `resolve` is driven by a caller-supplied function. */
export function stubRegistry(resolve: CapabilityRegistry['resolve']): CapabilityRegistry {
  return {
    async register() {/* no-op */},
    async registerDiscovered() {
      return [];
    },
    async get() {
      return undefined;
    },
    resolve,
    async list() {
      return [];
    },
    async markHealth() {/* no-op */},
    async remove() {/* no-op */},
  };
}

export function makeStores(overrides: Partial<FabricStores> = {}): FabricStores {
  return {
    tasks: new FakeTaskStore(),
    sessions: new FakeSessionStore(),
    approvals: new FakeApprovalStore(),
    budget: new FakeBudgetStore(),
    idempotency: stubIdempotency(),
    receipts: stubReceipts(),
    audit: stubAudit(),
    events: stubEvents(),
    registry: stubRegistry(async () => {
      throw new Error('no capability registered');
    }),
    identity: stubIdentity(),
    evidence: stubEvidence(),
    ...overrides,
  };
}

/** A permission engine wired to a fake runtime, for the local preset bridge. */
export function makePermissionEngine(runtime: FakeRuntime, mode: import('@syaocode/core').PermissionMode = 'default'): PermissionEngine {
  return new PermissionEngine({
    mode,
    rules: [],
    workspaceRoots: ['/work'],
    runtime,
  });
}

export const noopTool: Tool = {
  name: 'noop',
  description: 'test tool',
  inputSchema: { parse: (v: unknown) => v } as unknown as Tool['inputSchema'],
  risk: 'read',
  readOnly: true,
  concurrencySafe: true,
  execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
};
