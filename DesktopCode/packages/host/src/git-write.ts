/**
 * Git 写操作服务（`27` §10.5 / FR-N-025）。
 *
 * 职责边界：
 *  - 本文件只做"**不出本机**"的写操作：暂存 / 取消暂存 / 提交 / 建分支 / 切分支；
 *  - 会把代码送出本机的上传在 `git-upload.ts`（`27` §10.8–§10.9）。
 *
 * 三条不可让步的原则（`27` §10.5.2）：
 *  1. **触发者必须是用户**：本服务不提供模型可调用的入口，host.ts 只从 DHP 的
 *     用户路径调用（`27` §12 矩阵最后两行）。
 *  2. **二次确认 + 审计**：每次执行前后各写一条审计记录；执行前那条写不进去
 *     就**不执行副作用**（`27` §10.9 门禁 8）。
 *  3. **失败可恢复**：失败不改工作区状态，错误一律以 `GitError` 抛出，
 *     由 host.ts 映射成 DHP 错误码。
 *
 * 命令信封（`27` §5.1，六态 ACK 的语义子集）：
 *  - `baseRevision` 与当前 Git 状态版本不符 → `stale`（客户端刷新后重试）；
 *  - 同一 `commandId` 重复提交 → `duplicate`，**且不重复执行副作用**；
 *  - 成功 → `accepted`。
 *
 * 幂等窗口由本服务自己维护（`Map<commandId, {hash, result}>`）：
 *  - 同 `commandId` + 同内容 → `duplicate`；
 *  - 同 `commandId` + 不同内容 → `rejected`（不执行）。
 *
 * 安全姿态：
 *  - 全部 git 调用走 `runGit({ write: true })`，子命令白名单与危险参数拒绝
 *    由 `git-run.ts` 统一把关（`--force` / `-C` / `--git-dir` 等 → `git_unsafe`）；
 *  - 路径参数先过 `assertRelativePath()`（绝对路径 / `..` 逃逸直接拒绝）；
 *  - 分支名先过 `assertBranchName()`（防止 `-d` 之类被 git 当成选项）；
 *  - 审计 `detail` 一律过 `redactSecret` + `redact`，不含凭据、长度与片段。
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { codeForKind, type GitAckResult, type GitStatusResult } from '@syaocode/dhp';
import { type CredentialProvider, redactSecret } from './credentials.ts';
import { GitError, assertRelativePath, redact, requireRepository, runGit } from './git-run.ts';

/** 写操作信封（`27` §5.1）。 */
export interface GitCommandEnvelope {
  readonly commandId: string;
  readonly baseRevision: number;
}

/**
 * Git 状态读取口。
 *
 * 由 `git-service.ts` 的 `GitService` 直接实现（它已经有 `status(root)`），
 * 本文件**不 import** 实现类，只消费这个结构化接口。
 */
export interface GitStatusReader {
  status(root: string): Promise<GitStatusResult>;
}

/** 一条审计记录（`27` §10.9 的字段表）。 */
export interface GitAuditRecord {
  /** 写入时间戳（毫秒）。 */
  readonly at: number;
  readonly workspaceRoot: string;
  /** 操作名，如 `git.commit`；执行前的那条带 `.attempt` 后缀。 */
  readonly action: string;
  /** 人类可读摘要（已脱敏，不含凭据）。 */
  readonly detail: string;
  readonly result: 'success' | 'failed';
  /** DHP 错误码；成功或无错误码时为 `null`。 */
  readonly code: number | null;
}

/** 审计落点（host.ts 接审计文件 / 审计流）。 */
export interface GitAuditSink {
  (record: GitAuditRecord): void | Promise<void>;
}

export interface GitWriteOptions {
  readonly reader: GitStatusReader;
  /** 凭据存储（本机的写操作不需要凭据，保留字段是为了让 host.ts 统一接线）。 */
  readonly credentials?: CredentialProvider;
  readonly audit?: GitAuditSink;
}

/** 幂等窗口最多保留多少条记录（超出后按先进先出淘汰）。 */
const MAX_IDEMPOTENCY_ENTRIES = 512;

/** 审计 `detail` 的最大长度（超出截断，避免把整屏内容写进审计）。 */
const MAX_DETAIL_CHARS = 1500;

interface ExecutedCommand {
  readonly hash: string;
  readonly result: GitAckResult;
}

type Prepared =
  | { readonly ok: true; readonly revision: number; readonly status: GitStatusResult }
  | { readonly ok: false; readonly reply: GitAckResult };

/**
 * Git 写操作服务。
 *
 * 用法（host.ts）：`new GitWriteService({ reader, credentials, audit })`，
 * 然后按 DHP 方法逐个转发 `stage` / `unstage` / `commit` / `createBranch` /
 * `switchBranch`。
 */
/**
 * 这条 stderr 是否表示"签名失败"（`27` §10.5.3）。
 *
 * 只做保守匹配：宁可不匹配（退回 `git_command_failed`）也不要把普通失败误判成签名问题——
 * 误判会让界面给出"无签名提交"这个危险选项。
 */
export function isSigningFailure(stderr: string | undefined): boolean {
  if (stderr === undefined || stderr === '') return false;
  const text = stderr.toLowerCase();
  const signatures = [
    'gpg failed to sign',
    'failed to write commit object',
    'error: gpg failed',
    'signing failed',
    'gpg: signing failed',
    'could not sign',
    'ssh signing',
  ];
  return signatures.some((needle) => text.includes(needle));
}

export class GitWriteService {
  private readonly reader: GitStatusReader;
  private readonly credentials: CredentialProvider | undefined;
  private readonly audit: GitAuditSink | undefined;
  /** 幂等窗口：`commandId` → 请求哈希与首次执行结果。 */
  private readonly executed = new Map<string, ExecutedCommand>();

  constructor(opts: GitWriteOptions) {
    this.reader = opts.reader;
    this.credentials = opts.credentials;
    this.audit = opts.audit;
  }

  /** 凭据存储（host.ts 用于判断"本次不持久化"提示）。 */
  get credentialProvider(): CredentialProvider | undefined {
    return this.credentials;
  }

  /**
   * 状态读取透传。
   *
   * 上传流程（`git-upload.ts`）需要**同一口径**的 `revision` / `clean` / `files`，
   * 所以由写操作服务把注入进来的 `reader` 透出去，而不是再实现一份口径。
   */
  async status(root: string): Promise<GitStatusResult> {
    return await this.reader.status(root);
  }

  /** 暂存：`git add -- <paths>`。 */
  async stage(root: string, paths: readonly string[], envelope: GitCommandEnvelope): Promise<GitAckResult> {
    const action = 'git.stage';
    try {
      this.assertEnvelope(envelope);
      if (paths.length === 0) return await this.reject(root, action, envelope, '没有指定要暂存的路径');
      const safePaths = paths.map((p) => assertRelativePath(p));
      const hash = requestHash(action, root, { paths: safePaths });
      const prepared = await this.prepare(root, envelope, hash);
      if (!prepared.ok) {
        await this.record(root, action, `未执行（${prepared.reply.status}）：${prepared.reply.reason ?? ''}`, 'failed', null);
        return prepared.reply;
      }
      await this.recordIntent(root, action, `准备暂存 ${safePaths.length} 个路径`);
      await runGit({ root, args: ['add', '--', ...safePaths], write: true });
      const revision = await this.currentRevision(root);
      const result: GitAckResult = {
        commandId: envelope.commandId,
        status: 'accepted',
        revision,
        data: { paths: safePaths.length },
      };
      this.remember(envelope.commandId, hash, result);
      await this.record(root, action, `已暂存 ${safePaths.length} 个路径`, 'success', null);
      return result;
    } catch (error) {
      await this.reportFailure(root, action, error);
      throw error;
    }
  }

  /** 取消暂存：`git restore --staged -- <paths>`。 */
  async unstage(root: string, paths: readonly string[], envelope: GitCommandEnvelope): Promise<GitAckResult> {
    const action = 'git.unstage';
    try {
      this.assertEnvelope(envelope);
      if (paths.length === 0) return await this.reject(root, action, envelope, '没有指定要取消暂存的路径');
      const safePaths = paths.map((p) => assertRelativePath(p));
      const hash = requestHash(action, root, { paths: safePaths });
      const prepared = await this.prepare(root, envelope, hash);
      if (!prepared.ok) {
        await this.record(root, action, `未执行（${prepared.reply.status}）：${prepared.reply.reason ?? ''}`, 'failed', null);
        return prepared.reply;
      }
      await this.recordIntent(root, action, `准备取消暂存 ${safePaths.length} 个路径`);
      await runGit({ root, args: ['restore', '--staged', '--', ...safePaths], write: true });
      const revision = await this.currentRevision(root);
      const result: GitAckResult = {
        commandId: envelope.commandId,
        status: 'accepted',
        revision,
        data: { paths: safePaths.length },
      };
      this.remember(envelope.commandId, hash, result);
      await this.record(root, action, `已取消暂存 ${safePaths.length} 个路径`, 'success', null);
      return result;
    } catch (error) {
      await this.reportFailure(root, action, error);
      throw error;
    }
  }

  /**
   * 提交：`git commit -m <message>`。
   *
   * - `includeUnstaged` → 追加 `-a`；
   * - `noVerify` → 追加 `--no-verify`，且审计 `detail` 里必须出现"已跳过钩子"；
   * - 提交信息为空/只有空白 → `rejected`；
   * - 钩子失败 → git 非零退出，抛 `GitError`（`git_command_failed`），
   *   **不产生提交**，工作区状态不变（TC-N-048）。
   */
  async commit(
    root: string,
    message: string,
    envelope: GitCommandEnvelope,
    opts?: { includeUnstaged?: boolean; noVerify?: boolean; allowEmpty?: boolean; noSign?: boolean },
  ): Promise<GitAckResult> {
    const action = 'git.commit';
    const includeUnstaged = opts?.includeUnstaged === true;
    const noVerify = opts?.noVerify === true;
    const allowEmpty = opts?.allowEmpty === true;
    const noSign = opts?.noSign === true;
    try {
      this.assertEnvelope(envelope);
      const text = message.trim();
      if (text.length === 0) return await this.reject(root, action, envelope, '提交信息不能为空');
      const hash = requestHash(action, root, { message: text, includeUnstaged, noVerify, allowEmpty, noSign });
      const prepared = await this.prepare(root, envelope, hash);
      if (!prepared.ok) {
        await this.record(root, action, `未执行（${prepared.reply.status}）：${prepared.reply.reason ?? ''}`, 'failed', null);
        return prepared.reply;
      }
      const notes: string[] = [];
      if (includeUnstaged) notes.push('包含未暂存改动');
      if (noVerify) notes.push('已跳过钩子');
      if (allowEmpty) notes.push('允许空提交');
      // `noSign` 只可能在用户看到签名失败后显式选择；审计里必须留痕。
      if (noSign) notes.push('本次未签名（用户显式选择）');
      await this.recordIntent(
        root,
        action,
        `准备提交${notes.length > 0 ? `（${notes.join('，')}）` : ''}`,
      );
      const command = await this.commitCommand(text, includeUnstaged, noVerify, allowEmpty, noSign);
      try {
        await runGit({ root, args: command.args, write: true });
      } finally {
        await command.dispose();
      }
      const sha = await this.headSha(root);
      const revision = await this.currentRevision(root);
      const result: GitAckResult = {
        commandId: envelope.commandId,
        status: 'accepted',
        revision,
        data: { sha },
      };
      this.remember(envelope.commandId, hash, result);
      await this.record(
        root,
        action,
        `提交成功：${sha.slice(0, 12)}${noVerify ? '（已跳过钩子）' : ''}${noSign ? '（未签名）' : ''}`,
        'success',
        null,
      );
      return result;
    } catch (error) {
      // 签名失败必须是**独立 kind**：界面要给出"重试 / 无签名提交 / 取消"三选一，
      // 而不是把它混进 git_command_failed 让用户以为"提交坏了"。
      if (error instanceof GitError && error.kind === 'git_command_failed' && isSigningFailure(error.stderrTail)) {
        const signing = new GitError('git_signing_failed', 'commit signing failed; choose retry, unsigned commit, or cancel', {
          ...(error.exitCode !== undefined ? { exitCode: error.exitCode } : {}),
          ...(error.stderrTail !== undefined ? { stderrTail: error.stderrTail } : {}),
        });
        await this.reportFailure(root, action, signing);
        throw signing;
      }
      await this.reportFailure(root, action, error);
      throw error;
    }
  }

  /**
   * 新建分支：`git branch <name>`，`checkout` 时再 `git switch <name>`。
   *
   * 注意：新分支指向当前 HEAD，**文件内容不变**，因此不适用"工作区干净"这条
   * 前置条件（`27` §10.5.1 的"新建分支"行只要求"分支名合法且不重名"）。
   */
  async createBranch(
    root: string,
    name: string,
    envelope: GitCommandEnvelope,
    opts?: { checkout?: boolean },
  ): Promise<GitAckResult> {
    const action = 'git.branch.create';
    const checkout = opts?.checkout === true;
    try {
      this.assertEnvelope(envelope);
      const branch = assertBranchName(name);
      const hash = requestHash(action, root, { branch, checkout });
      const prepared = await this.prepare(root, envelope, hash);
      if (!prepared.ok) {
        await this.record(root, action, `未执行（${prepared.reply.status}）：${prepared.reply.reason ?? ''}`, 'failed', null);
        return prepared.reply;
      }
      await this.recordIntent(root, action, `准备创建分支 ${branch}${checkout ? '（并切换过去）' : ''}`);
      await runGit({ root, args: ['branch', branch], write: true });
      if (checkout) await runGit({ root, args: ['switch', branch], write: true });
      const revision = await this.currentRevision(root);
      const result: GitAckResult = {
        commandId: envelope.commandId,
        status: 'accepted',
        revision,
        data: { branch },
      };
      this.remember(envelope.commandId, hash, result);
      await this.record(root, action, `已创建分支 ${branch}${checkout ? '并已切换' : ''}`, 'success', null);
      return result;
    } catch (error) {
      await this.reportFailure(root, action, error);
      throw error;
    }
  }

  /**
   * 切换分支：`git switch <name>`。
   *
   * 工作区有未提交改动时**拒绝并说明**（TC-N-047）：
   * 不自动 stash，也不强行切换。
   */
  async switchBranch(root: string, name: string, envelope: GitCommandEnvelope): Promise<GitAckResult> {
    const action = 'git.branch.switch';
    try {
      this.assertEnvelope(envelope);
      const branch = assertBranchName(name);
      const hash = requestHash(action, root, { branch });
      const prepared = await this.prepare(root, envelope, hash);
      if (!prepared.ok) {
        await this.record(root, action, `未执行（${prepared.reply.status}）：${prepared.reply.reason ?? ''}`, 'failed', null);
        return prepared.reply;
      }
      if (!prepared.status.clean) {
        const names = prepared.status.files.slice(0, 5).map((f) => f.path).join('、');
        return await this.reject(
          root,
          action,
          envelope,
          `工作区存在未提交改动（${prepared.status.files.length} 个文件${names === '' ? '' : `：${names}`}），切换分支被拒绝；请先提交或暂存后再切换`,
        );
      }
      await this.recordIntent(root, action, `准备切换到分支 ${branch}`);
      await runGit({ root, args: ['switch', branch], write: true });
      const revision = await this.currentRevision(root);
      const result: GitAckResult = {
        commandId: envelope.commandId,
        status: 'accepted',
        revision,
        data: { branch },
      };
      this.remember(envelope.commandId, hash, result);
      await this.record(root, action, `已切换到分支 ${branch}`, 'success', null);
      return result;
    } catch (error) {
      await this.reportFailure(root, action, error);
      throw error;
    }
  }

  // ── 内部实现 ────────────────────────────────────────────────────────

  /** 校验信封（host.ts 还会用 DHP schema 校验一遍，这里是第二道闸）。 */
  private assertEnvelope(envelope: GitCommandEnvelope): void {
    const id = envelope.commandId;
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
      throw new GitError('git_unsafe', 'commandId 非法');
    }
    if (!Number.isInteger(envelope.baseRevision) || envelope.baseRevision < 0) {
      throw new GitError('git_unsafe', 'baseRevision 非法');
    }
  }

  /**
   * 幂等 + CAS 前置检查。
   *
   * 顺序很重要：**先查幂等，再查 CAS**——否则一次成功的提交之后 revision 已经
   * 前进，重放同一个 `commandId` 会被判成 `stale`，而不是幂等的 `duplicate`。
   */
  private async prepare(root: string, envelope: GitCommandEnvelope, hash: string): Promise<Prepared> {
    const executed = this.executed.get(envelope.commandId);
    if (executed !== undefined) {
      const revision = await this.currentRevision(root);
      if (executed.hash !== hash) {
        return {
          ok: false,
          reply: {
            commandId: envelope.commandId,
            status: 'rejected',
            revision,
            reason: '命令 ID 已被另一个请求占用',
          },
        };
      }
      return {
        ok: false,
        reply: {
          commandId: envelope.commandId,
          status: 'duplicate',
          revision,
          reason: '该命令已执行过（幂等命中，未重复执行）',
        },
      };
    }
    await requireRepository(root);
    const status = await this.reader.status(root);
    if (status.revision !== envelope.baseRevision) {
      return {
        ok: false,
        reply: {
          commandId: envelope.commandId,
          status: 'stale',
          revision: status.revision,
          reason: '工作区状态已变化（基线版本不符），请刷新后重试',
        },
      };
    }
    return { ok: true, revision: status.revision, status };
  }

  /** 业务规则拒绝（空提交信息、有未提交改动时切分支……）。 */
  private async reject(
    root: string,
    action: string,
    envelope: GitCommandEnvelope,
    reason: string,
  ): Promise<GitAckResult> {
    const revision = await this.currentRevision(root);
    const result: GitAckResult = {
      commandId: envelope.commandId,
      status: 'rejected',
      revision,
      reason,
    };
    await this.record(root, action, `已拒绝：${reason}`, 'failed', null);
    return result;
  }

  /** 记录一次成功执行（幂等窗口只记成功；失败允许原 `commandId` 重试）。 */
  private remember(commandId: string, hash: string, result: GitAckResult): void {
    this.executed.delete(commandId);
    this.executed.set(commandId, { hash, result });
    while (this.executed.size > MAX_IDEMPOTENCY_ENTRIES) {
      const oldest = this.executed.keys().next();
      if (oldest.done === true) break;
      this.executed.delete(oldest.value);
    }
  }

  private async currentRevision(root: string): Promise<number> {
    const status = await this.reader.status(root);
    return status.revision;
  }

  private async headSha(root: string): Promise<string> {
    const result = await runGit({ root, args: ['rev-parse', 'HEAD'], allowFailure: true });
    const sha = result.stdout.trim();
    if (result.code !== 0 || sha === '') {
      throw new GitError('git_command_failed', '无法读取 HEAD', { exitCode: result.code, stderrTail: result.stderr });
    }
    return sha;
  }

  /**
   * 组装 `git commit` 参数。
   *
   * 单行信息用 `-m`；**多行**信息用 `--file=<临时文件>`——`git-run.ts` 的参数
   * 检查会拒绝带换行的参数（防止把内容当参数解释），而多行提交信息是常见需求。
   * 注意这里**不能**用短选项 `-F`：安全层会把参数统一小写后比对禁止项，
   * `-F` 会命中 `-f`（force）而被拒绝。临时文件 `0600`，用完立即删除。
   */
  private async commitCommand(
    message: string,
    includeUnstaged: boolean,
    noVerify: boolean,
    allowEmpty: boolean,
    noSign: boolean,
  ): Promise<{ args: string[]; dispose: () => Promise<void> }> {
    const args = ['commit'];
    if (includeUnstaged) args.push('-a');
    if (noVerify) args.push('--no-verify');
    if (allowEmpty) args.push('--allow-empty');
    // 签名失败**绝不静默降级**：只有用户在失败面板里显式选择"无签名提交"才走到这里。
    if (noSign) args.push('--no-gpg-sign');
    if (!/[\r\n]/.test(message)) {
      args.push('-m', message);
      return { args, dispose: async () => { /* 无临时文件 */ } };
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'syaocode-git-msg-'));
    await fs.chmod(dir, 0o700);
    const file = path.join(dir, 'message.txt');
    await fs.writeFile(file, message, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(file, 0o600);
    args.push(`--file=${file}`);
    return {
      args,
      dispose: async () => {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => { /* 忽略清理失败 */ });
      },
    };
  }

  /**
   * 执行前的"意图"审计记录。
   *
   * 这条写失败会**抛出**——`27` §10.9 门禁 8："记录失败则不执行"。
   */
  private async recordIntent(root: string, action: string, detail: string): Promise<void> {
    await this.write(root, `${action}.attempt`, detail, 'success', null);
  }

  /** 执行后的结果记录（写失败不影响已经发生的操作，不覆盖原始错误）。 */
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
      // 审计落点异常：结果记录写不进去不能反过来改写操作的真实结果。
    }
  }

  private async reportFailure(root: string, action: string, error: unknown): Promise<void> {
    const code = error instanceof GitError ? codeForKind(error.kind) : null;
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

/**
 * 分支名校验。
 *
 * 除了 git 的 `check-ref-format` 规则，还额外拒绝"以 `-` 开头"的名字——
 * 否则 `git branch -d <name>` 会被当成**删除分支**（`27` §12 红线：写操作
 * 不得越出用户明确表达的范围）。
 */
export function assertBranchName(name: string): string {
  const value = name.trim();
  if (value.length === 0 || value.length > 255) throw new GitError('git_unsafe', '分支名为空或过长');
  if (/[\0\r\n\t ]/.test(value)) throw new GitError('git_unsafe', '分支名包含非法字符');
  if (value.startsWith('-')) throw new GitError('git_unsafe', '分支名不能以 "-" 开头');
  if (value.includes('..') || value.includes('//') || value.includes('@{')) {
    throw new GitError('git_unsafe', '分支名包含非法序列');
  }
  if (value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) {
    throw new GitError('git_unsafe', '分支名结尾非法');
  }
  if (/[~^:?*[\\]/.test(value)) throw new GitError('git_unsafe', '分支名包含非法字符');
  if (value.startsWith('/') || value.startsWith('.')) throw new GitError('git_unsafe', '分支名不能以 "/" 或 "." 开头');
  return value;
}

/** 请求哈希：同 `commandId` + 同内容 → 幂等命中；同 id 不同内容 → 拒绝。 */
export function requestHash(action: string, root: string, payload: unknown): string {
  return createHash('sha256').update(JSON.stringify({ action, root, payload })).digest('hex');
}

/** 审计文本脱敏：截断 → 去掉凭据形态 → 去掉 URL 内嵌凭据。 */
export function safeDetail(detail: string): string {
  const clipped = detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS)}…` : detail;
  return redactSecret(redact(clipped));
}
