/**
 * 可视化上传流程（`27` §10.8 / §10.9，FR-N-028 / FR-N-029）。
 *
 * 这是全套功能里**唯一会把本地代码送出本机**的操作，因此门禁是
 * "**全部满足才放行**"，不是"任意一条满足"（`27` §10.9 八条）。
 *
 * 流程（`27` §10.8.1）：
 *   选远端 → 认证 → 预检（`preflight`）→ 选范围 → 填提交信息 → 二次确认
 *   → `upload`（内部 = 提交 + 推送）→ 展示 sha。
 *
 * 关键实现约束（`27` §10.8.4）：
 *  - **令牌绝不进命令行参数**：HTTPS 走 `GIT_ASKPASS` + 临时助手脚本
 *    （`0700`，从环境变量读凭据，用完立即删除）；SSH 走 `0600` 临时密钥文件
 *    （用完立即删除）+ `IdentitiesOnly=yes`；
 *  - `GIT_TERMINAL_PROMPT=0`（`git-run.ts` 统一设置）；
 *  - 禁用凭据助手写盘：`-c credential.helper=` 是**参数**形式会被安全层拒绝，
 *    这里改用等价的**环境变量**形式 `GIT_CONFIG_COUNT/GIT_CONFIG_KEY_0/…`；
 *  - **禁止 force**：推送参数固定为 `remote + branch` 两个，不接受任意 refspec；
 *  - 整体超时 120 s。
 *
 * 错误口径：
 *  - git 自身的失败 → `GitError`（`git-run.ts` 的六种 kind）；
 *  - 上传专属语义（远端冲突 / 未配凭据 / 凭据被拒 / CAS 过期 / 幂等冲突）
 *    → `GitUploadError`，它在 `kind` 之外额外带一个更精确的 `dhpKind`，
 *    host.ts 用 `dhpKindForGitError()` 取 DHP 错误种类。
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  codeForKind,
  type DhpErrorKind,
  type GitPreflightBlocker,
  type GitPreflightResult,
  type GitStatusResult,
  type GitUploadResult,
} from '@liwencode/dhp';
import { type CredentialProvider, keychainEntryFor } from './credentials.ts';
import {
  GitError,
  assertSafeRemoteUrl,
  requireRepository,
  runGit,
  sanitizeRemoteUrl,
  type GitRunResult,
} from './git-run.ts';
import {
  type GitAuditSink,
  type GitCommandEnvelope,
  GitWriteService,
  assertBranchName,
  requestHash,
  safeDetail,
} from './git-write.ts';

/** 上传整体超时（`27` §10.8.4）。 */
const UPLOAD_TIMEOUT_MS = 120_000;

/** 单次远端探测（`ls-remote`）的超时。 */
const REMOTE_PROBE_TIMEOUT_MS = 30_000;

export interface GitUploadOptions {
  readonly writer: GitWriteService;
  readonly credentials?: CredentialProvider;
  readonly audit?: GitAuditSink;
}

/**
 * 上传路径专属的失败种类。
 *
 * `git-run.ts` 的 `GitFailureKind` 只覆盖"git 命令层面的失败"，而上传还要表达
 * "远端分叉 / 没配凭据 / 凭据被拒 / CAS 过期 / 幂等冲突"这几种**语义**失败。
 * 这里用 `dhpKind` 承载它们，`kind` 仍然留在 `GitFailureKind` 的范围内。
 */
export class GitUploadError extends GitError {
  /** 更精确的 DHP 错误种类（host.ts 优先用这个做映射）。 */
  readonly dhpKind: DhpErrorKind;

  constructor(dhpKind: DhpErrorKind, message: string, extra: { exitCode?: number; stderrTail?: string } = {}) {
    super(baseKindFor(dhpKind), message, extra);
    this.name = 'GitUploadError';
    this.dhpKind = dhpKind;
  }
}

/** GitError → DHP 错误种类（上传错误优先用更细的 `dhpKind`）。 */
export function dhpKindForGitError(error: GitError): DhpErrorKind {
  if (error instanceof GitUploadError) return error.dhpKind;
  return error.kind;
}

/** GitError → DHP 错误码。 */
export function dhpCodeForGitError(error: GitError): number {
  return codeForKind(dhpKindForGitError(error));
}

interface RemoteTarget {
  /** 远端名（配置过的远端用名字；直接给 URL 时用脱敏后的 URL）。 */
  readonly name: string;
  /** 实际用于 git 命令的地址（可能含内嵌凭据，只在进程内使用）。 */
  readonly url: string;
  /** 展示用（已剥离内嵌凭据，`27` §12 红线 6）。 */
  readonly display: string;
  /** 是否是配置过的远端（决定 push 能不能带 `-u`）。 */
  readonly configured: boolean;
}

interface InspectResult {
  readonly status: GitStatusResult;
  readonly target: RemoteTarget;
  readonly branch: string;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly diverged: boolean;
  readonly remoteWritable: boolean | null;
  readonly online: boolean | null;
  readonly blockers: readonly GitPreflightBlocker[];
}

interface CredentialContext {
  readonly env: Readonly<Record<string, string>>;
  /** 是否真的注入了凭据（决定认证失败是"未配置"还是"被拒绝"）。 */
  readonly used: boolean;
  readonly dispose: () => Promise<void>;
}

/** 统计口径。 */
type UploadScope = 'all' | 'session';

/**
 * 可视化上传服务。
 *
 * 用法（host.ts）：`new GitUploadService({ writer, credentials, audit })`，
 * 把 `git/preflight` 与 `git/upload` 两个 DHP 方法转发过来。
 */
export class GitUploadService {
  private readonly writer: GitWriteService;
  private readonly credentials: CredentialProvider | undefined;
  private readonly audit: GitAuditSink | undefined;
  /** 幂等窗口：`commandId` → 请求哈希与首次成功结果。 */
  private readonly executed = new Map<string, { hash: string; result: GitUploadResult }>();

  constructor(opts: GitUploadOptions) {
    this.writer = opts.writer;
    this.credentials = opts.credentials;
    this.audit = opts.audit;
  }

  /**
   * 上传前预检（`27` §10.8.1 第 4 步）。
   *
   * 检查五件事：工作区是否干净、ahead/behind、是否分叉、远端可写性、网络可达性。
   * **任何情况下都不提供 force 选项**——落后或分叉只给"先拉取 / 换分支 / 取消"。
   */
  async preflight(
    root: string,
    remote: string,
    opts?: { branch?: string; scope?: 'all' | 'session' },
  ): Promise<GitPreflightResult> {
    const action = 'git.preflight';
    const scope = opts?.scope ?? 'all';
    try {
      const inspected = await this.inspect(root, remote, opts?.branch);
      const stats = summarize(inspected.status, scope);
      const result: GitPreflightResult = {
        workspaceRoot: root,
        remote: inspected.target.name,
        remoteUrl: inspected.target.display,
        branch: inspected.branch,
        clean: inspected.status.clean,
        ahead: inspected.ahead,
        behind: inspected.behind,
        diverged: inspected.diverged,
        remoteWritable: inspected.remoteWritable,
        online: inspected.online,
        files: stats.files,
        added: stats.added,
        removed: stats.removed,
        truncated: inspected.status.truncated,
        requiresCommit: !inspected.status.clean,
        revision: inspected.status.revision,
        blockers: inspected.blockers,
      };
      await this.record(
        root,
        action,
        `预检远端 ${result.remote}（${result.remoteUrl}）分支 ${result.branch}：` +
          (inspected.blockers.length === 0
            ? '无阻塞，ahead=' + String(result.ahead) + '，behind=' + String(result.behind)
            : inspected.blockers.map((b) => b.reason).join('；')),
        inspected.blockers.length === 0 ? 'success' : 'failed',
        inspected.blockers[0]?.code ?? null,
      );
      return result;
    } catch (error) {
      await this.reportFailure(root, action, error);
      throw error;
    }
  }

  /**
   * 上传（`27` §10.8.1 第 8 步）：**提交 + 推送**一次完成。
   *
   * - 需要凭据时走环境变量注入（`GIT_ASKPASS` / 临时密钥文件）；
   * - 推送参数固定 `remote + branch`，不接受任意 refspec，也不提供 force；
   * - 整体超时 120 s；
   * - 成功返回 `sha` 与范围统计。
   */
  async upload(
    root: string,
    remote: string,
    branch: string,
    message: string,
    envelope: GitCommandEnvelope,
    opts?: { includeUnstaged?: boolean; scope?: 'all' | 'session' },
  ): Promise<GitUploadResult> {
    const action = 'git.upload';
    const scope = opts?.scope ?? 'all';
    const includeUnstaged = opts?.includeUnstaged ?? scope !== 'session';
    try {
      this.assertEnvelope(envelope);
      const text = message.trim();
      if (text.length === 0) throw new GitUploadError('git_command_failed', '提交信息不能为空');
      const hash = requestHash(action, root, { remote, branch, message: text, includeUnstaged, scope });

      // 幂等优先：同一 commandId 重放不重复产生副作用。
      const executed = this.executed.get(envelope.commandId);
      if (executed !== undefined) {
        if (executed.hash !== hash) {
          throw new GitUploadError('idempotency_conflict', '命令 ID 已被另一个上传请求占用');
        }
        await this.record(
          root,
          action,
          `重复命令（幂等命中，未重复上传）：${executed.result.remote}/${executed.result.branch}`,
          'success',
          null,
        );
        return executed.result;
      }

      const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
      const inspected = await this.inspect(root, remote, branch, deadline);
      const blocker = inspected.blockers[0];
      if (blocker !== undefined) {
        throw new GitUploadError(blockerKind(blocker.kind), blocker.reason);
      }

      const stats = summarize(inspected.status, scope);
      await this.recordIntent(
        root,
        action,
        `准备上传到 ${inspected.target.name}（${inspected.target.display}）分支 ${inspected.branch}，` +
          `文件 ${stats.files} 个（+${stats.added}/-${stats.removed}）`,
      );

      // 先提交（`27` §10.5.4：上传 = 提交 + 推送，不暴露成自由 commit 入口）。
      if (needsCommit(inspected.status, scope)) {
        if (scope === 'all') {
          const revision = await this.currentRevision(root);
          await this.writer.stage(root, ['.'], {
            commandId: `${envelope.commandId}#stage#${revision}`,
            baseRevision: revision,
          });
        }
        const revision = await this.currentRevision(root);
        await this.writer.commit(
          root,
          text,
          { commandId: `${envelope.commandId}#commit#${revision}`, baseRevision: revision },
          { includeUnstaged, noVerify: false },
        );
      }

      // 再推送。
      const pushArgs = await this.pushArgs(root, inspected.target, inspected.branch);
      const credential = await this.credentialContext(inspected.target.url);
      let pushOutput: GitRunResult;
      try {
        pushOutput = await runGit({
          root,
          args: pushArgs,
          write: true,
          env: credential.env,
          timeoutMs: Math.max(1_000, deadline - Date.now()),
        });
      } catch (error) {
        throw this.mapPushError(error, credential.used);
      } finally {
        await credential.dispose();
      }
      if (pushOutput.code !== 0) {
        throw this.mapPushError(
          new GitError('git_command_failed', 'git push 非零退出', {
            exitCode: pushOutput.code,
            stderrTail: pushOutput.stderr,
          }),
          credential.used,
        );
      }

      const sha = await this.headSha(root);
      const result: GitUploadResult = {
        sha,
        remote: inspected.target.name,
        branch: inspected.branch,
        files: stats.files,
        added: stats.added,
        removed: stats.removed,
        pushed: true,
      };
      this.remember(envelope.commandId, hash, result);
      await this.record(
        root,
        action,
        `上传成功：远端 ${result.remote}，分支 ${result.branch}，提交 ${sha.slice(0, 12)}，` +
          `文件 ${stats.files} 个（+${stats.added}/-${stats.removed}）`,
        'success',
        null,
      );
      return result;
    } catch (error) {
      await this.reportFailure(root, action, error);
      throw error;
    }
  }

  // ── 内部实现 ────────────────────────────────────────────────────────

  private assertEnvelope(envelope: GitCommandEnvelope): void {
    const id = envelope.commandId;
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
      throw new GitUploadError('git_command_failed', 'commandId 非法');
    }
    if (!Number.isInteger(envelope.baseRevision) || envelope.baseRevision < 0) {
      throw new GitUploadError('git_command_failed', 'baseRevision 非法');
    }
  }

  private remember(commandId: string, hash: string, result: GitUploadResult): void {
    this.executed.delete(commandId);
    this.executed.set(commandId, { hash, result });
    while (this.executed.size > 512) {
      const oldest = this.executed.keys().next();
      if (oldest.done === true) break;
      this.executed.delete(oldest.value);
    }
  }

  /**
   * 预检的内部实现：工作区状态 + 远端连通性 + ahead/behind + 分叉判定。
   */
  private async inspect(
    root: string,
    remote: string,
    branch: string | undefined,
    deadline?: number,
  ): Promise<InspectResult> {
    await requireRepository(root);
    const target = await this.resolveRemote(root, remote);
    const status = await this.writer.status(root);
    const branchName = branch ?? status.branch ?? '';
    if (branchName === '') {
      throw new GitUploadError(
        'git_command_failed',
        '无法确定目标分支（当前处于分离头指针状态，请显式指定分支）',
      );
    }
    const safeBranch = assertBranchName(branchName);

    // 远端连通性 + 认证（`27` §10.8.1 第 3、4 步）。
    const credential = await this.credentialContext(target.url);
    let lsRemote: GitRunResult;
    try {
      lsRemote = await runGit({
        root,
        args: ['ls-remote', '--heads', target.name],
        env: credential.env,
        allowFailure: true,
        timeoutMs: Math.min(REMOTE_PROBE_TIMEOUT_MS, remaining(deadline)),
      });
    } finally {
      await credential.dispose();
    }

    const blockers: GitPreflightBlocker[] = [];
    const reachable = lsRemote.code === 0;
    const stderr = lsRemote.stderr;
    const authFailed = reachable === false && isAuthError(stderr);
    const offline = reachable === false && isOfflineError(stderr);
    if (offline) {
      blockers.push({
        kind: 'git_offline',
        code: codeForKind('git_offline'),
        reason: '远端不可达（网络异常或主机无法连接），请检查网络后重试',
      });
    } else if (authFailed) {
      const kind = credential.used ? 'git_auth_failed' : 'git_auth_required';
      blockers.push({
        kind,
        code: codeForKind(kind),
        reason:
          kind === 'git_auth_failed'
            ? '凭据被远端拒绝，请重新输入令牌或改用 SSH'
            : '远端需要凭据但尚未配置，请先配置令牌或改用 SSH',
      });
    }

    const counts = await this.counts(root, target, safeBranch, lsRemote.stdout);
    if (counts.diverged) {
      blockers.push({
        kind: 'git_remote_conflict',
        code: codeForKind('git_remote_conflict'),
        reason:
          `本地分支与远端已分叉（本地独有 ${counts.ahead ?? '?'} 个提交、远端独有 ${counts.behind ?? '?'} 个提交），` +
          '请先拉取或改用新分支；本流程不提供强制推送',
      });
    } else if (counts.stale) {
      blockers.push({
        kind: 'git_remote_conflict',
        code: codeForKind('git_remote_conflict'),
        reason: '远端分支已更新（本地跟踪引用过期），请先拉取后再上传',
      });
    } else if ((counts.behind ?? 0) > 0) {
      blockers.push({
        kind: 'git_remote_conflict',
        code: codeForKind('git_remote_conflict'),
        reason: `本地分支落后远端 ${counts.behind ?? 0} 个提交，请先拉取后再上传`,
      });
    }

    return {
      status,
      target,
      branch: safeBranch,
      ahead: counts.ahead,
      behind: counts.behind,
      diverged: counts.diverged,
      remoteWritable: reachable ? true : authFailed ? false : null,
      online: reachable ? true : offline ? false : null,
      blockers,
    };
  }

  /**
   * ahead / behind / 分叉判定。
   *
   * 口径说明：预检**不做 fetch**（fetch 会改本地引用，属于写操作），
   * 因此计数以"本地远端跟踪引用"为准；若远端真实 sha 与本地跟踪引用不一致，
   * 说明远端已前进，此时保守地判定为"需先拉取"（`stale`），
   * 真正的分叉由推送时的 non-fast-forward 拒绝兜底。
   */
  private async counts(
    root: string,
    target: RemoteTarget,
    branch: string,
    lsRemoteOutput: string,
  ): Promise<{ ahead: number | null; behind: number | null; diverged: boolean; stale: boolean }> {
    const localSha = await this.revParse(root, branch);
    const remoteSha = parseLsRemoteSha(lsRemoteOutput, branch);
    const trackingSha = target.configured ? await this.revParse(root, `${target.name}/${branch}`) : undefined;

    // 远端还没有这个分支：本地提交全部未推送。
    if (remoteSha === undefined) {
      const count = await this.revCount(root, branch);
      return { ahead: count, behind: 0, diverged: false, stale: false };
    }

    // 远端分支存在，但本地跟踪引用过期 → 保守判定"需先拉取"。
    const stale = trackingSha !== undefined && trackingSha !== remoteSha;

    if (trackingSha !== undefined) {
      const parsed = await this.revListCounts(root, `${branch}...${target.name}/${branch}`);
      if (parsed !== undefined) {
        const diverged = parsed.left > 0 && parsed.right > 0;
        return {
          ahead: parsed.left,
          behind: parsed.right,
          diverged: diverged || stale,
          stale,
        };
      }
    }

    // 没有本地跟踪引用，但远端提交对象本地可见（例：刚被别的流程推过）。
    if (remoteSha !== undefined && localSha !== undefined && remoteSha !== localSha) {
      if (await this.hasObject(root, remoteSha)) {
        const parsed = await this.revListCounts(root, `${branch}...${remoteSha}`);
        if (parsed !== undefined) {
          return {
            ahead: parsed.left,
            behind: parsed.right,
            diverged: parsed.left > 0 && parsed.right > 0,
            stale,
          };
        }
      }
    }

    if (localSha === undefined) {
      // 本地分支还没有提交。
      return { ahead: 0, behind: null, diverged: false, stale };
    }
    if (localSha === remoteSha) {
      return { ahead: 0, behind: 0, diverged: false, stale };
    }
    return { ahead: null, behind: null, diverged: false, stale };
  }

  private async revParse(root: string, ref: string): Promise<string | undefined> {
    const result = await runGit({ root, args: ['rev-parse', '--verify', '--quiet', ref], allowFailure: true });
    const value = result.stdout.trim();
    return result.code === 0 && value !== '' ? value : undefined;
  }

  private async revCount(root: string, ref: string): Promise<number> {
    const result = await runGit({ root, args: ['rev-list', '--count', ref], allowFailure: true });
    const value = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(value) ? value : 0;
  }

  private async hasObject(root: string, sha: string): Promise<boolean> {
    const result = await runGit({ root, args: ['cat-file', '-e', `${sha}^{commit}`], allowFailure: true });
    return result.code === 0;
  }

  /** `git rev-list --left-right --count A...B` → left（A 独有）/ right（B 独有）。 */
  private async revListCounts(
    root: string,
    range: string,
  ): Promise<{ left: number; right: number } | undefined> {
    const result = await runGit({
      root,
      args: ['rev-list', '--left-right', '--count', range],
      allowFailure: true,
    });
    if (result.code !== 0) return undefined;
    const parts = result.stdout.trim().split(/\s+/);
    const left = Number.parseInt(parts[0] ?? '', 10);
    const right = Number.parseInt(parts[1] ?? '', 10);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return undefined;
    return { left, right };
  }

  /**
   * 解析远端名。
   *
   * 优先用**配置过的远端名**（`git remote` 列表内的名字）；
   * 其次接受一个安全的 URL（`assertSafeRemoteUrl`），展示时剥离内嵌凭据。
   */
  private async resolveRemote(root: string, remote: string): Promise<RemoteTarget> {
    const value = remote.trim();
    if (value === '') throw new GitUploadError('git_command_failed', '远端不能为空');
    if (value.startsWith('-')) throw new GitUploadError('git_unsafe', '远端名不能以 "-" 开头');
    const remotes = await runGit({ root, args: ['remote'], allowFailure: true });
    const names = remotes.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (names.includes(value)) {
      const getUrl = await runGit({ root, args: ['remote', 'get-url', value], allowFailure: true });
      const url = getUrl.code === 0 ? getUrl.stdout.trim().split('\n')[0]?.trim() ?? '' : '';
      return {
        name: value,
        url: url === '' ? value : url,
        display: url === '' ? value : sanitizeRemoteUrl(url),
        configured: true,
      };
    }
    if (/^[A-Za-z0-9._-]+$/.test(value)) {
      throw new GitUploadError('git_command_failed', `远端未配置：${value}`);
    }
    const url = assertSafeRemoteUrl(value);
    return { name: url, url, display: sanitizeRemoteUrl(url), configured: false };
  }

  /** 推送参数：**只接受 remote + branch**，可选 `-u`（仅配置过的远端）。 */
  private async pushArgs(root: string, target: RemoteTarget, branch: string): Promise<string[]> {
    const args = ['push'];
    if (target.configured) {
      const upstream = await runGit({
        root,
        args: ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`],
        allowFailure: true,
      });
      if (upstream.code !== 0) args.push('-u');
    }
    args.push(target.name, branch);
    return args;
  }

  /**
   * 凭据注入。
   *
   * - HTTPS/HTTP：`GIT_ASKPASS` → 临时助手脚本（`0700`，脚本从环境变量读凭据）；
   * - SSH：临时私钥文件（`0600`）+ `IdentitiesOnly=yes`；
   * - 两者都用完立即删除（`27` §10.9 红线 3）。
   */
  private async credentialContext(remoteUrl: string): Promise<CredentialContext> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'liwencode-git-cred-'));
    await fs.chmod(dir, 0o700);
    let disposed = false;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => { /* 忽略清理失败 */ });
    };
    try {
      const kind = remoteKind(remoteUrl);
      if (kind === 'https') {
        const secret = await this.readSecret(remoteHost(remoteUrl), 'token');
        if (secret === undefined) return { env: helperDisabledEnv(), used: false, dispose };
        const script = path.join(dir, 'askpass.sh');
        await fs.writeFile(script, ASKPASS_SCRIPT, { encoding: 'utf8', mode: 0o700 });
        await fs.chmod(script, 0o700);
        const { username, password } = splitSecret(secret);
        return {
          env: {
            GIT_ASKPASS: script,
            LIWENCODE_GIT_USERNAME: username,
            LIWENCODE_GIT_PASSWORD: password,
            ...helperDisabledEnv(),
          },
          used: true,
          dispose,
        };
      }
      if (kind === 'ssh') {
        const secret = await this.readSecret(remoteHost(remoteUrl), 'ssh-key');
        if (secret === undefined) return { env: helperDisabledEnv(), used: false, dispose };
        const keyFile = path.join(dir, 'id_key');
        await fs.writeFile(keyFile, secret.endsWith('\n') ? secret : `${secret}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
        await fs.chmod(keyFile, 0o600);
        const knownHosts = path.join(dir, 'known_hosts');
        return {
          env: {
            GIT_SSH_COMMAND:
              `ssh -i ${keyFile} -o IdentitiesOnly=yes -o BatchMode=yes ` +
              `-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${knownHosts}`,
            GIT_SSH_VARIANT: 'ssh',
            ...helperDisabledEnv(),
          },
          used: true,
          dispose,
        };
      }
      return { env: helperDisabledEnv(), used: false, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  }

  /** 读一次凭据（只在执行 git 命令前调用一次，不缓存）。 */
  private async readSecret(host: string, method: 'token' | 'ssh-key'): Promise<string | undefined> {
    const provider = this.credentials;
    if (provider === undefined) return undefined;
    if (!(await provider.available())) return undefined;
    const entry = keychainEntryFor(host, method);
    const value = await provider.get(entry);
    if (value === undefined || value.trim() === '') return undefined;
    return value;
  }

  /** 把 git 的失败翻译成上传语义（远端冲突 / 未配凭据 / 凭据被拒 / 离线）。 */
  private mapPushError(error: unknown, usedCredentials: boolean): unknown {
    if (!(error instanceof GitError)) return error;
    if (error.kind !== 'git_command_failed') return error;
    const stderr = error.stderrTail ?? '';
    const extra: { exitCode?: number; stderrTail?: string } = {};
    if (error.exitCode !== undefined) extra.exitCode = error.exitCode;
    if (stderr !== '') extra.stderrTail = stderr;
    if (isConflictError(stderr)) {
      return new GitUploadError(
        'git_remote_conflict',
        '远端拒绝了推送：分支已分叉或落后，请先拉取或改用新分支（本流程不提供强制推送）',
        extra,
      );
    }
    if (isAuthError(stderr)) {
      return usedCredentials
        ? new GitUploadError('git_auth_failed', '远端拒绝了凭据，请重新输入令牌或改用 SSH', extra)
        : new GitUploadError('git_auth_required', '远端需要凭据但尚未配置，请先配置令牌或改用 SSH', extra);
    }
    if (isOfflineError(stderr)) {
      return new GitUploadError('git_offline', '远端不可达（网络异常），请检查网络后重试', extra);
    }
    return error;
  }

  private async currentRevision(root: string): Promise<number> {
    const status = await this.writer.status(root);
    return status.revision;
  }

  private async headSha(root: string): Promise<string> {
    const result = await runGit({ root, args: ['rev-parse', 'HEAD'], allowFailure: true });
    const sha = result.stdout.trim();
    if (result.code !== 0 || sha === '') {
      throw new GitUploadError('git_command_failed', '无法读取 HEAD', {
        exitCode: result.code,
        stderrTail: result.stderr,
      });
    }
    return sha;
  }

  private async recordIntent(root: string, action: string, detail: string): Promise<void> {
    await this.write(root, `${action}.attempt`, detail, 'success', null);
  }

  private async record(
    root: string,
    action: string,
    detail: string,
    result: 'success' | 'failed',
    code: number | null,
  ): Promise<void> {
    try {
      await this.write(root, action, detail, result, code);
    } catch {
      // 审计落点异常不改写操作结果。
    }
  }

  private async reportFailure(root: string, action: string, error: unknown): Promise<void> {
    const code = error instanceof GitError ? dhpCodeForGitError(error) : null;
    const message = error instanceof Error ? error.message : String(error);
    await this.record(root, action, `失败：${message}`, 'failed', code);
  }

  private async write(
    root: string,
    action: string,
    detail: string,
    result: 'success' | 'failed',
    code: number | null,
  ): Promise<void> {
    const sink = this.audit;
    if (sink === undefined) return;
    await sink({
      at: Date.now(),
      workspaceRoot: root,
      action,
      detail: safeDetail(detail),
      result,
      code,
    });
  }
}

// ── 小工具 ────────────────────────────────────────────────────────────

/** 助手脚本：凭据只从环境变量读，脚本本身不含任何凭据（`27` §10.8.4）。 */
const ASKPASS_SCRIPT = [
  '#!/bin/sh',
  '# LIWENCode 临时 GIT_ASKPASS 助手：凭据只从环境变量读取，执行后立即删除。',
  'case "$1" in',
  "  *[Uu]sername*) printf '%s\\n' \"$LIWENCODE_GIT_USERNAME\" ;;",
  "  *) printf '%s\\n' \"$LIWENCODE_GIT_PASSWORD\" ;;",
  'esac',
  '',
].join('\n');

/** 禁用 git 自带的凭据助手（避免写入 `~/.git-credentials`）。 */
function helperDisabledEnv(): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
  };
}

/** 远端类型。 */
function remoteKind(url: string): 'https' | 'ssh' | 'local' {
  if (/^https?:\/\//i.test(url)) return 'https';
  if (/^ssh:\/\//i.test(url)) return 'ssh';
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/.test(url)) return 'ssh';
  return 'local';
}

/** 远端主机名（用于钥匙串条目）。 */
function remoteHost(url: string): string {
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/.test(url)) {
    const match = /^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):/.exec(url);
    return match?.[1] ?? 'unknown';
  }
  try {
    return new URL(url).host || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 凭据值可能是 `user:token` 或单纯令牌。 */
function splitSecret(secret: string): { username: string; password: string } {
  const value = secret.trim();
  const index = value.indexOf(':');
  if (index > 0) {
    const username = value.slice(0, index);
    const password = value.slice(index + 1);
    return { username: username === '' ? 'git' : username, password };
  }
  return { username: 'x-access-token', password: value };
}

/** 从 `git ls-remote --heads` 的输出里取某个分支的 sha。 */
function parseLsRemoteSha(output: string, branch: string): string | undefined {
  const wanted = `refs/heads/${branch}`;
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const sha = parts[0];
    const ref = parts[1];
    if (sha !== undefined && ref === wanted) return sha;
  }
  return undefined;
}

/** 范围统计：`all` 统计全部未提交改动，`session` 只统计已暂存（本会话）的改动。 */
function summarize(status: GitStatusResult, scope: UploadScope): { files: number; added: number; removed: number } {
  const entries = scope === 'session' ? status.files.filter((f) => f.staged) : status.files;
  let added = 0;
  let removed = 0;
  for (const entry of entries) {
    added += entry.added ?? 0;
    removed += entry.removed ?? 0;
  }
  return { files: entries.length, added, removed };
}

/** 是否需要先提交。 */
function needsCommit(status: GitStatusResult, scope: UploadScope): boolean {
  if (scope === 'session') return status.files.some((f) => f.staged);
  return !status.clean;
}

function remaining(deadline: number | undefined): number {
  if (deadline === undefined) return REMOTE_PROBE_TIMEOUT_MS;
  return Math.max(1_000, deadline - Date.now());
}

function isAuthError(stderr: string): boolean {
  return /Authentication failed|could not read Username|could not read Password|Invalid username or password|Permission denied \(publickey\)|terminal prompts disabled/i.test(
    stderr,
  );
}

function isConflictError(stderr: string): boolean {
  return /non-fast-forward|fetch first|\[rejected\]|cannot push to unqualified destination|stale info/i.test(stderr);
}

function isOfflineError(stderr: string): boolean {
  return /Could not resolve host|Name or service not known|Network is unreachable|Connection refused|failed to connect|Operation timed out|Connection timed out/i.test(
    stderr,
  );
}

/** 预检阻塞项 → DHP 错误种类。 */
function blockerKind(kind: string): DhpErrorKind {
  switch (kind) {
    case 'git_remote_conflict':
      return 'git_remote_conflict';
    case 'git_auth_required':
      return 'git_auth_required';
    case 'git_auth_failed':
      return 'git_auth_failed';
    case 'git_offline':
      return 'git_offline';
    default:
      return 'git_command_failed';
  }
}

/** 上传语义失败 → `GitFailureKind` 里的兜底值（真正的种类在 `dhpKind`）。 */
function baseKindFor(kind: DhpErrorKind): GitError['kind'] {
  switch (kind) {
    case 'git_offline':
      return 'git_offline';
    case 'git_unavailable':
      return 'git_unavailable';
    case 'git_not_repo':
      return 'git_not_repo';
    case 'git_unsafe':
      return 'git_unsafe';
    default:
      return 'git_command_failed';
  }
}
