/**
 * DHP 方法名与参数/结果契约（`06` §5）
 *
 * 方法名用**常量对象**而不是散落的字符串字面量：
 * 编译器因此能发现拼写错误，客户端与服务端也永远对得上。
 */

export const Method = {
  // 握手
  Hello: 'hello',

  // 会话
  SessionCreate: 'session/create',
  SessionList: 'session/list',
  SessionSnapshot: 'session/snapshot',
  SessionResume: 'session/resume',
  SessionClose: 'session/close',
  SessionRename: 'session/rename',
  SessionEvents: 'session/events',
  SessionSubscribe: 'session/subscribe',
  SessionUnsubscribe: 'session/unsubscribe',

  // 对话
  TurnSend: 'turn/send',
  TurnStop: 'turn/stop',
  TurnSteer: 'turn/steer',

  // 交互
  InteractionResolve: 'interaction/resolve',

  // 配置 / 模型
  ConfigGet: 'config/get',
  ConfigSet: 'config/set',
  ModelList: 'model/list',
  ModelUse: 'model/use',

  // 工作区
  WorkspaceOpen: 'workspace/open',
  WorkspaceTree: 'workspace/tree',
  WorkspaceReadFile: 'workspace/readFile',
  WorkspaceDiff: 'workspace/diff',

  // 终端
  TerminalCreate: 'terminal/create',
  TerminalInput: 'terminal/input',
  TerminalResize: 'terminal/resize',
  TerminalClose: 'terminal/close',

  // 治理
  GovernanceStatus: 'governance/status',
  GovernanceTasks: 'governance/tasks',
  GovernanceApprovals: 'governance/approvals',
  GovernanceDecide: 'governance/decide',
  GovernanceAudit: 'governance/audit',
  GovernancePolicyExplain: 'governance/policyExplain',

  // 成本 / 诊断
  CostWorkspace: 'cost/workspace',
  DoctorRun: 'doctor/run',

  // 系统
  AppInfo: 'app/info',
  AppShutdown: 'app/shutdown',
} as const;

export type MethodName = (typeof Method)[keyof typeof Method];

/** 服务端 → 客户端的通知方法名。 */
export const Notification = {
  /** 会话事件流（核心）。 */
  SessionEvent: 'session/event',
  /** 需要用户决策（审批 / 提问）。 */
  InteractionRequest: 'interaction/request',
  /** 会话列表变化（新建/关闭/重命名）。 */
  SessionChanged: 'session/changed',
  /** 终端字节流（Base64；见 §2 的二进制帧约定）。 */
  TerminalData: 'terminal/data',
  TerminalExit: 'terminal/exit',
  /** 非致命的系统提示（更新可用、预算告警等）。 */
  AppNotice: 'app/notice',
} as const;

export type NotificationName = (typeof Notification)[keyof typeof Notification];

/** 全部方法名，用于"方法是否存在"的检查与文档生成。 */
export const ALL_METHODS: readonly MethodName[] = Object.values(Method);
export const ALL_NOTIFICATIONS: readonly NotificationName[] = Object.values(Notification);

// ── 参数 / 结果类型 ──────────────────────────────────────────────────────

import type { PendingInteraction, SessionDelta, SessionEvent, SessionSnapshot } from './projection.ts';
import type { AckResult } from './command.ts';
import type { DhpCapability, HelloAckResult, HelloParams } from './version.ts';

export interface SessionCreateParams {
  readonly title?: string;
  readonly model?: string;
  readonly permissionMode?: string;
  readonly workspaceRoot?: string;
}
export interface SessionCreateResult {
  readonly snapshot: SessionSnapshot;
}

export interface SessionListParams {
  readonly limit?: number;
}
export interface SessionSummary {
  readonly sessionId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly turnCount: number;
}
export interface SessionListResult {
  readonly sessions: readonly SessionSummary[];
}

export interface SessionSnapshotParams {
  readonly sessionId: string;
}
export type SessionSnapshotResult = SessionSnapshot;

export interface SessionResumeParams {
  readonly sessionId: string;
}
export interface SessionResumeResult {
  /** 恢复后返回完整快照（客户端整体替换，不 merge）。 */
  readonly snapshot: SessionSnapshot;
}

export interface SessionCloseParams {
  readonly sessionId: string;
}
export interface SessionRenameParams {
  readonly sessionId: string;
  readonly title: string;
}

export interface SessionEventsParams {
  readonly sessionId: string;
  readonly fromSeq: number;
  readonly toSeq?: number;
}
export interface SessionEventsResult {
  /** 补洞分页通道：与 `session/event` 通知共用 `SessionDelta` 形状。 */
  readonly delta: SessionDelta;
}

export interface SessionSubscribeParams {
  readonly sessionId: string;
  /** 客户端当前水位。服务端据此决定回 snapshot 还是补 delta。 */
  readonly baseSeq?: number;
  readonly epoch?: number;
}
export interface SessionSubscribeResult {
  readonly subscribed: true;
  /** 是否随订阅一起下发快照（断档或首次订阅时为 true）。 */
  readonly snapshotIncluded: boolean;
  readonly seq: number;
  readonly epoch: number;
}

export interface TurnSendParams {
  readonly commandId: string;
  readonly baseRevision: number;
  readonly sessionId: string;
  readonly text: string;
}
export type TurnSendResult = AckResult;

export interface TurnStopParams {
  readonly commandId: string;
  readonly baseRevision: number;
  readonly sessionId: string;
  /** 防止迟到的取消误杀后续执行（`06` §7）。 */
  readonly expectedExecutionId?: string;
}
export type TurnStopResult = AckResult;

export interface TurnSteerParams {
  readonly commandId: string;
  readonly baseRevision: number;
  readonly sessionId: string;
  /**
   * **必填**：必须命中当前执行 id（`06` §5.5 / `28` §2）。
   * 不匹配 = 迟到的 steer，Host 回 `noop`（reason `execution already changed`），
   * **不得**排入下一轮执行。
   */
  readonly expectedExecutionId: string;
  /** 补充指令文本，1..10 000 字符（`28` §2）。 */
  readonly text: string;
}

/**
 * `turn/steer` 的业务结果（放在 ACK 的 `data` 里）。
 *
 * **`queued: true` 只表示"已接受排队"**：不表示模型已看到，更不表示执行成功。
 * 终态只能从事件流读：`steer.consumed` / `steer.not_consumed`。
 */
export interface TurnSteerResult {
  readonly queued: true;
  readonly executionId: string;
  readonly steerId: string;
}

export interface InteractionResolveParams {
  readonly commandId: string;
  readonly baseRevision: number;
  readonly sessionId: string;
  readonly interactionId: string;
  /** 选项 id（`once` / `session` / `project` / `deny`）。 */
  readonly optionId: string;
}
export type InteractionResolveResult = AckResult;

export interface ConfigGetResult {
  readonly model: string;
  readonly permissionMode: string;
  readonly language: 'en' | 'zh';
  readonly workspaceRoot: string;
  /** 来源层标注（default/user/project/env/cli）—— UI 必须显示，用户才知道值从哪来。 */
  readonly sources: Readonly<Record<string, string>>;
}

export interface ConfigSetParams {
  readonly key: 'model' | 'permissionMode' | 'language';
  readonly value: string;
}
export interface ConfigSetResult {
  readonly ok: true;
  readonly effective: string;
}

export interface ModelInfo {
  readonly spec: string;
  readonly provider: string;
  readonly model: string;
  readonly hasKey: boolean;
}
export interface ModelListResult {
  readonly current: string;
  readonly available: readonly ModelInfo[];
}
export interface ModelUseParams {
  readonly spec: string;
}
export interface ModelUseResult {
  readonly ok: true;
  readonly current: string;
}

export interface WorkspaceOpenParams {
  readonly path: string;
}
export interface WorkspaceOpenResult {
  readonly workspaceRoot: string;
  readonly name: string;
}

export interface TreeNode {
  readonly name: string;
  readonly path: string;
  readonly type: 'file' | 'dir';
  readonly children?: readonly TreeNode[];
}
export interface WorkspaceTreeResult {
  readonly root: string;
  readonly nodes: readonly TreeNode[];
}

export interface WorkspaceReadFileParams {
  readonly path: string;
  readonly maxBytes?: number;
}
export interface WorkspaceReadFileResult {
  readonly path: string;
  readonly text: string;
  readonly truncated: boolean;
}

export interface WorkspaceDiffParams {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}
export interface DiffHunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly { readonly kind: 'add' | 'del' | 'ctx'; readonly text: string }[];
}
export interface WorkspaceDiffResult {
  readonly path: string;
  readonly hunks: readonly DiffHunk[];
  readonly added: number;
  readonly removed: number;
}

export interface TerminalCreateParams {
  readonly cwd?: string;
  readonly cols?: number;
  readonly rows?: number;
}
export interface TerminalCreateResult {
  readonly terminalId: string;
  readonly shell: string;
}
export interface TerminalInputParams {
  readonly terminalId: string;
  /** Base64 编码的字节（避免 JSON 字符串里的控制字符问题）。 */
  readonly dataBase64: string;
}
export interface TerminalResizeParams {
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
}
export interface TerminalCloseParams {
  readonly terminalId: string;
}

export interface GovernanceStatusResult {
  readonly tenantId: string;
  readonly policyRevision: string;
  readonly capabilityCount: number;
  readonly tasks: { readonly total: number; readonly unterminated: number };
  readonly pendingApprovals: number;
  readonly auditOk: boolean;
  readonly budget: { readonly accountId: string; readonly limitUsd?: number; readonly usedUsd: number };
}

export interface GovernanceTaskInfo {
  readonly taskId: string;
  readonly state: string;
  readonly sessionId?: string;
  readonly createdAt: string;
}
export interface GovernanceTasksResult {
  readonly tasks: readonly GovernanceTaskInfo[];
}

export interface GovernanceApprovalInfo {
  readonly id: string;
  readonly subject: string;
  readonly risk: string;
  readonly expiresAt?: string;
}
export interface GovernanceApprovalsResult {
  readonly approvals: readonly GovernanceApprovalInfo[];
}

export interface GovernanceDecideParams {
  readonly commandId: string;
  readonly baseRevision: number;
  readonly approvalId: string;
  readonly optionId: string;
}
export type GovernanceDecideResult = AckResult;

export interface GovernanceAuditParams {
  readonly limit?: number;
}
export interface GovernanceAuditResult {
  readonly ok: boolean;
  readonly events: readonly { readonly at: string; readonly kind: string; readonly subject: string }[];
}

export interface GovernancePolicyExplainParams {
  readonly capabilityId: string;
}
export interface GovernancePolicyExplainResult {
  /** 命中的规则链，用于回答"为什么问我"。 */
  readonly effect: 'allow' | 'deny' | 'ask';
  readonly reasons: readonly string[];
  readonly matchedRules: readonly { readonly id: string; readonly effect: string; readonly source: string }[];
}

export interface CostWorkspaceResult {
  readonly workspace: string;
  readonly totals: {
    readonly requests: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
  };
  readonly models: readonly {
    readonly spec: string;
    readonly requests: number;
    readonly costUsd: number;
  }[];
}

export interface DoctorCheckInfo {
  readonly name: string;
  readonly status: 'ok' | 'warn' | 'fail';
  readonly detail: string;
}
export interface DoctorRunResult {
  readonly checks: readonly DoctorCheckInfo[];
}

export interface AppInfoResult {
  readonly appVersion: string;
  readonly hostVersion: string;
  readonly dhpVersion: { readonly major: number; readonly minor: number };
  readonly nodeVersion: string;
  readonly platform: string;
  readonly workspaceRoot: string;
  readonly capabilities: readonly DhpCapability[];
}

export interface AppShutdownParams {
  /** 是否等待运行中任务完成。 */
  readonly graceful?: boolean;
}

/** `session/event` 通知的载荷。 */
export interface SessionEventNotification {
  readonly delta: SessionDelta;
  /** 合并帧标记：水位用 `toSeq` 推进，不按 `events.length`。 */
  readonly coalesced?: boolean;
}

/** `interaction/request` 通知的载荷。 */
export interface InteractionRequestNotification {
  readonly interaction: PendingInteraction;
}

/** `session/changed` 通知的载荷。 */
export interface SessionChangedNotification {
  readonly sessionId: string;
  readonly change: 'created' | 'closed' | 'renamed';
  readonly title?: string;
}

/** `terminal/data` 通知的载荷。 */
export interface TerminalDataNotification {
  readonly terminalId: string;
  readonly dataBase64: string;
}
export interface TerminalExitNotification {
  readonly terminalId: string;
  readonly exitCode: number;
}

export type { HelloParams, HelloAckResult, SessionSnapshot, SessionDelta, SessionEvent, PendingInteraction };
