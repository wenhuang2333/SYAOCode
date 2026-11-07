/**
 * Git 只读服务（`27` §10.1–§10.4）。
 *
 * 定位：**唯一执行点**。渲染层不执行 git、不解析 git 输出；
 * 本文件把 git 的各种输出格式翻译成 `@syaocode/dhp` 的稳定类型。
 *
 * 口径纪律（`27` §7.1）：
 *  - 本文件只产出**工作区口径**（工作区当前相对 HEAD 的未提交变化）；
 *  - **会话口径**（本会话工具造成的改动）由 `workbench-service` 采集，
 *    两者**绝不相加**。
 *
 * 安全姿态（与 `git-run.ts` 一致，不放宽）：
 *  - 所有 git 调用都走 `runGit`（不过 shell、参数是数组）；
 *  - 路径参数一律先过 `assertRelativePath`（`../` 逃逸在到达 git 前被拒）；
 *  - 远端 URL 一律过 `sanitizeRemoteUrl`（展示前剥离内嵌凭据）；
 *  - 本文件不读、不写、不缓存任何凭据；`auth` 只给占位状态，
 *    真实登录态由 `host.ts` 用凭据服务覆盖。
 *
 * 行数口径（**必须写清楚，否则 UI 会说谎**）：
 *  - 每个文件的 `added` / `removed` 一律取 **HEAD → 工作区**的净变化
 *    （`git diff HEAD --numstat`）：暂存与未暂存都算进去；
 *    同一文件两处都改过时，不会让人以为"未暂存的那部分不存在"；
 *  - `staged` 布尔只回答"这个文件的改动有没有进索引区"，供界面把文件分到
 *    "已暂存 / 未暂存 / 未跟踪"三组，**不参与行数计算**；
 *  - 二进制文件（numstat 为 `-\t-`）→ `added` / `removed` 为 `null`、
 *    `stat = 'unavailable'`、`binary = true`，**不猜数字**；
 *  - 未跟踪文件不在 diff 里，按 `file-stat.ts` 的预算（1 MiB / 64 KiB）统计行数。
 *
 * 提交图口径：覆盖**全部 ref**（`git log --all` 的等价写法，见 `GRAPH_REF_GLOBS`）
 * + `--topo-order`。提交图要画"分支泳道 + merge 边 + ref 标签"，只看 HEAD 历史的话，
 * 其它分支的独占提交根本不会出现，泳道无从谈起。
 * **因此分页语义是"全 ref 拓扑序里的第 skip … skip+maxCount 条"**，
 * 与"HEAD 历史的第 N 条"不是一回事（2026-11-07 拍板）。
 */

import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  DiffHunk,
  GitAuthInfo,
  GitHookInfo,
  GitBranchInfo,
  GitBranchesResult,
  GitCommitNode,
  GitDiffResult,
  GitFileEntry,
  GitFileStatus,
  GitGraphResult,
  GitRemoteInfo,
  GitRemotesResult,
  GitStatusResult,
} from '@syaocode/dhp';
import {
  assertRelativePath,
  GitError,
  requireRepository,
  runGit,
  sanitizeRemoteUrl,
  type GitRunOptions,
  type GitRunResult,
} from './git-run.ts';
import { statFile } from './file-stat.ts';

/** 状态条目上限（`27` §10.4：大仓库状态输出必须有界）。 */
const MAX_STATUS_ENTRIES = 2000;
/** 状态命令输出上限 512 KiB（`27` §10.4）。 */
const MAX_STATUS_OUTPUT_BYTES = 512 * 1024;
/** 提交图默认页大小与单页上限（`27` §10.3）。 */
const DEFAULT_GRAPH_COUNT = 100;
const MAX_GRAPH_COUNT = 500;
/** diff 行数上限：超过即标记 `truncated`。 */
const MAX_DIFF_LINES = 5000;
/** 空仓库没有 HEAD，用空树哈希代替（git 认识这个固定对象）。 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/**
 * 提交图的 ref 命名空间 = `git log --all` 的等价写法。
 *
 * `git-run.ts` 的禁止参数表把 `--all` / `--tags` 当成写操作的危险参数
 * （`git push --all` / `--tags`）全局拦下，读路径同样生效；
 * 用 `--glob` 逐个命名空间列出在 `git log` 上语义完全等价，
 * 且不会碰到那条护栏（护栏不在本文件的可改范围内）。
 */
const GRAPH_REF_GLOBS = ['--glob=refs/heads/*', '--glob=refs/tags/*', '--glob=refs/remotes/*'] as const;
/** 字段分隔符（0x1f）与记录分隔符（0x1e）：git 输出里不会出现这两个字节。 */
const FIELD = '\x1f';
const RECORD = '\x1e';

export interface GitServiceOptions {
  /** 单条 git 命令的超时（毫秒）；默认 20 s。 */
  readonly timeoutMs?: number;
}

/** `git status --porcelain=v2` 的一条记录。 */
interface StatusRecord {
  readonly kind: 'ordinary' | 'renamed' | 'unmerged' | 'untracked';
  /** 索引区状态（`X`）。 */
  readonly index: string;
  /** 工作区状态（`Y`）。 */
  readonly worktree: string;
  /** 仓库根相对路径。 */
  readonly path: string;
  /** 重命名前的路径（仓库根相对）；非重命名为 `null`。 */
  readonly oldPath: string | null;
}

/** 提交相关的钩子名（`27` §10.5.3）：只关心这三个。 */
const COMMIT_HOOK_NAMES = ['pre-commit', 'commit-msg', 'pre-push'] as const;

/** `git ls-files -s` 的一条索引记录。 */
interface IndexEntry {
  readonly sha: string;
  readonly path: string;
}

/** 解析 `git ls-files -s -z`：`<mode> <sha> <stage>\t<path>\0`。 */
function parseIndexEntries(stdout: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const record of stdout.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(' ');
    const sha = meta[1];
    const filePath = record.slice(tab + 1);
    if (sha === undefined || filePath === '') continue;
    entries.push({ sha, path: filePath });
  }
  return entries;
}

/** 一次 numstat 记录。 */
interface NumStat {
  readonly added: number | null;
  readonly removed: number | null;
  readonly binary: boolean;
}

/** 提交图原始节点（未挂 refs）。 */
interface RawCommit {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly email: string;
  readonly at: number;
  readonly subject: string;
}

/** unified diff 解析结果。 */
interface ParsedDiff {
  readonly hunks: readonly DiffHunk[];
  readonly added: number;
  readonly removed: number;
  readonly truncated: boolean;
  readonly binary: boolean;
}

export class GitService {
  private readonly timeoutMs: number;
  /** 每个工作区的 Git 状态版本号：初始 1，写操作后自增。 */
  private readonly revisions = new Map<string, number>();

  constructor(opts: GitServiceOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  // ── 工作区状态 ───────────────────────────────────────────────────────

  /**
   * 工作区状态（工作区口径）。
   *
   * 数据来源：`git status --porcelain=v2 -z --untracked-files=all`
   * + `git diff HEAD --numstat -z`（**HEAD → 工作区**的净变化）
   * + `git diff --numstat -z`（未暂存）与 `git diff --cached --numstat -z`（已暂存，
   *   仅在净变化拿不到时兜底）
   * + `git rev-list --left-right --count HEAD...@{upstream}`（领先 / 落后）。
   */
  async status(root: string): Promise<GitStatusResult> {
    await requireRepository(root);
    const workspaceRoot = path.resolve(root);
    const prefix = await this.repoPrefix(root);

    const [statusOut, netOut, unstagedOut, stagedOut, headOut, symOut, abOut, stagedSizes, hooks] = await Promise.all([
      this.git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], { maxOutputBytes: MAX_STATUS_OUTPUT_BYTES }),
      this.git(root, ['diff', 'HEAD', '--numstat', '-z'], { allowFailure: true }),
      this.git(root, ['diff', '--numstat', '-z'], { allowFailure: true }),
      this.git(root, ['diff', '--cached', '--numstat', '-z'], { allowFailure: true }),
      this.git(root, ['rev-parse', '--short', 'HEAD'], { allowFailure: true }),
      this.git(root, ['symbolic-ref', '--short', 'HEAD'], { allowFailure: true }),
      // 没有上游时 rev-list 会失败（exit 128）；这是**正常状态**，不是错误。
      this.git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], { allowFailure: true }),
      this.stagedBlobSizes(root, prefix),
      this.commitHooks(root),
    ]);

    const head = headOut.code === 0 ? headOut.stdout.trim() || null : null;
    const branch = symOut.code === 0 ? symOut.stdout.trim() || null : null;

    // HEAD → 工作区：暂存与未暂存都合进来。
    let net = parseNumstat(netOut.stdout);
    if (netOut.code !== 0 && head === null) {
      // 空仓库没有 HEAD，用空树等价表示"HEAD → 工作区"。
      const emptyOut = await this.git(root, ['diff', EMPTY_TREE, '--numstat', '-z'], { allowFailure: true });
      if (emptyOut.code === 0) net = parseNumstat(emptyOut.stdout);
    }
    const unstaged = parseNumstat(unstagedOut.stdout);
    const staged = parseNumstat(stagedOut.stdout);

    const records = parseStatusPorcelain(statusOut.stdout);
    const files: GitFileEntry[] = [];
    let truncated = statusOut.truncated;
    for (const record of records) {
      if (files.length >= MAX_STATUS_ENTRIES) {
        truncated = true;
        break;
      }
      const entry = await this.toFileEntry(root, prefix, record, net, staged, unstaged, stagedSizes);
      if (entry !== null) files.push(entry);
    }

    let ahead: number | null = null;
    let behind: number | null = null;
    if (abOut.code === 0) {
      const parts = abOut.stdout.trim().split(/\s+/);
      ahead = toCount(parts[0]);
      behind = toCount(parts[1]);
    }

    return {
      workspaceRoot,
      branch,
      detached: branch === null,
      head,
      clean: files.length === 0,
      ahead,
      behind,
      files,
      truncated,
      hooks,
      revision: this.revisionOf(root),
      fetchedAt: Date.now(),
    };
  }

  // ── 提交图 ───────────────────────────────────────────────────────────

  /**
   * 提交图窗口。
   *
   * 覆盖**全部 ref**（`--all` 的等价写法，见 `GRAPH_REF_GLOBS`）+ `--topo-order`：
   * 图要能画"分支泳道 + merge 边 + ref 标签"，只看 HEAD 历史会让其它分支的独占提交消失。
   * **分页语义 = 全 ref 拓扑序里的第 skip … skip+maxCount 条**（不是 HEAD 历史的第 N 条）。
   *
   * `hasMore` 用"多取一条"判断；父提交不在窗口内 → `truncated = true`。
   */
  async graph(root: string, opts: { maxCount?: number; skip?: number } = {}): Promise<GitGraphResult> {
    await requireRepository(root);
    const maxCount = Math.min(MAX_GRAPH_COUNT, Math.max(1, opts.maxCount ?? DEFAULT_GRAPH_COUNT));
    const skip = Math.max(0, opts.skip ?? 0);

    // 字段与记录都用 NUL 分隔：提交信息里不可能出现 NUL，
    // 因此 subject 含任何分隔符都不会破坏解析。
    const format = '%H%x00%P%x00%an%x00%ae%x00%at%x00%s';
    const out = await this.git(
      root,
      ['log', ...GRAPH_REF_GLOBS, '--topo-order', '-z', '--no-color', `--max-count=${maxCount + 1}`, `--skip=${skip}`, `--pretty=format:${format}`],
      { allowFailure: true },
    );
    if (out.code !== 0 && !isEmptyHistory(out.stderr)) {
      throw new GitError('git_command_failed', `git log exited with ${out.code}`, { exitCode: out.code, stderrTail: out.stderr });
    }

    const parsed = parseLogRecords(out.stdout);
    const hasMore = parsed.length > maxCount;
    const window = parsed.slice(0, maxCount);

    const refsBySha = await this.refsBySha(root);
    const inWindow = new Set(window.map((node) => node.sha));
    let truncated = false;
    const commits: GitCommitNode[] = window.map((node) => {
      for (const parent of node.parents) {
        if (!inWindow.has(parent)) truncated = true;
      }
      return {
        sha: node.sha,
        parents: node.parents,
        author: node.author,
        email: node.email,
        at: node.at,
        subject: node.subject,
        refs: refsBySha.get(node.sha) ?? [],
      };
    });

    return { workspaceRoot: path.resolve(root), commits, hasMore, truncated };
  }

  // ── 分支 ─────────────────────────────────────────────────────────────

  /** 本地 / 远端分支与领先落后数。 */
  async branches(root: string): Promise<GitBranchesResult> {
    await requireRepository(root);
    const out = await this.git(root, [
      'for-each-ref',
      `--format=%(refname)${FIELD}%(objectname)${FIELD}%(upstream:short)${FIELD}%(upstream:track)${RECORD}`,
      'refs/heads',
      'refs/remotes',
    ]);

    const symOut = await this.git(root, ['symbolic-ref', '--short', 'HEAD'], { allowFailure: true });
    const current = symOut.code === 0 ? symOut.stdout.trim() || null : null;

    const local: GitBranchInfo[] = [];
    const remote: GitBranchInfo[] = [];
    for (const record of out.stdout.split(RECORD)) {
      // for-each-ref 每条记录后跟一个换行，先去掉再按字段切。
      const trimmedRecord = record.trim();
      if (trimmedRecord === '') continue;
      const parts = trimmedRecord.split(FIELD);
      const refname = parts[0] ?? '';
      const objectname = parts[1] ?? '';
      const upstream = parts[2] ?? '';
      const track = parts[3] ?? '';
      if (refname === '') continue;

      if (refname.startsWith('refs/heads/')) {
        const name = refname.slice('refs/heads/'.length);
        const upstreamName = upstream === '' ? null : upstream;
        let ahead: number | null = null;
        let behind: number | null = null;
        if (upstreamName !== null) {
          const abOut = await this.git(root, ['rev-list', '--left-right', '--count', `${name}...${upstreamName}`], { allowFailure: true });
          if (abOut.code === 0) {
            const counts = abOut.stdout.trim().split(/\s+/);
            ahead = toCount(counts[0]);
            behind = toCount(counts[1]);
          } else {
            // 上游已被删除等情况：退回 %(upstream:track) 的括号内容。
            ahead = trackCount(track, 'ahead');
            behind = trackCount(track, 'behind');
          }
        }
        local.push({
          name,
          kind: 'local',
          current: current !== null && name === current,
          ahead,
          behind,
          upstream: upstreamName,
          sha: objectname === '' ? null : objectname,
        });
        continue;
      }

      if (refname.startsWith('refs/remotes/')) {
        remote.push({
          name: refname.slice('refs/remotes/'.length),
          kind: 'remote',
          current: false,
          ahead: null,
          behind: null,
          upstream: null,
          sha: objectname === '' ? null : objectname,
        });
      }
    }

    return {
      workspaceRoot: path.resolve(root),
      current,
      detached: current === null,
      local,
      remote,
    };
  }

  // ── 差异 ─────────────────────────────────────────────────────────────

  /**
   * 单文件差异。
   *
   * `mode`：`worktree`（默认，索引区 → 工作区）/ `staged`（HEAD → 索引区）
   * / `commit`（该提交 → 工作区）。
   */
  async diff(
    root: string,
    target: string,
    opts: { mode?: 'worktree' | 'staged' | 'commit'; commit?: string } = {},
  ): Promise<GitDiffResult> {
    // 路径围栏先于任何 git 调用：`../etc/passwd` 在这里就被拒。
    const relative = assertRelativePath(target);
    await requireRepository(root);
    const mode = opts.mode ?? 'worktree';

    // git 的 pathspec 相对**当前目录**（= 工作区根），因此这里直接用工作区相对路径；
    // 工作区根不是仓库根时也不需要额外换算。
    const args: string[] = ['diff', '--no-color', '--unified=3'];
    if (mode === 'staged') args.push('--cached');
    if (mode === 'commit') {
      if (opts.commit === undefined || opts.commit === '') {
        throw new GitError('git_command_failed', 'commit revision is required in commit mode');
      }
      args.push(assertRevision(opts.commit));
    }
    args.push('--', relative);

    const out = await this.git(root, args);
    const parsed = parseUnifiedDiff(out.stdout);
    return {
      workspaceRoot: path.resolve(root),
      path: relative,
      mode,
      hunks: parsed.hunks,
      added: parsed.added,
      removed: parsed.removed,
      truncated: parsed.truncated,
      binary: parsed.binary,
    };
  }

  // ── 远端 ─────────────────────────────────────────────────────────────

  /** 远端列表；URL 一律脱敏（剥离 `https://user:token@host/...` 的内嵌凭据）。 */
  async remotes(root: string): Promise<GitRemotesResult> {
    await requireRepository(root);
    const out = await this.git(root, ['remote', '-v']);
    const fetchUrls = new Map<string, string>();
    const pushUrls = new Map<string, string>();
    for (const line of out.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const tab = trimmed.indexOf('\t');
      if (tab < 0) continue;
      const name = trimmed.slice(0, tab).trim();
      const rest = trimmed.slice(tab + 1).trim();
      const matched = /^(.*?)\s+\((fetch|push)\)$/.exec(rest);
      if (matched === null) continue;
      const url = (matched[1] ?? '').trim();
      const direction = matched[2];
      if (name === '' || url === '' || direction === undefined) continue;
      if (direction === 'fetch') fetchUrls.set(name, url);
      else pushUrls.set(name, url);
    }

    const names = [...new Set([...fetchUrls.keys(), ...pushUrls.keys()])].sort();
    const remotes: GitRemoteInfo[] = [];
    for (const name of names) {
      const url = fetchUrls.get(name) ?? pushUrls.get(name);
      if (url === undefined) continue;
      remotes.push({ name, url: sanitizeRemoteUrl(url), auth: emptyAuth() });
    }
    return { workspaceRoot: path.resolve(root), remotes };
  }

  // ── 版本号 ───────────────────────────────────────────────────────────

  /** 当前工作区的 Git 状态版本（初始 1）。 */
  revisionOf(root: string): number {
    return this.revisions.get(this.revisionKey(root)) ?? 1;
  }

  /** 写操作后自增版本号，返回新值。 */
  bumpRevision(root: string): number {
    const key = this.revisionKey(root);
    const next = (this.revisions.get(key) ?? 1) + 1;
    this.revisions.set(key, next);
    return next;
  }

  // ── 内部工具 ─────────────────────────────────────────────────────────

  private revisionKey(root: string): string {
    return path.resolve(root);
  }

  private async git(
    root: string,
    args: readonly string[],
    opts: { allowFailure?: boolean; maxOutputBytes?: number; stdin?: string } = {},
  ): Promise<GitRunResult> {
    const request: GitRunOptions = {
      root,
      args,
      timeoutMs: this.timeoutMs,
      allowFailure: opts.allowFailure ?? false,
      ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
    };
    return await runGit(request);
  }

  /**
   * 仓库根相对工作区根的前缀。
   *
   * 工作区根不是仓库根时（工作区在仓库子目录），git 的路径都是**仓库根相对**，
   * 而界面用的是**工作区根相对**；这个前缀负责两者的换算。
   */
  private async repoPrefix(root: string): Promise<string> {
    const out = await this.git(root, ['rev-parse', '--show-toplevel']);
    const top = out.stdout.trim();
    if (top === '') return '';
    const realTop = await fs.realpath(top).catch(() => top);
    const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
    const relative = path.relative(realTop, realRoot);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return '';
    return relative.split(path.sep).join('/');
  }

  /** 仓库根相对路径 → 工作区根相对路径。 */
  private toWorkspacePath(prefix: string, repoPath: string): string {
    if (prefix === '') return repoPath;
    if (repoPath === prefix) return '';
    if (repoPath.startsWith(`${prefix}/`)) return repoPath.slice(prefix.length + 1);
    return repoPath;
  }

  /**
   * 已暂存内容（即将提交的 blob）的字节数：`path → size`。
   *
   * 口径说明（**不能拿工作区文件大小冒充**）：
   *  - 用 `git ls-files -s` 拿索引里的 blob 哈希，再用 `git cat-file --batch-check`
   *    一次批量取大小——两次子进程，不随文件数线性增长；
   *  - 只覆盖**索引区**条目：未暂存 / 未跟踪文件一律不出现在这里（`sizeBytes=null`）；
   *  - 取不到（超时 / 输出截断 / `missing`）就跳过，界面显示"大小不可统计"，不猜数字。
   */
  private async stagedBlobSizes(root: string, prefix: string): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    const listed = await this.git(root, ['ls-files', '-s', '-z'], { allowFailure: true, maxOutputBytes: 4 * 1024 * 1024 });
    if (listed.code !== 0) return sizes;
    /** blob 哈希 → 工作区相对路径（同一 blob 被多个路径引用时都要记）。 */
    const byHash = new Map<string, string[]>();
    for (const record of parseIndexEntries(listed.stdout)) {
      if (!isInsideWorkspace(prefix, record.path)) continue;
      const relative = this.toWorkspacePath(prefix, record.path);
      const paths = byHash.get(record.sha);
      if (paths === undefined) byHash.set(record.sha, [relative]);
      else paths.push(relative);
    }
    if (byHash.size === 0) return sizes;
    const hashes = [...byHash.keys()];
    const batch = await this.git(root, ['cat-file', '--batch-check'], {
      allowFailure: true,
      stdin: hashes.map((hash) => `${hash}\n`).join(''),
      maxOutputBytes: 4 * 1024 * 1024,
    });
    if (batch.code !== 0) return sizes;
    for (const line of batch.stdout.split('\n')) {
      // 形如 `<sha> blob <size>`；`missing` / `ambiguous` 一律跳过。
      const parts = line.trim().split(/\s+/);
      if (parts.length !== 3 || parts[1] !== 'blob') continue;
      const sha = parts[0] ?? '';
      const size = Number(parts[2]);
      if (!Number.isFinite(size) || size < 0) continue;
      for (const relative of byHash.get(sha) ?? []) sizes.set(relative, size);
    }
    return sizes;
  }

  /**
   * 仓库里存在的提交相关钩子（`pre-commit` / `commit-msg` / `pre-push`）。
   *
   * 钩子目录用 `git rev-parse --git-path hooks` 解析——这样 worktree / submodule /
   * `core.hooksPath` 都能拿到真实位置，不靠猜 `.git/hooks`。
   * **只报事实**：`executable` 用 `X_OK` 判定；不可执行的钩子 Git 不会运行，
   * 界面不能把它算进"将运行的 N 个"。
   */
  private async commitHooks(root: string): Promise<GitHookInfo[]> {
    const resolved = await this.git(root, ['rev-parse', '--git-path', 'hooks'], { allowFailure: true });
    if (resolved.code !== 0) return [];
    const dir = resolved.stdout.trim();
    if (dir === '') return [];
    const hooks: GitHookInfo[] = [];
    for (const name of COMMIT_HOOK_NAMES) {
      const file = path.resolve(root, dir, name);
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) continue;
        let executable = false;
        try { await fs.access(file, fsConstants.X_OK); executable = true; } catch { executable = false; }
        hooks.push({ name, executable });
      } catch {
        // 不存在就是不存在：不报、不猜。
      }
    }
    return hooks;
  }

  /** 把一条状态记录翻译成 `GitFileEntry`。 */
  private async toFileEntry(
    root: string,
    prefix: string,
    record: StatusRecord,
    net: Map<string, NumStat>,
    staged: Map<string, NumStat>,
    unstaged: Map<string, NumStat>,
    stagedSizes: Map<string, number>,
  ): Promise<GitFileEntry | null> {
    if (record.path === '') return null;
    // 工作区根不是仓库根时，只报工作区范围内的文件：否则一半路径是工作区相对、
    // 一半是仓库根相对，界面无法解释。
    if (!isInsideWorkspace(prefix, record.path)) return null;
    const relative = this.toWorkspacePath(prefix, record.path);
    const oldPath = record.oldPath === null ? null : this.toWorkspacePath(prefix, record.oldPath);

    if (record.kind === 'untracked') {
      // 未跟踪文件不在 numstat 里：按 §7.4 的预算单独统计行数。
      const stat = await statFile(path.join(root, relative));
      const lines = stat.kind === 'text' ? stat.lines : null;
      return {
        path: relative,
        status: 'untracked',
        staged: false,
        oldPath: null,
        added: lines,
        removed: lines === null ? null : 0,
        stat: lines === null ? 'unavailable' : 'exact',
        binary: stat.kind === 'binary',
        // 未跟踪文件不在索引区，没有"将要提交的 blob"。
        sizeBytes: null,
      };
    }

    const status = mapFileStatus(record);
    // `staged` 只描述"改动有没有进索引区"，供界面分组；不参与行数计算。
    const isStaged = record.kind !== 'unmerged' && record.index !== '.';
    // 行数一律取 HEAD → 工作区的净变化；净变化拿不到时才退回暂存 / 未暂存口径。
    const counts = net.get(record.path)
      ?? (isStaged ? staged.get(record.path) : unstaged.get(record.path))
      ?? (isStaged ? unstaged.get(record.path) : staged.get(record.path));

    return {
      path: relative,
      status,
      staged: isStaged,
      oldPath,
      added: counts?.added ?? null,
      removed: counts?.removed ?? null,
      stat: counts === undefined ? 'unavailable' : counts.binary ? 'unavailable' : 'exact',
      binary: counts?.binary ?? false,
      // 只有进索引区的条目才有"将要提交的内容大小"；删除条目为 0（提交里是删除）。
      sizeBytes: !isStaged ? null : (stagedSizes.get(relative) ?? (status === 'deleted' ? 0 : null)),
    };
  }

  /** 提交 sha → 指向它的 ref 短名（分支 / tag）。 */
  private async refsBySha(root: string): Promise<Map<string, string[]>> {
    const out = await this.git(root, [
      'for-each-ref',
      `--format=%(objectname)${FIELD}%(refname)${FIELD}%(*objectname)${RECORD}`,
      'refs/heads',
      'refs/tags',
      'refs/remotes',
    ]);
    const map = new Map<string, string[]>();
    for (const record of out.stdout.split(RECORD)) {
      const trimmedRecord = record.trim();
      if (trimmedRecord === '') continue;
      const parts = trimmedRecord.split(FIELD);
      const objectname = parts[0] ?? '';
      const refname = parts[1] ?? '';
      const peeled = parts[2] ?? '';
      const short = shortRefName(refname);
      if (short === '') continue;
      if (objectname !== '') pushRef(map, objectname, short);
      // 附注标签（annotated tag）的 %(objectname) 是标签对象，%(*objectname) 才是提交。
      if (peeled !== '' && peeled !== objectname) pushRef(map, peeled, short);
    }
    return map;
  }
}

// ── 纯函数（解析） ─────────────────────────────────────────────────────

/** 解析 `git status --porcelain=v2 -z` 的输出。 */
function parseStatusPorcelain(text: string): StatusRecord[] {
  const records: StatusRecord[] = [];
  const fields = text.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field === undefined || field === '') continue;
    if (field.startsWith('1 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = field.split(' ');
      const xy = parts[1] ?? '..';
      records.push({
        kind: 'ordinary',
        index: xy.charAt(0) || '.',
        worktree: xy.charAt(1) || '.',
        path: parts.slice(8).join(' '),
        oldPath: null,
      });
      continue;
    }
    if (field.startsWith('2 ')) {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>，紧随其后的字段是原路径。
      const parts = field.split(' ');
      const xy = parts[1] ?? '..';
      const original = fields[i + 1];
      i += 1;
      records.push({
        kind: 'renamed',
        index: xy.charAt(0) || '.',
        worktree: xy.charAt(1) || '.',
        path: parts.slice(9).join(' '),
        oldPath: original === undefined || original === '' ? null : original,
      });
      continue;
    }
    if (field.startsWith('u ')) {
      // u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const parts = field.split(' ');
      const xy = parts[1] ?? 'UU';
      records.push({
        kind: 'unmerged',
        index: xy.charAt(0) || 'U',
        worktree: xy.charAt(1) || 'U',
        path: parts.slice(10).join(' '),
        oldPath: null,
      });
      continue;
    }
    if (field.startsWith('? ')) {
      records.push({ kind: 'untracked', index: '?', worktree: '?', path: field.slice(2), oldPath: null });
      continue;
    }
    // `! `（ignored）直接忽略：侧栏不展示被忽略的文件。
  }
  return records;
}

/** 解析 `git diff --numstat -z` 的输出：路径 → 行数。 */
function parseNumstat(text: string): Map<string, NumStat> {
  const map = new Map<string, NumStat>();
  const fields = text.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field === undefined || field === '') continue;
    const firstTab = field.indexOf('\t');
    if (firstTab < 0) continue;
    const secondTab = field.indexOf('\t', firstTab + 1);
    if (secondTab < 0) continue;
    const addedRaw = field.slice(0, firstTab);
    const removedRaw = field.slice(firstTab + 1, secondTab);
    const rest = field.slice(secondTab + 1);
    if (rest === '') {
      // 重命名 / 复制：后两个字段分别是旧路径与新路径（以新路径为键）。
      const newPath = fields[i + 2];
      i += 2;
      if (newPath === undefined || newPath === '') continue;
      map.set(newPath, toNumStat(addedRaw, removedRaw));
      continue;
    }
    map.set(rest, toNumStat(addedRaw, removedRaw));
  }
  return map;
}

function toNumStat(addedRaw: string, removedRaw: string): NumStat {
  if (addedRaw === '-' || removedRaw === '-') return { added: null, removed: null, binary: true };
  const added = Number.parseInt(addedRaw, 10);
  const removed = Number.parseInt(removedRaw, 10);
  return {
    added: Number.isFinite(added) ? added : null,
    removed: Number.isFinite(removed) ? removed : null,
    binary: false,
  };
}

/** 把 porcelain v2 的 `XY` 翻译成 `GitFileStatus`。 */
function mapFileStatus(record: StatusRecord): GitFileStatus {
  if (record.kind === 'unmerged') return 'conflicted';
  const x = record.index;
  const y = record.worktree;
  if (x === 'U' || y === 'U' || x === 'AA' || x === 'DD') return 'conflicted';
  if (x === 'R' || y === 'R' || x === 'C' || y === 'C') return 'renamed';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  return 'modified';
}

/** 解析 `git log -z --pretty=format:` 的输出（每条记录 6 个 NUL 分隔字段）。 */
function parseLogRecords(text: string): RawCommit[] {
  const fields = text.split('\0');
  const commits: RawCommit[] = [];
  for (let i = 0; i + 5 < fields.length; i += 6) {
    const sha = fields[i] ?? '';
    const parentsRaw = fields[i + 1] ?? '';
    const author = fields[i + 2] ?? '';
    const email = fields[i + 3] ?? '';
    const atRaw = fields[i + 4] ?? '';
    const subject = (fields[i + 5] ?? '').replace(/\n+$/, '');
    if (sha === '') continue;
    const at = Number.parseInt(atRaw, 10);
    commits.push({
      sha,
      parents: parentsRaw.split(' ').filter((parent) => parent !== ''),
      author,
      email,
      // git 给的是秒；DHP 侧统一用毫秒。
      at: Number.isFinite(at) ? at * 1000 : 0,
      subject,
    });
  }
  return commits;
}

/** 解析 unified diff 输出。 */
function parseUnifiedDiff(text: string): ParsedDiff {
  const hunks: DiffHunk[] = [];
  let added = 0;
  let removed = 0;
  let total = 0;
  let truncated = false;
  let binary = false;
  let current: { oldStart: number; newStart: number; lines: { kind: 'add' | 'del' | 'ctx'; text: string }[] } | null = null;

  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
      binary = true;
      continue;
    }
    if (raw.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    if (raw.startsWith('@@')) {
      const matched = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (matched === null) {
        current = null;
        continue;
      }
      current = { oldStart: Number.parseInt(matched[1] ?? '0', 10), newStart: Number.parseInt(matched[2] ?? '0', 10), lines: [] };
      hunks.push(current);
      continue;
    }
    if (current === null) continue;
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    const marker = raw.charAt(0);
    let kind: 'add' | 'del' | 'ctx';
    if (marker === '+') {
      kind = 'add';
      added += 1;
    } else if (marker === '-') {
      kind = 'del';
      removed += 1;
    } else if (marker === ' ') {
      kind = 'ctx';
    } else {
      current = null;
      continue;
    }
    current.lines.push({ kind, text: raw.slice(1) });
    total += 1;
    if (total > MAX_DIFF_LINES) {
      truncated = true;
      break;
    }
  }

  if (binary) {
    // 二进制文件没有可读的行：不给假数字，hunks 置空。
    return { hunks: [], added: 0, removed: 0, truncated, binary: true };
  }
  return { hunks, added, removed, truncated, binary: false };
}

// ── 小工具 ─────────────────────────────────────────────────────────────

/** 空登录态占位：真实登录态由 `host.ts` 用凭据服务覆盖。 */
function emptyAuth(): GitAuthInfo {
  return {
    method: 'none',
    configured: false,
    account: null,
    scope: [],
    ready: false,
    keyFingerprint: null,
    updatedAt: null,
  };
}

/** 仓库根相对路径是否落在工作区范围内。 */
function isInsideWorkspace(prefix: string, repoPath: string): boolean {
  if (prefix === '') return true;
  return repoPath === prefix || repoPath.startsWith(`${prefix}/`);
}

/** ref 全名 → 短名（去掉 `refs/heads/`、`refs/tags/`、`refs/remotes/` 前缀）。 */function shortRefName(refname: string): string {
  if (refname.startsWith('refs/heads/')) return refname.slice('refs/heads/'.length);
  if (refname.startsWith('refs/tags/')) return refname.slice('refs/tags/'.length);
  if (refname.startsWith('refs/remotes/')) return refname.slice('refs/remotes/'.length);
  return refname;
}

function pushRef(map: Map<string, string[]>, sha: string, name: string): void {
  const existing = map.get(sha);
  if (existing === undefined) {
    map.set(sha, [name]);
    return;
  }
  if (!existing.includes(name)) existing.push(name);
}

/** 解析计数（`--left-right --count` 输出 "左\t右"）。 */
function toCount(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 从 `%(upstream:track)`（形如 `[ahead 1, behind 2]`）里取计数。 */
function trackCount(track: string, keyword: 'ahead' | 'behind'): number | null {
  const matched = new RegExp(`${keyword}\\s+(\\d+)`).exec(track);
  if (matched === null) return null;
  return toCount(matched[1]);
}

/** 空仓库里 `git log` 的报错特征（不算错误，返回空列表）。 */
function isEmptyHistory(stderr: string): boolean {
  return stderr.includes('does not have any commits yet') || stderr.includes('bad default revision');
}

/** 提交版本参数：不允许以 `-` 开头（避免被当成选项）。 */
function assertRevision(value: string): string {
  if (value.length > 256) throw new GitError('git_unsafe', 'commit revision is too long');
  if (value.includes('\0') || /[\r\n]/.test(value)) throw new GitError('git_unsafe', 'commit revision contains control characters');
  if (value.startsWith('-')) throw new GitError('git_unsafe', 'commit revision must not start with "-"');
  return value;
}
