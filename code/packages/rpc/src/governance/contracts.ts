/**
 * Governance contracts — the frozen interface set of the ARF kernel.
 *
 * Everything the dispatcher orchestrates is declared here so that the policy,
 * approval, budget, idempotency, evidence, audit, registry and store
 * implementations can be developed and tested independently.
 *
 * Rule (P1 / I13): adapters and callers depend on these interfaces, never on a
 * concrete implementation, and never on a raw tool/endpoint handle.
 */

import type { IdGenerator, Logger, Runtime } from '@syaocode/core';
import type {
  AdapterCapabilities,
  ApprovalDecision,
  ApprovalRecord,
  ApprovalSubject,
  AuditEvent,
  AuditVerifyResult,
  BudgetAccount,
  BudgetEstimate,
  BudgetReservation,
  CanonicalErrorShape,
  CanonicalEvent,
  Capability,
  DataClass,
  DelegationToken,
  Direction,
  DiscoveredCapability,
  Effect,
  HealthStatus,
  IdempotencyRecord,
  Obligation,
  PolicyDecision,
  PolicyInput,
  Principal,
  Protocol,
  Receipt,
  RegistryEntry,
  ResolvedCapability,
  Risk,
  Session,
  SideEffect,
  Task,
  TaskState,
  TrustTier,
  UsageReport,
  Visibility,
} from '../ir/types.js';

/**
 * Re-exported IR types that appear in this contract surface, so a consumer can
 * import everything it needs from the contract module.
 */
export type {
  AdapterCapabilities,
  ApprovalDecision,
  ApprovalOption,
  ApprovalRecord,
  ApprovalSubject,
  AuditEvent,
  AuditVerifyResult,
  BudgetAccount,
  BudgetEstimate,
  BudgetReservation,
  CanonicalErrorShape,
  CanonicalEvent,
  Capability,
  DataClass,
  DelegationToken,
  Direction,
  DiscoveredCapability,
  Effect,
  HealthStatus,
  IdempotencyRecord,
  Obligation,
  PolicyDecision,
  PolicyInput,
  Principal,
  Protocol,
  Receipt,
  RegistryEntry,
  ResolvedCapability,
  Risk,
  Session,
  SideEffect,
  Task,
  TaskState,
  TrustTier,
  UsageReport,
  Visibility,
} from '../ir/types.js';

// ── injected primitives ───────────────────────────────────────────────────

/**
 * Cryptographic digest used by the audit/evidence hash chains (C6).
 *
 * Injected rather than imported so the kernel stays host-agnostic; hosts pass
 * SHA-256. `contentHash` from core (FNV-1a) is explicitly NOT acceptable here.
 */
export interface Hasher {
  sha256(text: string): string;
}

/** Everything the kernel needs from the host, bundled for convenience. */
export interface KernelContext {
  runtime: Runtime;
  hash: Hasher;
  ids: IdGenerator;
  logger: Logger;
}

/**
 * Structural redaction contract (I7).
 *
 * Declared here rather than importing core's `Redactor` class so the kernel
 * depends on a shape, not on a class identity — core's `Redactor` satisfies it
 * structurally, and hosts may inject their own.
 */
export interface SecretRedactor {
  /** Register a concrete secret value so exact matches are scrubbed. */
  register(value: string, type?: string): void;
  redact(text: string): { text: string; hits: string[] };
  redactValue<T>(value: T): { value: T; hits: string[] };
}

// ── policy ────────────────────────────────────────────────────────────────

export interface PolicyEngine {
  /** Current bundle revision; changes invalidate caches and pending approvals. */
  readonly revision: string;
  evaluate(input: PolicyInput): Promise<PolicyDecision>;
  /** Decision trace for `policy explain` / audit; never leaks other tenants. */
  explain(input: PolicyInput): Promise<PolicyDecision>;
  /** Drop cached decisions (called when the bundle changes). */
  invalidate(): void;
}

export interface PolicyEngineOptions {
  bundle: import('../ir/types.js').PolicyBundle;
  /** Preset that maps the existing PermissionEngine modes onto rules. */
  localPreset?: LocalPolicyPreset;
}

/** Bridge to the existing `PermissionEngine` (02 §5.6: wrap, then replace). */
export interface LocalPolicyPreset {
  /** Evaluate a local tool call through core's deterministic engine. */
  evaluateLocal(input: PolicyInput): Promise<{ effect: Effect; reason: string }>;
  readonly mode: string;
}

// ── approvals ─────────────────────────────────────────────────────────────

export interface ApprovalRequest {
  tenantId: string;
  taskId: string;
  invocationId?: string;
  /** Binding: what this approval authorizes. */
  capabilityId?: string;
  inputHash?: string;
  subject: ApprovalSubject;
  options?: import('../ir/types.js').ApprovalOption[];
  authority: ApprovalRecord['authority'];
  delegationChain?: string[];
  policyRevision: string;
  timeoutMs?: number;
  sensitive?: boolean;
}

export interface ApprovalOutcome {
  approvalId: string;
  state: 'allowed' | 'denied' | 'expired' | 'cancelled';
  optionId?: string;
  decidedBy?: string;
  reason?: string;
}

/**
 * The approval surface an adapter is allowed to see: it may ask, and it may
 * read the queue, but it may not decide (02 §12.2 / I13).
 */
export interface ApprovalRequester {
  request(req: ApprovalRequest): Promise<ApprovalOutcome>;
  get(approvalId: string): Promise<ApprovalRecord | undefined>;
  listPending(filter?: { tenantId?: string; taskId?: string }): Promise<ApprovalRecord[]>;
}

export interface ApprovalBroker extends ApprovalRequester {
  /**
   * CAS decision; returns false when another authority already decided, when
   * the record expired, or when the decider is not entitled to it (I9).
   */
  decide(approvalId: string, expectedRevision: number, decision: ApprovalDecision): Promise<boolean>;
  /** Cancel every pending approval of a task (cancel propagation, 02 §9.3). */
  cancelForTask(taskId: string, reason: string): Promise<number>;
  /** Re-evaluate pending approvals after a policy revision change (recheck). */
  recheck(taskId: string): Promise<number>;
}

export interface ApprovalStore {
  insert(record: ApprovalRecord): Promise<void>;
  get(id: string, tenantId?: string): Promise<ApprovalRecord | undefined>;
  list(filter?: { tenantId?: string; taskId?: string; state?: ApprovalRecord['state'] }): Promise<ApprovalRecord[]>;
  /** Compare-and-set on `revision`; false when the record moved on. */
  decide(id: string, expectedRevision: number, patch: Partial<ApprovalRecord>): Promise<boolean>;
  /** Flip pending records past `expiresAt` to `expired`; returns how many. */
  expire(nowIso: string): Promise<number>;
}

// ── budget ────────────────────────────────────────────────────────────────

export interface ReserveRequest {
  accountId: string;
  estimate?: BudgetEstimate;
  ttlMs?: number;
  /** Correlation only; never used as an authorization input. */
  invocationId?: string;
}

export interface BudgetLedger {
  ensureAccount(account: Omit<BudgetAccount, 'reservedUsd' | 'spentUsd' | 'tokensUsed' | 'timeUsedMs' | 'toolCallsUsed'>): Promise<BudgetAccount>;
  get(accountId: string): Promise<BudgetAccount | undefined>;
  /** Non-binding availability probe used before asking for approval. */
  canAfford(accountId: string, estimate: BudgetEstimate): Promise<boolean>;
  /** Freeze `estimate` across the whole ancestor chain, or throw. */
  reserve(req: ReserveRequest): Promise<BudgetReservation>;
  /** Settle against actual usage; idempotent per reservation id. */
  settle(reservationId: string, usage: UsageReport, receiptId?: string): Promise<BudgetReservation>;
  /** Release a hold (cancellation, failure before dispatch). */
  release(reservationId: string): Promise<BudgetReservation>;
  /** Crash recovery: release holds past their TTL. */
  recoverExpired(nowIso: string): Promise<number>;
  list(tenantId: string): Promise<BudgetAccount[]>;
}

export interface BudgetStore {
  get(id: string): Promise<BudgetAccount | undefined>;
  put(account: BudgetAccount): Promise<void>;
  list(tenantId: string): Promise<BudgetAccount[]>;
  getReservation(id: string): Promise<BudgetReservation | undefined>;
  putReservation(reservation: BudgetReservation): Promise<void>;
  listReservations(filter?: { state?: BudgetReservation['state']; accountId?: string }): Promise<BudgetReservation[]>;
}

// ── idempotency ───────────────────────────────────────────────────────────

export type IdempotencyBegin =
  | { kind: 'new'; record: IdempotencyRecord }
  | { kind: 'replay'; record: IdempotencyRecord }
  | { kind: 'in_flight'; record: IdempotencyRecord }
  | { kind: 'conflict'; record: IdempotencyRecord };

export interface IdempotencyStore {
  /**
   * Atomic begin; decides new/replay/in_flight/conflict from key + hash.
   *
   * A previous attempt that failed is only retryable when the failure was
   * retryable AND the capability is not non-idempotent AND the outcome was
   * known. Otherwise `conflict` is returned: a retry of an unknown-outcome
   * side effect would duplicate it (I10 / ADR-R6).
   */
  begin(key: string, requestHash: string, ttlMs?: number): Promise<IdempotencyBegin>;
  get(key: string): Promise<IdempotencyRecord | undefined>;
  complete(key: string, result: unknown, resultRef?: string): Promise<void>;
  fail(
    key: string,
    error: CanonicalErrorShape,
    meta?: { retryable?: boolean; sideEffect?: SideEffect; outcome?: string },
  ): Promise<void>;
}

// ── evidence ──────────────────────────────────────────────────────────────

export interface ReceiptStore {
  /**
   * Append to the per-task hash chain and return the stored receipt.
   *
   * The caller supplies the receipt WITHOUT `hash`/`prevHash`: only the store
   * knows the current chain head, so it is the store that seals the link
   * (`prevHash` = head hash, `hash` = H(receipt minus hash + prevHash)).
   */
  put(receipt: Omit<Receipt, 'hash' | 'prevHash'>): Promise<Receipt>;
  /** `tenantId` narrows the read when supplied (I8). */
  get(id: string, tenantId?: string): Promise<Receipt | undefined>;
  listByTask(taskId: string, tenantId?: string): Promise<Receipt[]>;
  /** Head of the task's chain (for `prevHash`). */
  head(taskId: string, tenantId?: string): Promise<Receipt | undefined>;
}

export interface EvidenceSealer {
  /** `tenantId` narrows the seal to one tenant when supplied (I8). */
  seal(taskId: string, tenantId?: string): Promise<import('../ir/types.js').EvidenceBundle>;
  verify(bundle: import('../ir/types.js').EvidenceBundle): Promise<{ ok: boolean; checks: import('../ir/types.js').EvidenceCheck[] }>;
}

// ── audit ─────────────────────────────────────────────────────────────────

export interface AuditStore {
  /** `id` is assigned by the store when omitted (02 §10.1). */
  append(event: Omit<AuditEvent, 'prevHash' | 'hash' | 'id'> & { id?: string }): Promise<AuditEvent>;
  list(filter?: { tenantId?: string; from?: string; limit?: number }): Promise<AuditEvent[]>;
  verify(tenantId: string, fromCheckpoint?: string): Promise<AuditVerifyResult>;
  checkpoint(tenantId: string): Promise<import('../ir/types.js').AuditCheckpoint>;
}

// ── registry / routing ────────────────────────────────────────────────────

export interface RouteConstraints {
  tenantId: string;
  protocolPreference?: ('mcp' | 'a2a' | 'acp' | 'local')[];
  maxCostUsd?: number;
  requireTrust?: TrustTier;
  requireVersion?: string;
  excludeProviders?: string[];
}

export interface CapabilityRegistry {
  register(entry: RegistryEntry): Promise<void>;
  /** Register adapter discovery output; risk comes from the registry, not the peer. */
  registerDiscovered(
    provider: { id: string; protocol: 'mcp' | 'a2a' | 'acp' | 'local'; endpoint: string; version?: string; trust: TrustTier; ttlMs: number },
    discovered: DiscoveredCapability[],
    defaults?: { risk?: Risk; sideEffect?: SideEffect; dataClass?: DataClass; visibility?: Visibility; reversible?: boolean },
  ): Promise<Capability[]>;
  /** `tenantId` narrows the read when supplied (I8). */
  get(capabilityId: string, tenantId?: string): Promise<RegistryEntry | undefined>;
  resolve(capabilityId: string, constraints: RouteConstraints): Promise<ResolvedCapability>;
  list(filter?: { kind?: Capability['kind']; protocol?: string; q?: string; tenantId?: string }): Promise<Capability[]>;
  markHealth(providerId: string, health: HealthStatus): Promise<void>;
  remove(capabilityId: string): Promise<void>;
}

// ── identity ──────────────────────────────────────────────────────────────

export interface AuthenticatedCaller {
  principal: Principal;
  delegationChain: string[];
}

export interface IdentityService {
  /** Authenticate a transport credential or the local session principal. */
  authenticate(credential: TransportCredential): Promise<AuthenticatedCaller>;
  issueDelegation(token: Omit<DelegationToken, 'signature' | 'id'>): Promise<DelegationToken>;
  verifyDelegation(token: DelegationToken, audience: string): Promise<AuthenticatedCaller>;
}

export type TransportCredential =
  | { kind: 'local'; principal: Principal }
  | { kind: 'bearer'; token: string; tenantId: string }
  | { kind: 'delegation'; token: DelegationToken };

// ── event log ─────────────────────────────────────────────────────────────

/**
 * An event as produced by a caller: the log owns `seq`, `eventId` and `ts`,
 * because only the log can guarantee a gap-free per-task sequence.
 */
export type EventDraft = Omit<CanonicalEvent, 'seq' | 'eventId' | 'ts' | 'schemaVersion'> & {
  schemaVersion?: 1;
  ts?: string;
};

export interface EventLog {
  /**
   * Append with the next gap-free seq for the task; returns the stamped event.
   * `seq`, `eventId` and `ts` are assigned by the log; `schemaVersion`
   * defaults to 1.
   */
  append(event: EventDraft): Promise<CanonicalEvent>;
  list(taskId: string, afterSeq?: number): Promise<CanonicalEvent[]>;
  snapshot(taskId: string): Promise<{ task?: Task; lastSeq: number }>;
  subscribe?(taskId: string, afterSeq: number): AsyncIterable<CanonicalEvent>;
}

// ── task store ────────────────────────────────────────────────────────────

export interface TaskStore {
  create(task: Task): Promise<void>;
  get(taskId: string, tenantId: string): Promise<Task | undefined>;
  put(task: Task): Promise<void>;
  list(filter: { tenantId: string; sessionId?: string; state?: TaskState; limit?: number }): Promise<Task[]>;
  /** All tasks that never reached a terminal state (crash recovery). */
  listUnterminated(tenantId: string): Promise<Task[]>;
  delete(taskId: string, tenantId: string): Promise<void>;
}

export interface SessionStore {
  create(session: Session): Promise<void>;
  get(sessionId: string, tenantId: string): Promise<Session | undefined>;
  put(session: Session): Promise<void>;
  list(tenantId: string): Promise<Session[]>;
}

/**
 * Every pluggable store the fabric needs, bundled so a host can swap the whole
 * storage面 in one argument. `createMemoryStores()` in `runtime/stores.ts` is
 * the default (single-process) implementation.
 */
export interface FabricStores {
  tasks: TaskStore;
  sessions: SessionStore;
  approvals: ApprovalStore;
  budget: BudgetStore;
  idempotency: IdempotencyStore;
  receipts: ReceiptStore;
  audit: AuditStore;
  events: EventLog;
  registry: CapabilityRegistry;
  identity: IdentityService;
  evidence: EvidenceSealer;
}

export interface MemoryStoresOptions {
  ids: IdGenerator;
  /** ISO clock. */
  now: () => string;
  hash: Hasher;
  /** Audit checkpoint cadence; default 1000 events (02 §10.1). */
  checkpointEvery?: number;
}

/** Build the default in-memory store bundle. Implemented in runtime/stores.ts. */
export type CreateMemoryStores = (opts: MemoryStoresOptions) => FabricStores;

// ── dispatcher ────────────────────────────────────────────────────────────

export interface InvokeRequest {
  principal: Principal;
  capabilityId: string;
  input: unknown;
  protocol: Protocol;
  direction: Direction;
  taskId?: string;
  sessionId?: string;
  idempotencyKey?: string;
  deadlineAt?: string;
  approvalAuthority?: ApprovalRecord['authority'];
  /**
   * Budget exemption. The caller may only ASK; the dispatcher grants it for
   * free read-only capabilities and ignores it otherwise, so a caller cannot
   * switch off the ledger (I6).
   */
  skipBudget?: boolean;
  /** Credential used to authenticate the call (defaults to the local principal). */
  credential?: TransportCredential;
  /** Cancellation signal propagated to the executor (and to the adapter). */
  signal?: AbortSignal;
}

export interface DispatchContext {
  session?: Session;
  /**
   * The tenant of the calling host. When present the dispatcher REQUIRES
   * `principal.tenantId` and `session.tenantId` to match it, so a caller cannot
   * name someone else's tenant in the principal it supplies (I1).
   */
  tenantId?: string;
  cwd: string;
  workspaceRoots: string[];
  signal?: AbortSignal;
  correlationId?: string;
  /** Sink for canonical events produced by this dispatch. */
  emit?: (event: CanonicalEvent) => void;
  /** When true the dispatcher does not create a task for a task-less call. */
  ephemeralTask?: boolean;
  /** Estimated cost used for the budget reservation. */
  estimate?: BudgetEstimate;
}

export interface InvokeResult {
  invocationId: string;
  taskId: string;
  receiptId: string;
  outcome: import('../ir/types.js').InvocationState;
  output?: unknown;
  error?: CanonicalErrorShape;
  /** True when the result came from the idempotency cache. */
  replayed?: boolean;
  approvalIds: string[];
  /** Adapter-reported semantic gaps, surfaced to UI and audit. */
  lossy?: string[];
}

/** Handed to adapters: authorized, budgeted, obligated, but not yet executed. */
export interface AuthorizedInvocation {
  invocationId: string;
  taskId: string;
  sessionId: string;
  tenantId: string;
  capability: Capability;
  endpoint: string;
  input: unknown;
  inputHash: string;
  principal: Principal;
  protocol: Protocol;
  direction: Direction;
  deadlineAt?: string;
  obligations: Obligation[];
  visibility: Visibility;
  idempotencyKey?: string;
  /** Budget reservation already held for this invocation. */
  reservationId?: string;
}

export interface DispatcherDeps {
  kernel: KernelContext;
  policy: PolicyEngine;
  approvals: ApprovalBroker;
  budget: BudgetLedger;
  idempotency: IdempotencyStore;
  receipts: ReceiptStore;
  audit: AuditStore;
  registry: CapabilityRegistry;
  identity: IdentityService;
  tasks: TaskStore;
  sessions: SessionStore;
  events: EventLog;
  redactor?: SecretRedactor;
  /** Executes an authorized invocation; the only path to a real side effect. */
  execute: (invocation: AuthorizedInvocation, ctx: DispatchContext) => Promise<InvokeResultPayload>;
  /** Optional hook so tests and the CLI can observe each pipeline step. */
  onStep?: (step: DispatchStep, detail: Record<string, unknown>) => void;
}

export interface InvokeResultPayload {
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'indeterminate';
  output?: unknown;
  error?: CanonicalErrorShape;
  usage?: UsageReport;
  lossy?: string[];
  artifacts?: import('../ir/types.js').ArtifactRef[];
}

export type DispatchStep =
  | 'normalize'
  | 'authenticate'
  | 'resolve'
  | 'idempotency'
  | 'authorize'
  | 'approve'
  | 'reserve'
  | 'dispatch'
  | 'settle'
  | 'receipt';

export const DISPATCH_STEPS: readonly DispatchStep[] = [
  'normalize', 'authenticate', 'resolve', 'idempotency', 'authorize',
  'approve', 'reserve', 'dispatch', 'settle', 'receipt',
];

export interface Dispatcher {
  invoke(req: InvokeRequest, ctx: DispatchContext): Promise<InvokeResult>;
  /** Create a task without invoking anything (A2A SendMessage, ACP session/prompt). */
  createTask(input: { sessionId: string; tenantId: string; principal: Principal; blocks: Task['input']; parentTaskId?: string }): Promise<Task>;
  cancelTask(taskId: string, reason: string): Promise<Task>;
  getTask(taskId: string, tenantId: string): Promise<Task | undefined>;
  listTasks(filter: { tenantId: string; sessionId?: string; state?: TaskState; limit?: number }): Promise<Task[]>;
}

// ── adapter contract (01 §6.1, 02 §12.1) ──────────────────────────────────

export interface AdapterContext {
  runtime: Runtime;
  signal: AbortSignal;
  deadlineAt: string;
  /**
   * Record a canonical event for this task. Adapters pass a DRAFT — the event
   * log assigns `seq`/`eventId`/`ts`, so an adapter can never break the
   * gap-free sequence the replay contract depends on.
   */
  append(event: EventDraft): Promise<CanonicalEvent>;
  /**
   * Request an approval. Deliberately NOT the full broker: 02 §12.2 forbids an
   * adapter from deciding allow/deny, so the deciding half is not exposed here.
   */
  approval: ApprovalRequester;
  redactor: SecretRedactor;
  logger: Logger;
}

export interface ProtocolAdapter {
  readonly protocol: 'mcp' | 'a2a' | 'acp';
  readonly version: string;
  capabilities(): AdapterCapabilities;
  discover(ctx: AdapterContext): Promise<DiscoveredCapability[]>;
  invoke(req: AuthorizedInvocation, ctx: AdapterContext): Promise<InvokeResultPayload>;
  subscribe?(taskId: string, afterSeq: number, ctx: AdapterContext): AsyncIterable<CanonicalEvent>;
  cancel?(taskId: string, reason: string, ctx: AdapterContext): Promise<void>;
  respondApproval?(approvalId: string, decision: ApprovalDecision, ctx: AdapterContext): Promise<void>;
  health(): Promise<HealthStatus>;
  close(): Promise<void>;
}

/** Structural check that an object satisfies the adapter contract. */
export function assertAdapterShape(value: unknown, label = 'adapter'): asserts value is ProtocolAdapter {
  const a = value as Partial<ProtocolAdapter> | null;
  if (a === null || typeof a !== 'object') throw new Error(`${label} is not an object`);
  for (const method of ['capabilities', 'discover', 'invoke', 'health', 'close'] as const) {
    if (typeof a[method] !== 'function') throw new Error(`${label} is missing ${method}()`);
  }
  if (a.protocol !== 'mcp' && a.protocol !== 'a2a' && a.protocol !== 'acp') {
    throw new Error(`${label} has an invalid protocol`);
  }
}
