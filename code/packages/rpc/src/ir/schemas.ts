/**
 * Zod schemas — the single runtime source of truth for the Canonical IR
 * (ADR-07 / P10). Types in ./types.ts are derived from these.
 *
 * Every object that crosses a trust boundary (adapter ↔ kernel, kernel ↔ store,
 * kernel ↔ CLI) is validated here. JSON Schema for remote registries is derived
 * from these schemas, never hand-written.
 */

import { z } from 'zod';

export const protocolSchema = z.enum(['mcp', 'a2a', 'acp', 'native', 'local']);
export const directionSchema = z.enum(['inbound', 'outbound', 'reverse']);
export const effectSchema = z.enum(['allow', 'deny', 'ask']);
export const principalKindSchema = z.enum(['user', 'agent', 'service', 'anonymous']);
export const trustTierSchema = z.enum(['first_party', 'verified', 'untrusted']);
export const capabilityKindSchema = z.enum(['tool', 'resource', 'prompt', 'agent_skill', 'fs', 'terminal']);
export const riskSchema = z.enum(['read', 'write', 'execute', 'network', 'spend', 'delegate']);
export const sideEffectSchema = z.enum(['none', 'idempotent', 'non_idempotent']);
export const dataClassSchema = z.enum(['public', 'internal', 'confidential', 'secret']);
export const visibilitySchema = z.enum(['full', 'summary', 'opaque']);
export const healthStatusSchema = z.enum(['healthy', 'degraded', 'down']);

export const taskStateSchema = z.enum([
  'submitted', 'working', 'input_required', 'auth_required',
  'completed', 'failed', 'cancelled', 'rejected', 'expired',
]);

export const invocationStateSchema = z.enum([
  'proposed', 'authorized', 'running',
  'succeeded', 'failed', 'denied', 'cancelled', 'timed_out', 'indeterminate',
]);

export const approvalStateSchema = z.enum(['pending', 'allowed', 'denied', 'expired', 'cancelled']);

export const approvalOptionKindSchema = z.enum([
  'allow_once', 'allow_session', 'allow_always', 'deny_once', 'deny_always',
]);

export const canonicalErrorKindSchema = z.enum([
  'invalid_request', 'unauthenticated', 'unauthorized', 'denied',
  'capability_not_found', 'unsupported_capability', 'unsupported_obligation',
  'version_mismatch', 'idempotency_conflict', 'in_flight', 'budget_exceeded',
  'timed_out', 'cancelled', 'indeterminate', 'remote_error', 'internal',
]);

// ── principals ────────────────────────────────────────────────────────────

export const principalSchema = z.object({
  id: z.string().min(1),
  kind: principalKindSchema,
  tenantId: z.string().min(1),
  scopes: z.array(z.string()),
  trustTier: trustTierSchema,
  displayName: z.string().optional(),
});

export const delegationTokenSchema = z.object({
  id: z.string().min(1),
  issuer: z.string().min(1),
  subject: z.string().min(1),
  audience: z.string().min(1),
  scopes: z.array(z.string()),
  constraints: z.object({
    tenantId: z.string().min(1),
    workspaceRoots: z.array(z.string()).optional(),
    maxSpendUsd: z.number().nonnegative().optional(),
    maxHops: z.number().int().positive().optional(),
    expiresAt: z.string().min(1),
    approvalsRequired: z.boolean().optional(),
  }),
  budgetAccountId: z.string().optional(),
  parentTokenId: z.string().optional(),
  signature: z.string(),
});

// ── capabilities ──────────────────────────────────────────────────────────

export const capabilityProviderSchema = z.object({
  id: z.string().min(1),
  protocol: z.enum(['mcp', 'a2a', 'acp', 'local']),
  endpoint: z.string().min(1),
  version: z.string().optional(),
  trust: trustTierSchema,
  health: healthStatusSchema,
  ttlMs: z.number().int().nonnegative(),
  lastSeenAt: z.string().min(1),
});

export const capabilitySchema = z.object({
  id: z.string().min(1),
  kind: capabilityKindSchema,
  protocol: z.enum(['mcp', 'a2a', 'acp', 'local']),
  displayName: z.string().min(1),
  description: z.string().optional(),
  inputSchemaRef: z.string().optional(),
  outputSchemaRef: z.string().optional(),
  risk: riskSchema,
  sideEffect: sideEffectSchema,
  dataClass: dataClassSchema,
  visibility: visibilitySchema,
  reversible: z.boolean(),
  provider: capabilityProviderSchema,
});

export const discoveredCapabilitySchema = z.object({
  id: z.string().min(1),
  kind: capabilityKindSchema,
  displayName: z.string().min(1),
  description: z.string().optional(),
  inputJsonSchema: z.unknown().optional(),
  outputJsonSchema: z.unknown().optional(),
  declaredRisk: riskSchema.optional(),
  annotations: z.record(z.unknown()).optional(),
});

// ── session / task / invocation ───────────────────────────────────────────

export const sessionSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  principal: principalSchema,
  protocolBinding: z.enum(['mcp', 'a2a', 'acp', 'native']),
  workspaceRoots: z.array(z.string()),
  policyRevision: z.string().min(1),
  budgetId: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  state: z.enum(['open', 'suspended', 'closed']),
  approvalAuthority: z.enum(['local', 'delegated', 'chain']),
  metadata: z.record(z.string()).optional(),
});

export const taskInputBlockSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('data'), mediaType: z.string(), ref: z.string() }),
  z.object({ type: z.literal('protocol'), protocol: z.enum(['mcp', 'a2a', 'acp', 'local']), native: z.unknown() }),
]);

export const artifactRefSchema = z.object({
  id: z.string().min(1),
  hash: z.string().min(1),
  mediaType: z.string().optional(),
  ref: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
});

export const taskSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  tenantId: z.string().min(1),
  parentTaskId: z.string().optional(),
  state: taskStateSchema,
  input: z.array(taskInputBlockSchema),
  artifacts: z.array(artifactRefSchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  terminalReason: z.string().optional(),
  lastSeq: z.number().int().nonnegative(),
  cancelRequested: z.boolean().optional(),
});

export const canonicalErrorShapeSchema = z.object({
  kind: canonicalErrorKindSchema,
  code: z.string().optional(),
  message: z.string(),
  retryable: z.boolean(),
  protocolError: z.unknown().optional(),
  details: z.record(z.unknown()).optional(),
});

export const invocationSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  capabilityId: z.string().min(1),
  principal: principalSchema,
  protocol: protocolSchema,
  direction: directionSchema,
  input: z.unknown(),
  inputHash: z.string().min(1),
  idempotencyKey: z.string().optional(),
  deadlineAt: z.string().optional(),
  state: invocationStateSchema,
  output: z.unknown().optional(),
  outputHash: z.string().optional(),
  error: canonicalErrorShapeSchema.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  receiptId: z.string().optional(),
});

// ── approvals ─────────────────────────────────────────────────────────────

export const approvalSubjectSchema = z.object({
  kind: z.enum(['tool', 'fs', 'terminal', 'network', 'spend', 'delegate']),
  summary: z.string().min(1),
  detail: z.string().optional(),
  detailTrust: trustTierSchema.optional(),
  diff: z.object({ path: z.string(), before: z.string().optional(), after: z.string() }).optional(),
  command: z.object({ argv: z.array(z.string()), cwd: z.string(), timeoutMs: z.number().int().optional() }).optional(),
  resource: z.object({ uri: z.string(), operation: z.enum(['read', 'write', 'delete']) }).optional(),
  spend: z.object({ amount: z.number(), currency: z.string(), budgetId: z.string() }).optional(),
  delegation: z.object({ to: principalSchema, scopes: z.array(z.string()), expiresAt: z.string() }).optional(),
});

export const approvalOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: approvalOptionKindSchema,
  scope: z.object({
    capabilityId: z.string().optional(),
    pathPrefix: z.string().optional(),
    commandPrefix: z.string().optional(),
    expiresAt: z.string().optional(),
  }).optional(),
});

export const approvalRecordSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  taskId: z.string().min(1),
  invocationId: z.string().optional(),
  subject: approvalSubjectSchema,
  options: z.array(approvalOptionSchema),
  authority: z.enum(['local', 'delegated', 'chain']),
  delegationChain: z.array(z.string()),
  policyRevision: z.string().min(1),
  revision: z.number().int().positive(),
  state: approvalStateSchema,
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
  decidedAt: z.string().optional(),
  decidedBy: z.string().optional(),
  decisionOptionId: z.string().optional(),
  decisionReason: z.string().optional(),
  sensitive: z.boolean(),
});

// ── policy ────────────────────────────────────────────────────────────────

export const obligationSchema = z.union([
  z.object({ type: z.literal('require_approval'), options: z.array(approvalOptionSchema).optional() }),
  z.object({ type: z.literal('redact'), classes: z.array(z.enum(['secret', 'confidential'])) }),
  z.object({ type: z.literal('max_output_bytes'), bytes: z.number().int().positive() }),
  z.object({ type: z.literal('sandbox'), level: z.enum(['none', 'process', 'container']) }),
  z.object({ type: z.literal('network_allowlist'), hosts: z.array(z.string()) }),
  z.object({ type: z.literal('audit_level'), level: z.enum(['basic', 'full']) }),
  z.object({ type: z.literal('no_retry') }),
  z.object({ type: z.literal('ttl'), ms: z.number().int().positive() }),
  z.object({ type: z.literal('delegation_limit'), maxHops: z.number().int().positive(), maxSpendUsd: z.number().nonnegative().optional() }),
]);

export const policyRuleSchema = z.object({
  id: z.string().min(1),
  priority: z.number().int(),
  effect: effectSchema,
  match: z.object({
    tenants: z.array(z.string()).optional(),
    principals: z.array(z.string()).optional(),
    capabilities: z.array(z.string()).optional(),
    protocols: z.array(protocolSchema).optional(),
    directions: z.array(directionSchema).optional(),
    risk: z.array(riskSchema).optional(),
    dataClasses: z.array(dataClassSchema).optional(),
    paths: z.array(z.string()).optional(),
    commands: z.array(z.string()).optional(),
    urls: z.array(z.string()).optional(),
  }),
  obligations: z.array(obligationSchema).optional(),
  source: z.enum(['org', 'project', 'user', 'session', 'code']),
  reason: z.string().optional(),
});

export const policyBundleSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.string().min(1),
  tenantId: z.string().min(1),
  defaultEffect: effectSchema,
  rules: z.array(policyRuleSchema),
  signature: z.string().optional(),
  expiresAt: z.string().optional(),
});

// ── budget ────────────────────────────────────────────────────────────────

export const budgetAccountSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  parentId: z.string().optional(),
  currency: z.literal('USD'),
  limitUsd: z.number().positive().optional(),
  reservedUsd: z.number().nonnegative(),
  spentUsd: z.number().nonnegative(),
  tokenLimit: z.number().int().positive().optional(),
  tokensUsed: z.number().int().nonnegative(),
  timeLimitMs: z.number().int().positive().optional(),
  timeUsedMs: z.number().nonnegative(),
  toolCallLimit: z.number().int().positive().optional(),
  toolCallsUsed: z.number().int().nonnegative(),
  state: z.enum(['active', 'frozen', 'closed']),
});

export const budgetEstimateSchema = z.object({
  usd: z.number().nonnegative(),
  tokens: z.number().int().nonnegative().optional(),
  timeMs: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
});

export const budgetReservationSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  accountChain: z.array(z.string()),
  estimate: budgetEstimateSchema,
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
  state: z.enum(['held', 'settled', 'released']),
  settledUsd: z.number().nonnegative().optional(),
});

export const usageReportSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  timeMs: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
});

// ── idempotency ───────────────────────────────────────────────────────────

export const idempotencyRecordSchema = z.object({
  key: z.string().min(1),
  requestHash: z.string().min(1),
  state: z.enum(['in_flight', 'completed', 'failed']),
  resultRef: z.string().optional(),
  result: z.unknown().optional(),
  error: canonicalErrorShapeSchema.optional(),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
});

// ── evidence ──────────────────────────────────────────────────────────────

export const receiptSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  taskId: z.string().min(1),
  invocationId: z.string().min(1),
  protocol: protocolSchema,
  capabilityId: z.string().min(1),
  principalId: z.string().min(1),
  delegationChain: z.array(z.string()),
  outcome: invocationStateSchema,
  inputHash: z.string().min(1),
  outputHash: z.string().optional(),
  artifacts: z.array(artifactRefSchema),
  approvals: z.array(z.string()),
  policy: z.object({
    revision: z.string().min(1),
    decisionId: z.string().min(1),
    effect: effectSchema,
    obligations: z.array(z.string()),
  }),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  }).optional(),
  timing: z.object({ queuedAt: z.string(), startedAt: z.string(), endedAt: z.string() }),
  visibility: visibilitySchema,
  lossy: z.array(z.string()).optional(),
  prevHash: z.string().optional(),
  hash: z.string().min(1),
});

export const evidenceBundleSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().min(1),
  tenantId: z.string().min(1),
  createdAt: z.string().min(1),
  receipts: z.array(receiptSchema),
  approvals: z.array(approvalRecordSchema),
  policySnapshots: z.array(z.object({ revision: z.string(), rulesHash: z.string(), bundleRef: z.string().optional() })),
  artifacts: z.array(artifactRefSchema),
  verification: z.object({
    verdict: z.enum(['verified', 'unverified', 'failed']),
    checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string().optional() })),
  }),
  rootHash: z.string().min(1),
  signature: z.string().optional(),
});

// ── audit ─────────────────────────────────────────────────────────────────

export const auditEventSchema = z.object({
  id: z.string().min(1),
  ts: z.string().min(1),
  tenantId: z.string().min(1),
  actor: z.object({ type: z.enum(['user', 'agent', 'service', 'system']), id: z.string().min(1) }),
  action: z.string().min(1),
  subject: z.object({ type: z.string(), id: z.string() }),
  outcome: z.enum(['success', 'failure', 'denied']),
  policyRevision: z.string().optional(),
  detailHash: z.string().optional(),
  prevHash: z.string(),
  hash: z.string().min(1),
});

// ── events ────────────────────────────────────────────────────────────────

export const canonicalEventTypeSchema = z.enum([
  'task.created', 'task.state_changed', 'task.completed', 'task.failed', 'task.cancelled',
  'task.plan',
  'invocation.proposed', 'invocation.started', 'invocation.output_delta',
  'invocation.completed', 'invocation.failed', 'invocation.denied',
  'approval.requested', 'approval.resolved', 'approval.expired',
  'capability.discovered', 'capability.unavailable',
  'artifact.created', 'artifact.updated',
  'policy.decision', 'budget.reserved', 'budget.settled', 'budget.exceeded',
  'receipt.issued', 'evidence.sealed', 'evidence.verified',
  'session.mode_changed', 'session.config_changed', 'session.metadata_changed',
  'notice',
]);

export const canonicalEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  seq: z.number().int().positive(),
  taskId: z.string().min(1),
  invocationId: z.string().optional(),
  causationId: z.string().optional(),
  correlationId: z.string().min(1),
  ts: z.string().min(1),
  principalId: z.string().min(1),
  protocol: z.enum(['mcp', 'a2a', 'acp', 'native']),
  type: canonicalEventTypeSchema,
  payload: z.unknown(),
});

// ── adapter contract ──────────────────────────────────────────────────────

export const adapterCapabilitiesSchema = z.object({
  protocol: z.enum(['mcp', 'a2a', 'acp']),
  version: z.string().min(1),
  supports: z.object({
    session: z.boolean(),
    task: z.boolean(),
    streaming: z.boolean(),
    push: z.boolean(),
    approvalOptions: z.boolean(),
    artifacts: z.boolean(),
    reverseCalls: z.boolean(),
    cancellation: z.boolean(),
  }),
  lossy: z.array(z.string()),
});

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Canonical JSON: object keys sorted recursively, so hashing is stable across
 * key insertion order (mirrors core's `stableStringify` but lives here so the
 * rpc package has no dependency on core internals for its hash chain).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** Parse a JSON document with a schema; throws a readable error on failure. */
export function parseWith<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`invalid ${label}: ${issues}`);
  }
  return parsed.data;
}

/**
 * Parse into a canonical IR type.
 *
 * Zod's inferred output types allow `prop?: T | undefined`, while the hand
 * written IR types use the repository convention `prop?: T`. The two are
 * structurally identical at runtime — Zod omits absent optional keys — so the
 * validated value is narrowed here in one place instead of at every call site.
 */
export function parseCanonical<T>(schema: z.ZodTypeAny, raw: unknown, label: string): T {
  const parsed = parseWith(schema, raw, label) as unknown;
  return parsed as T;
}
