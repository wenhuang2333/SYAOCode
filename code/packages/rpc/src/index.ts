/**
 * @syaocode/rpc — the ARF (Agent RPC Fabric) governance kernel.
 *
 * Public API, grouped the same way as @syaocode/core. Host-agnostic: the only
 * imports are `zod` and `@syaocode/core`; all IO arrives through `Runtime`.
 *
 * Design references (document/Agent-RPC/):
 *   01 §4   Canonical IR, state machines
 *   02 §4   ten-step governance pipeline
 *   02 §3   invariants I1–I13
 *   03 §3   package layout
 */

// ── canonical IR ──────────────────────────────────────────────────────────
export type {
  AdapterCapabilities,
  ApprovalAuthorityKind,
  ApprovalDecision,
  ApprovalOption,
  ApprovalRecord,
  ApprovalState,
  ApprovalSubject,
  ApprovalSubjectKind,
  Artifact,
  ArtifactRef,
  AuditCheckpoint,
  AuditEvent,
  AuditVerifyResult,
  BudgetAccount,
  BudgetEstimate,
  BudgetReservation,
  CanonicalErrorKind,
  CanonicalErrorShape,
  CanonicalEvent,
  CanonicalEventType,
  Capability,
  CapabilityKind,
  CapabilityProvider,
  CostBreakdown,
  DataClass,
  DelegationToken,
  Direction,
  DiscoveredCapability,
  Effect,
  EvidenceBundle,
  EvidenceCheck,
  HealthStatus,
  IdempotencyRecord,
  Invocation,
  InvocationState,
  Obligation,
  PolicyBundle,
  PolicyDecision,
  PolicyInput,
  PolicyRule,
  PolicyRuleMatch,
  PolicyTrace,
  Principal,
  PrincipalKind,
  Protocol,
  ProtocolBinding,
  Receipt,
  RegistryEntry,
  ResolvedCapability,
  Risk,
  Session,
  SideEffect,
  Task,
  TaskInputBlock,
  TaskState,
  TrustTier,
  UsageReport,
  Visibility,
} from './ir/types.js';

export {
  APPROVAL_STATES,
  INVOCATION_STATES,
  INVOCATION_TERMINAL,
  TASK_STATES,
  TASK_TERMINAL,
  TASK_WAITING,
  TASK_TO_A2A,
  TASK_TO_ACP_STOP,
  TASK_TO_MCP,
  assertApprovalTransition,
  assertInvocationTransition,
  assertTaskTransition,
  canTransitionApproval,
  canTransitionInvocation,
  canTransitionTask,
  isApprovalTerminal,
  isInvocationTerminal,
  isTaskTerminal,
  nextInvocationStates,
  nextTaskStates,
} from './ir/states.js';
export type { ApprovalOptionKind } from './ir/states.js';

export {
  canonicalJson,
  parseCanonical,
  parseWith,
} from './ir/schemas.js';
export {
  adapterCapabilitiesSchema,
  approvalRecordSchema,
  approvalSubjectSchema,
  auditEventSchema,
  budgetAccountSchema,
  budgetEstimateSchema,
  budgetReservationSchema,
  canonicalErrorShapeSchema,
  canonicalEventSchema,
  canonicalEventTypeSchema,
  capabilitySchema,
  dataClassSchema,
  delegationTokenSchema,
  directionSchema,
  discoveredCapabilitySchema,
  effectSchema,
  evidenceBundleSchema,
  idempotencyRecordSchema,
  invocationSchema,
  obligationSchema,
  policyBundleSchema,
  policyRuleSchema,
  principalSchema,
  protocolSchema,
  receiptSchema,
  riskSchema,
  sessionSchema,
  taskInputBlockSchema,
  taskSchema,
  taskStateSchema,
  usageReportSchema,
  visibilitySchema,
} from './ir/schemas.js';

export {
  ID_PREFIX,
  acpCapabilityId,
  a2aCapabilityId,
  deterministicIds,
  isId,
  localCapabilityId,
  mcpCapabilityId,
  mcpToolName,
  newId,
  parseCapabilityId,
  parseMcpToolName,
} from './ir/ids.js';
export type { IdKind, ParsedCapabilityId } from './ir/ids.js';

export {
  A2A_ERROR_CODES,
  ACP_ERROR_CODES,
  CanonicalError,
  EXIT,
  MCP_ERROR_CODES,
  canonicalFromJsonRpcError,
  defaultWireCode,
  retryVerdict,
} from './ir/errors.js';
export type { CanonicalErrorInit, RetryVerdict } from './ir/errors.js';

// ── governance contracts ──────────────────────────────────────────────────
export {
  DISPATCH_STEPS,
  assertAdapterShape,
} from './governance/contracts.js';
export type {
  AdapterContext,
  ApprovalBroker,
  ApprovalOutcome,
  ApprovalRequest,
  ApprovalStore,
  AuditStore,
  AuthenticatedCaller,
  AuthorizedInvocation,
  BudgetLedger,
  BudgetStore,
  CapabilityRegistry,
  CreateMemoryStores,
  DispatchContext,
  DispatchStep,
  Dispatcher,
  DispatcherDeps,
  EventLog,
  EvidenceSealer,
  FabricStores,
  Hasher,
  IdentityService,
  IdempotencyBegin,
  IdempotencyStore,
  InvokeRequest,
  InvokeResult,
  InvokeResultPayload,
  KernelContext,
  LocalPolicyPreset,
  MemoryStoresOptions,
  PolicyEngine,
  PolicyEngineOptions,
  ProtocolAdapter,
  ReceiptStore,
  ReserveRequest,
  RouteConstraints,
  SecretRedactor,
  SessionStore,
  TaskStore,
  TransportCredential,
} from './governance/contracts.js';

// ── governance engines ────────────────────────────────────────────────────
export {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_MAX_APPROVAL_ROUNDS,
  ApprovalBrokerImpl,
  defaultApprovalOptions,
  isAllowOption,
  normalizeOptions,
} from './governance/approval.js';
export type { ApprovalBrokerOptions } from './governance/approval.js';

export {
  BudgetExceededError,
  BudgetLedgerImpl,
  DEFAULT_MAX_PER_INVOCATION_USD,
  DEFAULT_RESERVATION_TTL_MS,
} from './governance/budget.js';
export type { BudgetLedgerOptions } from './governance/budget.js';

export {
  DEFAULT_IDEMPOTENCY_TTL_MS,
  MemoryIdempotencyStore,
  derivedKey,
  idempotencyKeyOf,
  requestHash,
} from './governance/idempotency.js';
export type { IdempotencyStoreOptions } from './governance/idempotency.js';

export {
  RulePolicyEngine,
  createPermissionPreset,
  defaultEffectOf,
  subjectFields,
  toToolRisk,
} from './governance/policy.js';
export type { PermissionPresetOptions, RulePolicyEngineOptions, SubjectFields } from './governance/policy.js';

export {
  POLICY_BUNDLE_SCHEMA_VERSION,
  POLICY_LAYER_ORDER,
  computeRevision,
  emptyBundle,
  isBundleExpired,
  layerBundles,
  loadBundle,
  rulesHash,
  withRevision,
} from './governance/policy-bundle.js';
export type { LayerBundleInput } from './governance/policy-bundle.js';

export {
  RecordingRedactor,
  redactError,
  redactEvent,
  redactReceipt,
  registerSecret,
  sanitizeUsage,
} from './governance/redactor-bridge.js';

export {
  GovernanceDispatcher,
} from './governance/dispatcher.js';
export type { DispatcherOptions } from './governance/dispatcher.js';

// ── fabric ────────────────────────────────────────────────────────────────
export { createFabric } from './runtime/fabric.js';
export type {
  Fabric,
  FabricBudgetOptions,
  FabricOptions,
  FabricPolicyOptions,
  FabricStatus,
  MountOptions,
  MountedAdapter,
} from './runtime/fabric.js';

// ── pluggable stores (default in-memory implementations) ─────────────────
export {
  MemoryApprovalStore,
  MemoryBudgetStore,
  MemorySessionStore,
  MemoryTaskStore,
  createMemoryStores,
  deepClone,
  sha256Hasher,
} from './runtime/stores.js';

export { MemoryEventLog } from './runtime/eventlog.js';
export type { EventDraft, EventLogOptions } from './runtime/eventlog.js';

export { applyEvent, projectTask } from './runtime/projection.js';

// ── evidence / audit / registry / identity ────────────────────────────────
export {
  GENESIS_HASH,
  HashChainEvidenceSealer,
  MemoryReceiptStore,
  chainHashWith,
  collectArtifacts,
  predecessorOf,
  receiptBody,
  receiptHash,
  recomputeReceiptHash,
  verdictOf,
} from './governance/receipts.js';
export type { UnsealedReceipt } from './governance/receipts.js';

export {
  DEFAULT_CHECKPOINT_EVERY,
  MemoryAuditStore,
  auditBody,
  auditHash,
  checkpointHashOf,
  recomputeAuditHash,
} from './governance/audit.js';

export {
  COST_LABEL,
  InMemoryCapabilityRegistry,
  LOGICAL_ID_LABEL,
  REGISTRY_FALLBACK,
  TENANT_LABEL,
  costOf,
  effectiveHealth,
  versionSatisfies,
  visibleTo,
} from './governance/registry.js';

export {
  DELEGATION_DOMAIN,
  LocalIdentityService,
  trustRank,
} from './governance/identity.js';
