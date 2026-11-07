/**
 * Git 侧栏（`27` §11.3 / §10.8）。
 *
 * 纪律：
 *  - **按需显示**：默认收起，不因改动、远端或上传结果自动弹出；
 *  - **与会话详情互斥**：两者共用右栏槽位，同一时刻只显示一个（见 `gitTabState`）；
 *  - **工作区口径**与"会话详情"的**会话口径**绝不混算、不相加；
 *  - 上传是唯一出网操作：必须二次确认，失败只给"凭据未配置 / 被拒 / 离线 / 分叉"四条路径，
 *    **任何位置都不提供 force 选项**。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  GitAuthInfo,
  GitAuthStatusResult,
  GitBranchesResult,
  GitBranchInfo,
  GitCommitMessageResult,
  GitCommitNode,
  GitDiffResult,
  GitFileEntry,
  GitFileStatus,
  GitGraphResult,
  GitHookInfo,
  GitAuthOauthPollResult,
  GitAuthOauthStartResult,
  GitOauthPollStatus,
  GitOauthProvider,
  GitPreflightResult,
  GitRemoteInfo,
  GitRemotesResult,
  GitStatusResult,
  GitUploadResult,
} from '@syaocode/dhp';
import { Icon } from './icons';
import { formatRelative } from './format';
import { t, type Lang } from './i18n';

// ── 纯函数（可被测试直接断言）────────────────────────────────────────────

export type GitTab = 'changes' | 'graph' | 'branches' | 'upload';

export function gitTabs(lang: Lang = 'zh'): readonly { readonly id: GitTab; readonly label: string }[] {
  return [
    { id: 'changes', label: t(lang, 'git.tabs.changes') },
    { id: 'graph', label: t(lang, 'git.tabs.graph') },
    { id: 'branches', label: t(lang, 'git.tabs.branches') },
    { id: 'upload', label: t(lang, 'git.tabs.upload') },
  ];
}

/** 中文标签页（默认语言），保留给既有调用方与测试。 */
export const GIT_TABS: readonly { readonly id: GitTab; readonly label: string }[] = gitTabs('zh');

/** 右栏槽位：会话详情与 Git 互斥。 */
export type RightSlot = 'none' | 'detail' | 'git';

export interface SidebarSlotState {
  readonly slot: RightSlot;
  readonly detailOpen: boolean;
  readonly gitOpen: boolean;
  readonly tab: GitTab;
  /** 打开 Git 之前会话详情是否展开（关闭 Git 后据此回退）。 */
  readonly detailBeforeGit: boolean;
}

export type SidebarAction = 'toggle-git' | 'toggle-detail' | 'select-tab' | 'close';

/** 右栏初始状态：**默认收起**（Git 不自动弹出）。 */
export const INITIAL_SIDEBAR_STATE: SidebarSlotState = {
  slot: 'none',
  detailOpen: false,
  gitOpen: false,
  tab: 'changes',
  detailBeforeGit: false,
};

/**
 * 右栏槽位状态机（纯函数）。
 *
 * - 打开 Git：若会话详情正展开，右栏直接切换为 Git（**不叠加第二个侧栏**）；
 * - 关闭 Git：回到会话详情；若详情此前是收起态，右栏整体收起；
 * - 打开会话详情：自动关闭 Git（互斥）。
 */
export function gitTabState(state: SidebarSlotState, action: SidebarAction, tab: GitTab = state.tab): SidebarSlotState {
  if (action === 'select-tab') {
    return state.gitOpen ? { ...state, tab } : state;
  }
  if (action === 'close') {
    return { ...INITIAL_SIDEBAR_STATE, tab: state.tab };
  }
  if (action === 'toggle-git') {
    if (state.gitOpen) {
      const back = state.detailBeforeGit;
      return { ...state, slot: back ? 'detail' : 'none', detailOpen: back, gitOpen: false, detailBeforeGit: false };
    }
    return { ...state, slot: 'git', detailOpen: false, gitOpen: true, detailBeforeGit: state.detailOpen, tab: state.tab };
  }
  // toggle-detail
  if (state.detailOpen) {
    return { ...state, slot: state.gitOpen ? 'git' : 'none', detailOpen: false, gitOpen: state.gitOpen };
  }
  return { ...state, slot: 'detail', detailOpen: true, gitOpen: false };
}

/** 工作区状态字母（颜色之外的第二信息载体）。 */
export const GIT_STATUS_LETTERS: Readonly<Record<GitFileStatus, string>> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: '!',
};

export function gitStatusLabels(lang: Lang = 'zh'): Readonly<Record<GitFileStatus, string>> {
  return {
    added: t(lang, 'git.status.added'),
    modified: t(lang, 'git.status.modified'),
    deleted: t(lang, 'git.status.deleted'),
    renamed: t(lang, 'git.status.renamed'),
    untracked: t(lang, 'git.status.untracked'),
    conflicted: t(lang, 'git.status.conflicted'),
  };
}

/** 中文状态名（默认语言），保留给既有调用方与测试。 */
export const GIT_STATUS_LABELS: Readonly<Record<GitFileStatus, string>> = gitStatusLabels('zh');

export interface StagingGroups {
  readonly staged: readonly GitFileEntry[];
  readonly unstaged: readonly GitFileEntry[];
  readonly untracked: readonly GitFileEntry[];
}

/** 按 已暂存 / 未暂存 / 未跟踪 分组。 */
export function groupByStaging(files: readonly GitFileEntry[]): StagingGroups {
  const staged: GitFileEntry[] = [];
  const unstaged: GitFileEntry[] = [];
  const untracked: GitFileEntry[] = [];
  for (const file of files) {
    if (file.status === 'untracked') untracked.push(file);
    else if (file.staged) staged.push(file);
    else unstaged.push(file);
  }
  return { staged, unstaged, untracked };
}

export interface GitFileTotals {
  readonly files: number;
  readonly added: number | null;
  readonly removed: number | null;
  readonly unavailable: number;
}

/** 工作区改动汇总；任一条目不可统计时总计标为未知（`null`）。 */
export function summarizeGitFiles(files: readonly GitFileEntry[]): GitFileTotals {
  let added = 0;
  let removed = 0;
  let unavailable = 0;
  for (const file of files) {
    if (file.stat === 'unavailable' || file.added == null || file.removed == null) {
      unavailable += 1;
      continue;
    }
    added += file.added;
    removed += file.removed;
  }
  return { files: files.length, added: unavailable > 0 ? null : added, removed: unavailable > 0 ? null : removed, unavailable };
}

/** 行数文本：`+12 -3`；不可统计时是"不可统计"（**不是 0**）。 */
export function gitFileStatText(file: GitFileEntry, lang: Lang = 'zh'): string {
  if (file.stat === 'unavailable' || file.added == null || file.removed == null) return t(lang, 'git.file.statUnavailable');
  return `+${file.added} -${file.removed}`;
}

/** 文件行 `aria-label`。 */
export function gitFileLabel(file: GitFileEntry, lang: Lang = 'zh'): string {
  const status = gitStatusLabels(lang)[file.status] ?? t(lang, 'git.status.unknown');
  const where = file.staged
    ? t(lang, 'git.file.whereStaged')
    : file.status === 'untracked' ? t(lang, 'git.file.whereUntracked') : t(lang, 'git.file.whereUnstaged');
  if (file.stat === 'unavailable' || file.added == null || file.removed == null) {
    return t(lang, 'git.file.ariaUnavailable', { path: file.path, status, where });
  }
  return t(lang, 'git.file.ariaChanged', { path: file.path, status, where, added: file.added, removed: file.removed });
}

/** 变更页顶部说明：工作区口径，且明确与会话口径不同。 */
export function gitStatusSummary(status: GitStatusResult | undefined, lang: Lang = 'zh'): string {
  if (!status) return t(lang, 'git.summary.notLoaded');
  const totals = summarizeGitFiles(status.files);
  if (totals.files === 0) return t(lang, 'git.summary.empty');
  if (totals.added == null || totals.removed == null) return t(lang, 'git.summary.incomplete', { files: totals.files });
  return t(lang, 'git.summary.withCounts', { files: totals.files, added: totals.added, removed: totals.removed });
}

/** 顶部工具栏角标：`+12 -3`；没有改动时是空串（不显示虚假数字）。 */
export function gitStatusBadge(status: GitStatusResult | undefined, lang: Lang = 'zh'): string {
  if (!status) return '';
  const totals = summarizeGitFiles(status.files);
  if (totals.files === 0) return '';
  if (totals.added == null || totals.removed == null) return t(lang, 'git.summary.badgeFiles', { files: totals.files });
  return `+${totals.added} -${totals.removed}`;
}

// ── 工作区口径的只读 diff（FR-N-024）────────────────────────────────────
//
// 纪律：Git 侧栏的 diff 是**工作区口径**（索引区 / 工作区），
// 与会话详情里的**会话口径**是两件事，展开时必须写明口径。

/** 文件行该用哪个口径看 diff：已暂存看索引区，其余看工作区。 */
export function diffModeForFile(file: GitFileEntry): 'worktree' | 'staged' {
  return file.staged ? 'staged' : 'worktree';
}

/** 口径说明：两句都点明"工作区口径"，避免与会话口径混为一谈。 */
export function gitDiffScopeText(mode: 'worktree' | 'staged', lang: Lang = 'zh'): string {
  if (mode === 'staged') return t(lang, 'git.scope.staged');
  return t(lang, 'git.scope.worktree');
}

/**
 * diff 的诚实说明：三种原因互不相同，且都不是空白。
 *
 *  - `binary`   → 二进制文件无法显示文本 diff（**不渲染 hunk**）
 *  - `truncated`→ 差异过长，只显示前一部分
 *  - 无 hunk    → 该文件在当前口径下没有文本差异
 * 其它情况返回空串（表示"有内容可显示"）。
 */
export function gitDiffEmptyText(result: GitDiffResult, lang: Lang = 'zh'): string {
  if (result.binary) return t(lang, 'git.diff.binary');
  if (result.truncated) return t(lang, 'git.diff.truncated');
  if (result.hunks.length === 0) return t(lang, 'git.diff.noText');
  return '';
}

/** diff 行的着色类名（颜色之外的第二信息载体是 +/-/空格 前缀）。 */
export function gitDiffLineClass(kind: 'add' | 'del' | 'ctx'): string {
  return kind === 'add' ? 'git-diff-line-add' : kind === 'del' ? 'git-diff-line-del' : 'git-diff-line-ctx';
}

/** diff 行前缀：`+` / `-` / 空格。 */
export function gitDiffLinePrefix(kind: 'add' | 'del' | 'ctx'): string {
  return kind === 'add' ? '+' : kind === 'del' ? '-' : ' ';
}

// ── 提交前提示与签名失败（`27` §10.5.3）─────────────────────────────────

/** 大文件提示阈值：5 MiB。只提示，不阻止提交。 */
export const LARGE_FILE_THRESHOLD_BYTES = 5 * 1024 * 1024;

/** 提交签名失败的错误码（`06` §10.2 / `27` §10.5.3）。 */
export const SIGNING_FAILED_CODE = -32046;

/** 会被 Git 实际执行的提交相关钩子（`executable=false` 的不计入）。 */
export function executableHooks(status: GitStatusResult | undefined): readonly GitHookInfo[] {
  return (status?.hooks ?? []).filter((hook) => hook.executable);
}

/** 存在但不可执行的钩子：仍要在界面里可见，让用户知道"有，但不会运行"。 */
export function inactiveHooks(status: GitStatusResult | undefined): readonly GitHookInfo[] {
  return (status?.hooks ?? []).filter((hook) => !hook.executable);
}

/** 提交前钩子提示：只数可执行钩子；0 个时明确说"没有可执行的提交钩子"。 */
export function commitHooksText(status: GitStatusResult | undefined, lang: Lang = 'zh'): string {
  if (!status) return t(lang, 'git.hooks.notLoaded');
  const hooks = executableHooks(status);
  if (hooks.length === 0) return t(lang, 'git.hooks.none');
  const names = hooks.map((hook) => hook.name).join(lang === 'en' ? ', ' : '、');
  return t(lang, 'git.hooks.willRun', { count: hooks.length, names });
}

/** 已暂存且超过阈值的大文件（未暂存 / `sizeBytes=null` 一律不算）。 */
export function largeStagedFiles(
  status: GitStatusResult | undefined,
  thresholdBytes: number = LARGE_FILE_THRESHOLD_BYTES,
): readonly GitFileEntry[] {
  return (status?.files ?? []).filter((file) => file.staged && file.sizeBytes !== null && file.sizeBytes > thresholdBytes);
}

/** 人类可读字节数（B / KB / MB，KB 与 MB 保留 1 位小数）。 */
export function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 提交参数（`onCommit` 的唯一入参）。
 *
 * `noSign` **只能**由用户在签名失败面板里显式选择——任何自动传入都是违规的。
 */
export interface GitCommitInput {
  readonly message: string;
  readonly allowEmpty?: boolean;
  readonly noVerify?: boolean;
  readonly noSign?: boolean;
}

export type SigningFailureActionId = 'retry' | 'unsigned' | 'cancel';

export interface SigningFailureAction {
  readonly id: SigningFailureActionId;
  readonly label: string;
  readonly hint: string;
}

/** 签名失败后的三条路径（顺序固定；绝不自动重试、绝不自动降级为无签名）。 */
export function signingFailureActions(lang: Lang = 'zh'): readonly SigningFailureAction[] {
  return [
    { id: 'retry', label: t(lang, 'git.signing.retry'), hint: t(lang, 'git.signing.retryHint') },
    { id: 'unsigned', label: t(lang, 'git.signing.unsigned'), hint: t(lang, 'git.signing.unsignedHint') },
    { id: 'cancel', label: t(lang, 'git.signing.cancel'), hint: t(lang, 'git.signing.cancelHint') },
  ];
}

/**
 * 判断错误是否是"提交签名失败"。
 *
 * 优先按 `kind` 分支（契约）；数字码与消息里的码只做兜底（传输层可能只留下 message）。
 */
export function isSigningFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as { readonly kind?: unknown; readonly code?: unknown; readonly message?: unknown };
  if (candidate.kind === 'git_signing_failed') return true;
  if (candidate.code === SIGNING_FAILED_CODE) return true;
  if (typeof candidate.message !== 'string') return false;
  // 消息兜底：**契约标识优先**（`kind` / 数字码），文案匹配只是最后一道保险。
  //
  // 注意这里同时匹配中英两种措辞：Host 的 `git-write.ts` 现在返回英文
  // （`commit signing failed; ...`），只匹配中文会永远命中不了。真正稳固的做法是
  // Host 始终带 `kind='git_signing_failed'`（已由 `git-write.test.ts` 与
  // `dhp-features.test.ts` 断言），文案匹配不承担正确性。
  const message = candidate.message.toLowerCase();
  return candidate.message.includes(String(SIGNING_FAILED_CODE))
    || message.includes('git_signing_failed')
    || message.includes('signing failed')
    || candidate.message.includes('\u7b7e\u540d\u5931\u8d25');
}

/** 领先 / 落后文案；未知时是"未知"（不是 0）。 */
export function aheadBehindText(ahead: number | null | undefined, behind: number | null | undefined, lang: Lang = 'zh'): string {
  const a = ahead == null || !Number.isFinite(ahead) ? null : ahead;
  const b = behind == null || !Number.isFinite(behind) ? null : behind;
  if (a === null && b === null) return t(lang, 'git.ahead.unknown');
  return t(lang, 'git.ahead.value', { ahead: a ?? t(lang, 'git.unknownWord.unknown'), behind: b ?? t(lang, 'git.unknownWord.unknown') });
}

/** 认证状态文案（只显示方式与账号，绝不显示令牌）。 */
export function authStatusLabel(auth: GitAuthInfo | undefined, lang: Lang = 'zh'): string {
  if (!auth) return t(lang, 'git.auth.unknown');
  if (!auth.configured) return t(lang, 'git.auth.notConfigured');
  if (!auth.ready) return t(lang, 'git.auth.configuredNotVerified');
  const account = auth.account ? t(lang, 'git.auth.account', { account: auth.account }) : '';
  return t(lang, 'git.auth.ready', { method: authMethodLabel(auth.method, lang), account });
}

/** 认证方式文案。 */
export function authMethodLabel(method: GitAuthInfo['method'], lang: Lang = 'zh'): string {
  switch (method) {
    case 'oauth': return t(lang, 'git.auth.methodOauth');
    case 'ssh-agent': return t(lang, 'git.auth.methodSshAgent');
    case 'ssh-key': return t(lang, 'git.auth.methodSshKey');
    case 'token': return t(lang, 'git.auth.methodToken');
    case 'none': return t(lang, 'git.auth.methodNone');
  }
}

// ── 浏览器授权（设备码，N-9 / `27` §10.7.6）────────────────────────────

/** 轮询安全上限：即使还没到 `expiresIn`，也绝不超过这么多次（防无限轮询）。 */
export const OAUTH_POLL_LIMIT = 600;

/** 单次轮询间隔的下限/上限（毫秒）：下限防打爆授权服务器，上限防"看起来卡死"。 */
export const OAUTH_MIN_DELAY_MS = 1000;
export const OAUTH_MAX_DELAY_MS = 60_000;

export type OauthProviderState = 'ready' | 'needs-client-id' | 'unsupported';

/**
 * 厂商可用性（**这是这条 UI 的核心**）。
 *
 * 开源仓库故意不内置 `client_id`：`builtinClientId=false` 时 `oauth/start` 必然抛
 * `git_oauth_unavailable`，所以界面必须先判断，不能让用户点了才失败。
 */
export function oauthProviderState(provider: GitOauthProvider): OauthProviderState {
  if (!provider.deviceFlow) return 'unsupported';
  return provider.builtinClientId ? 'ready' : 'needs-client-id';
}

/** 三种状态各一句人话（禁用时也要说清"为什么"与"改用哪条路"）。 */
export function oauthProviderHint(provider: GitOauthProvider, lang: Lang = 'zh'): string {
  switch (oauthProviderState(provider)) {
    case 'ready':
      return t(lang, 'git.oauth.hintReady');
    case 'needs-client-id':
      return t(lang, 'git.oauth.hintClientId');
    case 'unsupported':
      return t(lang, 'git.oauth.hintUnsupported');
  }
}

/** 下一次轮询的延迟（毫秒）；`null` = 停止轮询。`slow_down` 把间隔翻倍一次。 */
export function oauthPollDelay(status: GitOauthPollStatus, intervalMs: number): number | null {
  if (status === 'ready' || status === 'denied' || status === 'expired') return null;
  // 非法/非正的 interval 回落到安全下限；正常值按契约原样使用（不擅自改小）。
  const base = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : OAUTH_MIN_DELAY_MS;
  const wanted = status === 'slow_down' ? base * 2 : base;
  return Math.min(OAUTH_MAX_DELAY_MS, wanted);
}

/** 轮询状态文案（不是日志，是给用户看的"现在在等什么"）。 */
export function oauthPollLabel(status: GitOauthPollStatus, lang: Lang = 'zh'): string {
  switch (status) {
    case 'pending': return t(lang, 'git.oauth.pending');
    case 'slow_down': return t(lang, 'git.oauth.slowDown');
    case 'ready': return t(lang, 'git.oauth.ready');
    case 'denied': return t(lang, 'git.oauth.denied');
    case 'expired': return t(lang, 'git.oauth.expired');
  }
}

/** `denied` / `expired` 的失败文案（互不相同；其它状态返回空串）。 */
export function oauthFailureText(status: GitOauthPollStatus, lang: Lang = 'zh'): string {
  if (status === 'denied') return t(lang, 'git.oauth.failureDenied');
  if (status === 'expired') return t(lang, 'git.oauth.failureExpired');
  return '';
}

/** 剩余有效期文案：`剩余 3 分 20 秒` / `剩余 45 秒` / `已过期`。 */
export function oauthRemainingText(expiresAt: number, now: number, lang: Lang = 'zh'): string {
  const remainingMs = expiresAt - now;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return t(lang, 'git.oauth.alreadyExpired');
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return t(lang, 'git.oauth.remainingSeconds', { seconds });
  return t(lang, 'git.oauth.remainingMinutes', { minutes, seconds });
}

/** 授权相关错误的人话说明（不把协议错误伪装成成功，也不泄漏敏感内容）。 */
export function describeOauthError(error: unknown, lang: Lang = 'zh'): string {
  const candidate = error as { readonly kind?: unknown; readonly message?: unknown } | null;
  const kind = candidate?.kind;
  const message = typeof candidate?.message === 'string' ? candidate.message : '';
  if (kind === 'git_oauth_unavailable' || message.includes('git_oauth_unavailable')) {
    return t(lang, 'git.oauth.errorUnavailable');
  }
  if (kind === 'git_oauth_pending' || message.includes('git_oauth_pending')) return t(lang, 'git.oauth.errorPending');
  if (kind === 'git_oauth_denied' || message.includes('git_oauth_denied')) return oauthFailureText('denied', lang);
  return message === '' ? t(lang, 'git.oauth.errorFailed') : t(lang, 'git.oauth.errorFailedWith', { message });
}

/** 认证状态点：绿=就绪，琥珀=未配置/未校验，灰=未知。 */
export function authStatusTone(auth: GitAuthInfo | undefined): 'green' | 'amber' | 'grey' {
  if (!auth) return 'grey';
  if (auth.ready) return 'green';
  if (auth.configured) return 'amber';
  return 'amber';
}

/**
 * 联网状态：只认预检结果（§10.7.5）。
 *
 * 未知时显示"未知"，**不默认当作在线**；也不得用缓存状态冒充实时状态。
 */
export function onlineStateLabel(preflight: GitPreflightResult | undefined, lang: Lang = 'zh'): string {
  if (!preflight || preflight.online == null) return t(lang, 'git.online.unknown');
  return preflight.online ? t(lang, 'git.online.online') : t(lang, 'git.online.offline');
}

/** 联网状态点颜色：绿=在线，琥珀=离线，灰=未知。 */
export function onlineStateTone(preflight: GitPreflightResult | undefined): 'green' | 'amber' | 'grey' {
  if (!preflight || preflight.online == null) return 'grey';
  return preflight.online ? 'green' : 'amber';
}

/** 远端展示 URL（已由 Host 剥离内嵌凭据；此处再做一次兜底脱敏）。 */
export function remoteUrlLabel(remote: GitRemoteInfo): string {
  const url = remote.url ?? '';
  const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+):/.exec(url);
  if (scp) return url;
  return url.replace(/\/\/[^/@]+@/, '//');
}

/** 分支行文案：当前分支标记 + 领先落后。 */
export function branchLabel(branch: GitBranchInfo, lang: Lang = 'zh'): string {
  const name = branch.kind === 'remote' ? t(lang, 'git.branch.remote', { name: branch.name }) : branch.name;
  const current = branch.current ? t(lang, 'git.branch.current') : '';
  const counts = branch.ahead == null && branch.behind == null ? '' : ` · ${aheadBehindText(branch.ahead, branch.behind, lang)}`;
  return `${name}${current}${counts}`;
}

// ── 提交图布局（纯函数 + 自绘 SVG，不引入图形库）─────────────────────────

export interface GitGraphRow {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly author: string;
  readonly at: number;
  readonly lane: number;
  readonly refs: readonly string[];
  /** 父提交在当前窗口之外 → 画虚线。 */
  readonly truncated: boolean;
}

export interface GitGraphLayout {
  readonly rows: readonly GitGraphRow[];
  readonly lanes: number;
}

/**
 * 提交图排位（纯函数）。
 *
 * 输入已按 topo/date 排序的提交数组；输出每行的泳道号与"父提交在窗口外"标记。
 */
export function layoutGitGraph(commits: readonly GitCommitNode[]): GitGraphLayout {
  const window = new Set(commits.map((commit) => commit.sha));
  const laneOf = new Map<string, number>();
  const freeLanes: number[] = [];
  let nextLane = 0;
  const takeLane = (): number => (freeLanes.length > 0 ? (freeLanes.shift() as number) : nextLane++);
  const rows: GitGraphRow[] = [];

  for (const commit of commits) {
    // 子提交可能已经为本提交预留了泳道（首父继承子泳道）。
    const lane = laneOf.get(commit.sha) ?? takeLane();
    laneOf.set(commit.sha, lane);
    const truncated = commit.parents.some((parent) => !window.has(parent));
    commit.parents.forEach((parent, index) => {
      if (laneOf.has(parent)) return;
      laneOf.set(parent, index === 0 ? lane : takeLane());
    });
    // 没有窗口内父提交 → 本泳道到此结束，可被后续分支复用。
    const continues = commit.parents.some((parent) => window.has(parent));
    if (!continues && !freeLanes.includes(lane)) freeLanes.push(lane);
    rows.push({
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 7),
      subject: commit.subject,
      author: commit.author,
      at: commit.at,
      lane,
      refs: commit.refs,
      truncated,
    });
  }
  return { rows, lanes: Math.max(1, nextLane) };
}

// ── 上传流程（`27` §10.8）───────────────────────────────────────────────

export type UploadScope = 'all' | 'session';

export function uploadScopeLabels(lang: Lang = 'zh'): Readonly<Record<UploadScope, string>> {
  return {
    all: t(lang, 'git.upload.scopeAll'),
    session: t(lang, 'git.upload.scopeSession'),
  };
}

/** 中文范围标签（默认语言），保留给既有调用方与测试。 */
export const UPLOAD_SCOPE_LABELS: Readonly<Record<UploadScope, string>> = uploadScopeLabels('zh');

export interface UploadConfirmPayload {
  readonly remote: string;
  readonly branch: string;
  readonly files: number;
  readonly added: number;
  readonly removed: number;
  readonly message: string;
  readonly scope: UploadScope;
}

/** 二次确认框的字段（确认内容必须与实际执行一致）。 */
export function uploadConfirmPayload(
  preflight: GitPreflightResult,
  options: { readonly message: string; readonly scope: UploadScope },
): UploadConfirmPayload {
  return {
    remote: preflight.remote,
    branch: preflight.branch,
    files: preflight.files,
    added: preflight.added,
    removed: preflight.removed,
    message: options.message.trim(),
    scope: options.scope,
  };
}

export type UploadFailureKind = 'auth-required' | 'auth-rejected' | 'offline' | 'diverged' | 'no-change' | 'blocked' | 'incomplete' | 'unknown';

/**
 * 本地失败码（不是 DHP 错误码）。
 *
 * 为什么需要它：上传"结果不完整"（Host 返回了空/缺字段）曾被塞进 `-32032`，
 * 于是界面显示"提交或推送被拒绝（无改动 / 无 upstream / 钩子或远端策略）"——
 * 那与"结果不完整"完全不是一回事，会把用户引向错误的排查方向。
 * 本地码用正数，永远不会与 DHP 的负数错误码混淆。
 */
export const LOCAL_FAILURE_INCOMPLETE = 1;

export interface UploadFailurePath {
  readonly kind: UploadFailureKind;
  readonly title: string;
  /** 可操作路径（最多三条）。**永远不包含 force 选项。 */
  readonly actions: readonly string[];
}

/**
 * 上传失败 → 可操作路径（`27` §10.8.3）。
 *
 * 硬约束：分叉只给"先拉取 / 上传到新分支 / 取消"，**不提供 force**。
 */
export function uploadFailurePath(code: number, lang: Lang = 'zh'): UploadFailurePath {
  switch (code) {
    case -32036:
      return { kind: 'auth-required', title: t(lang, 'git.failure.authRequiredTitle'), actions: [t(lang, 'git.failure.authRequiredAction1'), t(lang, 'git.failure.authRequiredAction2')] };
    case -32037:
      return { kind: 'auth-rejected', title: t(lang, 'git.failure.authRejectedTitle'), actions: [t(lang, 'git.failure.authRejectedAction1'), t(lang, 'git.failure.authRejectedAction2')] };
    case -32038:
      return { kind: 'offline', title: t(lang, 'git.failure.offlineTitle'), actions: [t(lang, 'git.failure.offlineAction')] };
    case -32039:
      return { kind: 'diverged', title: t(lang, 'git.failure.divergedTitle'), actions: [t(lang, 'git.failure.divergedAction1'), t(lang, 'git.failure.divergedAction2'), t(lang, 'git.failure.cancelAction')] };
    case -32032:
      return { kind: 'no-change', title: t(lang, 'git.failure.noChangeTitle'), actions: [t(lang, 'git.failure.noChangeAction1'), t(lang, 'git.failure.noChangeAction2'), t(lang, 'git.failure.noChangeAction3')] };
    case -32033:
      return { kind: 'blocked', title: t(lang, 'git.failure.blockedTitle'), actions: [t(lang, 'git.failure.blockedAction')] };
    case LOCAL_FAILURE_INCOMPLETE:
      return { kind: 'incomplete', title: t(lang, 'git.failure.incompleteTitle'), actions: [t(lang, 'git.failure.incompleteAction')] };
    default:
      return { kind: 'unknown', title: t(lang, 'git.failure.unknownTitle'), actions: [t(lang, 'git.failure.unknownAction1'), t(lang, 'git.failure.unknownAction2'), t(lang, 'git.failure.unknownAction3')] };
  }
}

/** 预检阻塞项（`27` §10.9 的门禁不满足时的原因）。 */
export function uploadBlockers(preflight: GitPreflightResult | undefined): readonly string[] {
  if (!preflight) return [];
  return preflight.blockers.map((blocker) => blocker.reason);
}

/** 预检是否允许进入确认步骤。 */
export function preflightReady(preflight: GitPreflightResult | undefined): boolean {
  if (!preflight) return false;
  if (preflight.blockers.length > 0) return false;
  if (preflight.diverged) return false;
  if (preflight.online === false) return false;
  if (preflight.files === 0) return false;
  return true;
}

// ── 组件 ────────────────────────────────────────────────────────────────

export interface GitSidebarProps {
  readonly workspaceRoot: string;
  readonly status: GitStatusResult | undefined;
  readonly branches: GitBranchesResult | undefined;
  readonly graph: GitGraphResult | undefined;
  readonly remotes: GitRemotesResult | undefined;
  readonly auth: GitAuthStatusResult | undefined;
  readonly preflight: GitPreflightResult | undefined;
  readonly upload: GitUploadResult | undefined;
  readonly diff: GitDiffResult | undefined;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error: string;
  readonly tab: GitTab;
  readonly onTab: (tab: GitTab) => void;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  readonly onLoadGraph: (skip?: number) => void;
  readonly onStage: (paths: readonly string[]) => void;
  readonly onUnstage: (paths: readonly string[]) => void;
  /** 提交（本地写操作）：返回 Promise 以便提交区识别签名失败并给出三路径。 */
  readonly onCommit: (input: GitCommitInput) => Promise<void>;
  readonly onBranchSwitch: (name: string) => void;
  readonly onBranchCreate: (name: string) => void;
  readonly onPreflight: (input: { readonly remote: string; readonly branch?: string; readonly scope: UploadScope }) => Promise<GitPreflightResult | undefined>;
  readonly onUpload: (input: { readonly remote: string; readonly branch: string; readonly message: string; readonly scope: UploadScope }) => Promise<GitUploadResult | undefined>;
  readonly onOpenDetail: () => void;
  /**
   * 生成提交信息（FR-N-026，可选）：只读调用，模型不可用时返回确定性兜底文案。
   * 未提供时界面不显示"生成"按钮（不假装有模型）。
   */
  readonly onGenerateMessage?: ((input: { readonly scope: UploadScope }) => Promise<GitCommitMessageResult | undefined>) | undefined;
  /** 凭据窄桥（可选）：主进程尚未提供时界面明确降级，不假装保存成功。 */
  readonly onSetToken?: ((input: { readonly workspaceRoot: string; readonly remote: string; readonly url: string; readonly token: string }) => Promise<void>) | undefined;
  readonly onUseSshAgent?: ((input: { readonly workspaceRoot: string; readonly remote: string; readonly url: string }) => Promise<void>) | undefined;
  readonly onClearAuth?: ((input: { readonly workspaceRoot: string; readonly remote: string; readonly url: string }) => Promise<void>) | undefined;
  /** 浏览器授权（设备码）：开始 / 轮询 / 取消。未提供时整块入口不显示（不假装支持）。 */
  readonly onOauthStart?: ((input: {
    readonly workspaceRoot: string;
    readonly remote: string;
    readonly provider: string;
    readonly clientId?: string;
  }) => Promise<GitAuthOauthStartResult>) | undefined;
  readonly onOauthPoll?: ((flowId: string) => Promise<GitAuthOauthPollResult>) | undefined;
  readonly onOauthCancel?: ((flowId: string) => Promise<{ readonly cancelled: true }>) | undefined;
  /** 打开浏览器（主进程只放行 http(s)）；**只能由用户点击触发**，不得自动打开。 */
  readonly onOpenExternal?: ((url: string) => Promise<boolean>) | undefined;
  /**
   * 载入某个文件的**工作区口径**只读 diff（FR-N-024）。
   *
   * 未提供时文件行不可点击——不假装支持。
   */
  readonly onLoadDiff?: ((input: { readonly path: string; readonly mode: 'worktree' | 'staged' }) => Promise<void>) | undefined;
  /** 界面语言（默认中文，与桌面端默认一致）。 */
  readonly lang?: Lang | undefined;
}

type UploadStep = 'idle' | 'preflight' | 'confirm' | 'uploading' | 'success' | 'failed';

export interface GitDiffPanelProps {
  readonly diff: GitDiffResult;
  /** 口径：已暂存看索引区，其余看工作区。 */
  readonly mode: 'worktree' | 'staged';
  readonly lang?: Lang | undefined;
}

/**
 * 工作区口径的只读 diff 面板（FR-N-024）。
 *
 * 诚实要求：
 *  - 必须有一行写明**工作区口径**（与会话详情的会话口径不是一回事）；
 *  - binary 不渲染 hunk；truncated / 无 hunk 都给明确说明，不留空白；
 *  - 行内容保留 `+` / `-` / 空格前缀（颜色不是唯一信息载体）。
 */
export function GitDiffPanel({ diff, mode, lang = 'zh' }: GitDiffPanelProps): ReactNode {
  const empty = gitDiffEmptyText(diff, lang);
  return (
    <section className="git-diff" aria-label={t(lang, 'git.diff.aria', { path: diff.path })}>
      <header>{diff.path}<small>{diff.binary ? t(lang, 'git.diff.binaryBadge') : `+${diff.added} -${diff.removed}`}</small></header>
      <p className="git-diff-scope">{gitDiffScopeText(mode, lang)}</p>
      {empty !== '' && <p className="git-diff-empty">{empty}</p>}
      {!diff.binary && diff.hunks.map((hunk, index) => (
        <pre key={`${hunk.oldStart}:${hunk.newStart}:${index}`} className="git-diff-hunk">{`@@ -${hunk.oldStart} +${hunk.newStart} @@`}{'\n'}{hunk.lines.map((line, lineIndex) => (
          <span key={lineIndex} className={`git-diff-line ${gitDiffLineClass(line.kind)}`}>{gitDiffLinePrefix(line.kind)}{line.text}{'\n'}</span>
        ))}</pre>
      ))}
    </section>
  );
}

export function GitSidebar(props: GitSidebarProps) {
  const {
    workspaceRoot, status, branches, graph, remotes, auth, preflight, upload, diff,
    loading, busy, error, tab, onTab, onClose, onRefresh, onLoadGraph,
    onStage, onUnstage, onCommit, onBranchSwitch, onBranchCreate,
    onPreflight, onUpload, onOpenDetail, onGenerateMessage, onSetToken, onUseSshAgent, onClearAuth,
    onOauthStart, onOauthPoll, onOauthCancel, onOpenExternal, onLoadDiff,
    lang = 'zh',
  } = props;

  // ── 工作区口径的只读 diff（FR-N-024）──────────────────────────────
  // 同一时刻只展开一个文件；再点同一行收起；换文件时旧 diff 不残留。
  const [diffSelection, setDiffSelection] = useState<{ readonly path: string; readonly mode: 'worktree' | 'staged' }>();
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffFailed, setDiffFailed] = useState('');
  const toggleDiff = async (file: GitFileEntry) => {
    if (!onLoadDiff) return;
    const mode = diffModeForFile(file);
    if (diffSelection?.path === file.path && diffSelection.mode === mode) {
      // 再点同一行：收起，并清掉旧的 diff（避免残留上一次的内容）。
      setDiffSelection(undefined);
      setDiffLoading(false);
      setDiffFailed('');
      return;
    }
    setDiffSelection({ path: file.path, mode });
    setDiffLoading(true);
    setDiffFailed('');
    try {
      await onLoadDiff({ path: file.path, mode });
    } catch (error) {
      setDiffFailed(t(lang, 'git.diff.readFailed', { message: (error as Error).message }));
    } finally {
      setDiffLoading(false);
    }
  };
  const groups = useMemo(() => groupByStaging(status?.files ?? []), [status]);
  const layout = useMemo(() => layoutGitGraph(graph?.commits ?? []), [graph]);
  const hookText = commitHooksText(status);
  const inactiveHookNames = inactiveHooks(status).map((hook) => hook.name);
  const largeFiles = largeStagedFiles(status);
  const stagedCount = groups.staged.length;

  const [remoteName, setRemoteName] = useState('');
  const [branchName, setBranchName] = useState('');
  const [scope, setScope] = useState<UploadScope>('all');
  const [message, setMessage] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generateNote, setGenerateNote] = useState('');
  const [step, setStep] = useState<UploadStep>('idle');
  const [failure, setFailure] = useState<{ readonly code: number; readonly message: string }>();
  const [token, setToken] = useState('');
  const [credentialNote, setCredentialNote] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  // 提交前提示（`27` §10.5.3）：钩子 / 大文件 / 跳过钩子 / 空提交。
  const [allowEmpty, setAllowEmpty] = useState(false);
  const [noVerify, setNoVerify] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitNote, setCommitNote] = useState('');
  const [signingFailure, setSigningFailure] = useState<{ readonly input: GitCommitInput; readonly message: string }>();
  // ── 浏览器授权（设备码）状态 ─────────────────────────────────────────
  const [oauthProviderId, setOauthProviderId] = useState('');
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthFlow, setOauthFlow] = useState<GitAuthOauthStartResult>();
  const [oauthExpiresAt, setOauthExpiresAt] = useState(0);
  const [oauthNow, setOauthNow] = useState(() => Date.now());
  const [oauthPolls, setOauthPolls] = useState(0);
  const [oauthStatus, setOauthStatus] = useState<GitOauthPollStatus>();
  const [oauthOutcome, setOauthOutcome] = useState<'waiting' | 'ready' | 'denied' | 'expired' | 'failed'>('waiting');
  const [oauthAccount, setOauthAccount] = useState<string | null>(null);
  const [oauthStarting, setOauthStarting] = useState(false);
  const [oauthError, setOauthError] = useState('');
  const oauthTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const oauthTicket = useRef(0);
  const oauthAlive = useRef(true);
  // 父层回调每渲染都是新函数：用 ref 保存最新值，避免把父层重渲染变成"重新计时"。
  const oauthPollRef = useRef(onOauthPoll);
  oauthPollRef.current = onOauthPoll;
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const confirmRef = useRef<HTMLButtonElement>(null);
  const confirmBoxRef = useRef<HTMLDivElement>(null);
  const tabRef = useRef<HTMLButtonElement>(null);

  const remoteList = remotes?.remotes ?? [];
  const selectedRemote: GitRemoteInfo | undefined = remoteList.find((remote) => remote.name === remoteName) ?? remoteList[0];
  const remoteAuth = selectedRemote ? (auth?.remotes.find((item) => item.name === selectedRemote.name)?.auth ?? selectedRemote.auth) : undefined;
  const confirm = preflight ? uploadConfirmPayload(preflight, { message, scope }) : undefined;
  const onlineLabel = onlineStateLabel(preflight, lang);
  const onlineTone = onlineStateTone(preflight);

  useEffect(() => {
    if (remoteList.length > 0 && remoteName === '') setRemoteName(remoteList[0]!.name);
  }, [remoteList, remoteName]);

  // 打开侧栏后焦点进入侧栏（§11.4）。
  useEffect(() => { tabRef.current?.focus(); }, []);

  // 二次确认：焦点落在主按钮上，Tab 在对话框内循环，Esc 取消（§11.4）。
  useEffect(() => {
    if (step !== 'confirm') return;
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setStep('preflight'); return; }
      if (event.key !== 'Tab') return;
      const list = Array.from(confirmBoxRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []);
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [step]);

  const runPreflight = async () => {
    if (!selectedRemote) return;
    setStep('preflight');
    setFailure(undefined);
    try {
      const result = await onPreflight({ remote: selectedRemote.name, ...(branchName ? { branch: branchName } : {}), scope });
      if (result) setStep(preflightReady(result) ? 'confirm' : 'preflight');
    } catch (e) {
      setFailure({ code: -32032, message: (e as Error).message });
      setStep('failed');
    }
  };

  /**
   * 生成提交信息（FR-N-026）：只读调用，不产生提交。
   *
   * 三条纪律：
   *  1. 生成失败不等于功能失败——Host 会返回确定性兜底文案，这里预填并**允许改写**；
   *  2. 来源必须可见：模型生成与兜底文案在界面上有区别（`source`/`reason`/`truncated`）；
   *  3. 不覆盖用户已经手写的内容：只在输入框为空时自动填入，否则先问一次。
   */
  const runGenerate = async () => {
    if (!onGenerateMessage) return;
    if (message.trim() !== '' && !window.confirm(t(lang, 'git.upload.generateReplace'))) return;
    setGenerating(true);
    setGenerateNote('');
    try {
      const result = await onGenerateMessage({ scope });
      if (!result) { setGenerateNote(t(lang, 'git.upload.generateNoResult')); return; }
      setMessage(result.message);
      if (result.source === 'fallback') {
        setGenerateNote(t(lang, 'git.upload.generateFallback', { reason: result.reason === null ? '' : t(lang, 'git.upload.generateFallbackReason', { reason: result.reason }) }));
      } else if (result.truncated) {
        setGenerateNote(t(lang, 'git.upload.generateTruncated'));
      } else {
        setGenerateNote(t(lang, 'git.upload.generateOk'));
      }
    } catch (e) {
      // 生成失败不是上传失败：不跳失败页，只给一行说明，用户仍可手填。
      setGenerateNote(t(lang, 'git.upload.generateFailed', { message: (e as Error).message }));
    } finally {
      setGenerating(false);
    }
  };

  const runUpload = async () => {
    if (!selectedRemote || !confirm) return;
    setStep('uploading');
    setFailure(undefined);
    try {
      const result = await onUpload({
        remote: selectedRemote.name,
        branch: confirm.branch,
        message: confirm.message,
        scope: confirm.scope,
      });
      if (result) { setStep('success'); return; }
      setFailure({ code: LOCAL_FAILURE_INCOMPLETE, message: t(lang, 'git.upload.incomplete') });
      setStep('failed');
    } catch (e) {
      const error = e as { readonly code?: number; readonly message: string };
      const matched = /(-32\d{3})/.exec(error.message);
      const code = typeof error.code === 'number' ? error.code : matched ? Number(matched[1]) : -32032;
      setFailure({ code, message: error.message });
      setStep('failed');
    }
  };

  /**
   * 提交（本地写操作，`27` §10.5.3）。
   *
   * 纪律：
   *  1. 只有成功才清空提交信息；失败 / 取消都保留用户输入；
   *  2. 签名失败**不静默降级**：进入"重试 / 无签名提交 / 取消"三路径，等用户显式选择；
   *  3. `noSign` 只在用户点击"无签名提交"时传入。
   */
  const runCommit = async (input: GitCommitInput) => {
    if (committing) return;
    setCommitting(true);
    setSigningFailure(undefined);
    setCommitNote('');
    try {
      await onCommit(input);
      setCommitMessage('');
      setCommitNote(t(lang, input.noSign === true ? 'git.commit.unsignedDone' : 'git.commit.done'));
    } catch (e) {
      if (isSigningFailure(e)) {
        setSigningFailure({ input, message: (e as Error).message });
      } else {
        setCommitNote(t(lang, 'git.commit.failed', { message: (e as Error).message }));
      }
    } finally {
      setCommitting(false);
    }
  };

  const commitInput = (): GitCommitInput => ({
    message: commitMessage.trim(),
    ...(noVerify ? { noVerify: true } : {}),
    ...(allowEmpty ? { allowEmpty: true } : {}),
  });

  // ── 浏览器授权：定时器清理是硬要求 ───────────────────────────────────

  /** 停掉轮询：清 timer + 作废 ticket（已发出的响应回来也不再改状态）。 */
  const stopOauthPolling = (): void => {
    oauthTicket.current += 1;
    if (oauthTimer.current !== undefined) {
      clearTimeout(oauthTimer.current);
      oauthTimer.current = undefined;
    }
  };

  // 组件卸载：停止轮询 + 标记已死，避免 setState on unmounted。
  useEffect(() => {
    oauthAlive.current = true;
    return () => {
      oauthAlive.current = false;
      oauthTicket.current += 1;
      if (oauthTimer.current !== undefined) {
        clearTimeout(oauthTimer.current);
        oauthTimer.current = undefined;
      }
    };
  }, []);

  // 侧栏关闭（组件仍在但不可见）/ 换远端：停止轮询并回到步骤 1。
  useEffect(() => {
    if (!oauthFlow) return;
    const providerStillValid = (auth?.providers ?? []).some((provider) => provider.id === oauthProviderId);
    if (providerStillValid) return;
    stopOauthPolling();
    setOauthFlow(undefined);
    setOauthOutcome('waiting');
    setOauthStatus(undefined);
  }, [auth?.providers, oauthProviderId, oauthFlow]);

  // 倒计时只用于显示剩余有效期；它自己不做轮询调度，也不延长总时长。
  useEffect(() => {
    if (!oauthFlow || oauthOutcome !== 'waiting') return;
    const timer = setInterval(() => setOauthNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [oauthFlow, oauthOutcome]);

  /**
   * 轮询一次，并按结果决定是否继续。
   *
   * 五个状态分别处理：
   *  - `pending`     → 继续（`onUpdate` 时给文案）
   *  - `slow_down`   → 间隔翻倍，仍继续
   *  - `ready`       → 成功：停止 + 重拉 `git/auth/status`
   *  - `denied`      → 停止 + 明确失败文案（与 `expired` 不同）
   *  - `expired`     → 停止 + 明确失败文案
   * 另外：`OAUTH_POLL_LIMIT` 与 `expiresIn` 是双保险，任一命中即停止。
   */
  const pollOnce = async (flowId: string, ticket: number, attempt: number, delayMs: number, expiresAt: number): Promise<void> => {
    if (!oauthAlive.current || ticket !== oauthTicket.current) return;
    // 双保险 1：设备码过期后不再发轮询（即使定时器因为节流晚到）。
    if (expiresAt !== 0 && Date.now() >= expiresAt) {
      stopOauthPolling();
      setOauthOutcome('expired');
      setOauthError(oauthFailureText('expired', lang));
      return;
    }
    try {
      const poll = oauthPollRef.current;
      if (!poll) { setOauthOutcome('failed'); setOauthError(t(lang, 'git.oauth.noPollApi')); return; }
      const result = await poll(flowId);
      if (!oauthAlive.current || ticket !== oauthTicket.current) return;
      setOauthStatus(result.status);
      setOauthPolls(attempt);
      setOauthNow(Date.now());
      if (result.status === 'ready') {
        stopOauthPolling();
        setOauthOutcome('ready');
        setOauthAccount(result.account);
        setOauthError('');
        refreshRef.current();
        return;
      }
      if (result.status === 'denied' || result.status === 'expired') {
        stopOauthPolling();
        setOauthOutcome(result.status);
        setOauthError(oauthFailureText(result.status, lang));
        return;
      }
      const nextDelay = oauthPollDelay(result.status, delayMs);
      if (nextDelay === null) { stopOauthPolling(); setOauthOutcome('failed'); return; }
      if (attempt >= OAUTH_POLL_LIMIT) {
        stopOauthPolling();
        setOauthOutcome('expired');
        setOauthError(t(lang, 'git.oauth.pollLimit', { limit: OAUTH_POLL_LIMIT }));
        return;
      }
      if (expiresAt !== 0 && Date.now() >= expiresAt) {
        stopOauthPolling();
        setOauthOutcome('expired');
        setOauthError(oauthFailureText('expired', lang));
        return;
      }
      const remaining = expiresAt === 0 ? nextDelay : expiresAt - Date.now();
      if (remaining <= 0) {
        stopOauthPolling();
        setOauthOutcome('expired');
        setOauthError(oauthFailureText('expired', lang));
        return;
      }
      oauthTimer.current = setTimeout(() => {
        oauthTimer.current = undefined;
        void pollOnce(flowId, ticket, attempt + 1, nextDelay, expiresAt);
      }, Math.min(nextDelay, remaining));
    } catch (error) {
      if (!oauthAlive.current || ticket !== oauthTicket.current) return;
      // 网络 / 协议错误：显示出来，但**不假装成功**，也不继续轮询。
      stopOauthPolling();
      setOauthOutcome('failed');
      setOauthError(describeOauthError(error, lang));
    }
  };

  const startOauth = async (): Promise<void> => {
    if (!selectedRemote || !onOauthStart) return;
    const list = auth?.providers ?? [];
    const provider = list.find((item) => item.id === oauthProviderId)
      ?? list.find((item) => oauthProviderState(item) === 'ready')
      ?? list.find((item) => oauthProviderState(item) === 'needs-client-id');
    if (!provider) return;
    const state = oauthProviderState(provider);
    // 不可用的分支在这里就拦住：绝不发出一个必然失败的请求。
    if (state === 'unsupported') { setOauthError(oauthProviderHint(provider)); setOauthOutcome('failed'); return; }
    if (state === 'needs-client-id' && oauthClientId.trim() === '') {
      setOauthError(t(lang, 'git.oauth.needClientId'));
      setOauthOutcome('failed');
      return;
    }
    stopOauthPolling();
    setOauthProviderId(provider.id);
    const ticket = ++oauthTicket.current;
    setOauthStarting(true);
    setOauthError('');
    setOauthOutcome('waiting');
    setOauthStatus(undefined);
    setOauthAccount(null);
    setOauthPolls(0);
    try {
      const started = await onOauthStart({
        workspaceRoot,
        remote: selectedRemote.name,
        provider: provider.id,
        ...(state === 'needs-client-id' ? { clientId: oauthClientId.trim() } : {}),
      });
      if (!oauthAlive.current || ticket !== oauthTicket.current) return;
      setOauthFlow(started);
      const expiresAt = Date.now() + Math.max(0, started.expiresIn) * 1000;
      setOauthExpiresAt(expiresAt);
      setOauthNow(Date.now());
      const intervalMs = oauthPollDelay('pending', started.interval * 1000) ?? OAUTH_MIN_DELAY_MS;
      oauthTimer.current = setTimeout(() => {
        oauthTimer.current = undefined;
        void pollOnce(started.flowId, ticket, 1, intervalMs, expiresAt);
      }, intervalMs);
    } catch (error) {
      if (!oauthAlive.current || ticket !== oauthTicket.current) return;
      setOauthOutcome('failed');
      setOauthError(describeOauthError(error, lang));
    } finally {
      if (oauthAlive.current && ticket === oauthTicket.current) setOauthStarting(false);
    }
  };

  const cancelOauth = async (): Promise<void> => {
    const flowId = oauthFlow?.flowId;
    stopOauthPolling();
    setOauthFlow(undefined);
    setOauthOutcome('waiting');
    setOauthStatus(undefined);
    setOauthError('');
    setOauthAccount(null);
    if (!flowId || !onOauthCancel) return;
    try {
      await onOauthCancel(flowId);
    } catch {
      // 取消是尽力而为：Host 侧没清干净也不该把用户卡在面板里。
    }
  };

  const submitToken = async () => {
    if (!selectedRemote || !token) return;
    setCredentialNote('');
    if (!onSetToken) {
      setCredentialNote(t(lang, 'git.upload.noCredentialBridge'));
      setToken('');
      return;
    }
    try {
      await onSetToken({ workspaceRoot, remote: selectedRemote.name, url: selectedRemote.url, token });
    } finally {
      // 提交后立即清空：页面上任何位置都不提供"查看令牌"。
      setToken('');
    }
  };

  const header = (
    <div className="git-header">
      <div className="git-header-main">
        <div className="git-branch-line">
          <Icon name="branch" size={14} />
          <strong>{status?.branch ?? (status ? t(lang, 'git.header.detachedHead') : t(lang, 'git.header.branchNotLoaded'))}</strong>
          {status?.detached && <span className="subtle-badge">{t(lang, 'git.header.detachedBadge')}</span>}
        </div>
        <div className="git-status-line">
          <span>{status ? aheadBehindText(status.ahead, status.behind, lang) : t(lang, 'git.ahead.unknown')}</span>
          <span className="git-dot-group">
            <i className={`state-dot ${onlineTone}`} title={onlineLabel} />
            <span className="sr-only">{t(lang, 'git.header.onlineSr', { label: onlineLabel })}</span>
            <i className={`state-dot ${authStatusTone(remoteAuth)}`} title={authStatusLabel(remoteAuth, lang)} />
            <span className="sr-only">{t(lang, 'git.header.authSr', { label: authStatusLabel(remoteAuth, lang) })}</span>
          </span>
        </div>
      </div>
      <button aria-label={t(lang, 'git.panel.refreshAria')} title={t(lang, 'git.panel.refreshTitle')} disabled={loading || busy} onClick={onRefresh}><Icon name="refresh" size={15} /></button>
      <button aria-label={t(lang, 'git.panel.closeAria')} title={t(lang, 'git.panel.closeTitle')} onClick={onClose}><Icon name="close" size={15} /></button>
    </div>
  );

  const changesTab = (
    <div className="git-tab-body">
      <p className="git-scope-note">{gitStatusSummary(status, lang)}</p>
      {status?.truncated && <p className="data-note">{t(lang, 'git.changes.truncated')}</p>}
      {groups.staged.length === 0 && groups.unstaged.length === 0 && groups.untracked.length === 0
        // 还没读到状态时不能说"没有改动"——那是没有根据的断言（诚实空态）。
        ? <p className="git-empty">{status === undefined ? t(lang, 'git.changes.notLoaded') : t(lang, 'git.changes.empty')}</p>
        : <div className="git-groups">
          {([
            [t(lang, 'git.group.staged'), groups.staged],
            [t(lang, 'git.group.unstaged'), groups.unstaged],
            [t(lang, 'git.group.untracked'), groups.untracked],
          ] as const).map(([title, files]) => (
            <section className="git-group" key={title}>
              <header><span>{title}</span><small>{files.length}</small></header>
              {files.length === 0
                ? <p className="git-empty-small">{t(lang, 'git.group.empty')}</p>
                : <ul className="git-file-list">
                  {files.map((file) => {
                    const mode = diffModeForFile(file);
                    const expanded = diffSelection?.path === file.path && diffSelection.mode === mode;
                    const body = <>
                      <span className={`change-status change-status-${file.status}`} title={gitStatusLabels(lang)[file.status]}>{GIT_STATUS_LETTERS[file.status]}</span>
                      <span className="change-path" title={file.path}>{file.path}</span>
                      {file.stat === 'unavailable' || file.added == null || file.removed == null
                        ? <span className="change-stat change-stat-unknown">{t(lang, 'git.file.statUnavailable')}</span>
                        : <span className="change-stat"><span className="change-stat-add">+{file.added}</span> <span className="change-stat-del">-{file.removed}</span></span>}
                    </>;
                    return <li className="git-file-row" key={`${file.staged ? 's' : 'u'}:${file.path}`} aria-label={gitFileLabel(file, lang)}>
                      {onLoadDiff
                        ? <button
                          type="button"
                          className={`git-file-open${expanded ? ' expanded' : ''}`}
                          aria-expanded={expanded}
                          aria-label={t(lang, expanded ? 'git.diff.collapseAria' : 'git.diff.openAria', { path: file.path })}
                          onClick={() => void toggleDiff(file)}
                        >{body}<Icon name={expanded ? 'down' : 'chevron'} size={12} /></button>
                        : body}
                      <button
                        className="git-file-action"
                        aria-label={t(lang, 'git.file.stageAria', { action: t(lang, file.staged ? 'git.file.unstageAction' : 'git.file.stageAction'), path: file.path })}
                        disabled={busy}
                        onClick={() => (file.staged ? onUnstage([file.path]) : onStage([file.path]))}
                      >
                        {t(lang, file.staged ? 'git.file.unstageAction' : 'git.file.stageAction')}
                      </button>
                    </li>;
                  })}
                </ul>}
            </section>
          ))}
        </div>}
      <section className="git-commit-box" aria-label={t(lang, 'git.commit.aria')}>
        <label htmlFor="git-commit-message">{t(lang, 'git.commit.label')}</label>
        <input id="git-commit-message" value={commitMessage} placeholder={t(lang, 'git.commit.placeholder')} disabled={busy || committing} onChange={(event) => setCommitMessage(event.target.value)} />

        {/* 提交前提示（§10.5.3）：钩子数量 / 不可执行钩子 / 大文件。只提示，不阻止。 */}
        <p className="git-hook-note" role="status">{hookText}</p>
        {inactiveHookNames.length > 0 && <p className="data-note">{t(lang, 'git.hooks.inactive', { names: inactiveHookNames.join(lang === 'en' ? ', ' : '、') })}</p>}
        {largeFiles.length > 0 && (
          <div className="git-large-warning" role="status">
            <p>{t(lang, 'git.commit.largeFiles', { size: formatBytes(LARGE_FILE_THRESHOLD_BYTES) })}</p>
            <ul className="git-large-list">
              {largeFiles.map((file) => (
                <li key={file.path}><code>{file.path}</code><span>{file.sizeBytes === null ? t(lang, 'git.commit.unknownSize') : formatBytes(file.sizeBytes)}</span></li>
              ))}
            </ul>
            <p className="data-note">{t(lang, 'git.commit.largeFilesNote')}</p>
          </div>
        )}

        <label className="git-commit-option">
          <input type="checkbox" checked={noVerify} disabled={busy || committing} onChange={(event) => setNoVerify(event.target.checked)} />
          <span>{t(lang, 'git.commit.skipHooks')}</span>
        </label>
        <label className="git-commit-option">
          <input type="checkbox" checked={allowEmpty} disabled={busy || committing} onChange={(event) => setAllowEmpty(event.target.checked)} />
          <span>{t(lang, 'git.commit.allowEmpty')}</span>
        </label>
        <p className="data-note">{t(lang, 'git.commit.emptyHint')}</p>

        <button
          className="btn btn-primary"
          disabled={busy || committing || commitMessage.trim() === '' || (stagedCount === 0 && !allowEmpty)}
          onClick={() => void runCommit(commitInput())}
        >{t(lang, committing ? 'git.commit.submitting' : 'git.commit.submit')}</button>
        {commitNote !== '' && <p className="git-commit-note" role="status">{commitNote}</p>}

        {/* 签名失败三路径：不自动重试、不自动降级（§10.5.3）。 */}
        {signingFailure && (
          <section className="git-signing-failure" role="alertdialog" aria-label={t(lang, 'git.signing.title')}>
            <h4>{t(lang, 'git.signing.title')}</h4>
            <p className="data-note">{signingFailure.message}</p>
            <p className="data-note">{t(lang, 'git.signing.hint')}</p>
            <div className="git-signing-actions">
              {signingFailureActions(lang).map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={`btn${action.id === 'unsigned' ? ' btn-danger' : ''}`}
                  aria-label={`${action.label}：${action.hint}`}
                  title={action.hint}
                  disabled={busy || committing}
                  onClick={() => {
                    if (action.id === 'retry') void runCommit(signingFailure.input);
                    else if (action.id === 'unsigned') void runCommit({ ...signingFailure.input, noSign: true });
                    else setSigningFailure(undefined);
                  }}
                >
                  <span>{action.label}</span>
                  <small className="git-signing-hint">{action.hint}</small>
                </button>
              ))}
            </div>
            <p className="data-note">{t(lang, 'git.signing.cancelNote')}</p>
          </section>
        )}

        <p className="data-note">{t(lang, 'git.commit.localNote')}</p>
      </section>
    </div>
  );

  const graphTab = (
    <div className="git-tab-body">
      {graph?.truncated && <p className="data-note">{t(lang, 'git.graph.truncated')}</p>}
      {layout.rows.length === 0
        ? <p className="git-empty">{t(lang, 'git.graph.empty')}</p>
        : <ul className="git-graph">
          {layout.rows.map((row, index) => {
            const previous = index > 0 ? layout.rows[index - 1] : undefined;
            const laneX = 12 + row.lane * 16;
            const previousX = previous ? 12 + previous.lane * 16 : laneX;
            return <li className="git-graph-row" key={row.sha} aria-label={t(lang, 'git.graph.rowAria', { sha: row.shortSha, subject: row.subject })}>
              <svg className="git-graph-svg" width={12 + layout.lanes * 16 + 12} height={24} viewBox={`0 0 ${12 + layout.lanes * 16 + 12} 24`} aria-hidden="true">
                {previous && previous.lane !== row.lane && <path d={`M${previousX} 0 V12 H${laneX}`} className="git-graph-edge" />}
                {row.truncated && <path d={`M${laneX} 12 V24`} className="git-graph-edge git-graph-edge-dashed" />}
                <circle cx={laneX} cy={12} r={4} className="git-graph-node" />
              </svg>
              <div className="git-graph-meta">
                <strong title={row.subject}>{row.subject}</strong>
                <small>{row.shortSha} · {row.author} · {formatRelative(row.at, Date.now(), lang)}</small>
                {row.refs.length > 0 && <span className="git-graph-refs">{row.refs.join(' · ')}</span>}
              </div>
            </li>;
          })}
        </ul>}
      <button className="btn" disabled={loading || busy} onClick={() => onLoadGraph(layout.rows.length)}>{t(lang, 'git.graph.loadMore')}</button>
    </div>
  );

  const branchesTab = (
    <div className="git-tab-body">
      {branches?.detached && <p className="data-note">{t(lang, 'git.branch.detachedNote')}</p>}
      {(['local', 'remote'] as const).map((kind) => {
        const list = kind === 'local' ? (branches?.local ?? []) : (branches?.remote ?? []);
        return <section className="git-group" key={kind}>
          <header><span>{t(lang, kind === 'local' ? 'git.branch.localGroup' : 'git.branch.remoteGroup')}</span><small>{list.length}</small></header>
          {list.length === 0
            ? <p className="git-empty-small">无</p>
            : <ul className="git-branch-list">
              {list.map((branch) => (
                <li key={`${kind}:${branch.name}`} aria-label={branchLabel(branch)}>
                  <span className={branch.current ? 'git-branch-current' : ''}>{branch.name}</span>
                  {branch.current && <span className="subtle-badge">当前</span>}
                  {branch.upstream && <small>{t(lang, 'git.branch.upstream', { name: branch.upstream })}</small>}
                  {kind === 'local' && !branch.current && (
                    <button className="git-file-action" disabled={busy} onClick={() => onBranchSwitch(branch.name)}>{t(lang, 'git.branch.switch')}</button>
                  )}
                </li>
              ))}
            </ul>}
        </section>;
      })}
      <section className="git-commit-box">
        <label htmlFor="git-new-branch">{t(lang, 'git.branch.newLabel')}</label>
        <input id="git-new-branch" value={newBranch} placeholder={t(lang, 'git.branch.newPlaceholder')} disabled={busy} onChange={(event) => setNewBranch(event.target.value)} />
        <button className="btn" disabled={busy || newBranch.trim() === ''} onClick={() => { onBranchCreate(newBranch.trim()); setNewBranch(''); }}>{t(lang, 'git.branch.create')}</button>
      </section>
    </div>
  );

  /**
   * 浏览器授权（设备码）面板。
   *
   * 三条硬纪律：
   *  1. 厂商能力决定可用性（`deviceFlow` / `builtinClientId`），绝不做成"点了必然失败"的按钮；
   *  2. `client_id` 只存在本页 state，不落盘、不进 DHP 之外的任何地方；
   *  3. 轮询由本组件的定时器驱动，卸载 / 关闭 / 取消 / 完成 / 出错都会清理。
   */
  const oauthProviders = auth?.providers ?? [];
  // 默认选中：优先"可直接授权"的厂商，其次"需要 client_id"的；不可用的不默认选。
  const defaultOauthProvider = oauthProviders.find((provider) => oauthProviderState(provider) === 'ready')
    ?? oauthProviders.find((provider) => oauthProviderState(provider) === 'needs-client-id');
  const oauthProvider = oauthProviders.find((provider) => provider.id === oauthProviderId) ?? defaultOauthProvider;
  const oauthProviderStateValue = oauthProvider ? oauthProviderState(oauthProvider) : undefined;
  const oauthCanStart = Boolean(onOauthStart && selectedRemote && oauthProvider)
    && !busy && !oauthStarting
    && oauthProviderStateValue !== 'unsupported'
    && (oauthProviderStateValue !== 'needs-client-id' || oauthClientId.trim() !== '');
  const oauthPanel = !oauthFlow
    ? (
      <div className="oauth-start">
        <div className="oauth-providers" role="radiogroup" aria-label={t(lang, 'git.oauth.providersLabel')}>
          {oauthProviders.map((provider) => {
            const state = oauthProviderState(provider);
            return (
              <label key={provider.id} className={`oauth-provider${state === 'unsupported' ? ' disabled' : ''}${oauthProvider?.id === provider.id ? ' selected' : ''}`}>
                <input
                  type="radio"
                  name="oauth-provider"
                  value={provider.id}
                  checked={oauthProvider?.id === provider.id}
                  disabled={busy || state === 'unsupported'}
                  onChange={() => { setOauthProviderId(provider.id); setOauthError(''); setOauthOutcome('waiting'); }}
                />
                <span>{provider.label}</span>
                <small>{oauthProviderHint(provider, lang)}</small>
              </label>
            );
          })}
        </div>
        {oauthProvider && oauthProviderStateValue === 'needs-client-id' && (
          <label className="upload-field">
            <span>{t(lang, 'git.oauth.clientIdLabel')}</span>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={oauthClientId}
              placeholder={t(lang, 'git.oauth.clientIdPlaceholder')}
              disabled={busy || oauthStarting}
              onChange={(event) => setOauthClientId(event.target.value)}
            />
          </label>
        )}
        {oauthProvider && oauthProviderStateValue === 'needs-client-id' && (
          <p className="data-note">{t(lang, 'git.oauth.clientIdNote')}</p>
        )}
        <button className="btn btn-primary" disabled={!oauthCanStart} onClick={() => void startOauth()}>
          {t(lang, oauthStarting ? 'git.oauth.starting' : 'git.oauth.start')}
        </button>
        {oauthError !== '' && <p className="upload-note-error" role="alert">{oauthError}</p>}
      </div>
    )
    : (
      <div className="oauth-flow">
        <div className="detail-meta"><span>{t(lang, 'git.oauth.deviceCode')}</span><code className="oauth-code">{oauthFlow.userCode}</code></div>
        <div className="detail-meta"><span>{t(lang, 'git.oauth.verificationUri')}</span><code className="oauth-uri">{oauthFlow.verificationUri}</code></div>
        <div className="oauth-actions">
          <button className="btn" aria-label={t(lang, 'git.oauth.copyCode')} onClick={() => { void navigator.clipboard?.writeText(oauthFlow.userCode); }}><Icon name="copy" size={13} />{t(lang, 'git.oauth.copyCode')}</button>
          <button
            className="btn"
            disabled={!onOpenExternal}
            title={t(lang, onOpenExternal ? 'git.oauth.openTitle' : 'git.oauth.openUnavailableTitle')}
            onClick={() => { if (onOpenExternal) void onOpenExternal(oauthFlow.verificationUri); }}
          >{t(lang, 'git.oauth.openButton')}</button>
        </div>
        <p className="data-note">{t(lang, 'git.oauth.openNote')}</p>
        {!onOpenExternal && <p className="data-note">{t(lang, 'git.oauth.openUnavailableNote')}</p>}
        <p className="oauth-poll" role="status">
          {oauthOutcome === 'waiting' && oauthStatus === undefined ? t(lang, 'git.oauth.waitingFirst') : ''}
          {oauthOutcome === 'waiting' && oauthStatus !== undefined ? t(lang, 'git.oauth.pollStatus', { status: oauthPollLabel(oauthStatus, lang), count: oauthPolls }) : ''}
          {oauthOutcome === 'ready' ? t(lang, 'git.oauth.success', { account: oauthAccount ? t(lang, 'git.oauth.successAccount', { account: oauthAccount }) : '' }) : ''}
          {oauthOutcome === 'denied' ? oauthFailureText('denied', lang) : ''}
          {oauthOutcome === 'expired' ? oauthFailureText('expired', lang) : ''}
          {oauthOutcome === 'failed' ? t(lang, 'git.oauth.notCompleted') : ''}
        </p>
        {oauthOutcome === 'waiting' && <p className="data-note">{t(lang, 'git.oauth.remaining', { remaining: oauthRemainingText(oauthExpiresAt, oauthNow, lang), limit: OAUTH_POLL_LIMIT })}</p>}
        {oauthError !== '' && <p className="upload-note-error" role="alert">{oauthError}</p>}
        <div className="oauth-actions">
          {oauthOutcome === 'waiting'
            ? <button className="btn" onClick={() => void cancelOauth()}>{t(lang, 'git.oauth.cancel')}</button>
            : <button className="btn btn-primary" onClick={() => { void cancelOauth(); }}>{t(lang, 'git.oauth.restart')}</button>}
        </div>
      </div>
    );
  const oauthSection = oauthProviders.length === 0 || !onOauthStart
    ? null
    : (
      <div className="oauth-block">
        <h4>{t(lang, 'git.oauth.title')}</h4>
        {oauthPanel}
      </div>
    );

  const uploadTab = (
    <div className="git-tab-body">
      <section className="upload-step">
        <h4>{t(lang, 'git.upload.step1')}</h4>
        {remoteList.length === 0
          ? <p className="git-empty">{t(lang, 'git.upload.noRemote')}</p>
          : <label className="upload-field">
            <span>{t(lang, 'git.upload.remoteLabel')}</span>
            <select value={selectedRemote?.name ?? ''} disabled={busy} onChange={(event) => { if (oauthFlow) void cancelOauth(); setRemoteName(event.target.value); setStep('idle'); }}>
              {remoteList.map((remote) => <option key={remote.name} value={remote.name}>{remote.name} · {remoteUrlLabel(remote)}</option>)}
            </select>
          </label>}
      </section>

      <section className="upload-step">
        <h4>{t(lang, 'git.upload.step2')}</h4>
        <p className="upload-auth-line"><i className={`state-dot ${authStatusTone(remoteAuth)}`} />{authStatusLabel(remoteAuth, lang)}</p>
        {remoteAuth && !remoteAuth.configured && (
          <div className="upload-credential">
            <p className="data-note">{t(lang, 'git.upload.noCredentialNote')}</p>
            <div className="upload-credential-actions">
              <button className="btn" disabled={busy || !onUseSshAgent} onClick={() => { if (selectedRemote && onUseSshAgent) void onUseSshAgent({ workspaceRoot, remote: selectedRemote.name, url: selectedRemote.url }); }}>{t(lang, 'git.upload.useSshAgent')}</button>
              <label className="upload-field">
                <span>{t(lang, 'git.upload.tokenLabel')}</span>
                <input type="password" autoComplete="off" value={token} placeholder={t(lang, 'git.upload.tokenPlaceholder')} disabled={busy} onChange={(event) => setToken(event.target.value)} />
              </label>
              <button className="btn btn-primary" disabled={busy || token === ''} onClick={() => void submitToken()}>{t(lang, 'git.upload.saveToken')}</button>
            </div>
            {credentialNote && <p className="upload-note-error" role="alert">{credentialNote}</p>}
          </div>
        )}
        {remoteAuth?.configured && onClearAuth && (
          <button className="btn" disabled={busy} onClick={() => { if (selectedRemote) void onClearAuth({ workspaceRoot, remote: selectedRemote.name, url: selectedRemote.url }); }}>{t(lang, 'git.upload.disconnect')}</button>
        )}
        {oauthSection}
      </section>

      <section className="upload-step">
        <h4>{t(lang, 'git.upload.step3')}</h4>
        <p className="data-note">{t(lang, 'git.upload.preflightNote')}</p>
        <button className="btn" disabled={busy || !selectedRemote} onClick={() => void runPreflight()}>{t(lang, 'git.upload.startPreflight')}</button>
        {preflight && (
          <div className="upload-preflight">
            <div className="detail-meta"><span>{t(lang, 'git.upload.remoteLabel')}</span><span>{preflight.remote}</span></div>
            <div className="detail-meta"><span>{t(lang, 'git.upload.branchLabel')}</span><span>{preflight.branch}</span></div>
            <div className="detail-meta"><span>{t(lang, 'git.upload.aheadBehindLabel')}</span><span>{aheadBehindText(preflight.ahead, preflight.behind, lang)}</span></div>
            <div className="detail-meta"><span>{t(lang, 'git.upload.onlineLabel')}</span><span>{preflight.online === null ? t(lang, 'git.online.unknownShort') : preflight.online ? t(lang, 'git.online.online') : t(lang, 'git.online.offline')}</span></div>
            <div className="detail-meta"><span>{t(lang, 'git.upload.filesLabel')}</span><span>{preflight.files}</span></div>
            <div className="detail-meta"><span>{t(lang, 'git.upload.linesLabel')}</span><span>+{preflight.added} -{preflight.removed}</span></div>
            {uploadBlockers(preflight).map((reason) => <p className="upload-blocker" key={reason}>{reason}</p>)}
          </div>
        )}
      </section>

      <section className="upload-step">
        <h4>{t(lang, 'git.upload.step4')}</h4>
        <div className="upload-scope" role="radiogroup" aria-label={t(lang, 'git.upload.scopeLabel')}>
          {(['all', 'session'] as const).map((value) => (
            <label key={value} className={scope === value ? 'selected' : ''}>
              <input type="radio" name="upload-scope" value={value} checked={scope === value} disabled={busy} onChange={() => setScope(value)} />
              <span>{uploadScopeLabels(lang)[value]}</span>
            </label>
          ))}
        </div>
        <label className="upload-field">
          <span>{t(lang, 'git.upload.messageLabel')}</span>
          <textarea value={message} rows={3} placeholder={t(lang, 'git.upload.messagePlaceholder')} disabled={busy || generating} onChange={(event) => setMessage(event.target.value)} />
        </label>
        {onGenerateMessage && (
          <div className="upload-generate">
            <button className="btn" disabled={busy || generating} onClick={() => void runGenerate()}>
              {t(lang, generating ? 'git.upload.generating' : 'git.upload.generate')}
            </button>
            <span className="data-note">{t(lang, 'git.upload.generateNote')}</span>
          </div>
        )}
        {generateNote !== '' && <p className="upload-generate-note" role="status">{generateNote}</p>}
        <button className="btn" disabled={busy || message.trim() === ''} onClick={() => void runPreflight()}>{t(lang, 'git.upload.preflightAndConfirm')}</button>
      </section>

      {step === 'confirm' && confirm && (
        <section ref={confirmBoxRef} className="upload-confirm" role="dialog" aria-modal="true" aria-label={t(lang, 'git.upload.confirmButton')}>
          <h4>{t(lang, 'git.upload.confirmTitle')}</h4>
          <p className="data-note">{t(lang, 'git.upload.confirmNote')}</p>
          <div className="detail-meta"><span>{t(lang, 'git.upload.remoteLabel')}</span><span>{confirm.remote}</span></div>
          <div className="detail-meta"><span>{t(lang, 'git.upload.branchLabel')}</span><span>{confirm.branch}</span></div>
          <div className="detail-meta"><span>{t(lang, 'git.upload.filesLabel')}</span><span>{confirm.files}</span></div>
          <div className="detail-meta"><span>{t(lang, 'git.upload.linesLabel')}</span><span>+{confirm.added} -{confirm.removed}</span></div>
          <div className="detail-meta"><span>{t(lang, 'git.upload.scopeFieldLabel')}</span><span>{uploadScopeLabels(lang)[confirm.scope]}</span></div>
          <div className="upload-confirm-message"><span>{t(lang, 'git.upload.confirmMessageLabel')}</span><code>{confirm.message}</code></div>
          <div className="upload-confirm-actions">
            <button className="btn" onClick={() => setStep('preflight')}>{t(lang, 'git.upload.cancel')}</button>
            <button ref={confirmRef} className="btn btn-primary" disabled={busy} onClick={() => void runUpload()}>{t(lang, 'git.upload.confirmButton')}</button>
          </div>
        </section>
      )}

      {step === 'uploading' && <p className="upload-progress" role="status">{t(lang, 'git.upload.uploading')}</p>}

      {step === 'success' && upload && (
        <section className="upload-success">
          <h4>{t(lang, 'git.upload.successTitle')}</h4>
          <div className="detail-meta"><span>{t(lang, 'git.upload.shaLabel')}</span><code>{upload.sha}</code></div>
          <button className="btn" aria-label={t(lang, 'git.upload.copySha')} onClick={() => { void navigator.clipboard?.writeText(upload.sha); }}><Icon name="copy" size={13} />{t(lang, 'git.upload.copySha')}</button>
          <div className="detail-meta"><span>{t(lang, 'git.upload.remoteLabel')}</span><code>{upload.remote}</code></div>
          <div className="detail-meta"><span>{t(lang, 'git.upload.branchLabel')}</span><span>{upload.branch}</span></div>
          <div className="detail-meta"><span>{t(lang, 'git.upload.filesLabel')}</span><span>{upload.files}</span></div>
          <div className="detail-meta"><span>{t(lang, 'git.upload.linesLabel')}</span><span>+{upload.added} -{upload.removed}</span></div>
          <p className="data-note">{t(lang, 'git.upload.remoteNotAuto')}</p>
          <button className="btn" onClick={() => setStep('idle')}>{t(lang, 'git.upload.done')}</button>
        </section>
      )}

      {step === 'failed' && failure && (
        <section className="upload-failed" role="alert">
          <h4>{t(lang, 'git.upload.failedTitle', { code: failure.code })}</h4>
          <p>{uploadFailurePath(failure.code, lang).title}</p>
          <p className="data-note">{failure.message}</p>
          <ul className="upload-actions">
            {uploadFailurePath(failure.code, lang).actions.map((action) => <li key={action}>{action}</li>)}
          </ul>
          <button className="btn" onClick={() => setStep('idle')}>{t(lang, 'git.upload.back')}</button>
        </section>
      )}
    </div>
  );

  const tabs: readonly { readonly id: GitTab; readonly label: string }[] = gitTabs(lang);

  return (
    <aside className="git-sidebar" aria-label={t(lang, 'git.panel.ariaLabel')}>
      {header}
      <div className="git-tabs" role="tablist" aria-label={t(lang, 'git.panel.tabsLabel')}>
        {tabs.map((item, index) => (
          <button
            key={item.id}
            ref={index === 0 ? tabRef : undefined}
            role="tab"
            type="button"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'selected' : ''}
            onClick={() => onTab(item.id)}
          >{item.label}</button>
        ))}
      </div>
      <div className="git-scroll">
        {error && <p className="upload-note-error" role="alert">{error}</p>}
        {tab === 'changes' && changesTab}
        {tab === 'graph' && graphTab}
        {tab === 'branches' && branchesTab}
        {tab === 'upload' && uploadTab}
        {tab === 'changes' && diffSelection && diff && diff.path === diffSelection.path && (
          <GitDiffPanel diff={diff} mode={diffSelection.mode} lang={lang} />
        )}
        {tab === 'changes' && diffSelection && (!diff || diff.path !== diffSelection.path) && (
          <section className="git-diff" aria-label={t(lang, 'git.diff.readingAria')}>
            <header>{diffSelection.path}<small>{t(lang, diffLoading ? 'git.diff.reading' : 'git.diff.unavailable')}</small></header>
            <p className="git-diff-scope">{gitDiffScopeText(diffSelection.mode, lang)}</p>
            <p className="git-diff-empty">
              {diffFailed !== ''
                ? diffFailed
                : diffLoading
                  ? t(lang, 'git.diff.readingBody')
                  : t(lang, 'git.diff.unavailableBody')}
            </p>
          </section>
        )}
      </div>
      <div className="git-footer">
        <button className="text-link" onClick={onOpenDetail}>{t(lang, 'git.footer.openDetail')}</button>
        <small className="data-note">{t(lang, 'git.footer.scopeNote')}</small>
      </div>
    </aside>
  );
}
