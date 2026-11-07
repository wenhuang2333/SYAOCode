/**
 * DHP 错误码（对齐 `DesktopDoc/06-DHP-桌面宿主协议规范.md` §10）
 *
 * 三个层次，**互不混用**：
 *  - L1 内核错误（`SY-<域>-<序号>`，90 条 / 20 域）—— 由 `@syaocode/core` 产生，经 `data.syaoCode` 透传
 *  - L2 协议错误（本文件的 `-32xxx`）—— 由 Host 在 DHP 层产生
 *  - L3 壳层错误（`DSK-<区>-<序号>`）—— 由 Shell 产生，**不属于本协议**
 *
 * `-32099` 是码段边界，不是真实错误码。
 */

/**
 * L2 自定义错误码的段边界（`06` §10.2）。
 *
 * 2026-11-07 起按 `27-功能增补需求与实施清单` §5.2 顺延到 `-32045`：
 * `-32026…-32029` MCP、`-32030…-32035` Git/产出/来源、
 * `-32036…-32045` 凭据 / 联网 / OAuth / SSH。
 */
export const DHP_ERROR_RANGE = { min: -32045, max: -32000 } as const;

/**
 * L2 错误的 `kind` —— 客户端**必须**按 `kind` 分支，绝不按数字字面量分支。
 * 数字只是 wire 载体；`kind` 才是契约。
 */
export type DhpErrorKind =
  | 'frame_too_large'
  | 'unauthenticated'
  | 'not_ready'
  | 'rate_limited'
  | 'unsupported_capability'
  | 'capability_not_found'
  | 'denied'
  | 'unauthorized'
  | 'budget_exceeded'
  | 'conflict_in_flight'
  | 'idempotency_conflict'
  | 'stale'
  | 'gap_unrecoverable'
  | 'epoch_changed'
  | 'subscription_limit'
  | 'outside_workspace'
  | 'path_rejected'
  | 'timed_out'
  | 'cancelled'
  | 'indeterminate'
  | 'remote_error'
  | 'interaction_settled'
  | 'version_mismatch'
  | 'unsupported_obligation'
  | 'shutdown_in_progress'
  | 'read_only'
  // 27 §5.2：MCP
  | 'mcp_unavailable'
  | 'mcp_spawn_failed'
  | 'mcp_tool_failed'
  | 'mcp_not_trusted'
  // 27 §5.2：Git / 产出 / 来源
  | 'git_unavailable'
  | 'git_not_repo'
  | 'git_command_failed'
  | 'git_unsafe'
  | 'artifact_unreadable'
  | 'source_untrusted'
  // 27 §5.2：凭据 / 联网 / OAuth / SSH
  | 'git_auth_required'
  | 'git_auth_failed'
  | 'git_offline'
  | 'git_remote_conflict'
  | 'git_credential_unavailable'
  | 'git_oauth_pending'
  | 'git_oauth_denied'
  | 'git_oauth_unavailable'
  | 'git_ssh_key_invalid'
  | 'git_host_key_unverified';

/** 重试语义：客户端据此决定是否可自动重试。 */
export type DhpRetryPolicy = 'no' | 'once' | 'backoff' | 'after_turn_end' | 'after_hello' | 'never_auto';

export interface DhpErrorCodeSpec {
  readonly code: number;
  readonly kind: DhpErrorKind;
  /** 是否可重试以及怎么重试。 */
  readonly retry: DhpRetryPolicy;
  /** 一句话语义（用于诊断日志，不用于 UI 文案）。 */
  readonly summary: string;
}

/**
 * 46 个自定义码，`-32000`~`-32045` **连续无空洞**。
 * 顺序与 `06` §10.2（+ `27` §5.2）完全一致。
 */
export const DHP_ERROR_CODES: readonly DhpErrorCodeSpec[] = [
  { code: -32000, kind: 'frame_too_large', retry: 'once', summary: '单帧超 MAX_FRAME_BYTES' },
  { code: -32001, kind: 'unauthenticated', retry: 'no', summary: '令牌缺失/错误/过期' },
  { code: -32002, kind: 'not_ready', retry: 'after_hello', summary: 'hello 未完成即调业务方法' },
  { code: -32003, kind: 'rate_limited', retry: 'backoff', summary: '入站帧频率超限' },
  { code: -32004, kind: 'unsupported_capability', retry: 'no', summary: '所需能力位未被授予' },
  { code: -32005, kind: 'capability_not_found', retry: 'no', summary: '治理面能力 id 未注册' },
  { code: -32006, kind: 'denied', retry: 'no', summary: '策略引擎或审批人拒绝' },
  { code: -32007, kind: 'unauthorized', retry: 'no', summary: '角色不足' },
  { code: -32008, kind: 'budget_exceeded', retry: 'no', summary: '预算无法覆盖本次调用' },
  { code: -32009, kind: 'conflict_in_flight', retry: 'after_turn_end', summary: '同一会话已有执行中的轮次' },
  { code: -32010, kind: 'idempotency_conflict', retry: 'no', summary: 'commandId 相同但内容不同' },
  { code: -32011, kind: 'stale', retry: 'once', summary: 'CAS 基线不符' },
  { code: -32012, kind: 'gap_unrecoverable', retry: 'no', summary: '请求的事件区间已不可用' },
  { code: -32013, kind: 'epoch_changed', retry: 'no', summary: '会话日志世代已变' },
  { code: -32014, kind: 'subscription_limit', retry: 'no', summary: '订阅数超上限' },
  { code: -32015, kind: 'outside_workspace', retry: 'no', summary: '路径越出工作区围栏' },
  { code: -32016, kind: 'path_rejected', retry: 'no', summary: '路径非法' },
  { code: -32017, kind: 'timed_out', retry: 'once', summary: '操作超时' },
  { code: -32018, kind: 'cancelled', retry: 'no', summary: '被取消' },
  { code: -32019, kind: 'indeterminate', retry: 'never_auto', summary: '已发出但结果未知' },
  { code: -32020, kind: 'remote_error', retry: 'once', summary: '远端返回错误' },
  { code: -32021, kind: 'interaction_settled', retry: 'no', summary: '询问已被结算' },
  { code: -32022, kind: 'version_mismatch', retry: 'no', summary: 'DHP 主版本不兼容' },
  { code: -32023, kind: 'unsupported_obligation', retry: 'no', summary: '策略要求的义务无法履行' },
  { code: -32024, kind: 'shutdown_in_progress', retry: 'once', summary: 'Host 正在关停' },
  { code: -32025, kind: 'read_only', retry: 'no', summary: '连接为只读降级态' },
  // ── 27 §5.2 增补（2026-11-07）────────────────────────────────────────
  { code: -32026, kind: 'mcp_unavailable', retry: 'no', summary: 'MCP 服务不存在或未就绪' },
  { code: -32027, kind: 'mcp_spawn_failed', retry: 'once', summary: 'MCP 进程启动失败（含超时）' },
  { code: -32028, kind: 'mcp_tool_failed', retry: 'once', summary: 'MCP 工具调用返回错误' },
  { code: -32029, kind: 'mcp_not_trusted', retry: 'no', summary: 'MCP 服务未列入受信清单，拒绝执行' },
  { code: -32030, kind: 'git_unavailable', retry: 'no', summary: '本机没有可用的 git 可执行文件' },
  { code: -32031, kind: 'git_not_repo', retry: 'no', summary: '工作区不是 Git 仓库' },
  { code: -32032, kind: 'git_command_failed', retry: 'once', summary: 'git 命令非零退出' },
  { code: -32033, kind: 'git_unsafe', retry: 'no', summary: '命令或参数被安全策略拒绝' },
  { code: -32034, kind: 'artifact_unreadable', retry: 'no', summary: '产出文件不可读或超限' },
  { code: -32035, kind: 'source_untrusted', retry: 'no', summary: '来源缺少可验证凭据' },
  { code: -32036, kind: 'git_auth_required', retry: 'no', summary: '远端需要认证，但尚未配置凭据' },
  { code: -32037, kind: 'git_auth_failed', retry: 'once', summary: '凭据被远端拒绝（不回显令牌内容）' },
  { code: -32038, kind: 'git_offline', retry: 'backoff', summary: '需要联网但当前不可达' },
  { code: -32039, kind: 'git_remote_conflict', retry: 'no', summary: '分支分叉或落后于远端，需用户决策，禁止自动 force' },
  { code: -32040, kind: 'git_credential_unavailable', retry: 'no', summary: '系统钥匙串不可用或条目读取失败' },
  { code: -32041, kind: 'git_oauth_pending', retry: 'backoff', summary: '浏览器授权尚未完成（按 interval 轮询）' },
  { code: -32042, kind: 'git_oauth_denied', retry: 'no', summary: '用户在浏览器拒绝授权，或设备码过期' },
  { code: -32043, kind: 'git_oauth_unavailable', retry: 'no', summary: '厂商不支持设备码流程 / 未配置 OAuth App / 网络不可达' },
  { code: -32044, kind: 'git_ssh_key_invalid', retry: 'no', summary: '私钥无法解析、口令错误，或 agent 中没有可用身份' },
  { code: -32045, kind: 'git_host_key_unverified', retry: 'no', summary: '首次连接的主机指纹未确认' },
] as const;

/** JSON-RPC 2.0 标准码（`06` §10.1）。 */
export const JSONRPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** `kind` → 码。用于服务端构造错误。 */
const KIND_TO_CODE: ReadonlyMap<DhpErrorKind, number> = new Map(
  DHP_ERROR_CODES.map((spec) => [spec.kind, spec.code]),
);

/** `code` → 规格。未知数字码返回 `undefined`（客户端应按 `-32603` 兜底）。 */
const CODE_TO_SPEC: ReadonlyMap<number, DhpErrorCodeSpec> = new Map(
  DHP_ERROR_CODES.map((spec) => [spec.code, spec]),
);

export function codeForKind(kind: DhpErrorKind): number {
  const code = KIND_TO_CODE.get(kind);
  if (code === undefined) throw new Error(`dhp: unknown error kind ${kind}`);
  return code;
}

export function specForCode(code: number): DhpErrorCodeSpec | undefined {
  return CODE_TO_SPEC.get(code);
}

export function isDhpErrorCode(code: number): boolean {
  return CODE_TO_SPEC.has(code);
}

/** 该 `kind` 是否允许客户端自动重试（不包含需要人工介入的 `never_auto`）。 */
export function isAutoRetryable(kind: DhpErrorKind): boolean {
  const spec = DHP_ERROR_CODES.find((s) => s.kind === kind);
  if (spec === undefined) return false;
  return spec.retry === 'once' || spec.retry === 'backoff' || spec.retry === 'after_hello';
}
