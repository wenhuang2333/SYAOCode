/**
 * Git 侧栏（`27` §11.3 / §10.8）的界面契约测试。
 *
 * 风格与 `dashboard-pages.test.ts` 一致：**不引入浏览器/Playwright**。
 * 纯函数直接断言；组件用 `renderToStaticMarkup` 做静态标记断言（不是 DOM 测试）。
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  GitAuthInfo, GitAuthStatusResult, GitBranchesResult, GitCommitNode, GitFileEntry, GitPreflightResult, GitRemoteInfo, GitRemotesResult, GitStatusResult,
} from '@syaocode/dhp';
import {
  GIT_TABS, GitSidebar, INITIAL_SIDEBAR_STATE, aheadBehindText, authMethodLabel, authStatusLabel, authStatusTone,
  branchLabel, gitFileLabel, gitFileStatText, gitStatusBadge, gitStatusSummary, gitTabState, groupByStaging,
  layoutGitGraph, onlineStateLabel, onlineStateTone, preflightReady, remoteUrlLabel, summarizeGitFiles,
  uploadBlockers, uploadConfirmPayload, uploadFailurePath, type SidebarSlotState,
} from '../src/renderer/git-sidebar.tsx';

const file = (overrides: Partial<GitFileEntry> = {}): GitFileEntry => ({
  path: 'src/a.ts', status: 'modified', staged: false, oldPath: null, added: 12, removed: 3, stat: 'exact', binary: false, ...overrides,
});

const status = (overrides: Partial<GitStatusResult> = {}): GitStatusResult => ({
  workspaceRoot: '/workspace', branch: 'main', detached: false, head: 'abc1234', clean: false,
  ahead: 2, behind: 0, files: [], truncated: false, revision: 7, fetchedAt: 1_760_000_000_000, ...overrides,
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
  onCommit: () => { throw new Error('Rendering must not commit'); },
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
