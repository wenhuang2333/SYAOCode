/**
 * DHP 增补契约（`DesktopDoc/27-功能增补需求与实施清单.md` §5）
 *
 * 与 `methods.ts` / `workbench.ts` 同一分层：本文件**纯类型与常量**，
 * 零 IO、零 `node:`、零内核导入。所有实现细节在 Host。
 *
 * 契约纪律：
 *  - 凭据**不走 DHP**：本文件里没有任何"接收令牌 / 私钥"的方法；
 *    只有"查询是否已配置 / 什么方式 / 哪个指纹"。
 *  - 写操作（`git/stage` 起）一律带命令信封（`commandId` + `baseRevision`），
 *    与 `session/configure` 同一套六态 ACK 语义。
 *  - 会话改动 / 产出 / 来源由 Host 计算，渲染层只替换不合并。
 */

import type { AckResult } from './command.ts';
import type { DiffHunk } from './methods.ts';

// ── 方法名 ────────────────────────────────────────────────────────────────

export const FeatureMethod = {
  // MCP 客户端（FR-N-001）
  McpList: 'mcp/list',
  McpAdd: 'mcp/add',
  McpRemove: 'mcp/remove',
  McpRestart: 'mcp/restart',
  McpTools: 'mcp/tools',

  // Agent 群三角色（FR-N-003）
  AgentsList: 'agents/list',
  AgentsSave: 'agents/save',
  AgentsDelete: 'agents/delete',
  AgentsActivate: 'agents/activate',

  // Git 只读（FR-N-021…024 / 027）
  GitStatus: 'git/status',
  GitGraph: 'git/graph',
  GitBranches: 'git/branches',
  GitDiff: 'git/diff',
  GitRemotes: 'git/remotes',
  GitAuthStatus: 'git/auth/status',

  // Git 写操作（FR-N-025，2026-11-07 二次裁决纳入本轮）
  GitStage: 'git/stage',
  GitUnstage: 'git/unstage',
  GitCommit: 'git/commit',
  GitBranchCreate: 'git/branch/create',
  GitBranchSwitch: 'git/branch/switch',

  // 远端与凭据（FR-N-027 / 030）
  GitRemoteAdd: 'git/remote/add',
  GitRemoteRemove: 'git/remote/remove',
  GitAuthOauthStart: 'git/auth/oauth/start',
  GitAuthOauthPoll: 'git/auth/oauth/poll',
  GitAuthOauthCancel: 'git/auth/oauth/cancel',
  GitAuthSshUseAgent: 'git/auth/ssh/use-agent',
  GitAuthSshGenerate: 'git/auth/ssh/generate',
  GitAuthClear: 'git/auth/clear',

  // 预检与上传（FR-N-028 / 029）
  GitPreflight: 'git/preflight',
  GitUpload: 'git/upload',

  // 提交信息生成（FR-N-026）
  GitCommitMessage: 'git/commit-message',

  // 单文件改动 diff（FR-N-011，会话口径）
  SessionChangeDiff: 'session/change-diff',

  // `!` 前缀直接执行命令（FR-N-036，仍过权限闸门）
  SessionRunCommand: 'session/run-command',

  // 会话 fork / 删除（FR-N-035）
  SessionFork: 'session/fork',
  SessionDelete: 'session/delete',
} as const;

export type FeatureMethodName = (typeof FeatureMethod)[keyof typeof FeatureMethod];

/** 服务端 → 客户端的增补通知方法名。 */
export const FeatureNotification = {
  /** 会话改动 / 产出 / 来源快照（整体替换，不做 delta）。 */
  SessionChanges: 'session/changes',
  /** MCP 服务增删、崩溃、重启。 */
  McpChanged: 'mcp/changed',
  /** 工作区 Git 状态可能变化（可合并，仅提示刷新）。 */
  GitChanged: 'git/changed',
  /** 登录状态变化（只推方式与账号，不推任何凭据值）。 */
  GitAuthChanged: 'git/auth/changed',
} as const;

export type FeatureNotificationName = (typeof FeatureNotification)[keyof typeof FeatureNotification];

export const ALL_FEATURE_METHODS: readonly FeatureMethodName[] = Object.values(FeatureMethod);
export const ALL_FEATURE_NOTIFICATIONS: readonly FeatureNotificationName[] = Object.values(FeatureNotification);

// ── 会话详情三块（FR-N-011 / 012 / 013）─────────────────────────────────

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/**
 * 会话口径的文件改动（**不是**工作区口径）。
 *
 * `stat: 'unavailable'` 时 `added` / `removed` 必须为 `null`——UI 显示"不可统计"，
 * 绝不用 0 冒充（`27` §6 不伪造原则）。
 */
export interface FileChange {
  readonly path: string;
  readonly status: FileChangeStatus;
  /** 行数；`stat === 'unavailable'` 时为 `null`。 */
  readonly added: number | null;
  readonly removed: number | null;
  readonly stat: 'exact' | 'unavailable';
  /** 造成该改动的工具名（`write` / `edit` / …）。 */
  readonly tool: string;
  readonly updatedAt: number;
}

/**
 * `!` 前缀直接执行命令（FR-N-036）。
 *
 * 与模型的 `bash` 工具走**同一套权限闸门**（`27` §4.4「仍过权限闸门」）：
 * 危险命令被内核规则库直接拒绝、敏感路径强制询问、权限模式照常生效。
 * 本方法只负责"在已获准之后怎么跑"，不负责放行。
 */
export interface SessionRunCommandParams {
  readonly sessionId: string;
  /** 用户输入的命令原文（不含前导 `!`）。 */
  readonly command: string;
}

export interface SessionRunCommandResult {
  readonly sessionId: string;
  readonly command: string;
  /** 进程退出码；被信号杀死时为负或 1（与 POSIX 惯例一致）。 */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** 输出超过上限时为 `true`（界面必须显示"已截断"）。 */
  readonly truncated: boolean;
  /** 是否因超时被杀。 */
  readonly timedOut: boolean;
  readonly durationMs: number;
}

/**
 * 单文件改动的只读 diff（FR-N-011 的"点击展开 diff"）。
 *
 * **会话口径**：内容来自采集器记录的"本会话首次触碰前 → 现在"，
 * 与 Git 的 worktree/staged diff 是两件事，不能互相替代。
 */
export interface SessionChangeDiffParams {
  readonly sessionId: string;
  /** 工作区相对路径（必须来自 `changes`，服务端会再校验一次围栏）。 */
  readonly path: string;
}

export interface SessionChangeDiffResult {
  readonly sessionId: string;
  readonly path: string;
  /** 会话口径的改动状态（与 `changes` 里的一致）。 */
  readonly status: FileChangeStatus;
  readonly hunks: readonly DiffHunk[];
  readonly added: number;
  readonly removed: number;
  /** 行数超过上限时为 `true`（界面必须显示"只显示前 N 行"）。 */
  readonly truncated: boolean;
  /**
   * 不可算 diff 的原因；非 `null` 时 `hunks` 为空。
   * 取值：`binary`（二进制）/ `too_large`（超预算）/ `no_snapshot`（没有前置像，
   * 例如会话重启后或采集器未开启）/ `deleted`（文件已删除，只能给行数）。
   */
  readonly unavailable: 'binary' | 'too_large' | 'no_snapshot' | 'deleted' | null;
}

export type ArtifactKind = 'file' | 'image' | 'patch' | 'report' | 'archive';

/** 产出：会话**新建**或生成、用户可能想取走的东西。 */
export interface Artifact {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly kind: ArtifactKind;
  readonly sizeBytes: number | null;
  readonly tool: string;
  readonly createdAt: number;
}

export type SourceTrust = 'verified' | 'extracted' | 'declared';

/**
 * 参考来源。`trust !== 'verified'` 时 `verified` 必须为 `false`，
 * 且 UI 必须显示可见标注——抓不到验证凭据就不许说"已核实"。
 */
export interface SourceRef {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly count: number;
  readonly tool: string;
  readonly trust: SourceTrust;
  readonly verified: boolean;
}

/**
 * 改动统计的覆盖范围说明（`27` §7.3 诚实降级）。
 *
 * 用过 `bash` 时 `exact` 为 `false`：命令造成的文件变化未逐文件统计。
 */
export interface ChangesCoverage {
  readonly exact: boolean;
  readonly bashUsed: boolean;
  readonly note: string | null;
}

/** `session/changes` 通知载荷：整体替换语义。 */
export interface SessionChangesNotification {
  readonly sessionId: string;
  readonly changes: readonly FileChange[];
  readonly artifacts: readonly Artifact[];
  readonly sources: readonly SourceRef[];
  readonly coverage: ChangesCoverage;
}

// ── MCP（FR-N-001）──────────────────────────────────────────────────────

export type McpTransport = 'stdio' | 'http';
export type McpServerStatus = 'idle' | 'starting' | 'ready' | 'error' | 'stopped';

export interface McpServerInfo {
  readonly id: string;
  readonly name: string;
  readonly transport: McpTransport;
  readonly status: McpServerStatus;
  readonly toolCount: number;
  readonly lossy: readonly string[];
  readonly trusted: boolean;
  /** 面向用户的一句话状态（失败原因等），不含任何密钥。 */
  readonly detail: string | null;
  /** stdio 的命令（不含环境变量值）；http 为 `null`。 */
  readonly command: string | null;
  /** http 的端点（已剥离查询串与内嵌凭据）；stdio 为 `null`。 */
  readonly url: string | null;
  readonly updatedAt: number;
}

export interface McpListResult {
  readonly servers: readonly McpServerInfo[];
}

/**
 * 添加受信 MCP 服务。
 *
 * `envNames` **只允许环境变量名**：值来自 Host 启动环境，界面不读取、不回显、不落盘。
 */
export interface McpAddParams {
  readonly name?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly envNames?: readonly string[];
  readonly trusted: boolean;
}

export interface McpAddResult {
  readonly server: McpServerInfo;
}

export interface McpRemoveParams {
  readonly serverId: string;
}
export interface McpRestartParams {
  readonly serverId: string;
}
export interface McpToolsParams {
  readonly serverId: string;
}

export interface McpToolSummary {
  readonly name: string;
  readonly description: string;
  /** 输入 schema 的**摘要**（不是完整 JSON Schema，避免把大 schema 推给渲染层）。 */
  readonly inputSchemaSummary: string;
  readonly readOnly: boolean;
}

export interface McpToolsResult {
  readonly serverId: string;
  readonly tools: readonly McpToolSummary[];
}

export interface McpChangedNotification {
  readonly serverId: string;
  readonly status: McpServerStatus;
}

// ── Agent 群三角色（FR-N-003）───────────────────────────────────────────

export type AgentRole = 'hyaki' | 'sota' | 'common';

export const AGENT_ROLES: readonly AgentRole[] = ['hyaki', 'sota', 'common'];

/** 三角色各自的 `渠道:模型` 绑定；同一模型可兼任多角色。 */
export interface AgentGroup {
  readonly name: string;
  readonly roles: Readonly<Record<AgentRole, string>>;
  readonly active: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AgentsListResult {
  readonly groups: readonly AgentGroup[];
  /** 当前激活的群名；未激活为 `null`。 */
  readonly active: string | null;
}

export interface AgentsSaveParams {
  readonly name: string;
  readonly roles: Readonly<Record<AgentRole, string>>;
}

export interface AgentsDeleteParams {
  readonly name: string;
}

export interface AgentsActivateParams {
  readonly name: string;
}

// ── Git 只读（FR-N-021…024 / 027）──────────────────────────────────────

export type GitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

/**
 * 工作区口径的单个文件条目（`git status --porcelain=v2 -z` + `git diff --numstat`）。
 *
 * 与 `FileChange`（会话口径）**绝不能相加**：一个用户文件夹里本来就有的未提交
 * 改动不属于任何会话。
 */
export interface GitFileEntry {
  readonly path: string;
  readonly status: GitFileStatus;
  readonly staged: boolean;
  /** 重命名前的路径；非重命名为 `null`。 */
  readonly oldPath: string | null;
  readonly added: number | null;
  readonly removed: number | null;
  readonly stat: 'exact' | 'unavailable';
  readonly binary: boolean;
  /**
   * **已暂存内容**（即将提交的 blob）的字节数；无暂存内容或不可读时为 `null`。
   *
   * 用于提交前的大文件提示（`27` §10.5.3）：超过阈值只提示、不阻止。
   * 未暂存条目一律为 `null`——不能用工作区文件大小冒充"将要提交的大小"。
   */
  readonly sizeBytes: number | null;
}

/**
 * 仓库里的 Git 钩子（`27` §10.5.3）。
 *
 * 钩子是**用户仓库里的可执行脚本**：执行前必须在确认框里标注"将运行 N 个钩子"，
 * 跳过（`--no-verify`）需单独勾选并记审计。
 */
export interface GitHookInfo {
  /** 钩子名，例如 `pre-commit` / `commit-msg` / `pre-push`。 */
  readonly name: string;
  /** 是否可执行（不可执行的钩子 Git 不会运行，界面不能把它算进"将运行的 N 个"）。 */
  readonly executable: boolean;
}

export interface GitStatusResult {
  readonly workspaceRoot: string;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly head: string | null;
  readonly clean: boolean;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly files: readonly GitFileEntry[];
  /** 条目数超过上限时为 `true`（UI 必须显示"已截断"）。 */
  readonly truncated: boolean;
  /**
   * 仓库里存在且**可执行**的提交相关钩子（`pre-commit` / `commit-msg` / `pre-push`）。
   *
   * 只列存在项；`executable=false` 的也列出来，但界面不能把它算进"将运行的钩子数"。
   */
  readonly hooks: readonly GitHookInfo[];
  /**
   * Git 状态版本：写操作的 `baseRevision` 就是它。
   * 只随写操作与工作区状态变化前进，不随流式事件变化。
   */
  readonly revision: number;
  readonly fetchedAt: number;
}

export interface GitStatusParams {
  readonly workspaceRoot: string;
}

export interface GitCommitNode {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly email: string;
  readonly at: number;
  readonly subject: string;
  /** 指向该提交的 ref 短名（分支 / tag），已去掉 `refs/heads/` 等前缀。 */
  readonly refs: readonly string[];
}

export interface GitGraphParams {
  readonly workspaceRoot: string;
  readonly maxCount?: number;
  readonly skip?: number;
}

export interface GitGraphResult {
  readonly workspaceRoot: string;
  readonly commits: readonly GitCommitNode[];
  readonly hasMore: boolean;
  /** 窗口外父提交 → UI 画虚线（截断）。 */
  readonly truncated: boolean;
}

export interface GitBranchInfo {
  readonly name: string;
  readonly kind: 'local' | 'remote';
  readonly current: boolean;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly upstream: string | null;
  readonly sha: string | null;
}

export interface GitBranchesResult {
  readonly workspaceRoot: string;
  readonly current: string | null;
  readonly detached: boolean;
  readonly local: readonly GitBranchInfo[];
  readonly remote: readonly GitBranchInfo[];
}

export interface GitDiffParams {
  readonly workspaceRoot: string;
  readonly path: string;
  readonly mode?: 'worktree' | 'staged' | 'commit';
  readonly commit?: string;
}

export interface GitDiffResult {
  readonly workspaceRoot: string;
  readonly path: string;
  readonly mode: 'worktree' | 'staged' | 'commit';
  readonly hunks: readonly DiffHunk[];
  readonly added: number;
  readonly removed: number;
  readonly truncated: boolean;
  readonly binary: boolean;
}

// ── Git 认证 / 远端（FR-N-027 / 030）────────────────────────────────────

export type GitAuthMethod = 'oauth' | 'ssh-agent' | 'ssh-key' | 'token' | 'none';

/**
 * 登录状态。
 *
 * **只含元信息**：方式、账号、scope、指纹、是否就绪。
 * 永远不含令牌、口令、私钥内容——凭据只写不读（`27` §10.7）。
 */
export interface GitAuthInfo {
  readonly method: GitAuthMethod;
  readonly configured: boolean;
  readonly account: string | null;
  readonly scope: readonly string[];
  readonly ready: boolean;
  readonly keyFingerprint: string | null;
  readonly updatedAt: number | null;
}

export interface GitRemoteInfo {
  readonly name: string;
  /** 展示用 URL：已剥离 `https://user:token@host/...` 形式的内嵌凭据。 */
  readonly url: string;
  readonly auth: GitAuthInfo;
}

export interface GitRemotesParams {
  readonly workspaceRoot: string;
}

export interface GitRemotesResult {
  readonly workspaceRoot: string;
  readonly remotes: readonly GitRemoteInfo[];
}

export interface GitAuthStatusResult {
  readonly workspaceRoot: string;
  readonly remotes: readonly GitRemoteInfo[];
  /** 支持的授权厂商（GitHub 先做，GitLab / Gitee 走同一适配器）。 */
  readonly providers: readonly GitOauthProvider[];
}

export interface GitOauthProvider {
  readonly id: string;
  readonly label: string;
  /** 是否支持 OAuth Device Flow。 */
  readonly deviceFlow: boolean;
  /** 是否内置了 `client_id`（`27` §10.7.6 路线 1）。 */
  readonly builtinClientId: boolean;
}

export interface GitAuthOauthStartParams {
  readonly workspaceRoot: string;
  readonly remote: string;
  readonly provider: string;
  /** 自带应用（路线 2 / GHES）：覆盖内置 `client_id`。 */
  readonly clientId?: string;
  /** GHES 等自建实例域名。 */
  readonly domain?: string;
}

export interface GitAuthOauthStartResult {
  readonly flowId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresIn: number;
  readonly interval: number;
}

export interface GitAuthOauthPollParams {
  readonly flowId: string;
}

export type GitOauthPollStatus = 'pending' | 'ready' | 'denied' | 'expired' | 'slow_down';

export interface GitAuthOauthPollResult {
  readonly status: GitOauthPollStatus;
  readonly account: string | null;
  readonly scope: readonly string[];
}

export interface GitAuthOauthCancelParams {
  readonly flowId: string;
}

export interface GitAuthSshUseAgentParams {
  readonly workspaceRoot: string;
  readonly remote: string;
}

export interface GitAuthSshGenerateParams {
  readonly workspaceRoot: string;
  readonly remote: string;
  readonly comment?: string;
}

export interface GitAuthSshGenerateResult {
  /** 只返回公钥；私钥由 Host 直接交给主进程存钥匙串，不返回给渲染层。 */
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly keyType: 'ed25519';
}

export interface GitAuthClearParams {
  readonly workspaceRoot: string;
  readonly remote: string;
}

export interface GitRemoteAddParams {
  readonly workspaceRoot: string;
  readonly name: string;
  readonly url: string;
}

export interface GitRemoteRemoveParams {
  readonly workspaceRoot: string;
  readonly name: string;
}

export interface GitAuthChangedNotification {
  readonly workspaceRoot: string;
  readonly remote: string;
  readonly auth: GitAuthInfo;
}

// ── Git 写操作（FR-N-025）──────────────────────────────────────────────

/**
 * Git 写操作统一结果。
 *
 * `status` 复用六态 ACK 的语义子集：`accepted` / `duplicate` / `stale` / `rejected`。
 * 副作用完成后客户端应重新 `git/status` 取最新状态。
 */
export type GitAckResult = AckResult;

export interface GitStageParams {
  readonly workspaceRoot: string;
  readonly paths: readonly string[];
}

export interface GitCommitParams {
  readonly workspaceRoot: string;
  readonly message: string;
  /** 是否连同未暂存改动一起提交（`git commit -a`）；默认 `false`。 */
  readonly includeUnstaged?: boolean;
  /** 跳过钩子（`--no-verify`）需单独勾选并记审计；默认 `false`。 */
  readonly noVerify?: boolean;
  /** 允许空提交（`--allow-empty`）：无改动时默认拒绝，需显式勾选。 */
  readonly allowEmpty?: boolean;
  /**
   * 本次提交不签名（`--no-gpg-sign`）。
   *
   * 只在**签名失败后由用户显式选择**时使用（`27` §10.5.3）：签名失败绝不静默降级。
   */
  readonly noSign?: boolean;
}

export interface GitBranchCreateParams {
  readonly workspaceRoot: string;
  readonly name: string;
  /** 是否创建后切换过去；默认 `false`。 */
  readonly checkout?: boolean;
}

export interface GitBranchSwitchParams {
  readonly workspaceRoot: string;
  readonly name: string;
}

/** 写操作信封（`27` §5.1：与 `session/configure` 同一套语义）。 */
export interface GitCommandEnvelope {
  readonly commandId: string;
  readonly baseRevision: number;
}

// ── 预检与上传（FR-N-028 / 029）────────────────────────────────────────

export interface GitPreflightParams {
  readonly workspaceRoot: string;
  readonly remote: string;
  readonly branch?: string;
  /** `all`（默认，全部未提交改动）/ `session`（仅本会话改动）。 */
  readonly scope?: 'all' | 'session';
}

export interface GitPreflightBlocker {
  readonly kind: string;
  readonly code: number;
  readonly reason: string;
}

export interface GitPreflightResult {
  readonly workspaceRoot: string;
  readonly remote: string;
  readonly remoteUrl: string;
  readonly branch: string;
  readonly clean: boolean;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly diverged: boolean;
  readonly remoteWritable: boolean | null;
  readonly online: boolean | null;
  readonly files: number;
  readonly added: number;
  readonly removed: number;
  readonly truncated: boolean;
  readonly requiresCommit: boolean;
  readonly revision: number;
  readonly blockers: readonly GitPreflightBlocker[];
}

/**
 * 提交信息生成（FR-N-026）。
 *
 * 只读：不执行任何 git 写操作，也不落盘。生成失败时 `source='fallback'`，
 * 界面用 `message` 预填并允许用户改写（模型不可用不等于功能不可用）。
 */
export interface GitCommitMessageParams {
  readonly workspaceRoot: string;
  /** 可选：取该会话的模型与会话改动作为上下文。 */
  readonly sessionId?: string;
  /** `staged`（默认）只取已暂存改动；`session` 取本会话改动涉及的文件。 */
  readonly scope?: 'staged' | 'session';
  /** 用户补充说明（可编辑，不落盘）。 */
  readonly hint?: string;
}

export interface GitCommitMessageResult {
  /** 最终提交信息（已清洗、保证非空）。 */
  readonly message: string;
  readonly source: 'model' | 'fallback';
  /** diff 是否被截断（截断时提示用户可能只看到部分改动）。 */
  readonly truncated: boolean;
  /** `source='fallback'` 的原因（简短、无敏感信息）。 */
  readonly reason: string | null;
}

export interface GitUploadParams extends GitCommandEnvelope {
  readonly workspaceRoot: string;
  readonly remote: string;
  readonly branch: string;
  readonly message: string;
  readonly includeUnstaged?: boolean;
  readonly scope?: 'all' | 'session';
}

export interface GitUploadResult {
  readonly sha: string;
  readonly remote: string;
  readonly branch: string;
  readonly files: number;
  readonly added: number;
  readonly removed: number;
  readonly pushed: boolean;
}

// ── 会话 fork / 删除（FR-N-035）─────────────────────────────────────────

export interface SessionForkParams extends GitCommandEnvelope {
  readonly sessionId: string;
  /** 从哪条消息之后分叉（快照 `seq`）；缺省表示整段历史。 */
  readonly atSeq?: number;
  readonly title?: string;
}

export interface SessionForkResult {
  readonly sessionId: string;
}

export interface SessionDeleteParams extends GitCommandEnvelope {
  readonly sessionId: string;
}
