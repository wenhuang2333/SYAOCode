/**
 * `!` 前缀直接执行命令（FR-N-036）的测试。
 *
 * 重点不在"命令能不能跑"，而在**闸门与护栏**：
 *  - 未获准时**一条命令都不执行**（用副作用文件证明）；
 *  - 超时会被杀掉并标记 `timedOut`；
 *  - 输出超上限被截断并标记 `truncated`；
 *  - 每次执行都写审计（含被拒的情况）。
 *
 * 不联网；只跑 `echo` / `printf` / `sleep` 这类本地命令。
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeRuntime } from '@liwencode/node';
import {
  CommandDeniedError,
  MAX_COMMAND_OUTPUT_BYTES,
  runCommand,
  type CommandAuditRecord,
} from '../src/run-command.ts';

const dirs: string[] = [];
async function workdir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-cmd-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const allowAll = async (): Promise<{ allowed: boolean; reason: string | null }> => ({ allowed: true, reason: null });

describe('`!` 直接执行命令（FR-N-036）', () => {
  it('获准的命令会执行，返回退出码与输出', async () => {
    const root = await workdir();
    const result = await runCommand(
      { runtime: nodeRuntime() },
      { sessionId: 's1', workspaceRoot: root, command: 'echo hello', allow: allowAll },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
    expect(result.truncated).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it('cwd 是工作区根：命令看得到工作区里的文件', async () => {
    const root = await workdir();
    await fs.writeFile(path.join(root, 'marker.txt'), 'inside\n');
    const result = await runCommand(
      { runtime: nodeRuntime() },
      { sessionId: 's1', workspaceRoot: root, command: 'cat marker.txt', allow: allowAll },
    );
    expect(result.stdout).toContain('inside');
  });

  it('未获准时**一条命令都不执行**（用副作用文件证明），并写审计', async () => {
    const root = await workdir();
    const audit: CommandAuditRecord[] = [];
    const marker = path.join(root, 'should-not-exist.txt');
    await expect(
      runCommand(
        { runtime: nodeRuntime(), audit: (r) => { audit.push(r); } },
        {
          sessionId: 's1',
          workspaceRoot: root,
          command: `printf x > ${marker}`,
          allow: async () => ({ allowed: false, reason: 'SY-PERM-004: dangerous' }),
        },
      ),
    ).rejects.toBeInstanceOf(CommandDeniedError);
    // 命令根本没有被执行 → 副作用文件不存在。
    await expect(fs.stat(marker)).rejects.toBeTruthy();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.result).toBe('denied');
    expect(audit[0]?.exitCode).toBeNull();
  });

  it('超时会被杀掉并标记 timedOut', async () => {
    const root = await workdir();
    const result = await runCommand(
      { runtime: nodeRuntime(), timeoutMs: 300 },
      { sessionId: 's1', workspaceRoot: root, command: 'sleep 5', allow: allowAll },
    );
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(300);
  });

  it('输出超过上限被截断并标记 truncated', async () => {
    const root = await workdir();
    const result = await runCommand(
      { runtime: nodeRuntime(), maxOutputBytes: 1024 },
      { sessionId: 's1', workspaceRoot: root, command: 'head -c 100000 /dev/zero | tr "\\0" "x"', allow: allowAll },
    );
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1024);
  });

  it('输出上限默认是 256 KiB', () => {
    expect(MAX_COMMAND_OUTPUT_BYTES).toBe(256 * 1024);
  });

  it('空命令与超长命令被拒（连闸门都不问）', async () => {
    const root = await workdir();
    let asked = 0;
    const allow = async (): Promise<{ allowed: boolean; reason: string | null }> => {
      asked += 1;
      return { allowed: true, reason: null };
    };
    await expect(
      runCommand({ runtime: nodeRuntime() }, { sessionId: 's1', workspaceRoot: root, command: '   ', allow }),
    ).rejects.toBeTruthy();
    await expect(
      runCommand({ runtime: nodeRuntime() }, { sessionId: 's1', workspaceRoot: root, command: 'x'.repeat(5000), allow }),
    ).rejects.toBeTruthy();
    // 形状不合法时不该去问权限引擎。
    expect(asked).toBe(0);
  });

  it('失败（退出码非 0）也写审计，结果标 failed', async () => {
    const root = await workdir();
    const audit: CommandAuditRecord[] = [];
    const result = await runCommand(
      { runtime: nodeRuntime(), audit: (r) => { audit.push(r); } },
      { sessionId: 's1', workspaceRoot: root, command: 'exit 3', allow: allowAll },
    );
    expect(result.exitCode).toBe(3);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.result).toBe('failed');
    expect(audit[0]?.exitCode).toBe(3);
  });

  it('审计条目里含命令原文与工作区，便于追溯', async () => {
    const root = await workdir();
    const audit: CommandAuditRecord[] = [];
    await runCommand(
      { runtime: nodeRuntime(), audit: (r) => { audit.push(r); } },
      { sessionId: 'sess-42', workspaceRoot: root, command: 'echo audit-me', allow: allowAll },
    );
    expect(audit[0]?.sessionId).toBe('sess-42');
    expect(audit[0]?.workspaceRoot).toBe(root);
    expect(audit[0]?.command).toContain('audit-me');
  });
});
