/**
 * Canonical IR — shared vocabulary of the Agent RPC Fabric (ARF).
 *
 * Three scopes (ADR-R2): Session → Task → Invocation.
 * Six core objects: Principal / Capability / Approval / Receipt / Event / Artifact.
 *
 * This file is the single source of truth for the TypeScript surface; the Zod
 * schemas in ./schemas.ts are the runtime source of truth (ADR-07 / P10).
 * Types here are `z.infer` re-exports so the two can never drift.
 *
 * Host-agnostic: no `node:` imports, no I/O (ADR-R11).
 */

import type { TaskState, InvocationState, ApprovalState } from './states.js';

export type {
  TaskState,
  InvocationState,
  ApprovalState,
  ApprovalOptionKind,
} from './states.js';

// ── protocol / direction ──────────────────────────────────────────────────

/** Wire protocol an invocation belongs to. `local` is a built-in tool. */
export type Protocol = 'mcp' | 'a2a' | 'acp' | 'native' | 'local';

/** Which way the call flows (02 §2.3). */
export type Direction = 'inbound' | 'outbound' | 'reverse';

/** Decision effect of the policy engine. */
export type Effect = 'allow' | 'deny' | 'ask';

// ── principals ────────────────────────────────────────────────────────────

export type PrincipalKind = 'user' | 'agent' | 'service' | 'anonymous';
export type TrustTier = 'first_party' | 'verified' | 'untrusted';

export interface Principal {
  /** `user:alice` / `agent:syao` / `service:ci`. */
  id: string;
  kind: PrincipalKind;
  tenantId: string;
  /** Coarse-grained scopes, e.g. `repo:read`. */
  scopes: string[];
  trustTier: TrustTier;
  displayName?: string;
}

/** Delegation token (02 §8.2) — audience-bound, monotonically shrinking. */
export interface DelegationToken {
  id: string;
  issuer: string;
  subject: string;
  audience: string;
  scopes: string[];
  constraints: {
    tenantId: string;
    workspaceRoots?: string[];
    maxSpendUsd?: number;
    maxHops?: number;
    expiresAt: string;
    approvalsRequired?: boolean;
  };
  budgetAccountId?: string;
  parentTokenId?: string;
  /** Local HMAC or JWS; verified by the identity service before use. */
  signature: string;
}

// ── capabilities ──────────────────────────────────────────────────────────

export type CapabilityKind = 'tool' | 'resource' | 'prompt' | 'agent_skill' | 'fs' | 'terminal';
export type Risk = 'read' | 'write' | 'execute' | 'network' | 'spend' | 'delegate';
export type SideEffect = 'none' | 'idempotent' | 'non_idempotent';
export type DataClass = 'public' | 'internal' | 'confidential' | 'secret';
export type Visibility = 'full' | 'summary' | 'opaque';

export interface Capability {
  /** Stable id, e.g. `mcp://github/tool/create_issue`. */
  id: string;
  kind: CapabilityKind;
  protocol: Exclude<Protocol, 'native'>;
  displayName: string;
  description?: string;
  inputSchemaRef?: string;
  outputSchemaRef?: string;
  /** Never taken from protocol annotations alone (I4 / G8). */
  risk: Risk;
  sideEffect: SideEffect;
  dataClass: DataClass;
  visibility: Visibility;
  reversible: boolean;
  provider: CapabilityProvider;
}

export interface CapabilityProvider {
  id: string;
  protocol: Exclude<Protocol, 'native'>;
  /** Internal endpoint — never shown to the model. */
  endpoint: string;
  version?: string;
  trust: TrustTier;
  health: HealthStatus;
  ttlMs: number;
  lastSeenAt: string;
}

export type HealthStatus = 'healthy' | 'degraded' | 'down';

export interface RegistryEntry {
  capability: Capability;
  labels: Record<string, string>;
}

/** A capability as returned by adapter discovery, before registration. */
export interface DiscoveredCapability {
  id: string;
  kind: CapabilityKind;
  displayName: string;
  description?: string;
  /** Raw JSON Schema as published by the remote (never a Zod object). */
  inputJsonSchema?: unknown;
  outputJsonSchema?: unknown;
  /** Advisory only — the registry decides the effective risk (I4). */
  declaredRisk?: Risk;
  annotations?: Record<string, unknown>;
}

export interface ResolvedCapability {
  capability: Capability;
  provider: CapabilityProvider;
  endpoint: string;
}

// ── sessions / tasks / invocations ────────────────────────────────────────

export type ProtocolBinding = 'mcp' | 'a2a' | 'acp' | 'native';

export interface Session {
  id: string;
  tenantId: string;
  principal: Principal;
  protocolBinding: ProtocolBinding;
  workspaceRoots: string[];
  policyRevision: string;
  budgetId: string;
  createdAt: string;
  updatedAt: string;
  state: 'open' | 'suspended' | 'closed';
  /** Primary approval authority for this session (02 §6.3). */
  approvalAuthority: ApprovalAuthorityKind;
  metadata?: Record<string, string>;
}

export interface Task {
  id: string;
  sessionId: string;
  tenantId: string;
  parentTaskId?: string;
  state: TaskState;
  /** Input content blocks (task creation payload). */
  input: TaskInputBlock[];
  artifacts: ArtifactRef[];
  createdAt: string;
  updatedAt: string;
  terminalReason?: string;
  /** Last applied event seq — the projection watermark. */
  lastSeq: number;
  /** Set while a cancel has been requested but not yet acknowledged. */
  cancelRequested?: boolean;
}

/** Minimal content block so the kernel stays independent of provider types. */
export type TaskInputBlock =
  | { type: 'text'; text: string }
  | { type: 'data'; mediaType: string; ref: string }
  | { type: 'protocol'; protocol: Exclude<Protocol, 'native'>; native: unknown };

export interface Invocation {
  id: string;
  taskId: string;
  capabilityId: string;
  principal: Principal;
  protocol: Protocol;
  direction: Direction;
  input: unknown;
  inputHash: string;
  idempotencyKey?: string;
  deadlineAt?: string;
  state: InvocationState;
  output?: unknown;
  outputHash?: string;
  error?: CanonicalErrorShape;
  createdAt: string;
  updatedAt: string;
  receiptId?: string;
}

// ── approvals ─────────────────────────────────────────────────────────────

export type ApprovalAuthorityKind = 'local' | 'delegated' | 'chain';

export type ApprovalSubjectKind = 'tool' | 'fs' | 'terminal' | 'network' | 'spend' | 'delegate';

export interface ApprovalSubject {
  kind: ApprovalSubjectKind;
  /** Kernel-authored one-liner; never raw remote text (01 §4.7.3 rule 6). */
  summary: string;
  /** Remote text is quarantined here and flagged untrusted. */
  detail?: string;
  detailTrust?: TrustTier;
  diff?: { path: string; before?: string; after: string };
  command?: { argv: string[]; cwd: string; timeoutMs?: number };
  resource?: { uri: string; operation: 'read' | 'write' | 'delete' };
  spend?: { amount: number; currency: string; budgetId: string };
  delegation?: { to: Principal; scopes: string[]; expiresAt: string };
}

export interface ApprovalOption {
  id: string;
  label: string;
  kind: import('./states.js').ApprovalOptionKind;
  scope?: { capabilityId?: string; pathPrefix?: string; commandPrefix?: string; expiresAt?: string };
}

export interface ApprovalRecord {
  id: string;
  tenantId: string;
  taskId: string;
  invocationId?: string;
  subject: ApprovalSubject;
  options: ApprovalOption[];
  authority: ApprovalAuthorityKind;
  delegationChain: string[];
  policyRevision: string;
  /** Bumped on every recheck/update; CAS precondition. */
  revision: number;
  state: ApprovalState;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionOptionId?: string;
  decisionReason?: string;
  /** True for sensitive paths: never rememberable (BR: one-shot). */
  sensitive: boolean;
}

export interface ApprovalDecision {
  optionId: string;
  by: string;
  reason?: string;
}

// ── policy ────────────────────────────────────────────────────────────────

export interface PolicyInput {
  principal: Principal;
  session: Session;
  task?: Task;
  capability: Capability;
  input: unknown;
  inputHash: string;
  context: {
    protocol: Protocol;
    direction: Direction;
    workspaceRoots: string[];
    cwd: string;
    now: string;
    trust: TrustTier;
    dataClass: DataClass;
  };
  budget: { accountId: string; remainingUsd?: number; remainingTokens?: number };
  approvalHistory: { capabilityId: string; scope?: string; expiresAt?: string }[];
}

export type Obligation =
  | { type: 'require_approval'; options?: ApprovalOption[] }
  | { type: 'redact'; classes: ('secret' | 'confidential')[] }
  | { type: 'max_output_bytes'; bytes: number }
  | { type: 'sandbox'; level: 'none' | 'process' | 'container' }
  | { type: 'network_allowlist'; hosts: string[] }
  | { type: 'audit_level'; level: 'basic' | 'full' }
  | { type: 'no_retry' }
  | { type: 'ttl'; ms: number }
  | { type: 'delegation_limit'; maxHops: number; maxSpendUsd?: number };

export interface PolicyDecision {
  id: string;
  effect: Effect;
  reason: string;
  policyRevision: string;
  obligations: Obligation[];
  ttlMs?: number;
  explain?: PolicyTrace;
}

export interface PolicyTrace {
  matchedRules: { id: string; effect: Effect; source: string }[];
  deniedBy?: string;
  askedBy?: string;
  obligations: Obligation[];
  effectiveMode: string;
  revision: string;
}

export interface PolicyRuleMatch {
  tenants?: string[];
  principals?: string[];
  capabilities?: string[];
  protocols?: Protocol[];
  directions?: Direction[];
  risk?: Risk[];
  dataClasses?: DataClass[];
  paths?: string[];
  commands?: string[];
  urls?: string[];
}

export interface PolicyRule {
  id: string;
  /** Lower runs first. */
  priority: number;
  effect: Effect;
  match: PolicyRuleMatch;
  obligations?: Obligation[];
  source: 'org' | 'project' | 'user' | 'session' | 'code';
  reason?: string;
}

export interface PolicyBundle {
  schemaVersion: 1;
  revision: string;
  tenantId: string;
  defaultEffect: Effect;
  rules: PolicyRule[];
  /** Present for signed org bundles; verified before use. */
  signature?: string;
  expiresAt?: string;
}

// ── budget ────────────────────────────────────────────────────────────────

export interface BudgetAccount {
  id: string;
  tenantId: string;
  parentId?: string;
  currency: 'USD';
  limitUsd?: number;
  reservedUsd: number;
  spentUsd: number;
  tokenLimit?: number;
  tokensUsed: number;
  timeLimitMs?: number;
  timeUsedMs: number;
  toolCallLimit?: number;
  toolCallsUsed: number;
  state: 'active' | 'frozen' | 'closed';
}

export interface BudgetEstimate {
  usd: number;
  tokens?: number;
  timeMs?: number;
  toolCalls?: number;
}

export interface BudgetReservation {
  id: string;
  accountId: string;
  /** tenant → … → task account ids, outermost first. */
  accountChain: string[];
  estimate: BudgetEstimate;
  createdAt: string;
  expiresAt: string;
  state: 'held' | 'settled' | 'released';
  settledUsd?: number;
}

export interface UsageReport {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  timeMs?: number;
  toolCalls?: number;
}

// ── idempotency ───────────────────────────────────────────────────────────

export interface IdempotencyRecord {
  key: string;
  requestHash: string;
  state: 'in_flight' | 'completed' | 'failed';
  resultRef?: string;
  result?: unknown;
  error?: CanonicalErrorShape;
  createdAt: string;
  expiresAt: string;
}

// ── evidence ──────────────────────────────────────────────────────────────

export interface CostBreakdown {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface ArtifactRef {
  id: string;
  hash: string;
  mediaType?: string;
  ref?: string;
  bytes?: number;
}

export interface Artifact {
  id: string;
  taskId: string;
  tenantId: string;
  parts: { mediaType: string; hash: string; ref?: string; text?: string }[];
  hash: string;
  createdAt: string;
}

export interface Receipt {
  id: string;
  tenantId: string;
  taskId: string;
  invocationId: string;
  protocol: Protocol;
  capabilityId: string;
  principalId: string;
  delegationChain: string[];
  outcome: InvocationState;
  inputHash: string;
  outputHash?: string;
  artifacts: ArtifactRef[];
  approvals: string[];
  policy: { revision: string; decisionId: string; effect: Effect; obligations: string[] };
  usage?: CostBreakdown;
  timing: { queuedAt: string; startedAt: string; endedAt: string };
  visibility: Visibility;
  lossy?: string[];
  prevHash?: string;
  hash: string;
}

export interface EvidenceCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface EvidenceBundle {
  schemaVersion: 1;
  taskId: string;
  tenantId: string;
  createdAt: string;
  receipts: Receipt[];
  approvals: ApprovalRecord[];
  policySnapshots: { revision: string; rulesHash: string; bundleRef?: string }[];
  artifacts: ArtifactRef[];
  verification: { verdict: 'verified' | 'unverified' | 'failed'; checks: EvidenceCheck[] };
  rootHash: string;
  signature?: string;
}

// ── audit ─────────────────────────────────────────────────────────────────

export interface AuditEvent {
  id: string;
  ts: string;
  tenantId: string;
  actor: { type: 'user' | 'agent' | 'service' | 'system'; id: string };
  action: string;
  subject: { type: string; id: string };
  outcome: 'success' | 'failure' | 'denied';
  policyRevision?: string;
  detailHash?: string;
  prevHash: string;
  hash: string;
}

export interface AuditCheckpoint {
  tenantId: string;
  at: string;
  count: number;
  lastHash: string;
  checkpointHash: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  checked: number;
  brokenAt?: string;
  reason?: string;
}

// ── canonical errors ──────────────────────────────────────────────────────

/** Machine-readable failure classes (01 §5 / G10). */
export type CanonicalErrorKind =
  | 'invalid_request'
  | 'unauthenticated'
  | 'unauthorized'
  | 'denied'
  | 'capability_not_found'
  | 'unsupported_capability'
  | 'unsupported_obligation'
  | 'version_mismatch'
  | 'idempotency_conflict'
  | 'in_flight'
  | 'budget_exceeded'
  | 'timed_out'
  | 'cancelled'
  | 'indeterminate'
  | 'remote_error'
  | 'internal';

export interface CanonicalErrorShape {
  kind: CanonicalErrorKind;
  /** Registry code (`SY-*`) when one applies. */
  code?: string;
  message: string;
  retryable: boolean;
  /** Raw protocol error, preserved verbatim (adapters must not swallow it). */
  protocolError?: unknown;
  details?: Record<string, unknown>;
}

// ── canonical events ──────────────────────────────────────────────────────

export type CanonicalEventType =
  | 'task.created'
  | 'task.state_changed'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.plan'
  | 'invocation.proposed'
  | 'invocation.started'
  | 'invocation.output_delta'
  | 'invocation.completed'
  | 'invocation.failed'
  | 'invocation.denied'
  | 'approval.requested'
  | 'approval.resolved'
  | 'approval.expired'
  | 'capability.discovered'
  | 'capability.unavailable'
  | 'artifact.created'
  | 'artifact.updated'
  | 'policy.decision'
  | 'budget.reserved'
  | 'budget.settled'
  | 'budget.exceeded'
  | 'receipt.issued'
  | 'evidence.sealed'
  | 'evidence.verified'
  | 'session.mode_changed'
  | 'session.config_changed'
  | 'session.metadata_changed'
  | 'notice';

export interface CanonicalEvent<T = unknown> {
  schemaVersion: 1;
  eventId: string;
  /** Monotonic per task, starting at 1, gap-free. */
  seq: number;
  taskId: string;
  invocationId?: string;
  causationId?: string;
  correlationId: string;
  ts: string;
  principalId: string;
  protocol: Exclude<Protocol, 'local'>;
  type: CanonicalEventType;
  payload: T;
}

// ── adapter capability matrix ─────────────────────────────────────────────

export interface AdapterCapabilities {
  protocol: 'mcp' | 'a2a' | 'acp';
  version: string;
  supports: {
    session: boolean;
    task: boolean;
    streaming: boolean;
    push: boolean;
    approvalOptions: boolean;
    artifacts: boolean;
    reverseCalls: boolean;
    cancellation: boolean;
  };
  /** Semantics this protocol cannot express; UI and audit must surface it. */
  lossy: string[];
}
