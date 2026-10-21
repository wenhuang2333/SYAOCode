/**
 * SYAOCode error code registry (09-错误体系专项设计 §9.5).
 *
 * Format: SY-<domain>-<3-digit sequence>. Sequences are never reused; a
 * deprecated entry stays in the registry marked `deprecated`. SY-DEC-007
 * does not exist — the gap is intentional and must not be filled.
 *
 * Every active code needs: a test that triggers it, and a zh-CN message
 * (see ./messages-zh.ts). CI checks registry ↔ docs consistency.
 */

export type ErrorDomain =
  | 'CFG' | 'PRV' | 'LOOP' | 'TOOL' | 'PERM' | 'FS' | 'CTX' | 'SES' | 'SEC'
  | 'MCP' | 'ACP' | 'PLG' | 'HOOK' | 'DEC' | 'AGT' | 'RUN' | 'SRV' | 'CLI' | 'INT';

export type ErrorCategory =
  | 'config' | 'provider' | 'loop' | 'tool' | 'permission' | 'fs' | 'context'
  | 'session' | 'security' | 'mcp' | 'acp' | 'plugin' | 'hook' | 'decision'
  | 'agent' | 'run' | 'server' | 'cli' | 'internal';

export type Severity = 'info' | 'warning' | 'error' | 'fatal';
export type Recovery = 'retry' | 'fix_input' | 'ask_user' | 'reconfigure' | 'abort' | 'none';

export interface ErrorCodeEntry {
  readonly code: string;
  readonly name: string;
  readonly domain: ErrorDomain;
  readonly category: ErrorCategory;
  readonly severity: Severity;
  readonly retryable: boolean;
  readonly recovery: Recovery;
  readonly description: string;
  readonly status?: 'active' | 'deprecated';
}

const DOMAIN_CATEGORY: Record<ErrorDomain, ErrorCategory> = {
  CFG: 'config', PRV: 'provider', LOOP: 'loop', TOOL: 'tool', PERM: 'permission',
  FS: 'fs', CTX: 'context', SES: 'session', SEC: 'security', MCP: 'mcp',
  ACP: 'acp', PLG: 'plugin', HOOK: 'hook', DEC: 'decision', AGT: 'agent',
  RUN: 'run', SRV: 'server', CLI: 'cli', INT: 'internal',
};

interface Row {
  code: string;
  name: string;
  severity: Severity;
  retryable: boolean;
  recovery: Recovery;
  description: string;
}

const TABLE: readonly Row[] = [
  // ── SY-CFG 配置 ──────────────────────────────────────────────
  { code: 'SY-CFG-001', name: 'InvalidConfig', severity: 'error', retryable: false, recovery: 'reconfigure', description: 'Zod validation failed; details carry field paths. Also raised when project-level config tries to enable bypass (BR-002).' },
  { code: 'SY-CFG-002', name: 'SecretMissing', severity: 'error', retryable: false, recovery: 'reconfigure', description: 'Referenced secret not found in environment variables or key chain.' },
  { code: 'SY-CFG-003', name: 'ProjectIntegrationUntrusted', severity: 'warning', retryable: false, recovery: 'ask_user', description: 'Project-level MCP server / plugin / hook config seen for the first time or its content hash changed; needs user review (BR-043).' },
  // ── SY-PRV Provider ─────────────────────────────────────────
  { code: 'SY-PRV-001', name: 'AuthenticationFailed', severity: 'error', retryable: false, recovery: 'reconfigure', description: 'HTTP 401/403.' },
  { code: 'SY-PRV-002', name: 'RateLimited', severity: 'warning', retryable: true, recovery: 'retry', description: 'HTTP 429; honors Retry-After.' },
  { code: 'SY-PRV-003', name: 'NetworkOrTimeout', severity: 'warning', retryable: true, recovery: 'retry', description: 'Connection failure, DNS error, timeout.' },
  { code: 'SY-PRV-004', name: 'ContextTooLong', severity: 'error', retryable: false, recovery: 'fix_input', description: 'Request exceeds window; triggers one auto-compaction then one retry.' },
  { code: 'SY-PRV-005', name: 'ContentRefused', severity: 'error', retryable: false, recovery: 'ask_user', description: 'Safety filter or refusal stop reason.' },
  { code: 'SY-PRV-006', name: 'CapabilityUnsupported', severity: 'error', retryable: false, recovery: 'reconfigure', description: 'Required capability missing, e.g. no tool-use support (BR-015).' },
  { code: 'SY-PRV-007', name: 'StreamInterrupted', severity: 'warning', retryable: true, recovery: 'retry', description: 'Stream ended before message_stop.' },
  { code: 'SY-PRV-008', name: 'MalformedResponse', severity: 'error', retryable: true, recovery: 'retry', description: 'Unparsable response; retried at most once.' },
  { code: 'SY-PRV-009', name: 'ServerError', severity: 'warning', retryable: true, recovery: 'retry', description: 'HTTP 5xx / overloaded.' },
  { code: 'SY-PRV-010', name: 'ProtocolNotImplemented', severity: 'error', retryable: false, recovery: 'reconfigure', description: 'Profile uses a protocol whose adapter is not implemented yet (openai-responses / gemini, planned M2).' },
  // ── SY-LOOP 主循环 ───────────────────────────────────────────
  { code: 'SY-LOOP-001', name: 'MaxTurnsReached', severity: 'warning', retryable: false, recovery: 'ask_user', description: 'maxTurns reached.' },
  { code: 'SY-LOOP-002', name: 'BudgetExhausted', severity: 'warning', retryable: false, recovery: 'ask_user', description: 'Token or cost limit reached.' },
  { code: 'SY-LOOP-003', name: 'UserAbort', severity: 'info', retryable: false, recovery: 'none', description: 'AbortSignal fired; pending tool_use backfilled with this code (BR-009).' },
  { code: 'SY-LOOP-004', name: 'RepeatedFailureLoop', severity: 'error', retryable: false, recovery: 'abort', description: 'Same tool + normalized args failed 5 times in a row (BR-011).' },
  { code: 'SY-LOOP-005', name: 'RunTimeout', severity: 'warning', retryable: false, recovery: 'ask_user', description: 'Total run timeout exceeded.' },
  // ── SY-TOOL 工具 ─────────────────────────────────────────────
  { code: 'SY-TOOL-001', name: 'ToolNotFound', severity: 'error', retryable: false, recovery: 'fix_input', description: 'Model called an unregistered tool; modelMessage lists available tools.' },
  { code: 'SY-TOOL-002', name: 'InvalidToolArgs', severity: 'error', retryable: false, recovery: 'fix_input', description: 'Zod validation failed; modelMessage names fields and expectations.' },
  { code: 'SY-TOOL-003', name: 'ToolExecutionFailed', severity: 'error', retryable: false, recovery: 'fix_input', description: 'Expected failure raised inside a tool.' },
  { code: 'SY-TOOL-004', name: 'ToolTimeout', severity: 'error', retryable: true, recovery: 'fix_input', description: 'Exceeded timeoutMs; subprocess terminated.' },
  { code: 'SY-TOOL-005', name: 'ResultTruncated', severity: 'warning', retryable: false, recovery: 'none', description: 'Result exceeded BR-012 threshold; non-interrupting.' },
  // ── SY-PERM 权限 ─────────────────────────────────────────────
  { code: 'SY-PERM-001', name: 'DeniedByRule', severity: 'error', retryable: false, recovery: 'fix_input', description: 'Deny rule, mode restriction, or hook denial (BR-021).' },
  { code: 'SY-PERM-002', name: 'DeniedByUser', severity: 'error', retryable: false, recovery: 'ask_user', description: 'PermissionHandler returned deny.' },
  { code: 'SY-PERM-003', name: 'PathOutsideWorkspace', severity: 'error', retryable: false, recovery: 'ask_user', description: 'Path outside workspace / allowed dirs and not approved (BR-003).' },
  { code: 'SY-PERM-004', name: 'DangerousCommand', severity: 'error', retryable: false, recovery: 'fix_input', description: 'Command matched the dangerous-pattern library (BR-006).' },
  { code: 'SY-PERM-005', name: 'NoPermissionHandler', severity: 'error', retryable: false, recovery: 'reconfigure', description: 'Decision was ask but no handler injected; treated as deny.' },
  // ── SY-FS 文件系统 ───────────────────────────────────────────
  { code: 'SY-FS-001', name: 'WriteBeforeRead', severity: 'error', retryable: false, recovery: 'fix_input', description: 'BR-004: must read the file in-session before modifying.' },
  { code: 'SY-FS-002', name: 'FileChangedExternally', severity: 'error', retryable: false, recovery: 'fix_input', description: 'Hash/mtime changed since last read; re-read required.' },
  { code: 'SY-FS-003', name: 'AmbiguousMatch', severity: 'error', retryable: false, recovery: 'fix_input', description: 'old string matches multiple locations; count and lines reported.' },
  { code: 'SY-FS-004', name: 'MatchNotFound', severity: 'error', retryable: false, recovery: 'fix_input', description: 'No match; nearest lines hinted.' },
  { code: 'SY-FS-005', name: 'PathNotFound', severity: 'error', retryable: false, recovery: 'fix_input', description: 'ENOENT / EACCES.' },
  { code: 'SY-FS-006', name: 'WriteFailed', severity: 'error', retryable: false, recovery: 'ask_user', description: 'Disk full, read-only filesystem, etc.' },
  // ── SY-CTX 上下文 ────────────────────────────────────────────
  { code: 'SY-CTX-001', name: 'CompactionFailed', severity: 'warning', retryable: true, recovery: 'retry', description: 'Summary call failed; fell back to dropping old tool results.' },
  { code: 'SY-CTX-002', name: 'ContextUnfittable', severity: 'fatal', retryable: false, recovery: 'abort', description: 'Still over window after compaction.' },
  // ── SY-SES 会话 ──────────────────────────────────────────────
  { code: 'SY-SES-001', name: 'SessionNotFound', severity: 'error', retryable: false, recovery: 'ask_user', description: 'No record for the given sessionId.' },
  { code: 'SY-SES-002', name: 'SessionLogCorrupted', severity: 'error', retryable: false, recovery: 'ask_user', description: 'Corruption ratio above threshold; cannot recover.' },
  { code: 'SY-SES-003', name: 'SessionLogVersionUnsupported', severity: 'error', retryable: false, recovery: 'reconfigure', description: 'Log schemaVersion higher than supported; upgrade required.' },
  { code: 'SY-SES-004', name: 'SessionLocked', severity: 'error', retryable: true, recovery: 'ask_user', description: 'Lock file held by another process.' },
  // ── SY-SEC 安全 ──────────────────────────────────────────────
  { code: 'SY-SEC-001', name: 'RedactedSecret', severity: 'info', retryable: false, recovery: 'none', description: 'Redactor hit; only the type is recorded, never the value (BR-023).' },
  { code: 'SY-SEC-002', name: 'InjectionSuspected', severity: 'warning', retryable: false, recovery: 'ask_user', description: 'Untrusted content contains suspected instructions (BR-007).' },
  // ── SY-MCP MCP 客户端 ────────────────────────────────────────
  { code: 'SY-MCP-001', name: 'McpConnectFailed', severity: 'error', retryable: true, recovery: 'retry', description: 'Process failed to start or HTTP unreachable.' },
  { code: 'SY-MCP-002', name: 'McpProtocolError', severity: 'error', retryable: false, recovery: 'reconfigure', description: 'Version or capability negotiation failed.' },
  { code: 'SY-MCP-003', name: 'McpToolCallFailed', severity: 'error', retryable: false, recovery: 'fix_input', description: 'Server returned an error.' },
  { code: 'SY-MCP-004', name: 'McpAuthFailed', severity: 'error', retryable: false, recovery: 'ask_user', description: 'OAuth expired or rejected.' },
  { code: 'SY-MCP-005', name: 'McpTimeout', severity: 'warning', retryable: true, recovery: 'retry', description: 'Exceeded timeoutMs.' },
  // ── SY-ACP ACP 协议 ──────────────────────────────────────────
  { code: 'SY-ACP-001', name: 'AcpVersionMismatch', severity: 'fatal', retryable: false, recovery: 'abort', description: 'No common protocol version between client and server.' },
  { code: 'SY-ACP-002', name: 'AcpInvalidRequest', severity: 'error', retryable: false, recovery: 'none', description: 'Invalid JSON-RPC params; protocol-level error returned.' },
  // ── SY-PLG 插件 ──────────────────────────────────────────────
  { code: 'SY-PLG-001', name: 'PluginManifestInvalid', severity: 'error', retryable: false, recovery: 'reconfigure', description: 'Manifest validation failed.' },
  { code: 'SY-PLG-002', name: 'PluginEngineIncompatible', severity: 'error', retryable: false, recovery: 'reconfigure', description: 'engines.syaocode not satisfied (BR-020).' },
  { code: 'SY-PLG-003', name: 'PluginLoadFailed', severity: 'error', retryable: false, recovery: 'reconfigure', description: 'Import failed or setup timed out.' },
  { code: 'SY-PLG-004', name: 'PluginPermissionNotGranted', severity: 'error', retryable: false, recovery: 'ask_user', description: 'Requested capability not approved (BR-019).' },
  { code: 'SY-PLG-005', name: 'PluginRuntimeError', severity: 'error', retryable: false, recovery: 'none', description: 'Caught by the error boundary; 3 consecutive failures auto-disable.' },
  // ── SY-HOOK 钩子 ─────────────────────────────────────────────
  { code: 'SY-HOOK-001', name: 'HookDenied', severity: 'warning', retryable: false, recovery: 'fix_input', description: 'Hook returned deny; reason passed back to the model.' },
  { code: 'SY-HOOK-002', name: 'HookFailedOrTimeout', severity: 'error', retryable: false, recovery: 'none', description: 'Handled per failMode (default fail-closed) (BR-021).' },
  // ── SY-DEC 决策层（SY-DEC-007 有意空缺，序号不复用）─────────
  { code: 'SY-DEC-001', name: 'DecisionCallFailed', severity: 'warning', retryable: true, recovery: 'retry', description: 'DecisionProvider timeout/throttle/unreachable and a safe fallback was used.' },
  { code: 'SY-DEC-002', name: 'DecisionResponseInvalid', severity: 'warning', retryable: true, recovery: 'retry', description: 'Missing fields, out-of-range probabilities, or schema/type mismatch.' },
  { code: 'SY-DEC-003', name: 'DecisionCircuitOpen', severity: 'warning', retryable: false, recovery: 'none', description: 'Consecutive failures reached threshold; remote provider temporarily bypassed (BR-034).' },
  { code: 'SY-DEC-004', name: 'DecisionInsufficientConfidence', severity: 'warning', retryable: false, recovery: 'ask_user', description: 'Completion or high-impact judgment cannot reach an acceptable conclusion.' },
  { code: 'SY-DEC-005', name: 'DecisionEgressDenied', severity: 'info', retryable: false, recovery: 'none', description: 'Policy forbids sending state to remote judges; local rules used (BR-031).' },
  { code: 'SY-DEC-006', name: 'DecisionVersionNotPinned', severity: 'error', retryable: false, recovery: 'reconfigure', description: 'enforce points to latest/preview or has not completed regression (BR-036).' },
  { code: 'SY-DEC-008', name: 'DecisionEscalated', severity: 'info', retryable: false, recovery: 'none', description: 'Low confidence escalated to the next judgment tier; recorded, never a permission grant (BR-039).' },
  // ── SY-AGT 三角色 agent ──────────────────────────────────────
  { code: 'SY-AGT-001', name: 'RoleBudgetExhausted', severity: 'warning', retryable: false, recovery: 'abort', description: 'A role hit its cost/token/time cap.' },
  { code: 'SY-AGT-002', name: 'HandoffSchemaInvalid', severity: 'error', retryable: true, recovery: 'fix_input', description: 'Brief/Plan/Result/EvidenceReceipt failed validation (BR-045).' },
  { code: 'SY-AGT-003', name: 'RolePermissionExceeded', severity: 'error', retryable: false, recovery: 'abort', description: 'Role requested beyond parent role/session permissions.' },
  { code: 'SY-AGT-004', name: 'ReplanBudgetExhausted', severity: 'warning', retryable: false, recovery: 'ask_user', description: 'sota replanning exceeded the cap without passing acceptance (BR-047).' },
  { code: 'SY-AGT-005', name: 'SummaryNotTraceable', severity: 'warning', retryable: true, recovery: 'retry', description: 'Brief source file/line/hash cannot be verified (BR-046).' },
  // ── SY-RUN goal/loop ─────────────────────────────────────────
  { code: 'SY-RUN-001', name: 'GoalAcceptanceFailed', severity: 'warning', retryable: false, recovery: 'ask_user', description: 'At least one mandatory verifier failed (BR-050).' },
  { code: 'SY-RUN-002', name: 'LoopMaxRunsReached', severity: 'info', retryable: false, recovery: 'none', description: 'maxRuns reached; normal stop.' },
  { code: 'SY-RUN-003', name: 'LoopPausedOnFailures', severity: 'warning', retryable: false, recovery: 'ask_user', description: 'Consecutive failures hit the threshold or external state changed (BR-051).' },
  { code: 'SY-RUN-004', name: 'LoopPausedOnPermissions', severity: 'warning', retryable: false, recovery: 'ask_user', description: 'ask encountered unattended, or permissions expired (BR-051).' },
  { code: 'SY-RUN-005', name: 'GoalUnverified', severity: 'warning', retryable: false, recovery: 'ask_user', description: 'Only model/decision says done; no verifier proof (BR-050).' },
  // ── SY-SRV 服务化 ────────────────────────────────────────────
  { code: 'SY-SRV-001', name: 'ServiceAuthFailed', severity: 'error', retryable: false, recovery: 'reconfigure', description: 'Invalid/expired bearer token or unauthorized client (BR-041).' },
  { code: 'SY-SRV-002', name: 'UnsafeListenAddress', severity: 'error', retryable: false, recovery: 'reconfigure', description: 'Attempted remote listen without safety params (BR-041).' },
  { code: 'SY-SRV-003', name: 'PermissionRequestStale', severity: 'warning', retryable: false, recovery: 'none', description: 'One-shot PermissionRequest answered twice or expired.' },
  // ── SY-CLI CLI ───────────────────────────────────────────────
  { code: 'SY-CLI-001', name: 'CliUsageOrProtocolInvalid', severity: 'error', retryable: false, recovery: 'fix_input', description: 'Invalid CLI args or unsupported input schemaVersion (BR-042).' },
  { code: 'SY-CLI-002', name: 'NonInteractivePermissionDenied', severity: 'warning', retryable: false, recovery: 'ask_user', description: 'Headless ask→deny left the task incomplete (BR-042).' },
  // ── SY-INT 内部 ──────────────────────────────────────────────
  { code: 'SY-INT-001', name: 'InternalError', severity: 'fatal', retryable: false, recovery: 'abort', description: 'Unexpected exception; issue feedback guidance attached (BR-025).' },
] as const;

function domainOf(code: string): ErrorDomain {
  const part = code.split('-')[1];
  if (part === undefined || !(part in DOMAIN_CATEGORY)) {
    throw new Error(`Bad error code in registry table: ${code}`);
  }
  return part as ErrorDomain;
}

export const ERROR_REGISTRY: ReadonlyMap<string, ErrorCodeEntry> = new Map(
  TABLE.map((row) => {
    const domain = domainOf(row.code);
    const entry: ErrorCodeEntry = {
      ...row,
      domain,
      category: DOMAIN_CATEGORY[domain],
      status: 'active',
    };
    return [row.code, entry];
  }),
);

export function lookupError(code: string): ErrorCodeEntry | undefined {
  return ERROR_REGISTRY.get(code);
}

export function requireError(code: string): ErrorCodeEntry {
  const entry = ERROR_REGISTRY.get(code);
  if (!entry) throw new Error(`Unknown error code: ${code} (not in registry; sequences are never reused)`);
  return entry;
}

export const ALL_ERROR_CODES: readonly string[] = TABLE.map((r) => r.code);
