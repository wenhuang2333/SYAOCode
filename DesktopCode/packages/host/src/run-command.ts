/**
 * `!` 前缀直接执行命令（FR-N-036）。
 *
 * 这个模块**只负责"怎么跑"**，不负责"能不能跑"：
 * 放行判断全部来自内核的权限引擎（`engine.checkSubject`），桌面端不另起一套规则。
 *
 * 为什么必须复用内核闸门（`27` §4.4：「`!` 前缀执行 shell（仍过权限闸门）」）：
 *  - 内核有**危险命令规则库**（`SY-PERM-004`），桌面端自己写一份必然漏；
 *  - 内核对**敏感路径**（工作区密钥、凭据目录）强制询问且不可记忆；
 *  - 内核的四种权限模式（plan / strict / default / acceptEdits / bypass）
 *    在这里必须**原样生效**，否则 `!` 就成了绕过审批的后门。
 *
 * 执行侧的三条硬约束：
 *  1. **工作区围栏**：cwd 固定为该会话的工作区根；
 *  2. **超时**：默认 60 s（与 CLI 的 `!` 一致），超时杀掉整个进程组；
 *  3. **输出上限**：stdout/stderr 各 256 KiB，超出即截断并标记 `truncated`。
 *
 * 每次执行都写审计（成功与失败都记），审计里**不含**凭据。
 */

import type { Runtime } from '@liwencode/core';

/** 单次执行的输出上限（字节）。超出部分丢弃并标记截断。 */
export const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;

/** 默认超时（毫秒）。与 CLI 的 `!` 行为一致（60 s）。 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/** 审计条目（**不含**任何凭据值）。 */
export interface CommandAuditRecord {
  readonly at: number;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly command: string;
  readonly result: 'success' | 'failed' | 'denied';
  readonly exitCode: number | null;
  readonly detail: string;
}

export interface RunCommandOptions {
  /** 执行用的运行时（提供 `shell.spawn`）。 */
  readonly runtime: Runtime;
  /** 审计 sink。 */
  readonly audit?: (record: CommandAuditRecord) => void;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** 时钟（测试可注入假时钟）。 */
  readonly now?: () => number;
}

export interface RunCommandInput {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  /** 命令原文（不含前导 `!`）。 */
  readonly command: string;
  /**
   * 放行判定。**由内核权限引擎提供**（`engine.checkSubject`）。
   *
   * 返回 `allowed: false` 时命令**一条都不执行**，调用方负责把原因报给用户。
   */
  readonly allow: () => Promise<{ allowed: boolean; reason: string | null }>;
}

export interface RunCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

/** 命令长度上限：够写正常的构建/测试命令，又不至于让审计条目失控。 */
export const MAX_COMMAND_LENGTH = 4096;

/**
 * 执行一条已获准的命令。
 *
 * 失败一律**抛错**（不返回半成品），由 Host 映射成 DHP 错误：
 *  - 未获准 → `command_denied`（`-32047`）；
 *  - 超时 → `timed_out`；
 *  - 命令为空或过长 → `invalid_request`。
 */
export async function runCommand(
  opts: RunCommandOptions,
  input: RunCommandInput,
): Promise<RunCommandResult> {
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES;

  const command = input.command.trim();
  if (command === '') throw new Error('command is empty');
  if (command.length > MAX_COMMAND_LENGTH) throw new Error('command is too long');

  const verdict = await input.allow();
  if (!verdict.allowed) {
    opts.audit?.({
      at: now(),
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      command,
      result: 'denied',
      exitCode: null,
      detail: verdict.reason ?? 'denied by the permission engine',
    });
    throw new CommandDeniedError(verdict.reason ?? 'the permission engine denied this command');
  }

  const startedAt = now();
  const proc = opts.runtime.shell.spawn('/bin/sh', ['-c', command], {
    cwd: input.workspaceRoot,
    timeoutMs,
    // 独立进程组：超时能连整个子进程树一起杀掉。
    detached: true,
  });

  let stdout = '';
  let stderr = '';
  let truncated = false;
  const collect = async (stream: AsyncIterable<string>, into: 'out' | 'err'): Promise<void> => {
    for await (const line of stream) {
      const text = `${line}\n`;
      if (into === 'out') {
        if (stdout.length + text.length > maxOutputBytes) {
          stdout += text.slice(0, Math.max(0, maxOutputBytes - stdout.length));
          truncated = true;
          continue;
        }
        stdout += text;
      } else {
        if (stderr.length + text.length > maxOutputBytes) {
          stderr += text.slice(0, Math.max(0, maxOutputBytes - stderr.length));
          truncated = true;
          continue;
        }
        stderr += text;
      }
    }
  };

  const exitCode = await Promise.all([
    proc.exited,
    collect(proc.stdout, 'out').catch(() => undefined),
    collect(proc.stderr, 'err').catch(() => undefined),
  ]).then(([code]) => code);

  const durationMs = now() - startedAt;
  // 被超时杀掉时退出码非 0；这里用"耗时是否撞到上限"区分超时与命令自己失败。
  const timedOut = durationMs >= timeoutMs;
  const result: RunCommandResult = { exitCode, stdout, stderr, truncated, timedOut, durationMs };

  opts.audit?.({
    at: startedAt,
    sessionId: input.sessionId,
    workspaceRoot: input.workspaceRoot,
    command,
    result: exitCode === 0 ? 'success' : 'failed',
    exitCode,
    detail: timedOut ? 'timed out' : `exit ${exitCode}`,
  });
  return result;
}

/** 未获准的命令。Host 映射为 `command_denied`（`-32047`）。 */
export class CommandDeniedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CommandDeniedError';
  }
}
