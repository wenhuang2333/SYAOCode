/**
 * Git 执行层（`27` §10.5 / §10.8.4 的实现底座）。
 *
 * 安全姿态（硬约束，不可放宽）：
 *  - **不经过 shell**：`spawn('git', args, { shell: false })`，参数是数组，
 *    不存在拼接注入面；任何"字符串命令"入口都不提供。
 *  - **写操作白名单**：`git/stage` 起的写命令只允许固定的子命令与前缀参数；
 *    `--force` / `--force-with-lease` / `--mirror` / `--delete` / `-C` /
 *    `--git-dir` / `--work-tree` / `-c` / `--exec-path` / `--upload-pack`
 *    一律在**进入 git 之前**拒绝（`git_unsafe`）。
 *  - **非交互**：`GIT_TERMINAL_PROMPT=0`，禁止 git 卡在等待输入；
 *    `GIT_ASKPASS` 只由上传路径显式注入，普通命令一律清空。
 *  - **不落凭据**：本文件不读取、不缓存、不打印任何令牌或私钥。
 *  - **有界**：默认 20 s 超时，输出截断；超时先 SIGTERM 再 SIGKILL。
 *
 * 所有路径参数都必须先过 `assertRelativePath()`：绝对路径与 `..` 逃逸
 * 在到达 git 之前就被拒绝。
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';

export type GitFailureKind =
  | 'git_unavailable'
  | 'git_not_repo'
  | 'git_command_failed'
  | 'git_unsafe'
  | 'git_offline'
  | 'timed_out'
  /** 提交签名失败（`27` §10.5.3）：必须由用户选择重试 / 无签名提交 / 取消。 */
  | 'git_signing_failed';

export class GitError extends Error {
  readonly kind: GitFailureKind;
  readonly exitCode: number | undefined;
  /** 远端 / git 的 stderr 尾部，**已脱敏**（只保留最后 2 KB）。 */
  readonly stderrTail: string | undefined;

  constructor(kind: GitFailureKind, message: string, extra: { exitCode?: number; stderrTail?: string } = {}) {
    super(message);
    this.name = 'GitError';
    this.kind = kind;
    if (extra.exitCode !== undefined) this.exitCode = extra.exitCode;
    if (extra.stderrTail !== undefined) this.stderrTail = redact(extra.stderrTail);
  }
}

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

/** 脱敏：把 URL 内嵌凭据、bearer 令牌、常见密钥形态替换成占位符。 */
export function redact(value: string): string {
  return value
    .replace(/(https?:\/\/)([^/@\s:]+)(:[^/@\s]*)?@/gi, '$1$2:***@')
    .replace(/\b(Bearer|token|authorization)\s*[:=]\s*\S+/gi, '$1: ***')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g, '***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***')
    .slice(-2048);
}

/**
 * 远端 URL 展示脱敏：`https://user:token@host/x.git` → `https://host/x.git`。
 *
 * 这是"展示前必须剥离内嵌凭据"（`27` §12 红线 6）的唯一实现，
 * 任何要把 URL 送进 DHP / 日志 / 界面的地方都必须先过它。
 */
export function sanitizeRemoteUrl(url: string): string {
  const trimmed = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (scheme !== null) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.username !== '' || parsed.password !== '') {
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
      }
      return trimmed;
    } catch {
      // 不是合法 URL（例如 scp 风格的 `git@host:path`），走下面的兜底。
    }
  }
  // scp 风格：`user:password@host:path` 里的 password 段也剥掉。
  return trimmed.replace(/^([^@/\s]+):([^@/\s]*)@/, '$1@');
}

/** 远端 URL 只接受显式协议或本地路径；拒绝 `file://` 之外的奇怪协议与裸命令。 */
export function assertSafeRemoteUrl(url: string): string {
  const value = url.trim();
  if (value === '' || value.length > 2048) throw new GitError('git_unsafe', 'remote URL is empty or too long');
  if (/[\0\r\n]/.test(value)) throw new GitError('git_unsafe', 'remote URL contains control characters');
  if (/^(https?|ssh|git):\/\//i.test(value)) return value;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/.test(value)) return value; // scp 风格 git@host:path
  if (path.isAbsolute(value)) return value; // 本地仓库（离线测试 / 内网路径）
  throw new GitError('git_unsafe', 'remote URL must be https://, ssh://, git@host:path or an absolute local path');
}

/** 路径参数：只允许工作区相对路径，拒绝绝对路径、`..` 逃逸与 NUL。 */
export function assertRelativePath(value: string): string {
  if (value === '' || value.length > 4096) throw new GitError('git_unsafe', 'path is empty or too long');
  if (value.includes('\0') || /[\r\n]/.test(value)) throw new GitError('git_unsafe', 'path contains control characters');
  if (path.isAbsolute(value)) throw new GitError('git_unsafe', `absolute path is not allowed: ${value}`);
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new GitError('git_unsafe', `path escapes workspace: ${value}`);
  }
  if (normalized === '.') return '.';
  return normalized;
}

/**
 * 写操作参数白名单。
 *
 * 读操作也走这里做一次"禁止项"检查——防御性一致比"读操作不需要"更重要：
 * 一旦某个读方法被复用到写路径上，禁止项依然生效。
 */
const FORBIDDEN_ARGS = [
  '--force',
  '-f',
  '--force-with-lease',
  '--force-if-includes',
  '--mirror',
  '--delete',
  '--prune',
  '--all',
  '--tags',
  '--git-dir',
  '--work-tree',
  '--exec-path',
  '--upload-pack',
  '--receive-pack',
  '-C',
  '-c',
  '--namespace',
  '--config',
];

/**
 * 允许被"写"调用的子命令（`27` §10.5：暂存/取消暂存/提交/分支；§10.7 远端增删）。
 *
 * `remote` 只允许 host.ts 里的 `remote add` / `remote remove` 两条受控路径：
 * 参数由 DHP 层先过 `assertSafeRemoteUrl`，危险 flag 仍被 {@link FORBIDDEN_ARGS} 拦住。
 */
const WRITE_SUBCOMMANDS = new Set(['add', 'restore', 'reset', 'commit', 'branch', 'switch', 'checkout', 'push', 'remote']);

export function assertSafeGitArgs(args: readonly string[], opts: { write: boolean }): void {
  if (args.length === 0) throw new GitError('git_unsafe', 'empty git command');
  const sub = args[0]!;
  if (opts.write && !WRITE_SUBCOMMANDS.has(sub)) {
    throw new GitError('git_unsafe', `subcommand not allowed for write: ${sub}`);
  }
  for (const arg of args) {
    if (arg.includes('\0') || /[\r\n]/.test(arg)) throw new GitError('git_unsafe', 'argument contains control characters');
    const lower = arg.toLowerCase();
    for (const bad of FORBIDDEN_ARGS) {
      if (lower === bad || (bad.length > 2 && lower.startsWith(`${bad}=`))) {
        throw new GitError('git_unsafe', `argument is not allowed: ${arg}`);
      }
    }
  }
  // `--` 之后一律当作路径，不再解释为参数；上面的禁止项检查对路径同样无害。
}

export interface GitRunOptions {
  readonly root: string;
  readonly args: readonly string[];
  readonly write?: boolean;
  readonly timeoutMs?: number;
  /** 额外环境变量（例如上传路径注入的 `GIT_ASKPASS`）。 */
  readonly env?: Readonly<Record<string, string>>;
  /** 非零退出不抛错，由调用方读取 `code`。 */
  readonly allowFailure?: boolean;
  readonly maxOutputBytes?: number;
  /**
   * 写入子进程 stdin 的内容（例如 `git cat-file --batch-check` 的哈希清单）。
   *
   * 只用于**读**类命令：写命令的 stdin 一律关闭，避免把内容意外喂给交互式命令。
   */
  readonly stdin?: string;
}

export interface GitRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

/** git 可执行文件是否可用（每个 Host 生命周期只探测一次，结果缓存）。 */
let availability: Promise<boolean> | undefined;
export function gitAvailable(): Promise<boolean> {
  availability ??= new Promise<boolean>((resolve) => {
    let settled = false;
    const child = spawn('git', ['--version'], { shell: false, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const done = (value: boolean): void => { if (!settled) { settled = true; resolve(value); } };
    child.on('error', () => done(false));
    child.on('exit', (code) => done(code === 0));
    child.stdout?.resume();
    child.stderr?.resume();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } done(false); }, 5000).unref();
  });
  return availability;
}

/** 测试用：重置可用性缓存。 */
export function resetGitAvailability(): void {
  availability = undefined;
}

/** 干净的环境：不继承可能让 git 交互或写盘的变量。 */
export function cleanEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  // 非交互 + 不落凭据助手写盘（`27` §10.8.4）。
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_OPTIONAL_LOCKS'] = '0';
  env['LC_ALL'] = 'C';
  if (extra['GIT_ASKPASS'] === undefined) delete env['GIT_ASKPASS'];
  if (extra['SSH_ASKPASS'] === undefined) delete env['SSH_ASKPASS'];
  // 禁止 git 自行写 `~/.git-credentials`。
  if (extra['GIT_CONFIG_PARAMETERS'] === undefined) delete env['GIT_CONFIG_PARAMETERS'];
  return env;
}

/**
 * 执行一条 git 命令。
 *
 * 调用方必须先决定 `write`：读命令与写命令走同一入口，
 * 但写命令额外受子命令白名单约束。
 */
export async function runGit(opts: GitRunOptions): Promise<GitRunResult> {
  assertSafeGitArgs(opts.args, { write: opts.write ?? false });
  if (!(await gitAvailable())) throw new GitError('git_unavailable', 'git executable is not available');
  return await spawnGit(opts);
}

function spawnGit(opts: GitRunOptions): Promise<GitRunResult> {
  const maxBytes = opts.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<GitRunResult>((resolve, reject) => {
    let child;
    try {
      child = spawn('git', [...opts.args], {
        cwd: opts.root,
        shell: false,
        stdio: [opts.stdin === undefined || opts.write === true ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        env: cleanEnv(opts.env ?? {}),
      });
    } catch (error) {
      reject(new GitError('git_command_failed', `cannot spawn git: ${(error as Error).message}`));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (outBytes >= maxBytes) { truncated = true; return; }
      outBytes += chunk.length;
      out.push(chunk);
      if (outBytes > maxBytes) truncated = true;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes >= 64 * 1024) return;
      errBytes += chunk.length;
      err.push(chunk);
    });
    if (opts.stdin !== undefined && opts.write !== true && child.stdin !== null) {
      // 写完立即关闭：`cat-file --batch-check` 读到 EOF 才收尾。
      child.stdin.end(opts.stdin);
    }
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = (error as NodeJS.ErrnoException).code;
      reject(new GitError(code === 'ENOENT' ? 'git_unavailable' : 'git_command_failed', `git failed to start: ${(error as Error).message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(out).subarray(0, maxBytes).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      const exitCode = code ?? -1;
      if (timedOut) {
        reject(new GitError('timed_out', `git ${opts.args[0] ?? ''} timed out after ${timeoutMs}ms`, { exitCode, stderrTail: stderr }));
        return;
      }
      const result: GitRunResult = { code: exitCode, stdout, stderr, truncated };
      if (exitCode !== 0 && opts.allowFailure !== true) {
        reject(new GitError('git_command_failed', `git ${opts.args[0] ?? ''} exited with ${exitCode}`, { exitCode, stderrTail: stderr }));
        return;
      }
      resolve(result);
    });
  });
}

/** 该目录是否是一个 Git 仓库根（用 `rev-parse --show-toplevel` 判断，符号链接安全）。 */
export async function isGitRepository(root: string): Promise<boolean> {
  const result = await runGit({ root, args: ['rev-parse', '--show-toplevel'], allowFailure: true });
  if (result.code !== 0) return false;
  return result.stdout.trim().length > 0;
}

/** 断言目录是仓库根；不是则 `git_not_repo`（`27` TC-N-011）。 */
export async function requireRepository(root: string): Promise<void> {
  if (!(await gitAvailable())) throw new GitError('git_unavailable', 'git executable is not available');
  const result = await runGit({ root, args: ['rev-parse', '--show-toplevel'], allowFailure: true });
  if (result.code !== 0) throw new GitError('git_not_repo', 'workspace is not a Git repository', { exitCode: result.code, stderrTail: result.stderr });
}
