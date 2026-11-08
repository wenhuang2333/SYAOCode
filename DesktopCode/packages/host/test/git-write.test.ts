/**
 * Git 写操作 / 预检 / 上传 的端到端测试（`27` §10.5 / §10.8 / §10.9）。
 *
 * 全部用**真实 git** + 临时目录 + **本地裸仓库**，不联网：
 *  - 裸仓库（`git init --bare`）当远端，验证"提交 + 推送"真的落到了远端；
 *  - 需要认证的路径用本机 `127.0.0.1` 上的 401 服务模拟远端，
 *    验证凭据只经 `GIT_ASKPASS` 注入、且审计记录里没有凭据；
 *  - 本机没有 git 时整组 `skipIf` 跳过。
 *
 * 覆盖：TC-N-016（`--force` 被拒）/ TC-N-029…033 / TC-N-047 / TC-N-048。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { GitFileEntry, GitFileStatus, GitStatusResult } from '@syaocode/dhp';
import { MemoryCredentialProvider, keychainEntryFor } from '../src/credentials.ts';
import { GitUploadError, GitUploadService } from '../src/git-upload.ts';
import {
  GitWriteService,
  type GitAuditRecord,
  type GitAuditSink,
  type GitStatusReader,
} from '../src/git-write.ts';

// ── 环境与清理 ────────────────────────────────────────────────────────

/**
 * 本文件用**私有 TMPDIR**。
 *
 * 原因：有一条断言要检查"凭据临时目录用完即删"（`27` §10.9 红线 3），
 * 而 `os.tmpdir()` 是全进程共享的——其它测试文件在并行 worker 里同时创建
 * `syaocode-git-cred-*` 时，这条断言会随机变红（真实发生过的 flake）。
 * 把本文件的 TMPDIR 指向私有目录后，`readdir(os.tmpdir())` 只会看到本文件
 * 自己的临时目录，断言既严格又稳定。
 */
const privateTmp = mkdtempSync(path.join(tmpdir(), 'syaocode-gw-tmp-'));
process.env['TMPDIR'] = privateTmp;

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await fs.rm(privateTmp, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

interface GitOutput {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** 测试里直接调 git 二进制（被测代码才走 runGit 的安全层）。 */
function git(cwd: string, args: readonly string[]): GitOutput {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** 建一个带初始提交的仓库（分支名固定 `main`）。 */
async function makeRepo(): Promise<string> {
  const dir = await tempDir('syaocode-repo-');
  git(dir, ['init', '-q']);
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'SYAOCode Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(dir, 'README.md'), '# 测试仓库\n');
  git(dir, ['add', '--', 'README.md']);
  git(dir, ['commit', '-q', '-m', '初始化']);
  return dir;
}

/** 建一个本地裸仓库当远端（不联网）。 */
async function makeBare(): Promise<string> {
  const dir = await tempDir('syaocode-bare-');
  git(dir, ['init', '--bare', '-q', '-b', 'main']);
  return dir;
}

function porcelainStatus(index: string, worktree: string): GitFileStatus {
  if (index === '?' || worktree === '?') return 'untracked';
  if (index === 'U' || worktree === 'U') return 'conflicted';
  if (index === 'R' || worktree === 'R') return 'renamed';
  if (index === 'A' || worktree === 'A') return 'added';
  if (index === 'D' || worktree === 'D') return 'deleted';
  return 'modified';
}

function parsePorcelain(output: string): GitFileEntry[] {
  const entries: GitFileEntry[] = [];
  for (const line of output.split('\n')) {
    if (line.length < 4) continue;
    const index = line[0] ?? ' ';
    const worktree = line[1] ?? ' ';
    entries.push({
      path: line.slice(3),
      status: porcelainStatus(index, worktree),
      staged: index !== ' ' && index !== '?',
      oldPath: null,
      added: null,
      removed: null,
      stat: 'unavailable',
      binary: false,
      sizeBytes: null,
    });
  }
  return entries;
}

function hashNumber(value: string): number {
  return createHash('sha256').update(value).digest().readUInt32BE(0);
}

interface TestReader extends GitStatusReader {
  revisionOf(root: string): Promise<number>;
}

/**
 * 测试用的状态读取器：用 HEAD + `git status --porcelain` 派生 revision，
 * 口径与 `git-service.ts` 的 `GitStatusResult` 一致（本任务不 import 它）。
 */
function makeReader(): TestReader {
  const status = async (root: string): Promise<GitStatusResult> => {
    const porcelain = git(root, ['status', '--porcelain']).stdout;
    const branchOut = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
    const headOut = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).stdout.trim();
    const files = parsePorcelain(porcelain);
    return {
      workspaceRoot: root,
      branch: branchOut === '' || branchOut === 'HEAD' ? null : branchOut,
      detached: branchOut === 'HEAD',
      head: headOut === '' ? null : headOut,
      clean: files.length === 0,
      ahead: null,
      behind: null,
      files,
      truncated: false,
      hooks: [],
      revision: hashNumber(`${headOut}\n${porcelain}`),
      fetchedAt: Date.now(),
    };
  };
  return { status, revisionOf: async (root: string) => (await status(root)).revision };
}

interface AuditRecorder {
  readonly sink: GitAuditSink;
  readonly records: GitAuditRecord[];
}

function makeAudit(): AuditRecorder {
  const records: GitAuditRecord[] = [];
  return {
    sink: (record) => {
      records.push(record);
    },
    records,
  };
}

// ── 写操作（`27` §10.5）───────────────────────────────────────────────

describe('Git 写操作', () => {
  it.skipIf(!hasGit)('暂存 → 提交 → 取消暂存都返回 accepted，且工作区状态随之前进', async () => {
    const root = await makeRepo();
    const reader = makeReader();
    const writer = new GitWriteService({ reader });

    await fs.writeFile(path.join(root, 'a.txt'), 'hello\n');
    const staged = await writer.stage(root, ['a.txt'], {
      commandId: 'cmd-stage-0001',
      baseRevision: await reader.revisionOf(root),
    });
    expect(staged.status).toBe('accepted');
    expect(git(root, ['diff', '--cached', '--name-only']).stdout.trim()).toBe('a.txt');

    const committed = await writer.commit(root, '新增 a.txt', {
      commandId: 'cmd-commit-0001',
      baseRevision: await reader.revisionOf(root),
    });
    expect(committed.status).toBe('accepted');
    expect(git(root, ['rev-list', '--count', 'HEAD']).stdout.trim()).toBe('2');

    await fs.writeFile(path.join(root, 'b.txt'), 'b\n');
    await writer.stage(root, ['b.txt'], {
      commandId: 'cmd-stage-0002',
      baseRevision: await reader.revisionOf(root),
    });
    expect(git(root, ['diff', '--cached', '--name-only']).stdout.trim()).toBe('b.txt');
    const unstaged = await writer.unstage(root, ['b.txt'], {
      commandId: 'cmd-unstage-0001',
      baseRevision: await reader.revisionOf(root),
    });
    expect(unstaged.status).toBe('accepted');
    expect(git(root, ['diff', '--cached', '--name-only']).stdout.trim()).toBe('');
  });

  it.skipIf(!hasGit)('baseRevision 与当前 revision 不符 → stale，且副作用不执行', async () => {
    const root = await makeRepo();
    const reader = makeReader();
    const writer = new GitWriteService({ reader });
    await fs.writeFile(path.join(root, 'a.txt'), 'hello\n');
    const current = await reader.revisionOf(root);

    const stale = await writer.stage(root, ['a.txt'], {
      commandId: 'cmd-stale-0001',
      baseRevision: current + 1,
    });
    expect(stale.status).toBe('stale');
    expect(stale.revision).toBe(current);
    expect(git(root, ['diff', '--cached', '--name-only']).stdout.trim()).toBe('');
  });

  it.skipIf(!hasGit)('同一 commandId 重复提交 → duplicate，且不产生第二次提交', async () => {
    const root = await makeRepo();
    const reader = makeReader();
    const writer = new GitWriteService({ reader });
    await fs.writeFile(path.join(root, 'a.txt'), 'hello\n');
    await writer.stage(root, ['a.txt'], {
      commandId: 'cmd-dup-stage',
      baseRevision: await reader.revisionOf(root),
    });

    const envelope = { commandId: 'cmd-dup-commit', baseRevision: await reader.revisionOf(root) };
    const first = await writer.commit(root, '一次提交', envelope);
    expect(first.status).toBe('accepted');
    const before = git(root, ['rev-list', '--count', 'HEAD']).stdout.trim();

    // 重放：注意此时 revision 已经前进，幂等判定必须**先于** CAS 判定。
    const second = await writer.commit(root, '一次提交', envelope);
    expect(second.status).toBe('duplicate');
    expect(git(root, ['rev-list', '--count', 'HEAD']).stdout.trim()).toBe(before);
  });

  it.skipIf(!hasGit)('路径或参数含 --force / 绝对路径 → git_unsafe（TC-N-016）', async () => {
    const root = await makeRepo();
    const reader = makeReader();
    const writer = new GitWriteService({ reader });
    const baseRevision = await reader.revisionOf(root);

    await expect(
      writer.stage(root, ['--force'], { commandId: 'cmd-force-0001', baseRevision }),
    ).rejects.toMatchObject({ kind: 'git_unsafe' });
    await expect(
      writer.stage(root, ['/etc/passwd'], { commandId: 'cmd-abs-0001', baseRevision }),
    ).rejects.toMatchObject({ kind: 'git_unsafe' });
    await expect(
      writer.stage(root, ['../escape.txt'], { commandId: 'cmd-dotdot-0001', baseRevision }),
    ).rejects.toMatchObject({ kind: 'git_unsafe' });
    // 分支名不能以 "-" 开头，否则 `git branch -d` 会被当成删除分支。
    await expect(
      writer.createBranch(root, '-d', { commandId: 'cmd-branch-0001', baseRevision }),
    ).rejects.toMatchObject({ kind: 'git_unsafe' });
  });

  it.skipIf(!hasGit)('空提交信息 → rejected 并给出原因', async () => {
    const root = await makeRepo();
    const reader = makeReader();
    const writer = new GitWriteService({ reader });
    const result = await writer.commit(root, '   \n  ', {
      commandId: 'cmd-empty-0001',
      baseRevision: await reader.revisionOf(root),
    });
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/提交信息/);
  });

  it.skipIf(!hasGit)('有未提交改动时切换分支 → rejected 并说明，分支保持不变（TC-N-047）', async () => {
    const root = await makeRepo();
    const reader = makeReader();
    const writer = new GitWriteService({ reader });

    const created = await writer.createBranch(
      root,
      'feature/x',
      { commandId: 'cmd-branch-0002', baseRevision: await reader.revisionOf(root) },
      { checkout: false },
    );
    expect(created.status).toBe('accepted');

    await fs.writeFile(path.join(root, 'dirty.txt'), 'dirty\n');
    const switched = await writer.switchBranch(root, 'feature/x', {
      commandId: 'cmd-switch-0001',
      baseRevision: await reader.revisionOf(root),
    });
    expect(switched.status).toBe('rejected');
    expect(switched.reason).toMatch(/未提交改动/);
    expect(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()).toBe('main');
  });

  it.skipIf(!hasGit)('多行提交信息也能提交（走临时 --file 文件，不被参数安全层的换行检查拒绝）', async () => {
    const root = await makeRepo();
    const reader = makeReader();
    const writer = new GitWriteService({ reader });
    await fs.writeFile(path.join(root, 'm.txt'), 'm\n');
    await writer.stage(root, ['m.txt'], {
      commandId: 'cmd-multiline-stage',
      baseRevision: await reader.revisionOf(root),
    });
    const committed = await writer.commit(root, '第一行\n\n第三行说明', {
      commandId: 'cmd-multiline-commit',
      baseRevision: await reader.revisionOf(root),
    });
    expect(committed.status).toBe('accepted');
    expect(git(root, ['log', '-1', '--pretty=%B']).stdout).toContain('第三行说明');
  });

  it.skipIf(!hasGit)('提交钩子失败 → 不产生提交、HEAD 不变、审计 result=failed（TC-N-048）', async () => {
    const root = await makeRepo();
    const reader = makeReader();
    const audit = makeAudit();
    const writer = new GitWriteService({ reader, audit: audit.sink });

    const hook = path.join(root, '.git', 'hooks', 'pre-commit');
    await fs.writeFile(hook, '#!/bin/sh\necho "pre-commit 钩子拒绝" >&2\nexit 1\n', { mode: 0o755 });
    await fs.chmod(hook, 0o755);

    await fs.writeFile(path.join(root, 'c.txt'), 'c\n');
    await writer.stage(root, ['c.txt'], {
      commandId: 'cmd-hook-stage',
      baseRevision: await reader.revisionOf(root),
    });
    const headBefore = git(root, ['rev-parse', 'HEAD']).stdout.trim();
    const countBefore = git(root, ['rev-list', '--count', 'HEAD']).stdout.trim();

    await expect(
      writer.commit(root, '会被钩子拒绝', {
        commandId: 'cmd-hook-commit',
        baseRevision: await reader.revisionOf(root),
      }),
    ).rejects.toMatchObject({ kind: 'git_command_failed' });

    expect(git(root, ['rev-parse', 'HEAD']).stdout.trim()).toBe(headBefore);
    expect(git(root, ['rev-list', '--count', 'HEAD']).stdout.trim()).toBe(countBefore);
    expect(audit.records.some((r) => r.result === 'failed')).toBe(true);
    expect(audit.records.filter((r) => r.action === 'git.commit').at(-1)?.result).toBe('failed');
  });

  it.skipIf(!hasGit)('noVerify 提交在审计 detail 里标注"已跳过钩子"', async () => {
    const root = await makeRepo();
    const reader = makeReader();
    const audit = makeAudit();
    const writer = new GitWriteService({ reader, audit: audit.sink });
    await fs.writeFile(path.join(root, 'n.txt'), 'n\n');
    await writer.stage(root, ['n.txt'], {
      commandId: 'cmd-noverify-stage',
      baseRevision: await reader.revisionOf(root),
    });
    const committed = await writer.commit(
      root,
      '跳过钩子提交',
      { commandId: 'cmd-noverify-commit', baseRevision: await reader.revisionOf(root) },
      { noVerify: true },
    );
    expect(committed.status).toBe('accepted');
    expect(audit.records.some((r) => r.detail.includes('已跳过钩子'))).toBe(true);
  });
});

// ── 预检与上传（`27` §10.8 / §10.9）──────────────────────────────────

describe('Git 预检与上传', () => {
  it.skipIf(!hasGit)('干净仓库 + 本地裸远端 → clean=true、blockers 为空（不联网）', async () => {
    const root = await makeRepo();
    const bare = await makeBare();
    git(root, ['remote', 'add', 'origin', bare]);
    const reader = makeReader();
    const writer = new GitWriteService({ reader });
    const upload = new GitUploadService({ writer });

    const preflight = await upload.preflight(root, 'origin');
    expect(preflight.clean).toBe(true);
    expect(preflight.blockers).toEqual([]);
    expect(preflight.branch).toBe('main');
    expect(preflight.remote).toBe('origin');
    expect(preflight.remoteUrl).toBe(bare);
    expect(preflight.remoteWritable).toBe(true);
    expect(preflight.online).toBe(true);
    expect(preflight.requiresCommit).toBe(false);
    expect(preflight.revision).toBe(await reader.revisionOf(root));
  });

  it.skipIf(!hasGit)('上传成功后裸仓库里能看到提交，审计记录含远端/分支/sha/文件数（TC-N-033）', async () => {
    const root = await makeRepo();
    const bare = await makeBare();
    git(root, ['remote', 'add', 'origin', bare]);
    const reader = makeReader();
    const audit = makeAudit();
    const writer = new GitWriteService({ reader });
    const upload = new GitUploadService({ writer, audit: audit.sink });

    await fs.writeFile(path.join(root, 'feature.txt'), 'feature\n');
    const preflight = await upload.preflight(root, 'origin');
    expect(preflight.clean).toBe(false);
    expect(preflight.requiresCommit).toBe(true);
    expect(preflight.files).toBe(1);

    const result = await upload.upload(root, 'origin', 'main', '上传新功能', {
      commandId: 'cmd-upload-0001',
      baseRevision: await reader.revisionOf(root),
    });
    expect(result.pushed).toBe(true);
    expect(result.remote).toBe('origin');
    expect(result.branch).toBe('main');
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.files).toBe(1);

    // 裸仓库里确实有这次提交。
    const bareLog = git(bare, ['log', '--oneline', 'main']);
    expect(bareLog.stdout).toContain(result.sha.slice(0, 7));
    expect(git(root, ['rev-parse', 'HEAD']).stdout.trim()).toBe(result.sha);
    expect(git(root, ['status', '--porcelain']).stdout.trim()).toBe('');

    const uploadRecord = audit.records.filter((r) => r.action === 'git.upload').at(-1);
    expect(uploadRecord).toBeDefined();
    expect(uploadRecord?.result).toBe('success');
    expect(uploadRecord?.detail).toContain('origin');
    expect(uploadRecord?.detail).toContain('main');
    expect(uploadRecord?.detail).toContain(result.sha.slice(0, 12));
    expect(uploadRecord?.detail).toContain('文件 1 个');
  });

  it.skipIf(!hasGit)('同一 commandId 重复上传 → 幂等命中，不重复推送', async () => {
    const root = await makeRepo();
    const bare = await makeBare();
    git(root, ['remote', 'add', 'origin', bare]);
    const reader = makeReader();
    const audit = makeAudit();
    const writer = new GitWriteService({ reader });
    const upload = new GitUploadService({ writer, audit: audit.sink });

    await fs.writeFile(path.join(root, 'once.txt'), 'once\n');
    const envelope = { commandId: 'cmd-upload-dup', baseRevision: await reader.revisionOf(root) };
    const first = await upload.upload(root, 'origin', 'main', '只应推一次', envelope);
    const second = await upload.upload(root, 'origin', 'main', '只应推一次', envelope);
    expect(second).toEqual(first);
    expect(git(bare, ['rev-list', '--count', 'main']).stdout.trim()).toBe('2');
    expect(audit.records.some((r) => r.detail.includes('幂等命中'))).toBe(true);
  });

  it.skipIf(!hasGit)('本地与远端分叉 → blockers 含 git_remote_conflict(-32039)，且不提供 force（TC-N-032）', async () => {
    const root = await makeRepo();
    const bare = await makeBare();
    git(root, ['remote', 'add', 'origin', bare]);
    git(root, ['push', '-q', '-u', 'origin', 'main']);

    // 另一个人从裸仓库克隆并推了一个新提交。
    const clone = await tempDir('syaocode-clone-');
    git(clone, ['clone', '-q', bare, '.']);
    git(clone, ['config', 'user.email', 'other@example.com']);
    git(clone, ['config', 'user.name', 'Other']);
    await fs.writeFile(path.join(clone, 'other.txt'), 'other\n');
    git(clone, ['add', '--', 'other.txt']);
    git(clone, ['commit', '-q', '-m', '别人的提交']);
    git(clone, ['push', '-q', 'origin', 'main']);

    // 本地也提交一次，并把远端跟踪引用拉新 → 真分叉。
    await fs.writeFile(path.join(root, 'mine.txt'), 'mine\n');
    git(root, ['add', '--', 'mine.txt']);
    git(root, ['commit', '-q', '-m', '我的提交']);
    git(root, ['fetch', '-q', 'origin']);

    const reader = makeReader();
    const writer = new GitWriteService({ reader });
    const upload = new GitUploadService({ writer });

    const preflight = await upload.preflight(root, 'origin');
    expect(preflight.diverged).toBe(true);
    expect(preflight.ahead).toBe(1);
    expect(preflight.behind).toBe(1);
    const conflict = preflight.blockers.find((b) => b.kind === 'git_remote_conflict');
    expect(conflict).toBeDefined();
    expect(conflict?.code).toBe(-32039);
    expect(conflict?.reason).toMatch(/拉取|新分支/);
    expect(preflight.blockers.every((b) => !/force/i.test(b.reason) || /不提供强制推送/.test(b.reason))).toBe(
      true,
    );

    // 上传必须被拒绝，且远端不被改动。
    const beforeRemote = git(bare, ['rev-parse', 'main']).stdout.trim();
    await expect(
      upload.upload(root, 'origin', 'main', '不应上传', {
        commandId: 'cmd-upload-conflict',
        baseRevision: await reader.revisionOf(root),
      }),
    ).rejects.toMatchObject({ dhpKind: 'git_remote_conflict' });
    expect(git(bare, ['rev-parse', 'main']).stdout.trim()).toBe(beforeRemote);
  });

  it.skipIf(!hasGit)('本地跟踪引用过期（远端已前进）→ 保守判定需先拉取', async () => {
    const root = await makeRepo();
    const bare = await makeBare();
    git(root, ['remote', 'add', 'origin', bare]);
    git(root, ['push', '-q', '-u', 'origin', 'main']);

    const clone = await tempDir('syaocode-clone2-');
    git(clone, ['clone', '-q', bare, '.']);
    git(clone, ['config', 'user.email', 'other@example.com']);
    git(clone, ['config', 'user.name', 'Other']);
    await fs.writeFile(path.join(clone, 'advance.txt'), 'advance\n');
    git(clone, ['add', '--', 'advance.txt']);
    git(clone, ['commit', '-q', '-m', '远端前进']);
    git(clone, ['push', '-q', 'origin', 'main']);

    // 本地不 fetch：跟踪引用仍是旧 sha。
    const reader = makeReader();
    const writer = new GitWriteService({ reader });
    const upload = new GitUploadService({ writer });
    const preflight = await upload.preflight(root, 'origin');
    expect(preflight.blockers.some((b) => b.kind === 'git_remote_conflict')).toBe(true);
    expect(preflight.blockers.find((b) => b.kind === 'git_remote_conflict')?.reason).toMatch(/拉取/);
  });
});

// ── 凭据注入与审计脱敏（`27` §10.8.4 / §10.9）─────────────────────────

interface AuthServer {
  readonly url: string;
  readonly host: string;
  readonly authorizations: string[];
  readonly close: () => Promise<void>;
}

/** 本机 401 服务：模拟"需要认证的远端"，验证凭据注入与失败分支。 */
async function startAuthServer(): Promise<AuthServer> {
  const authorizations: string[] = [];
  const server = http.createServer((request, response) => {
    const header = request.headers.authorization;
    if (header !== undefined) authorizations.push(header);
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="syaocode-test"' });
    response.end('需要认证');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  const host = `127.0.0.1:${address.port}`;
  return {
    url: `http://${host}/repo.git`,
    host,
    authorizations,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

describe('凭据注入与审计脱敏', () => {
  it.skipIf(!hasGit)('未配置凭据时上传 → git_auth_required(-32036)（TC-N-029）', async () => {
    const server = await startAuthServer();
    try {
      const root = await makeRepo();
      const reader = makeReader();
      const writer = new GitWriteService({ reader });
      const upload = new GitUploadService({ writer });
      const preflight = await upload.preflight(root, server.url);
      expect(preflight.blockers.some((b) => b.kind === 'git_auth_required')).toBe(true);
      expect(preflight.blockers.find((b) => b.kind === 'git_auth_required')?.code).toBe(-32036);
      expect(preflight.remoteWritable).toBe(false);

      await expect(
        upload.upload(root, server.url, 'main', '不应上传', {
          commandId: 'cmd-auth-required',
          baseRevision: await reader.revisionOf(root),
        }),
      ).rejects.toMatchObject({ dhpKind: 'git_auth_required' });
    } finally {
      await server.close();
    }
  });

  it.skipIf(!hasGit)('凭据经 GIT_ASKPASS 注入、被拒 → git_auth_failed(-32037)，审计不含凭据（TC-N-030/033）', async () => {
    const server = await startAuthServer();
    try {
      const root = await makeRepo();
      const reader = makeReader();
      const audit = makeAudit();
      const token = 'ghp_TESTTOKEN0123456789abcdefABCDEF';
      const credentials = new MemoryCredentialProvider({
        seed: { [keychainEntryFor(server.host, 'token')]: `test-user:${token}` },
      });
      const writer = new GitWriteService({ reader });
      const upload = new GitUploadService({ writer, credentials, audit: audit.sink });

      const preflight = await upload.preflight(root, server.url);
      expect(preflight.blockers.some((b) => b.kind === 'git_auth_failed')).toBe(true);
      expect(preflight.blockers.find((b) => b.kind === 'git_auth_failed')?.code).toBe(-32037);

      // 401 服务收到了 Basic 凭据 → 证明助手脚本确实从环境变量读到了凭据。
      const decoded = server.authorizations
        .map((header) => Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8'))
        .join('\n');
      expect(decoded).toContain(token);

      await expect(
        upload.upload(root, server.url, 'main', '不应上传', {
          commandId: 'cmd-auth-failed',
          baseRevision: await reader.revisionOf(root),
        }),
      ).rejects.toMatchObject({ dhpKind: 'git_auth_failed' });

      // 审计记录不得含凭据原文、长度或片段。
      expect(audit.records.length).toBeGreaterThan(0);
      for (const record of audit.records) {
        expect(record.detail).not.toContain(token);
        expect(record.detail).not.toContain(token.slice(0, 8));
        expect(record.detail).not.toContain('test-user');
        // token 长度不得泄露。**必须按词边界匹配**：审计里含远端 URL，
        // 而 URL 的端口是随机的——裸 `toContain('35')` 会在端口恰好含 35 时
        // 误报（如 `:59359` 里的 "35"）。词边界只匹配独立的数字，保留原意。
        expect(record.detail).not.toMatch(new RegExp(`\\b${String(token.length)}\\b`));
      }
      expect(audit.records.some((r) => r.result === 'failed')).toBe(true);

      // 临时凭据目录用完立即删除（`27` §10.9 红线 3）。
      const leftovers = (await fs.readdir(os.tmpdir())).filter((name) =>
        name.startsWith('syaocode-git-cred-'),
      );
      expect(leftovers).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it.skipIf(!hasGit)('远端不可达 → git_offline(-32038)，不发起推送（TC-N-031）', async () => {
    const root = await makeRepo();
    const reader = makeReader();
    const writer = new GitWriteService({ reader });
    const upload = new GitUploadService({ writer });
    // 端口 1 上没有服务 → 连接被拒绝。
    const offlineUrl = 'http://127.0.0.1:1/repo.git';

    const preflight = await upload.preflight(root, offlineUrl);
    expect(preflight.online).toBe(false);
    expect(preflight.blockers.some((b) => b.kind === 'git_offline')).toBe(true);
    expect(preflight.blockers.find((b) => b.kind === 'git_offline')?.code).toBe(-32038);

    await expect(
      upload.upload(root, offlineUrl, 'main', '不应上传', {
        commandId: 'cmd-offline-0001',
        baseRevision: await reader.revisionOf(root),
      }),
    ).rejects.toMatchObject({ dhpKind: 'git_offline' });
  });

  it.skipIf(!hasGit)('未配置的远端名 → 报错且不改动任何东西', async () => {
    const root = await makeRepo();
    const reader = makeReader();
    const writer = new GitWriteService({ reader });
    const upload = new GitUploadService({ writer });
    await expect(upload.preflight(root, 'upstream')).rejects.toBeInstanceOf(GitUploadError);
    await expect(upload.preflight(root, 'upstream')).rejects.toMatchObject({
      dhpKind: 'git_command_failed',
    });
  });
});

describe('提交细节（27 §10.5.3）：空提交 / 签名失败 / 无签名提交', () => {
  it.skipIf(!hasGit)('无改动时默认拒绝提交；allowEmpty=true 才允许空提交', async () => {
    const root = await makeRepo();
    const reader = makeReader();
    const audit: GitAuditRecord[] = [];
    const writer = new GitWriteService({ reader, audit: (record) => { audit.push(record); } });
    const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();

    // 没有暂存内容：默认必须被拒（git 非零退出 → 抛错），且不产生提交。
    await expect(
      writer.commit(root, 'chore: empty', { commandId: 'cmd-empty-0001', baseRevision: await reader.revisionOf(root) }),
    ).rejects.toBeTruthy();
    expect(git(root, ['rev-parse', 'HEAD']).stdout.trim()).toBe(head);

    // 显式 allowEmpty 才允许；审计里必须留痕。
    const result = await writer.commit(root, 'chore: empty', { commandId: 'cmd-empty-0002', baseRevision: await reader.revisionOf(root) }, { allowEmpty: true });
    expect(result.status).toBe('accepted');
    expect(git(root, ['rev-parse', 'HEAD']).stdout.trim()).not.toBe(head);
    expect(audit.some((r) => r.detail.includes('允许空提交'))).toBe(true);
  });

  it.skipIf(!hasGit)('签名失败 → git_signing_failed；noSign=true 才允许无签名提交（并记审计）', async () => {
    const root = await makeRepo();
    // 故意配置一个必然失败的签名程序：`false` 退出码 1。
    git(root, ['config', 'commit.gpgsign', 'true']);
    git(root, ['config', 'gpg.program', 'false']);
    await fs.writeFile(path.join(root, 'b.txt'), 'signed?\n');
    git(root, ['add', '--', 'b.txt']);

    const reader = makeReader();
    const audit: GitAuditRecord[] = [];
    const writer = new GitWriteService({ reader, audit: (record) => { audit.push(record); } });
    const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();

    // 1) 签名失败必须是**独立 kind**，不能混进 git_command_failed。
    const failure = await writer
      .commit(root, 'feat: signed', { commandId: 'cmd-sign-0001', baseRevision: await reader.revisionOf(root) })
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(failure).toBeTruthy();
    expect((failure as { kind?: string }).kind).toBe('git_signing_failed');
    expect(git(root, ['rev-parse', 'HEAD']).stdout.trim()).toBe(head);

    // 2) 只有用户显式选择 noSign 才能提交，且审计里必须有"未签名"。
    const unsigned = await writer.commit(
      root,
      'feat: signed',
      { commandId: 'cmd-sign-0002', baseRevision: await reader.revisionOf(root) },
      { noSign: true },
    );
    expect(unsigned.status).toBe('accepted');
    expect(git(root, ['rev-parse', 'HEAD']).stdout.trim()).not.toBe(head);
    expect(audit.some((r) => r.detail.includes('未签名'))).toBe(true);
  });
});
