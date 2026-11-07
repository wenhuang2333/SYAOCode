/**
 * Git 只读服务的测试（`27` §13 TC-N-011…015 的等价断言）。
 *
 * 全部用**真实 git** + 临时目录建仓库，不 mock：
 * 只读服务的价值全在"解析真实输出"，mock 等于不测。
 * 没有 git 可执行文件时整组跳过（`it.skipIf`）。
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitError } from '../src/git-run.ts';
import { GitService } from '../src/git-service.ts';

const gitProbe = spawnSync('git', ['--version'], { encoding: 'utf8' });
const hasGit = gitProbe.status === 0;

const dirs: string[] = [];
const service = new GitService();

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${result.stderr}`);
  return result.stdout;
}

async function tempDir(prefix: string): Promise<string> {
  // 用 realpath 消掉 macOS 上 /var → /private/var 的软链差异。
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

async function repo(): Promise<string> {
  const dir = await tempDir('git-service-');
  git(dir, ['init', '-q']);
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(dir, ['config', 'user.email', 'tester@example.com']);
  git(dir, ['config', 'user.name', 'Tester']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

async function commit(root: string, message: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  git(root, ['add', '--all']);
  git(root, ['commit', '-q', '-m', message]);
}

async function errorOf(promise: Promise<unknown>): Promise<GitError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GitError);
    return error as GitError;
  }
  throw new Error('期望抛出 GitError，但调用成功了');
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe.skipIf(!hasGit)('GitService 只读能力', () => {
  it('非仓库目录 → git_not_repo（TC-N-011）', async () => {
    const dir = await tempDir('not-a-repo-');
    expect((await errorOf(service.status(dir))).kind).toBe('git_not_repo');
    expect((await errorOf(service.graph(dir))).kind).toBe('git_not_repo');
    expect((await errorOf(service.branches(dir))).kind).toBe('git_not_repo');
    expect((await errorOf(service.remotes(dir))).kind).toBe('git_not_repo');
  });

  it('干净仓库：clean=true、无文件、无上游时 ahead/behind 为 null', async () => {
    const root = await repo();
    await commit(root, 'init', { 'a.txt': 'l1\nl2\nl3\n' });
    const status = await service.status(root);
    expect(status.clean).toBe(true);
    expect(status.files).toEqual([]);
    expect(status.branch).toBe('main');
    expect(status.detached).toBe(false);
    expect(status.head).toMatch(/^[0-9a-f]{7,40}$/);
    expect(status.ahead).toBeNull();
    expect(status.behind).toBeNull();
    expect(status.truncated).toBe(false);
    expect(status.revision).toBe(1);
  });

  it('逐文件状态与行数：未暂存 / 已暂存 / 未跟踪各一条', async () => {
    const root = await repo();
    await commit(root, 'init', { 'a.txt': 'l1\nl2\nl3\n' });
    await fs.writeFile(path.join(root, 'a.txt'), 'l1\nl2x\nl3\n');
    await fs.writeFile(path.join(root, 'b.txt'), 'x\ny\n');
    git(root, ['add', '--', 'b.txt']);
    await fs.writeFile(path.join(root, 'c.txt'), '1\n2\n3\n');

    const status = await service.status(root);
    expect(status.clean).toBe(false);
    const byPath = new Map(status.files.map((file) => [file.path, file]));
    expect(byPath.get('a.txt')).toMatchObject({
      status: 'modified', staged: false, added: 1, removed: 1, stat: 'exact', binary: false, oldPath: null,
    });
    expect(byPath.get('b.txt')).toMatchObject({
      status: 'added', staged: true, added: 2, removed: 0, stat: 'exact', binary: false,
    });
    expect(byPath.get('c.txt')).toMatchObject({
      status: 'untracked', staged: false, added: 3, removed: 0, stat: 'exact', binary: false,
    });
  });

  it('同一文件既有暂存改动又有工作区改动：行数取 HEAD→工作区净变化', async () => {
    const root = await repo();
    await commit(root, 'init', { 'a.txt': 'l1\nl2\n' });
    await fs.writeFile(path.join(root, 'a.txt'), 'l1\nl2a\n');
    git(root, ['add', '--', 'a.txt']);
    await fs.writeFile(path.join(root, 'a.txt'), 'l1\nl2b\nl3\n');
    const status = await service.status(root);
    const entry = status.files.find((file) => file.path === 'a.txt');
    // HEAD 是 2 行、工作区是 3 行：净变化 +2 -1（已暂存口径只有 +1 -1，
    // 若按已暂存报就会让人以为"未暂存的那部分不存在"）。
    expect(entry).toMatchObject({ status: 'modified', staged: true, added: 2, removed: 1, stat: 'exact' });
  });

  it('工作区根在仓库子目录时：路径是工作区相对，diff 也能定位', async () => {
    const root = await repo();
    await commit(root, 'init', { 'sub/a.txt': 'l1\nl2\n', 'other.txt': 'x\n' });
    const workspace = path.join(root, 'sub');
    await fs.writeFile(path.join(workspace, 'a.txt'), 'l1\nl2x\n');

    const status = await service.status(workspace);
    expect(status.files.map((file) => file.path)).toEqual(['a.txt']);
    expect(status.files[0]).toMatchObject({ status: 'modified', added: 1, removed: 1 });

    const diff = await service.diff(workspace, 'a.txt');
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.hunks[0]?.lines.map((line) => line.text)).toEqual(['l1', 'l2', 'l2x']);
  });

  it('二进制文件：stat=unavailable、binary=true、行数为 null', async () => {    const root = await repo();
    await commit(root, 'init', { 'a.txt': 'l1\n' });
    await fs.writeFile(path.join(root, 'b.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    git(root, ['add', '--', 'b.bin']);
    const status = await service.status(root);
    expect(status.files.find((file) => file.path === 'b.bin')).toMatchObject({
      status: 'added', staged: true, added: null, removed: null, stat: 'unavailable', binary: true,
    });
  });

  it('重命名：status=renamed 且 oldPath 正确', async () => {
    const root = await repo();
    await commit(root, 'init', { 'a.txt': 'l1\nl2\n' });
    git(root, ['mv', 'a.txt', 'renamed.txt']);
    const status = await service.status(root);
    const entry = status.files.find((file) => file.path === 'renamed.txt');
    expect(entry).toMatchObject({ status: 'renamed', staged: true, oldPath: 'a.txt' });
  });

  it('detached HEAD：branch=null、detached=true', async () => {
    const root = await repo();
    await commit(root, 'init', { 'a.txt': 'l1\n' });
    git(root, ['checkout', '-q', '--detach', 'HEAD']);
    const status = await service.status(root);
    expect(status.branch).toBeNull();
    expect(status.detached).toBe(true);
    const branches = await service.branches(root);
    expect(branches.current).toBeNull();
    expect(branches.detached).toBe(true);
    expect(branches.local.find((branch) => branch.name === 'main')?.current).toBe(false);
  });

  it('空仓库：head=null、提交图为空列表', async () => {
    const root = await repo();
    await fs.writeFile(path.join(root, 'a.txt'), 'x\n');
    const status = await service.status(root);
    expect(status.head).toBeNull();
    expect(status.branch).toBe('main');
    expect(status.detached).toBe(false);
    expect(status.files.map((file) => file.path)).toEqual(['a.txt']);
    const graph = await service.graph(root, { maxCount: 10 });
    expect(graph.commits).toEqual([]);
    expect(graph.hasMore).toBe(false);
  });

  it('提交图分页：hasMore 与 skip 正确、无重复无缺漏（TC-N-013）', async () => {
    const root = await repo();
    for (let index = 1; index <= 5; index += 1) await commit(root, `c${index}`, { [`f${index}.txt`]: `${index}\n` });

    const first = await service.graph(root, { maxCount: 2 });
    expect(first.commits).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.commits.map((node) => node.subject)).toEqual(['c5', 'c4']);

    const second = await service.graph(root, { maxCount: 2, skip: 2 });
    expect(second.commits.map((node) => node.subject)).toEqual(['c3', 'c2']);

    const all = await service.graph(root, { maxCount: 10 });
    expect(all.commits).toHaveLength(5);
    expect(all.hasMore).toBe(false);
    expect(all.commits.map((node) => node.subject)).toEqual(['c5', 'c4', 'c3', 'c2', 'c1']);

    // 分页拼接后既不重复也不缺漏。
    const paged = [...first.commits, ...second.commits].map((node) => node.sha);
    expect(new Set(paged).size).toBe(4);
    expect(all.commits.slice(0, 4).map((node) => node.sha)).toEqual(paged);
  });

  it('提交图包含其它分支的独占提交（全 ref 拓扑序）', async () => {
    const root = await repo();
    await commit(root, 'c1', { 'a.txt': '1\n' });
    await commit(root, 'c2', { 'b.txt': '2\n' });
    git(root, ['checkout', '-q', '-b', 'feature']);
    await commit(root, 'c3-feature', { 'c.txt': '3\n' });
    git(root, ['checkout', '-q', 'main']);

    // 只看 HEAD 历史时 c3-feature 不会出现；`--all` 后必须出现且带 feature 标签。
    const graph = await service.graph(root, { maxCount: 10 });
    expect(graph.commits.map((node) => node.subject)).toEqual(['c3-feature', 'c2', 'c1']);
    expect(graph.commits[0]?.refs).toContain('feature');
    expect(graph.hasMore).toBe(false);
  });

  it('窗口外父提交 → truncated=true（TC-N-014）', async () => {
    const root = await repo();
    for (let index = 1; index <= 3; index += 1) await commit(root, `c${index}`, { [`f${index}.txt`]: `${index}\n` });
    const page = await service.graph(root, { maxCount: 2 });
    expect(page.truncated).toBe(true);
    const all = await service.graph(root, { maxCount: 10 });
    expect(all.truncated).toBe(false);
    expect(all.commits[all.commits.length - 1]?.parents).toEqual([]);
  });

  it('提交图 refs：分支短名正确', async () => {
    const root = await repo();
    await commit(root, 'c1', { 'a.txt': '1\n' });
    await commit(root, 'c2', { 'b.txt': '2\n' });
    git(root, ['branch', 'feature']);
    const graph = await service.graph(root, { maxCount: 10 });
    const head = graph.commits[0];
    expect(head?.subject).toBe('c2');
    expect(head?.refs).toContain('feature');
    expect(head?.refs).toContain('main');
    expect(head?.at).toBeGreaterThan(0);
    expect(head?.parents).toHaveLength(1);
  });

  it('diff：worktree 模式的 hunks 与增删行数', async () => {
    const root = await repo();
    await commit(root, 'init', { 'a.txt': 'l1\nl2\nl3\n' });
    await fs.writeFile(path.join(root, 'a.txt'), 'l1\nl2x\nl3\nl4\n');
    const diff = await service.diff(root, 'a.txt');
    expect(diff.mode).toBe('worktree');
    expect(diff.path).toBe('a.txt');
    expect(diff.binary).toBe(false);
    expect(diff.truncated).toBe(false);
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]).toMatchObject({ oldStart: 1, newStart: 1 });
    expect(diff.hunks[0]?.lines.map((line) => line.kind)).toEqual(['ctx', 'del', 'add', 'ctx', 'add']);
    expect(diff.hunks[0]?.lines.map((line) => line.text)).toEqual(['l1', 'l2', 'l2x', 'l3', 'l4']);
  });

  it('diff：staged 与 commit 模式', async () => {
    const root = await repo();
    await commit(root, 'init', { 'a.txt': 'l1\n' });
    await fs.writeFile(path.join(root, 'a.txt'), 'l1\nl2\n');
    git(root, ['add', '--', 'a.txt']);
    const staged = await service.diff(root, 'a.txt', { mode: 'staged' });
    expect(staged.mode).toBe('staged');
    expect(staged.added).toBe(1);
    expect(staged.removed).toBe(0);
    const byCommit = await service.diff(root, 'a.txt', { mode: 'commit', commit: 'HEAD' });
    expect(byCommit.mode).toBe('commit');
    expect(byCommit.added).toBe(1);
    expect((await errorOf(service.diff(root, 'a.txt', { mode: 'commit' }))).kind).toBe('git_command_failed');
  });

  it('diff：二进制文件 → binary=true 且 hunks 为空', async () => {
    const root = await repo();
    await commit(root, 'init', { 'a.txt': 'l1\n' });
    await fs.writeFile(path.join(root, 'b.bin'), Buffer.from([0, 1, 2, 3]));
    git(root, ['add', '--', 'b.bin']);
    git(root, ['commit', '-q', '-m', 'binary']);
    await fs.writeFile(path.join(root, 'b.bin'), Buffer.from([9, 9, 0, 9]));
    const diff = await service.diff(root, 'b.bin');
    expect(diff.binary).toBe(true);
    expect(diff.hunks).toEqual([]);
  });

  it('diff：路径逃逸被拒绝（TC-N-015）', async () => {
    const root = await repo();
    await commit(root, 'init', { 'a.txt': 'l1\n' });
    expect((await errorOf(service.diff(root, '../etc/passwd'))).kind).toBe('git_unsafe');
    expect((await errorOf(service.diff(root, '/etc/passwd'))).kind).toBe('git_unsafe');
    expect((await errorOf(service.diff(root, 'a/../../b'))).kind).toBe('git_unsafe');
  });

  it('branches：有上游时 ahead/behind 正确，无上游时为 null', async () => {
    const root = await repo();
    const remote = await tempDir('git-remote-');
    git(remote, ['init', '-q', '--bare']);
    await commit(root, 'init', { 'a.txt': 'l1\n' });
    git(root, ['remote', 'add', 'origin', remote]);
    git(root, ['push', '-q', '-u', 'origin', 'main']);

    const branches = await service.branches(root);
    expect(branches.current).toBe('main');
    expect(branches.detached).toBe(false);
    expect(branches.local.find((branch) => branch.name === 'main')).toMatchObject({
      kind: 'local', current: true, upstream: 'origin/main', ahead: 0, behind: 0,
    });
    expect(branches.remote.map((branch) => branch.name)).toEqual(['origin/main']);

    await commit(root, 'c2', { 'b.txt': '2\n' });
    const after = await service.branches(root);
    expect(after.local.find((branch) => branch.name === 'main')).toMatchObject({ ahead: 1, behind: 0 });

    // 没有上游的分支：ahead/behind 必须是 null（不是 0）。
    git(root, ['branch', 'no-upstream']);
    const mixed = await service.branches(root);
    expect(mixed.local.find((branch) => branch.name === 'no-upstream')).toMatchObject({
      upstream: null, ahead: null, behind: null,
    });
  });

  it('remotes：URL 剥离内嵌凭据，auth 为 none 占位', async () => {
    const root = await repo();
    git(root, ['remote', 'add', 'origin', 'https://user:token@example.com/x/y.git']);
    const remotes = await service.remotes(root);
    expect(remotes.remotes).toHaveLength(1);
    expect(remotes.remotes[0]?.name).toBe('origin');
    expect(remotes.remotes[0]?.url).toBe('https://example.com/x/y.git');
    expect(remotes.remotes[0]?.auth).toMatchObject({
      method: 'none', configured: false, ready: false, account: null, scope: [],
    });
  });

  it('revisionOf / bumpRevision：初始 1，自增返回新值', () => {
    const root = path.join(os.tmpdir(), 'git-service-revision');
    expect(service.revisionOf(root)).toBe(1);
    expect(service.bumpRevision(root)).toBe(2);
    expect(service.revisionOf(root)).toBe(2);
    expect(service.bumpRevision(root)).toBe(3);
    expect(service.revisionOf(root)).toBe(3);
  });

  it('状态条目超过 2000 条时截断', async () => {
    const root = await repo();
    await commit(root, 'init', { 'a.txt': 'l1\n' });
    for (let index = 0; index < 2001; index += 1) {
      await fs.writeFile(path.join(root, `f${index}.txt`), 'x\n');
    }
    const status = await service.status(root);
    expect(status.files).toHaveLength(2000);
    expect(status.truncated).toBe(true);
  }, 60_000);
});

describe('提交前提示所需的数据（27 §10.5.3）', () => {
  it.skipIf(!hasGit)('sizeBytes 只反映**已暂存内容**：暂存有值、未暂存与未跟踪为 null', async () => {
    const root = await repo();
    // 1000 字节的已暂存内容。
    await fs.writeFile(path.join(root, 'staged.txt'), 'x'.repeat(1000));
    git(root, ['add', '--', 'staged.txt']);
    // 未暂存的新内容（不进索引）。
    await fs.writeFile(path.join(root, 'unstaged.txt'), 'y'.repeat(20));
    // 未跟踪文件。
    await fs.writeFile(path.join(root, 'untracked.txt'), 'z'.repeat(30));

    const status = await service.status(root);
    const byPath = new Map(status.files.map((file) => [file.path, file]));

    const staged = byPath.get('staged.txt');
    expect(staged?.staged).toBe(true);
    expect(staged?.sizeBytes).toBe(1000);

    const unstaged = byPath.get('unstaged.txt');
    expect(unstaged?.staged).toBe(false);
    // 未暂存条目没有"将要提交的 blob"，不能用工作区大小冒充。
    expect(unstaged?.sizeBytes).toBeNull();

    const untracked = byPath.get('untracked.txt');
    expect(untracked?.status).toBe('untracked');
    expect(untracked?.sizeBytes).toBeNull();
  });

  it.skipIf(!hasGit)('sizeBytes 取的是 blob 大小：工作区内容与暂存内容不同时也不撒谎', async () => {
    const root = await repo();
    await fs.writeFile(path.join(root, 'a.txt'), 'first\n');
    git(root, ['add', '--', 'a.txt']);
    // 暂存后又改了工作区：将要提交的是索引里的 6 字节，不是工作区的新内容。
    await fs.writeFile(path.join(root, 'a.txt'), 'a much longer working tree content\n');

    const status = await service.status(root);
    const entry = status.files.find((file) => file.path === 'a.txt');
    expect(entry?.staged).toBe(true);
    expect(entry?.sizeBytes).toBe('first\n'.length);
  });

  it.skipIf(!hasGit)('hooks：只列存在的提交相关钩子，可执行性如实标注', async () => {
    const root = await repo();
    const hooksDir = path.join(root, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    // 可执行的 pre-commit 与不可执行的 commit-msg；pre-push 不存在。
    await fs.writeFile(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await fs.chmod(path.join(hooksDir, 'pre-commit'), 0o755);
    await fs.writeFile(path.join(hooksDir, 'commit-msg'), 'not executable\n', { mode: 0o644 });
    await fs.chmod(path.join(hooksDir, 'commit-msg'), 0o644);

    const status = await service.status(root);
    const byName = new Map(status.hooks.map((hook) => [hook.name, hook]));
    expect(byName.get('pre-commit')?.executable).toBe(true);
    expect(byName.get('commit-msg')?.executable).toBe(false);
    expect(byName.has('pre-push')).toBe(false);
    // 不存在的钩子不得凭空出现。
    expect(status.hooks.every((hook) => ['pre-commit', 'commit-msg', 'pre-push'].includes(hook.name))).toBe(true);
  });

  it.skipIf(!hasGit)('hooks：没有钩子时是空数组（不是 null，也不猜）', async () => {
    const root = await repo();
    const status = await service.status(root);
    expect(Array.isArray(status.hooks)).toBe(true);
    expect(status.hooks).toEqual([]);
  });
});
