/**
 * Protocol drift control (03 §7.3 / §7.4).
 *
 * The wire surface of MCP / A2A / ACP is pinned here as data. The adapters
 * export their *actual* method tables; `test/drift.test.ts` compares the two so
 * an upstream spec bump (or an accidental local rename) fails CI immediately
 * instead of silently changing the wire.
 *
 * Updating a pin requires: verify against `document/Agent-RPC/04-外部事实核验记录.md`
 * → update the pin → update the adapter → add a golden fixture.
 */

export type DriftKind = 'missing-method' | 'unexpected-method' | 'missing-field' | 'missing-notification' | 'unexpected-notification' | 'error-code';

export interface Drift {
  protocol: 'mcp' | 'a2a' | 'acp';
  kind: DriftKind;
  detail: string;
}

export interface MethodSpec {
  /** Wire method name exactly as it appears on the wire. */
  method: string;
  /** Fields that must be present in the request params. */
  requiredParams: readonly string[];
  /** Fields that must be present in a successful result. */
  requiredResult: readonly string[];
}

export interface ProtocolInventory {
  protocol: 'mcp' | 'a2a' | 'acp';
  /** Pinned spec version this inventory describes. */
  version: string;
  methods: readonly MethodSpec[];
  notifications: readonly string[];
  /** Pinned numeric error codes. */
  errorCodes: Readonly<Record<string, number>>;
}

// ── pinned inventories ────────────────────────────────────────────────────

export const MCP_INVENTORY: ProtocolInventory = {
  protocol: 'mcp',
  version: '2026-07-28',
  methods: [
    { method: 'server/discover', requiredParams: ['_meta'], requiredResult: ['supportedVersions', 'capabilities', 'ttlMs', 'cacheScope'] },
    { method: 'tools/list', requiredParams: [], requiredResult: ['tools'] },
    { method: 'tools/call', requiredParams: ['name'], requiredResult: ['resultType'] },
    { method: 'resources/list', requiredParams: [], requiredResult: ['resources'] },
    { method: 'resources/read', requiredParams: ['uri'], requiredResult: ['contents'] },
    { method: 'prompts/list', requiredParams: [], requiredResult: ['prompts'] },
    { method: 'prompts/get', requiredParams: ['name'], requiredResult: ['messages'] },
    { method: 'tasks/get', requiredParams: ['taskId'], requiredResult: ['taskId', 'status'] },
    { method: 'tasks/update', requiredParams: ['taskId'], requiredResult: ['taskId'] },
    { method: 'tasks/cancel', requiredParams: ['taskId'], requiredResult: ['taskId'] },
    // Legacy era only: kept so the fallback path stays pinned.
    { method: 'initialize', requiredParams: [], requiredResult: ['protocolVersion', 'capabilities', 'serverInfo'] },
  ],
  notifications: ['notifications/cancelled', 'notifications/progress', 'notifications/tasks', 'notifications/initialized'],
  errorCodes: {
    parseError: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internalError: -32603,
    inputRequired: -32020,
    requestStateInvalid: -32021,
    versionNegotiationFailed: -32022,
  },
};

export const A2A_INVENTORY: ProtocolInventory = {
  protocol: 'a2a',
  version: '1.0.0',
  methods: [
    { method: 'SendMessage', requiredParams: ['message'], requiredResult: [] },
    { method: 'SendStreamingMessage', requiredParams: ['message'], requiredResult: [] },
    { method: 'GetTask', requiredParams: ['id'], requiredResult: ['id', 'status'] },
    { method: 'ListTasks', requiredParams: [], requiredResult: ['tasks'] },
    { method: 'CancelTask', requiredParams: ['id'], requiredResult: ['id', 'status'] },
    { method: 'SubscribeToTask', requiredParams: ['id'], requiredResult: [] },
    { method: 'CreateTaskPushNotificationConfig', requiredParams: [], requiredResult: [] },
    { method: 'GetTaskPushNotificationConfig', requiredParams: [], requiredResult: [] },
    { method: 'ListTaskPushNotificationConfigs', requiredParams: [], requiredResult: [] },
    { method: 'DeleteTaskPushNotificationConfig', requiredParams: [], requiredResult: [] },
    { method: 'GetExtendedAgentCard', requiredParams: [], requiredResult: ['name', 'skills'] },
  ],
  notifications: [],
  errorCodes: {
    taskNotFound: -32001,
    taskNotCancelable: -32002,
    pushNotificationNotSupported: -32003,
    unsupportedOperation: -32004,
    versionNotSupported: -32022,
  },
};

export const ACP_INVENTORY: ProtocolInventory = {
  protocol: 'acp',
  version: '1',
  methods: [
    { method: 'initialize', requiredParams: [], requiredResult: ['protocolVersion', 'agentCapabilities'] },
    { method: 'authenticate', requiredParams: [], requiredResult: [] },
    { method: 'session/new', requiredParams: ['cwd'], requiredResult: ['sessionId'] },
    { method: 'session/load', requiredParams: ['sessionId', 'cwd'], requiredResult: [] },
    { method: 'session/resume', requiredParams: ['sessionId', 'cwd'], requiredResult: [] },
    { method: 'session/prompt', requiredParams: ['sessionId', 'prompt'], requiredResult: ['stopReason'] },
    { method: 'session/cancel', requiredParams: ['sessionId'], requiredResult: [] },
    { method: 'session/close', requiredParams: ['sessionId'], requiredResult: [] },
    { method: 'session/list', requiredParams: [], requiredResult: ['sessions'] },
    { method: 'session/delete', requiredParams: ['sessionId'], requiredResult: [] },
    { method: 'session/request_permission', requiredParams: ['sessionId', 'toolCall', 'options'], requiredResult: [] },
    { method: 'fs/read_text_file', requiredParams: ['sessionId', 'path'], requiredResult: [] },
    { method: 'fs/write_text_file', requiredParams: ['sessionId', 'path', 'content'], requiredResult: [] },
    { method: 'terminal/create', requiredParams: ['sessionId', 'command'], requiredResult: ['terminalId'] },
    { method: 'terminal/output', requiredParams: ['sessionId', 'terminalId'], requiredResult: [] },
    { method: 'terminal/wait_for_exit', requiredParams: ['sessionId', 'terminalId'], requiredResult: [] },
    { method: 'terminal/kill', requiredParams: ['sessionId', 'terminalId'], requiredResult: [] },
    { method: 'terminal/release', requiredParams: ['sessionId', 'terminalId'], requiredResult: [] },
    { method: 'elicitation/create', requiredParams: [], requiredResult: [] },
    { method: '$/cancel_request', requiredParams: ['requestId'], requiredResult: [] },
  ],
  notifications: ['session/update', 'session/cancel'],
  errorCodes: {
    parseError: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internalError: -32603,
    authRequired: -32000,
    resourceNotFound: -32002,
  },
};

export const PINNED_INVENTORIES: readonly ProtocolInventory[] = [MCP_INVENTORY, A2A_INVENTORY, ACP_INVENTORY];

/** ACP `session/update` variants, pinned (01 §5.5). */
export const ACP_UPDATE_VARIANTS: readonly string[] = [
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
  'notice',
  'compaction_update',
  'compaction_summary_chunk',
];

/** ACP `stopReason` values, pinned. */
export const ACP_STOP_REASONS: readonly string[] = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'];

/** A2A `TASK_STATE_*` ProtoJSON enum names, pinned. */
export const A2A_TASK_STATES: readonly string[] = [
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
];

/** MCP `resultType` values, pinned. */
export const MCP_RESULT_TYPES: readonly string[] = ['complete', 'input_required', 'task'];

/** MCP per-request `_meta` envelope keys, pinned. */
export const MCP_META_KEYS: readonly string[] = [
  'io.modelcontextprotocol/protocolVersion',
  'io.modelcontextprotocol/clientCapabilities',
  'io.modelcontextprotocol/clientInfo',
];

// ── comparison ────────────────────────────────────────────────────────────

function diff(expected: readonly string[], actual: readonly string[]): { missing: string[]; unexpected: string[] } {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((item) => !actualSet.has(item)),
    unexpected: actual.filter((item) => !expectedSet.has(item)),
  };
}

/** Compare the pinned method list with the adapter's actual method table. */
export function compareMethods(
  protocol: 'mcp' | 'a2a' | 'acp',
  expected: readonly string[],
  actual: readonly string[],
): Drift[] {
  const { missing, unexpected } = diff(expected, actual);
  return [
    ...missing.map((method): Drift => ({ protocol, kind: 'missing-method', detail: method })),
    ...unexpected.map((method): Drift => ({ protocol, kind: 'unexpected-method', detail: method })),
  ];
}

/** Compare the pinned notification list with the adapter's actual one. */
export function compareNotifications(
  protocol: 'mcp' | 'a2a' | 'acp',
  expected: readonly string[],
  actual: readonly string[],
): Drift[] {
  const { missing, unexpected } = diff(expected, actual);
  return [
    ...missing.map((method): Drift => ({ protocol, kind: 'missing-notification', detail: method })),
    ...unexpected.map((method): Drift => ({ protocol, kind: 'unexpected-notification', detail: method })),
  ];
}

/** Compare pinned numeric error codes with the adapter's table. */
export function compareErrorCodes(
  protocol: 'mcp' | 'a2a' | 'acp',
  expected: Readonly<Record<string, number>>,
  actual: Readonly<Record<string, number>>,
): Drift[] {
  const out: Drift[] = [];
  for (const [name, code] of Object.entries(expected)) {
    if (actual[name] !== code) out.push({ protocol, kind: 'error-code', detail: `${name}: expected ${code}, got ${String(actual[name])}` });
  }
  return out;
}

/** Compare one pinned method spec's required fields against an actual result. */
export function compareFields(
  protocol: 'mcp' | 'a2a' | 'acp',
  method: string,
  required: readonly string[],
  actual: Record<string, unknown>,
): Drift[] {
  return required
    .filter((field) => actual[field] === undefined)
    .map((field): Drift => ({ protocol, kind: 'missing-field', detail: `${method}.${field}` }));
}

/** Assert a drift list is empty; used by the drift suite. */
export function assertNoDrift(drifts: readonly Drift[]): void {
  if (drifts.length === 0) return;
  const rendered = drifts.map((d) => `  ${d.protocol} ${d.kind}: ${d.detail}`).join('\n');
  throw new Error(`protocol drift detected:\n${rendered}`);
}
