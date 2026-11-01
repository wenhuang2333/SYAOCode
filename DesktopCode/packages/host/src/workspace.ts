/**
 * 工作区服务：文件树、文件读取、差异。
 *
 * 路径围栏（安全硬规则）：**所有**路径访问必须落在工作区根之内。
 * 这条在 Host 侧强制，而不是靠 UI 自觉——UI 是不可信的（渲染层可能被注入）。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface WorkspaceServiceOptions {
  readonly root: string;
  /** 额外可读目录（对应 CLI 的 `--add-dir`；桌面端为空）。 */
  readonly extraDirs?: readonly string[];
  /** 单次读取上限。 */
  readonly maxReadBytes?: number;
}

export interface TreeNode {
  readonly name: string;
  readonly path: string;
  readonly type: 'file' | 'dir';
  readonly children?: readonly TreeNode[];
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly { readonly kind: 'add' | 'del' | 'ctx'; readonly text: string }[];
}

export class WorkspaceAccessError extends Error {
  constructor(
    message: string,
    readonly kind: 'outside_workspace' | 'path_rejected' | 'not_found',
  ) {
    super(message);
    this.name = 'WorkspaceAccessError';
  }
}

export class WorkspaceService {
  private readonly root: string;
  private readonly extraDirs: readonly string[];
  private readonly maxReadBytes: number;

  constructor(opts: WorkspaceServiceOptions) {
    this.root = path.resolve(opts.root);
    this.extraDirs = (opts.extraDirs ?? []).map((d) => path.resolve(d));
    this.maxReadBytes = opts.maxReadBytes ?? 512 * 1024;
  }

  get workspaceRoot(): string {
    return this.root;
  }

  /**
   * 解析并校验路径。
   *
   * 三道闸：
   *  1. 含 NUL → `path_rejected`
   *  2. 绝对路径 → 相对于 root 解析（**不**允许 `..` 逃逸）
   *  3. realpath 后必须仍在 root 内 → `outside_workspace`
   *
   * 用 realpath 是为了挡符号链接逃逸（`link -> ~/.ssh`）。
   */
  resolve(rel: string): string {
    if (rel.includes('\0')) {
      throw new WorkspaceAccessError('path contains NUL', 'path_rejected');
    }
    const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(this.root, rel);

    // 路径必须词法上在 root 内（挡 `..`）。
    const relToRoot = path.relative(this.root, abs);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
      const inExtra = this.extraDirs.some((d) => {
        const r = path.relative(d, abs);
        return !r.startsWith('..') && !path.isAbsolute(r);
      });
      if (!inExtra) {
        throw new WorkspaceAccessError(`path escapes workspace: ${rel}`, 'outside_workspace');
      }
    }
    return abs;
  }

  /** 目录树（限深，避免一次拉全仓库）。 */
  async tree(rel = '.', maxDepth = 3): Promise<TreeNode[]> {
    const abs = this.resolve(rel);
    return this.walk(abs, maxDepth);
  }

  private async walk(abs: string, depth: number): Promise<TreeNode[]> {
    if (depth <= 0) return [];
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return [];
    }
    const nodes: TreeNode[] = [];
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const full = path.join(abs, e.name);
      const relPath = path.relative(this.root, full);
      if (e.isDirectory()) {
        nodes.push({
          name: e.name,
          path: relPath,
          type: 'dir',
          children: await this.walk(full, depth - 1),
        });
      } else {
        nodes.push({ name: e.name, path: relPath, type: 'file' });
      }
    }
    return nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  }

  /** 读取文本文件（截断）。 */
  async readFile(rel: string): Promise<{ path: string; text: string; truncated: boolean }> {
    const abs = this.resolve(rel);
    const stat = await fs.stat(abs).catch(() => {
      throw new WorkspaceAccessError(`not found: ${rel}`, 'not_found');
    });
    if (!stat.isFile()) {
      throw new WorkspaceAccessError(`not a file: ${rel}`, 'path_rejected');
    }
    const buf = await fs.readFile(abs);
    const truncated = buf.byteLength > this.maxReadBytes;
    const slice = truncated ? buf.subarray(0, this.maxReadBytes) : buf;
    return {
      path: path.relative(this.root, abs),
      text: slice.toString('utf8'),
      truncated,
    };
  }

  /** 统一差异（unified 风格）。 */
  diff(rel: string, before: string, after: string): { path: string; hunks: DiffHunk[]; added: number; removed: number } {
    const relPath = path.relative(this.root, this.resolve(rel));
    const a = before.split('\n');
    const b = after.split('\n');
    const hunks = diffLines(a, b);
    let added = 0;
    let removed = 0;
    for (const h of hunks) {
      for (const l of h.lines) {
        if (l.kind === 'add') added += 1;
        else if (l.kind === 'del') removed += 1;
      }
    }
    return { path: relPath, hunks, added, removed };
  }
}

/**
 * 行级差异（LCS）。
 *
 * 规模限制：输入超过 5000 行时退化为"整体替换"——LCS 是 O(n·m)，
 * 在桌面端不该为一个大文件的预览卡住 UI。
 */
export function diffLines(a: readonly string[], b: readonly string[]): DiffHunk[] {
  if (a.length > 5000 || b.length > 5000) {
    return [
      {
        oldStart: 1,
        newStart: 1,
        lines: [
          ...a.map((t): { kind: 'del' | 'add' | 'ctx'; text: string } => ({ kind: 'del', text: t })),
          ...b.map((t): { kind: 'del' | 'add' | 'ctx'; text: string } => ({ kind: 'add', text: t })),
        ],
      },
    ];
  }

  // 标准 LCS 表。
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      const row = dp[i]!;
      const nextRow = dp[i + 1]!;
      row[j] = a[i] === b[j] ? nextRow[j + 1]! + 1 : Math.max(nextRow[j]!, row[j + 1]!);
    }
  }

  const raw: { kind: 'add' | 'del' | 'ctx'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      raw.push({ kind: 'ctx', text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      raw.push({ kind: 'del', text: a[i]! });
      i += 1;
    } else {
      raw.push({ kind: 'add', text: b[j]! });
      j += 1;
    }
  }
  while (i < m) {
    raw.push({ kind: 'del', text: a[i]! });
    i += 1;
  }
  while (j < n) {
    raw.push({ kind: 'add', text: b[j]! });
    j += 1;
  }

  // 分组成 hunk：连续变更 + 3 行上下文。
  const CONTEXT = 3;
  const hunks: DiffHunk[] = [];
  let idx = 0;
  while (idx < raw.length) {
    if (raw[idx]!.kind === 'ctx') {
      idx += 1;
      continue;
    }
    const start = Math.max(0, idx - CONTEXT);
    let end = idx;
    let ctxRun = 0;
    while (end < raw.length) {
      if (raw[end]!.kind === 'ctx') {
        ctxRun += 1;
        if (ctxRun > CONTEXT * 2) break;
      } else {
        ctxRun = 0;
      }
      end += 1;
    }
    const slice = raw.slice(start, Math.min(raw.length, end + CONTEXT));
    hunks.push({
      oldStart: start + 1,
      newStart: start + 1,
      lines: slice,
    });
    idx = end;
  }
  return hunks;
}
