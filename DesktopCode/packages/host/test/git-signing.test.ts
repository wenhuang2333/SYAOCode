/**
 * 真实 GPG 签名提交（`27` §10.5.3 / `26` N-16 相关）。
 *
 * 此前只验证过**签名失败**（配置一个必然失败的签名程序），从未验证过
 * **签名成功**。这两件事完全不同：
 *  - 失败路径验的是"错误被正确归类为 git_signing_failed"；
 *  - 成功路径验的是"签名环境配好之后，提交真的带上了一个**可校验**的签名"。
 *
 * 后者才是用户实际会遇到的场景，也是签名功能的意义所在。
 * 而"命令退出码 0"不等于"签名有效"——`--no-gpg-sign` 也能退出码 0。
 * 所以这里用 `git verify-commit` 独立复核，而不是只看提交成功。
 *
 * 密钥在**隔离的 GNUPGHOME** 里现生成（无口令），用完删除：
 * 不碰用户真实密钥环，也不需要任何外部条件。
 */

import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitService } from '../src/git-service.ts';
import { GitWriteService } from '../src/git-write.ts';
import type { GitAuditRecord } from '../src/git-write.ts';

const hasGpg = ((): boolean => {
  try {
    execFileSync('gpg', ['--version'], { stdio: 'ignore' });
    return process.platform !== 'win32';
  } catch {
    return false;
  }
})();

function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe.skipIf(!hasGpg)('真实 GPG 签名提交', () => {
  it('配置好签名环境后，提交带上**可校验**的签名；审计记录为成功', async () => {
    // 1) 隔离的密钥环：绝不碰用户真实的 ~/.gnupg。
    const gnupg = await fs.mkdtemp(path.join(os.tmpdir(), 'liwen-gnupg-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'liwen-signrepo-'));
    await fs.chmod(gnupg, 0o700);
    const env: NodeJS.ProcessEnv = { ...process.env, GNUPGHOME: gnupg };
    // `GitWriteService` 内部用 `runGit` 起 git 子进程，它继承的是**进程环境**
    // （`{...process.env, ...extra}`），所以签名密钥环必须放进 process.env；
    // 只传给测试自己的 execFile 是不够的。结束时恢复。
    const previousGnupgHome = process.env['GNUPGHOME'];
    process.env['GNUPGHOME'] = gnupg;

    try {
      // 2) 无口令的 ed25519 密钥（批量参数，不需要交互）。
      execFileSync('gpg', [
        '--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase', '',
        '--quick-generate-key', 'LIWEN Test <liwen-test@example.invalid>', 'ed25519', 'sign', '0',
      ], { env, stdio: 'ignore', timeout: 60_000 });

      const keyId = execFileSync('gpg', ['--list-secret-keys', '--with-colons'], { env, encoding: 'utf8' })
        .split('\n').filter((line) => line.startsWith('sec:')).map((line) => line.split(':')[4])[0];
      expect(typeof keyId).toBe('string');
      expect(keyId).toBeTruthy();

      // 3) 仓库：关掉全局模板，显式开启签名并指定隔离密钥。
      git(repo, ['init', '-q'], env);
      git(repo, ['config', 'user.email', 'liwen-test@example.invalid'], env);
      git(repo, ['config', 'user.name', 'LIWEN Test'], env);
      git(repo, ['config', 'user.signingkey', String(keyId)], env);
      git(repo, ['config', 'commit.gpgsign', 'true'], env);
      git(repo, ['config', 'gpg.program', 'gpg'], env);
      await fs.writeFile(path.join(repo, 'a.txt'), 'base\n');
      git(repo, ['add', '--', 'a.txt'], env);
      git(repo, ['commit', '-q', '-m', 'init'], env);

      // 4) 通过我们的服务提交（这是要被验证的那条路径）。
      await fs.writeFile(path.join(repo, 'a.txt'), 'base\nsigned change\n');
      git(repo, ['add', '--', 'a.txt'], env);

      const reader = new GitService();
      const audit: GitAuditRecord[] = [];
      const writer = new GitWriteService({ reader, audit: (record) => { audit.push(record); } });
      const headBefore = git(repo, ['rev-parse', 'HEAD'], env).trim();

      const result = await writer.commit(repo, 'feat: signed change', {
        commandId: 'cmd-real-sign-1',
        baseRevision: await reader.revisionOf(repo),
      });
      expect(result.status).toBe('accepted');
      const headAfter = git(repo, ['rev-parse', 'HEAD'], env).trim();
      expect(headAfter).not.toBe(headBefore);

      // 5) **关键**：退出码 0 不等于签名有效（`--no-gpg-sign` 也是 0）。
      //    用 `git verify-commit` 独立复核，退出码非 0 即抛错。
      // `git verify-commit` 把"Good signature"写到 **stderr**，不是 stdout；
      // 用 spawnSync 同时取两者，并单独断言退出码（非 0 即签名无效）。
      // 文案要**锁语言**：中文机器上 gpg 输出的是"完好的签名"，断言英文才跨机器稳定。
      const verified = spawnSync('git', ['verify-commit', headAfter], {
        cwd: repo, env: { ...env, LC_ALL: 'C', LANGUAGE: '' }, encoding: 'utf8',
      });
      expect(verified.status).toBe(0);
      expect(`${verified.stdout ?? ''}${verified.stderr ?? ''}`).toContain('Good signature');

      // 6) 审计必须记成成功，且不得把签名当成失败。
      const record = audit.find((r) => r.action === 'git.commit');
      expect(record?.result).toBe('success');
    } finally {
      if (previousGnupgHome === undefined) delete process.env['GNUPGHOME'];
      else process.env['GNUPGHOME'] = previousGnupgHome;
      await fs.rm(repo, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(gnupg, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 180_000);

  it('签名环境不可用时仍然归类为 git_signing_failed，不会静默降级成无签名提交', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'liwen-signrepo2-'));
    const env: NodeJS.ProcessEnv = { ...process.env };
    try {
      git(repo, ['init', '-q'], env);
      git(repo, ['config', 'user.email', 'liwen-test@example.invalid'], env);
      git(repo, ['config', 'user.name', 'LIWEN Test'], env);
      await fs.writeFile(path.join(repo, 'a.txt'), 'base\n');
      git(repo, ['add', '--', 'a.txt'], env);
      git(repo, ['config', 'commit.gpgsign', 'false'], env);
      git(repo, ['commit', '-q', '-m', 'init'], env);

      // 要求签名，但签名程序必然失败。
      git(repo, ['config', 'commit.gpgsign', 'true'], env);
      git(repo, ['config', 'gpg.program', 'false'], env);
      await fs.writeFile(path.join(repo, 'a.txt'), 'base\nmore\n');
      git(repo, ['add', '--', 'a.txt'], env);

      const reader = new GitService();
      const writer = new GitWriteService({ reader });
      const headBefore = git(repo, ['rev-parse', 'HEAD'], env).trim();

      const failure = await writer
        .commit(repo, 'feat: x', { commandId: 'cmd-real-sign-2', baseRevision: await reader.revisionOf(repo) })
        .then(() => undefined)
        .catch((error: unknown) => error);

      expect((failure as { kind?: string } | undefined)?.kind).toBe('git_signing_failed');
      // 不静默降级：HEAD 不动，工作区仍是"有暂存改动"。
      expect(git(repo, ['rev-parse', 'HEAD'], env).trim()).toBe(headBefore);
      const status = await reader.status(repo);
      expect(status.files.some((file) => file.staged)).toBe(true);
    } finally {
      await fs.rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 120_000);
});
