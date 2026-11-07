/**
 * Git 侧栏（`27` §11.3 / §10.8）的界面契约测试。
 *
 * 风格与 `dashboard-pages.test.ts` 一致：**不引入浏览器/Playwright**。
 * 纯函数直接断言；组件用 `renderToStaticMarkup` 做静态标记断言（不是 DOM 测试）。
 */

import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  GitAuthInfo, GitAuthStatusResult, GitBranchesResult, GitCommitNode, GitDiffResult, GitFileEntry, GitOauthProvider, GitPreflightResult, GitRemoteInfo, GitRemotesResult, GitStatusResult,
} from '@syaocode/dhp';
import {
  GIT_TABS, GitDiffPanel, GitSidebar, INITIAL_SIDEBAR_STATE, LARGE_FILE_THRESHOLD_BYTES, OAUTH_MAX_DELAY_MS, OAUTH_MIN_DELAY_MS, OAUTH_POLL_LIMIT, SIGNING_FAILED_CODE,
  aheadBehindText, authMethodLabel, authStatusLabel, authStatusTone, branchLabel, commitHooksText, executableHooks,
  formatBytes, gitFileLabel, gitFileStatText, gitStatusBadge, gitStatusSummary, gitTabState, groupByStaging,
  diffModeForFile, gitDiffEmptyText, gitDiffScopeText,
  inactiveHooks, isSigningFailure, largeStagedFiles, layoutGitGraph, onlineStateLabel, onlineStateTone,
  oauthFailureText, oauthPollDelay, oauthPollLabel, oauthProviderHint, oauthProviderState, oauthRemainingText,
  preflightReady, remoteUrlLabel, signingFailureActions, summarizeGitFiles,
  uploadBlockers, uploadConfirmPayload, uploadFailurePath, type SidebarSlotState,
} from '../src/renderer/git-sidebar.tsx';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string): string => readFileSync(path.join(ROOT, p), 'utf8');

const file = (overrides: Partial<GitFileEntry> = {}): GitFileEntry => ({
  path: 'src/a.ts', status: 'modified', staged: false, oldPath: null, added: 12, removed: 3, stat: 'exact', binary: false, sizeBytes: null, ...overrides,
});

const status = (overrides: Partial<GitStatusResult> = {}): GitStatusResult => ({
  workspaceRoot: '/workspace', branch: 'main', detached: false, head: 'abc1234', clean: false,
  ahead: 2, behind: 0, files: [], truncated: false, hooks: [], revision: 7, fetchedAt: 1_760_000_000_000, ...overrides,
});

const auth = (overrides: Partial<GitAuthInfo> = {}): GitAuthInfo => ({
  method: 'token', configured: false, account: null, scope: [], ready: false, keyFingerprint: null, updatedAt: null, ...overrides,
});

const remote = (overrides: Partial<GitRemoteInfo> = {}): GitRemoteInfo => ({ name: 'origin', url: 'https://github.com/example/repo.git', auth: auth(), ...overrides });

const preflight = (overrides: Partial<GitPreflightResult> = {}): GitPreflightResult => ({
  workspaceRoot: '/workspace', remote: 'origin', remoteUrl: 'https://github.com/example/repo.git', branch: 'main',
  clean: false, ahead: 1, behind: 0, diverged: false, remoteWritable: true, online: true,
  files: 3, added: 42, removed: 7, truncated: false, requiresCommit: true, revision: 7, blockers: [], ...overrides,
});

const branches: GitBranchesResult = {
  workspaceRoot: '/workspace', current: 'main', detached: false,
  local: [
    { name: 'main', kind: 'local', current: true, ahead: 2, behind: 0, upstream: 'origin/main', sha: 'abc1234' },
    { name: 'feature', kind: 'local', current: false, ahead: null, behind: null, upstream: null, sha: 'def5678' },
  ],
  remote: [{ name: 'origin/main', kind: 'remote', current: false, ahead: null, behind: null, upstream: null, sha: 'abc1234' }],
};

const remotes: GitRemotesResult = { workspaceRoot: '/workspace', remotes: [remote()] };

const authStatus: GitAuthStatusResult = { workspaceRoot: '/workspace', remotes: [remote()], providers: [] };

const commit = (overrides: Partial<GitCommitNode> = {}): GitCommitNode => ({
  sha: 'abc1234567890', parents: [], author: 'Ada', email: 'ada@example.com', at: 1_760_000_000_000, subject: 'Initial commit', refs: [], ...overrides,
});

const render = (overrides: Partial<Parameters<typeof GitSidebar>[0]> = {}): string => renderToStaticMarkup(createElement(GitSidebar, {
  workspaceRoot: '/workspace',
  status: status({ files: [file({ path: 'src/a.ts', staged: true }), file({ path: 'src/b.ts' }), file({ path: 'notes.md', status: 'untracked', added: null, removed: null, stat: 'unavailable' })] }),
  branches,
  graph: undefined,
  remotes,
  auth: authStatus,
  preflight: undefined,
  upload: undefined,
  diff: undefined,
  loading: false,
  busy: false,
  error: '',
  tab: 'changes',
  onTab: () => { throw new Error('Rendering must not switch tabs'); },
  onClose: () => { throw new Error('Rendering must not close'); },
  onRefresh: () => { throw new Error('Rendering must not refresh'); },
  onLoadGraph: () => { throw new Error('Rendering must not load the graph'); },
  onStage: () => { throw new Error('Rendering must not stage'); },
  onUnstage: () => { throw new Error('Rendering must not unstage'); },
  onCommit: async () => { throw new Error('Rendering must not commit'); },
  onBranchSwitch: () => { throw new Error('Rendering must not switch branches'); },
  onBranchCreate: () => { throw new Error('Rendering must not create branches'); },
  onPreflight: async () => { throw new Error('Rendering must not preflight'); },
  onUpload: async () => { throw new Error('Rendering must not upload'); },
  onOpenDetail: () => { throw new Error('Rendering must not navigate'); },
  ...overrides,
}));

describe('right-column slot: Git hidden by default and mutually exclusive with session detail (TC-N-034)', () => {
  it('starts collapsed with Git closed and no detail panel', () => {
    expect(INITIAL_SIDEBAR_STATE.slot).toBe('none');
    expect(INITIAL_SIDEBAR_STATE.gitOpen).toBe(false);
    expect(INITIAL_SIDEBAR_STATE.detailOpen).toBe(false);
    expect(INITIAL_SIDEBAR_STATE.tab).toBe('changes');
  });
  it('opens Git on the first toggle and closes it on the second (no auto-open)', () => {
    const opened = gitTabState(INITIAL_SIDEBAR_STATE, 'toggle-git');
    expect(opened).toMatchObject({ slot: 'git', gitOpen: true, detailOpen: false, detailBeforeGit: false });
    const closed = gitTabState(opened, 'toggle-git');
    expect(closed).toMatchObject({ slot: 'none', gitOpen: false, detailOpen: false });
  });
  it('switches the slot instead of stacking a second sidebar', () => {
    const detailOpen: SidebarSlotState = { ...INITIAL_SIDEBAR_STATE, slot: 'detail', detailOpen: true };
    const gitOpen = gitTabState(detailOpen, 'toggle-git');
    expect(gitOpen.slot).toBe('git');
    expect(gitOpen.gitOpen).toBe(true);
    expect(gitOpen.detailOpen).toBe(false);
    // 关闭 Git 后回到会话详情（此前是展开态）。
    const back = gitTabState(gitOpen, 'toggle-git');
    expect(back.slot).toBe('detail');
    expect(back.detailOpen).toBe(true);
    expect(back.gitOpen).toBe(false);
  });
  it('opening the session detail always closes Git (mutual exclusion)', () => {
    const gitOpen = gitTabState(INITIAL_SIDEBAR_STATE, 'toggle-git');
    const detailOpen = gitTabState(gitOpen, 'toggle-detail');
    expect(detailOpen.slot).toBe('detail');
    expect(detailOpen.gitOpen).toBe(false);
    expect(detailOpen.detailOpen).toBe(true);
  });
  it('only changes the selected tab while Git is open and remembers it', () => {
    const closed = gitTabState(INITIAL_SIDEBAR_STATE, 'select-tab', 'upload');
    expect(closed.tab).toBe('changes');
    const opened = gitTabState(INITIAL_SIDEBAR_STATE, 'toggle-git');
    const selected = gitTabState(opened, 'select-tab', 'upload');
    expect(selected.tab).toBe('upload');
    expect(selected.slot).toBe('git');
    expect(GIT_TABS.map((tab) => tab.label)).toEqual(['变更', '提交图', '分支', '上传']);
  });
  it('close collapses the whole right column but keeps the tab preference', () => {
    const opened = gitTabState(INITIAL_SIDEBAR_STATE, 'toggle-git');
    const selected = gitTabState(opened, 'select-tab', 'branches');
    const closed = gitTabState(selected, 'close');
    expect(closed.slot).toBe('none');
    expect(closed.gitOpen).toBe(false);
    expect(closed.tab).toBe('branches');
  });
});

describe('working-tree changes: grouping and honest stats', () => {
  it('groups files into staged / unstaged / untracked', () => {
    const groups = groupByStaging([
      file({ path: 'a', staged: true }),
      file({ path: 'b', staged: false }),
      file({ path: 'c', status: 'untracked', staged: false }),
    ]);
    expect(groups.staged.map((entry) => entry.path)).toEqual(['a']);
    expect(groups.unstaged.map((entry) => entry.path)).toEqual(['b']);
    expect(groups.untracked.map((entry) => entry.path)).toEqual(['c']);
  });
  it('shows "+N -M" and the exact aria-label for a statted file', () => {
    expect(gitFileStatText(file())).toBe('+12 -3');
    expect(gitFileLabel(file())).toBe('src/a.ts，修改，未暂存，新增 12 行，删除 3 行');
    expect(gitFileLabel(file({ staged: true }))).toContain('已暂存');
    expect(gitFileLabel(file({ status: 'untracked', added: null, removed: null, stat: 'unavailable' }))).toContain('未跟踪');
  });
  it('shows "不可统计" (never 0) for unavailable files', () => {
    const entry = file({ path: 'bin/data.bin', added: null, removed: null, stat: 'unavailable' });
    expect(gitFileStatText(entry)).toBe('不可统计');
    expect(gitFileStatText(entry)).not.toBe('+0 -0');
    expect(gitFileLabel(entry)).toContain('不可统计行数');
    expect(summarizeGitFiles([entry])).toEqual({ files: 1, added: null, removed: null, unavailable: 1 });
  });
  it('labels the tab as working-tree scope, never as session scope', () => {
    expect(gitStatusSummary(status({ files: [file(), file({ path: 'b', added: 30, removed: 4 })] }))).toBe('工作区未提交改动 · 2 个文件 · +42 -7');
    expect(gitStatusSummary(status({ files: [] }))).toBe('工作区未提交改动 · 0 个文件');
    expect(gitStatusSummary(undefined)).toContain('工作区未提交改动');
    expect(gitStatusSummary(status({ files: [file({ stat: 'unavailable', added: null, removed: null })] }))).toContain('统计不完整');
  });
  it('derives the toolbar badge without inventing numbers', () => {
    expect(gitStatusBadge(status({ files: [] }))).toBe('');
    expect(gitStatusBadge(undefined)).toBe('');
    expect(gitStatusBadge(status({ files: [file(), file({ path: 'b', added: 30, removed: 4 })] }))).toBe('+42 -7');
    expect(gitStatusBadge(status({ files: [file({ stat: 'unavailable', added: null, removed: null })] }))).toBe('1 个文件');
  });
});

describe('header status: branch, ahead/behind, online and auth dots', () => {
  it('never turns unknown ahead/behind into zero', () => {
    expect(aheadBehindText(null, null)).toBe('领先/落后未知');
    expect(aheadBehindText(2, 0)).toBe('领先 2 · 落后 0');
    expect(aheadBehindText(undefined, 1)).toBe('领先 未知 · 落后 1');
  });
  it('reports auth state without exposing any credential value', () => {
    expect(authStatusLabel(undefined)).toBe('认证状态未知');
    expect(authStatusLabel(auth())).toBe('未配置凭据');
    expect(authStatusLabel(auth({ configured: true, ready: false }))).toBe('凭据已配置，尚未校验');
    expect(authStatusLabel(auth({ configured: true, ready: true, account: 'ada', method: 'oauth' }))).toBe('认证就绪 · 浏览器授权（ada）');
    expect(authMethodLabel('ssh-agent')).toBe('系统 SSH 凭据');
    expect(authStatusTone(auth({ configured: true, ready: true }))).toBe('green');
    expect(authStatusTone(auth())).toBe('amber');
    expect(authStatusTone(undefined)).toBe('grey');
  });
  it('treats unknown connectivity as unknown, never as online', () => {
    expect(onlineStateLabel(undefined)).toContain('未知');
    expect(onlineStateLabel(preflight({ online: null }))).toContain('未知');
    expect(onlineStateLabel(preflight({ online: false }))).toBe('离线');
    expect(onlineStateLabel(preflight({ online: true }))).toBe('在线');
    expect(onlineStateTone(preflight({ online: null }))).toBe('grey');
    expect(onlineStateTone(preflight({ online: false }))).toBe('amber');
    expect(onlineStateTone(preflight({ online: true }))).toBe('green');
  });
  it('labels branches with the current marker and counts', () => {
    expect(branchLabel(branches.local[0]!)).toBe('main（当前） · 领先 2 · 落后 0');
    expect(branchLabel(branches.local[1]!)).toBe('feature');
    expect(branchLabel(branches.remote[0]!)).toBe('远端 origin/main');
  });
  it('strips embedded credentials from remote URLs as a renderer-side fallback', () => {
    expect(remoteUrlLabel(remote({ url: 'https://user:token@github.com/example/repo.git' }))).toBe('https://github.com/example/repo.git');
    expect(remoteUrlLabel(remote({ url: 'git@github.com:example/repo.git' }))).toBe('git@github.com:example/repo.git');
  });
});

describe('commit graph layout (§10.3)', () => {
  it('keeps a linear history in one lane', () => {
    const layout = layoutGitGraph([
      commit({ sha: 'c3', parents: ['c2'] }),
      commit({ sha: 'c2', parents: ['c1'] }),
      commit({ sha: 'c1', parents: [] }),
    ]);
    expect(layout.rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(layout.rows.every((row) => !row.truncated)).toBe(true);
    expect(layout.lanes).toBe(1);
  });
  it('marks a parent outside the window as truncated (dashed edge)', () => {
    const layout = layoutGitGraph([commit({ sha: 'c3', parents: ['outside'] })]);
    expect(layout.rows[0]!.truncated).toBe(true);
    expect(layout.rows[0]!.lane).toBe(0);
  });
  it('places a parallel branch in its own lane', () => {
    const layout = layoutGitGraph([
      commit({ sha: 'm', parents: ['a', 'b'] }),
      commit({ sha: 'a', parents: [] }),
      commit({ sha: 'b', parents: [] }),
    ]);
    expect(layout.rows.map((row) => row.lane)).toEqual([0, 0, 1]);
    expect(layout.lanes).toBe(2);
  });
  it('renders an empty repository as an explicit empty state', () => {
    expect(layoutGitGraph([])).toEqual({ rows: [], lanes: 1 });
    const html = render({ tab: 'graph', graph: { workspaceRoot: '/workspace', commits: [], hasMore: false, truncated: false } });
    expect(html).toContain('仓库还没有提交记录');
  });
  it('renders commit rows and a dashed edge for a truncated window', () => {
    const html = render({
      tab: 'graph',
      graph: { workspaceRoot: '/workspace', commits: [commit({ sha: 'c3', parents: ['outside'], subject: 'feat: graph' })], hasMore: true, truncated: true },
    });
    expect(html).toContain('feat: graph');
    expect(html).toContain('git-graph-edge-dashed');
    expect(html).toContain('窗口外的父提交以虚线表示');
  });
});

describe('upload flow: preflight, confirmation and failure paths (§10.8)', () => {
  it('only allows confirmation when the preflight passes every gate', () => {
    expect(preflightReady(undefined)).toBe(false);
    expect(preflightReady(preflight())).toBe(true);
    expect(preflightReady(preflight({ blockers: [{ kind: 'auth', code: -32036, reason: '未配置凭据' }] }))).toBe(false);
    expect(preflightReady(preflight({ diverged: true }))).toBe(false);
    expect(preflightReady(preflight({ online: false }))).toBe(false);
    expect(preflightReady(preflight({ files: 0 }))).toBe(false);
    expect(uploadBlockers(preflight({ blockers: [{ kind: 'auth', code: -32036, reason: '未配置凭据' }] }))).toEqual(['未配置凭据']);
  });
  it('builds a confirmation payload with every required field', () => {
    const payload = uploadConfirmPayload(preflight(), { message: '  feat: upload  ', scope: 'session' });
    expect(payload).toEqual({ remote: 'origin', branch: 'main', files: 3, added: 42, removed: 7, message: 'feat: upload', scope: 'session' });
    expect(Object.keys(payload).sort()).toEqual(['added', 'branch', 'files', 'message', 'remote', 'removed', 'scope']);
  });
  it('gives actionable paths for credentials / rejection / offline / divergence', () => {
    expect(uploadFailurePath(-32036)).toMatchObject({ kind: 'auth-required', title: '未配置凭据' });
    expect(uploadFailurePath(-32036).actions).toContain('去配置凭据');
    expect(uploadFailurePath(-32037)).toMatchObject({ kind: 'auth-rejected' });
    expect(uploadFailurePath(-32037).actions).toContain('重新输入令牌');
    expect(uploadFailurePath(-32038)).toMatchObject({ kind: 'offline' });
    expect(uploadFailurePath(-32038).actions).toContain('检查网络后重试');
    expect(uploadFailurePath(-32039)).toMatchObject({ kind: 'diverged' });
    expect(uploadFailurePath(-32039).actions).toEqual(['先拉取再上传', '上传到新分支', '取消']);
  });
  it('never offers a force option on any failure path', () => {
    for (const code of [-32036, -32037, -32038, -32039, -32032, -32033, -1]) {
      const path = uploadFailurePath(code);
      expect(path.actions.length).toBeGreaterThan(0);
      for (const action of path.actions) expect(action.toLowerCase()).not.toMatch(/force|强制/);
    }
  });
  it('renders the upload tab with remote, auth, preflight, scope and message fields', () => {
    const html = render({ tab: 'upload' });
    expect(html).toContain('1 · 选择远端');
    expect(html).toContain('2 · 认证状态');
    expect(html).toContain('3 · 预检');
    expect(html).toContain('4 · 范围与提交信息');
    expect(html).toContain('全部未提交改动');
    expect(html).toContain('仅本会话改动');
    expect(html).toContain('提交信息');
    expect(html).toContain('此远端尚未配置凭据');
    expect(html).toContain('type="password"');
    expect(html.toLowerCase()).not.toContain('force');
  });
  it('renders the preflight summary that the confirmation is built from', () => {
    const html = render({
      tab: 'upload',
      preflight: preflight(),
      status: status({ files: [file(), file({ path: 'b', added: 30, removed: 4 })] }),
    });
    // 二次确认的字段来源：远端 / 分支 / 文件数 / ± 行数 / 范围 / 提交信息。
    expect(html).toContain('origin');
    expect(html).toContain('main');
    expect(html).toContain('文件数');
    expect(html).toContain('行数');
    expect(html).toContain('+42 -7');
    expect(html).toContain('全部未提交改动');
    expect(html).toContain('提交信息');
    expect(html.toLowerCase()).not.toContain('force');
  });
});

describe('sidebar static render', () => {
  it('labels the changes tab with the working-tree scope and the session-detail cross-link', () => {
    const html = render();
    expect(html).toContain('工作区未提交改动');
    expect(html).toContain('已暂存');
    expect(html).toContain('未暂存');
    expect(html).toContain('未跟踪');
    expect(html).toContain('本会话改动见会话详情');
    expect(html).toContain('aria-label="src/a.ts，修改，已暂存，新增 12 行，删除 3 行"');
    expect(html).toContain('aria-label="notes.md，未跟踪，未跟踪，不可统计行数"');
    expect(html).not.toContain('+0 -0');
  });
  it('renders an explicit empty state when the working tree is clean', () => {
    const html = render({ status: status({ files: [], clean: true }) });
    expect(html).toContain('工作区没有未提交改动');
  });
  it('shows the remote list and never renders force wording', () => {
    const html = render({ tab: 'upload', remotes, auth: authStatus });
    expect(html).toContain('origin');
    expect(html.toLowerCase()).not.toContain('force');
    expect(html.toLowerCase()).not.toContain('强制推送');
  });
});

describe('提交信息生成（FR-N-026）', () => {
  it('提供生成回调时出现"生成提交信息"按钮，并说明生成是只读的', () => {
    const html = render({ tab: 'upload', remotes, auth: authStatus, onGenerateMessage: async () => undefined });
    expect(html).toContain('生成提交信息');
    expect(html).toContain('生成是只读的，不会提交');
  });

  it('没有生成回调时不显示按钮（不假装有模型）', () => {
    const html = render({ tab: 'upload', remotes, auth: authStatus });
    expect(html).not.toContain('生成提交信息');
  });

  it('渲染层源码里区分模型生成与兜底文案，且失败不跳上传失败页', () => {
    const source = readFileSync(new URL('../src/renderer/git-sidebar.tsx', import.meta.url), 'utf8');
    expect(source).toContain("result.source === 'fallback'");
    expect(source).toContain('确定性兜底文案');
    expect(source).toContain('result.truncated');
    // 生成失败只写一行说明，不把上传流程推进到 failed 步骤。
    expect(source).toMatch(/生成失败：\$\{\(e as Error\)\.message\}/);
    // 已手写内容不静默覆盖。
    expect(source).toContain('用生成的提交信息替换吗');
  });
});

describe('commit preflight hints and signing-failure paths (§10.5.3)', () => {
  it('counts only executable hooks and keeps inactive ones visible', () => {
    const hooks = [
      { name: 'pre-commit', executable: true },
      { name: 'commit-msg', executable: true },
      { name: 'pre-push', executable: false },
    ];
    expect(executableHooks(status({ hooks })).map((hook) => hook.name)).toEqual(['pre-commit', 'commit-msg']);
    expect(inactiveHooks(status({ hooks })).map((hook) => hook.name)).toEqual(['pre-push']);
    expect(commitHooksText(status({ hooks }))).toBe('将运行 2 个钩子（pre-commit、commit-msg）');
    expect(commitHooksText(status({ hooks: [{ name: 'pre-commit', executable: true }] }))).toBe('将运行 1 个钩子（pre-commit）');
    expect(commitHooksText(status({ hooks: [] }))).toBe('没有可执行的提交钩子');
    expect(commitHooksText(status({ hooks: [{ name: 'pre-push', executable: false }] }))).toBe('没有可执行的提交钩子');
    expect(commitHooksText(undefined)).toContain('尚未读取');
  });

  it('lists only staged files above the threshold', () => {
    const big = LARGE_FILE_THRESHOLD_BYTES + 1;
    const files = [
      file({ path: 'assets/big.bin', staged: true, sizeBytes: big }),
      file({ path: 'assets/just-at.bin', staged: true, sizeBytes: LARGE_FILE_THRESHOLD_BYTES }),
      file({ path: 'src/small.ts', staged: true, sizeBytes: 1024 }),
      file({ path: 'src/unstaged.ts', staged: false, sizeBytes: big }),
      file({ path: 'src/unknown.ts', staged: true, sizeBytes: null }),
    ];
    expect(largeStagedFiles(status({ files })).map((entry) => entry.path)).toEqual(['assets/big.bin']);
    expect(largeStagedFiles(status({ files }), 1024).map((entry) => entry.path)).toEqual(['assets/big.bin', 'assets/just-at.bin']);
    expect(largeStagedFiles(undefined)).toEqual([]);
    expect(largeStagedFiles(status({ files }), LARGE_FILE_THRESHOLD_BYTES).every((entry) => entry.staged && entry.sizeBytes !== null)).toBe(true);
  });

  it('formats bytes across B / KB / MB boundaries', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(LARGE_FILE_THRESHOLD_BYTES)).toBe('5.0 MB');
  });

  it('offers exactly three signing-failure paths in the fixed order', () => {
    const actions = signingFailureActions();
    expect(actions).toHaveLength(3);
    expect(actions.map((action) => action.id)).toEqual(['retry', 'unsigned', 'cancel']);
    expect(actions[1]!.label).toContain('无签名');
    expect(actions[1]!.hint).toContain('审计');
    for (const action of actions) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.hint.length).toBeGreaterThan(0);
    }
  });

  it('recognises signing failure by kind, code or message', () => {
    expect(isSigningFailure({ kind: 'git_signing_failed' })).toBe(true);
    expect(isSigningFailure({ code: SIGNING_FAILED_CODE })).toBe(true);
    expect(isSigningFailure(new Error(`提交失败（${SIGNING_FAILED_CODE}）`))).toBe(true);
    expect(isSigningFailure(new Error('签名失败：gpg: signing failed'))).toBe(true);
    expect(isSigningFailure(new Error('network down'))).toBe(false);
    expect(isSigningFailure(null)).toBe(false);
    expect(isSigningFailure('git_signing_failed')).toBe(false);
    expect(SIGNING_FAILED_CODE).toBe(-32046);
  });

  it('renders hooks, the large-file warning and both commit options', () => {
    const html = render({
      status: status({
        hooks: [
          { name: 'pre-commit', executable: true },
          { name: 'commit-msg', executable: true },
          { name: 'pre-push', executable: false },
        ],
        files: [file({ path: 'assets/big.bin', staged: true, sizeBytes: LARGE_FILE_THRESHOLD_BYTES + 1024, added: null, removed: null, stat: 'unavailable' })],
      }),
    });
    expect(html).toContain('将运行 2 个钩子');
    expect(html).toContain('pre-commit');
    expect(html).toContain('commit-msg');
    expect(html).toContain('存在但不可执行');
    expect(html).toContain('pre-push');
    expect(html).toContain('assets/big.bin');
    expect(html).toContain('5.0 MB');
    expect(html).toContain('只提示，不阻止提交');
    expect(html).toContain('--no-verify');
    expect(html).toContain('允许空提交');
    expect(html).toContain('默认拒绝空提交');
  });

  it('disables the commit button when nothing is staged (empty commit is opt-in)', () => {
    const html = render({ status: status({ files: [] }) });
    expect(html).toContain('允许空提交');
    // 没有已暂存文件、也没勾"允许空提交"时，提交按钮必须是 disabled（空提交默认拒绝）。
    expect(html).toMatch(/<button class="btn btn-primary" disabled="">提交已暂存改动<\/button>/);
  });

  it('never auto-degrades to an unsigned commit in source', () => {
    const source = read('src/renderer/git-sidebar.tsx');
    expect(source).toContain('git_signing_failed');
    expect(source).toContain('signingFailureActions');
    expect(source).toContain('提交签名失败');
    expect(source).toContain('role="alertdialog"');
    const start = source.indexOf('const runCommit');
    const end = source.indexOf('const header =', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // 自动提交路径里绝不能出现 noSign。
    expect(source.slice(start, end)).not.toContain('noSign: true');
    // noSign 只出现在签名失败面板的用户点击里。
    expect(source).toContain('runCommit({ ...signingFailure.input, noSign: true })');
  });
});

describe('Git browser authorization (device flow, N-9)', () => {
  const provider = (overrides: Partial<GitOauthProvider> = {}): GitOauthProvider => ({
    id: 'github', label: 'GitHub', deviceFlow: true, builtinClientId: true, ...overrides,
  });
  const providersAuth = (providers: readonly GitOauthProvider[]): GitAuthStatusResult => ({
    workspaceRoot: '/workspace', remotes: [remote()], providers,
  });

  it('classifies providers into ready / needs-client-id / unsupported', () => {
    expect(oauthProviderState(provider())).toBe('ready');
    expect(oauthProviderState(provider({ builtinClientId: false }))).toBe('needs-client-id');
    expect(oauthProviderState(provider({ deviceFlow: false, builtinClientId: false }))).toBe('unsupported');
    expect(oauthProviderHint(provider())).toContain('无需填 client_id');
    expect(oauthProviderHint(provider({ builtinClientId: false }))).toContain('client_id');
    expect(oauthProviderHint(provider({ deviceFlow: false }))).toContain('SSH');
    // 三种状态的文案互不相同。
    expect(new Set([oauthProviderHint(provider()), oauthProviderHint(provider({ builtinClientId: false })), oauthProviderHint(provider({ deviceFlow: false }))]).size).toBe(3);
  });

  it('computes poll delays for all five statuses, doubling slow_down with caps', () => {
    expect(oauthPollDelay('pending', 5000)).toBe(5000);
    expect(oauthPollDelay('slow_down', 5000)).toBe(10000);
    expect(oauthPollDelay('slow_down', OAUTH_MAX_DELAY_MS)).toBe(OAUTH_MAX_DELAY_MS);
    expect(oauthPollDelay('slow_down', 40_000)).toBe(OAUTH_MAX_DELAY_MS);
    expect(oauthPollDelay('pending', 0)).toBe(OAUTH_MIN_DELAY_MS);
    expect(oauthPollDelay('ready', 5000)).toBeNull();
    expect(oauthPollDelay('denied', 5000)).toBeNull();
    expect(oauthPollDelay('expired', 5000)).toBeNull();
    expect(OAUTH_POLL_LIMIT).toBeGreaterThan(0);
  });

  it('formats the remaining validity and expires at the boundary', () => {
    expect(oauthRemainingText(1000 + 200_000, 1000)).toBe('剩余 3 分 20 秒');
    expect(oauthRemainingText(1000 + 45_000, 1000)).toBe('剩余 45 秒');
    expect(oauthRemainingText(1000, 1000)).toBe('已过期');
    expect(oauthRemainingText(1000, 2000)).toBe('已过期');
    expect(oauthRemainingText(1000 + 500, 1000)).toBe('剩余 1 秒');
  });

  it('gives denied and expired distinct failure texts that never claim success', () => {
    expect(oauthFailureText('denied')).not.toBe(oauthFailureText('expired'));
    expect(oauthFailureText('denied')).toContain('拒绝');
    expect(oauthFailureText('expired')).toContain('过期');
    for (const status of ['denied', 'expired'] as const) {
      expect(oauthFailureText(status)).not.toContain('成功');
    }
    expect(oauthFailureText('pending')).toBe('');
    expect(oauthFailureText('ready')).toBe('');
    expect(oauthPollLabel('pending')).toContain('等待');
    expect(oauthPollLabel('slow_down')).toContain('放慢');
    expect(oauthPollLabel('ready')).toContain('成功');
    expect(oauthPollLabel('denied')).not.toBe(oauthPollLabel('expired'));
  });

  it('does not show the browser-auth entry when the host exposes no providers', () => {
    const html = render({ tab: 'upload', auth: providersAuth([]), onOauthStart: async () => ({ flowId: 'f', userCode: 'u', verificationUri: 'https://example.com', expiresIn: 60, interval: 5 }) });
    expect(html).not.toContain('浏览器授权（设备码）');
  });

  it('asks for a client_id when the provider has no builtin one', () => {
    const html = render({
      tab: 'upload',
      auth: providersAuth([provider({ builtinClientId: false })]),
      onOauthStart: async () => ({ flowId: 'f', userCode: 'u', verificationUri: 'https://example.com', expiresIn: 60, interval: 5 }),
    });
    expect(html).toContain('浏览器授权（设备码）');
    expect(html).toContain('OAuth App client_id');
    expect(html).toContain('type="text"');
    expect(html).toContain('需要填入你自己的 OAuth App client_id');
    // 未填 client_id 时开始按钮必须 disabled（不能点了才失败）。
    expect(html).toMatch(/<button class="btn btn-primary" disabled="">开始浏览器授权<\/button>/);
  });

  it('allows builtin-client-id providers without asking for a client_id', () => {
    const html = render({
      tab: 'upload',
      auth: providersAuth([provider()]),
      onOauthStart: async () => ({ flowId: 'f', userCode: 'u', verificationUri: 'https://example.com', expiresIn: 60, interval: 5 }),
    });
    expect(html).toContain('浏览器授权（设备码）');
    expect(html).not.toContain('OAuth App client_id');
    expect(html).not.toMatch(/<button class="btn btn-primary" disabled="">开始浏览器授权<\/button>/);
  });

  it('disables device-flow-less providers and explains the fallback', () => {
    const html = render({
      tab: 'upload',
      auth: providersAuth([provider({ id: 'gitlab', label: 'GitLab', deviceFlow: false, builtinClientId: false })]),
      onOauthStart: async () => ({ flowId: 'f', userCode: 'u', verificationUri: 'https://example.com', expiresIn: 60, interval: 5 }),
    });
    expect(html).toContain('该厂商暂不支持设备码流程');
    expect(html).toContain('disabled=""');
  });

  it('cleans up polling timers and only opens the browser from a user gesture in source', () => {
    const source = read('src/renderer/git-sidebar.tsx');
    expect(source).toContain('clearTimeout');
    expect(source).toContain('clearInterval');
    expect(source).toContain('OAUTH_POLL_LIMIT');
    expect(source).toContain('oauthExpiresAt');
    // 打开浏览器必须发生在 onClick 回调里（不得在 effect / 渲染期自动调用）。
    expect(source).toMatch(/onClick=\{[^}]*onOpenExternal\(/);
    expect(source).not.toMatch(/useEffect\([^)]*onOpenExternal/);
  });
});

describe('working-tree diff entry (FR-N-024)', () => {
  const diffResult = (overrides: Partial<GitDiffResult> = {}): GitDiffResult => ({
    workspaceRoot: '/workspace', path: 'src/a.ts', mode: 'worktree',
    hunks: [], added: 12, removed: 3, truncated: false, binary: false, ...overrides,
  });

  it('picks the diff mode by staging group', () => {
    expect(diffModeForFile(file({ staged: true }))).toBe('staged');
    expect(diffModeForFile(file({ staged: false }))).toBe('worktree');
    expect(diffModeForFile(file({ staged: false, status: 'untracked' }))).toBe('worktree');
  });

  it('gives three distinct honest explanations', () => {
    const binary = gitDiffEmptyText(diffResult({ binary: true }));
    const truncated = gitDiffEmptyText(diffResult({ truncated: true }));
    const empty = gitDiffEmptyText(diffResult());
    expect(new Set([binary, truncated, empty]).size).toBe(3);
    expect(binary).toContain('二进制');
    expect(truncated).toContain('只显示前一部分');
    expect(empty).toContain('没有文本差异');
    // 二进制说明不得出现行数（那是 0 行，不是"不可统计"）。
    expect(binary).not.toContain('+');
    expect(binary).not.toMatch(/\d/);
    // 有内容可显示时返回空串。
    expect(gitDiffEmptyText(diffResult({ hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: 'ctx', text: 'x' }] }] }))).toBe('');
  });

  it('names the scope in both modes', () => {
    const staged = gitDiffScopeText('staged');
    const worktree = gitDiffScopeText('worktree');
    expect(staged).not.toBe(worktree);
    expect(staged).toContain('工作区口径');
    expect(worktree).toContain('工作区口径');
  });

  it('makes file rows clickable only when onLoadDiff is provided', () => {
    const clickable = render({ onLoadDiff: async () => {} });
    expect(clickable).toContain('aria-expanded="false"');
    expect(clickable).toContain('查看 src/a.ts 的只读 diff');
    expect(clickable).toContain('git-file-open');
    const plain = render();
    expect(plain).not.toContain('aria-expanded');
    expect(plain).not.toContain('git-file-open');
    expect(plain).not.toContain('的只读 diff');
  });

  it('never renders hunks for a binary file', () => {
    const html = renderToStaticMarkup(createElement(GitDiffPanel, { diff: diffResult({ binary: true, added: 0, removed: 0 }), mode: 'worktree' }));
    expect(html).not.toContain('<pre class="git-diff-hunk">');
    expect(html).toContain('二进制文件，无法显示文本 diff');
    expect(html).toContain('工作区口径');
  });

  it('explains an empty diff instead of leaving a blank panel', () => {
    const html = renderToStaticMarkup(createElement(GitDiffPanel, { diff: diffResult(), mode: 'staged' }));
    expect(html).toContain('该文件在当前口径下没有文本差异');
    expect(html).not.toContain('<pre class="git-diff-hunk">');
    expect(html).toContain('工作区口径');
  });

  it('keeps +/- prefixes and per-kind classes for the diff lines', () => {
    const html = renderToStaticMarkup(createElement(GitDiffPanel, {
      diff: diffResult({ hunks: [{ oldStart: 3, newStart: 3, lines: [{ kind: 'ctx', text: 'keep' }, { kind: 'del', text: 'old' }, { kind: 'add', text: 'new' }] }] }),
      mode: 'worktree',
    }));
    expect(html).toContain('@@ -3 +3 @@');
    expect(html).toContain('git-diff-line-add');
    expect(html).toContain('git-diff-line-del');
    expect(html).toContain('git-diff-line-ctx');
    expect(html).toContain('+new');
    expect(html).toContain('-old');
  });

  it('source contract: the diff area states the working-tree scope', () => {
    const source = read('src/renderer/git-sidebar.tsx');
    expect(source).toContain('工作区口径');
    expect(source).toContain('gitDiffScopeText');
  });
});
