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

/** L2 自定义错误码的段边界（`06` §10.2）。 */
export const DHP_ERROR_RANGE = { min: -32025, max: -32000 } as const;

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
  | 'read_only';

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
 * 26 个自定义码，`-32000`~`-32025` **连续无空洞**。
 * 顺序与 `06` §10.2 完全一致；`check-dhp-code-tables.mjs` 会做差集校验。
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
