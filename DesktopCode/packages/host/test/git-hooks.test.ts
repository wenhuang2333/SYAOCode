/**
 * 提交钩子（`27` §10.5.4 / TC-N-048）。
 *
 * 此前只验证过**失败**路径（钩子拒绝 → 不产生提交、HEAD 不变、审计 failed）。
 * 本文件补上另外三件同样重要的事：
 *
 *  1. **成功路径**：钩子正常通过时，提交**确实产生**，且钩子**确实运行过**
 *     （用它的副作用证明，而不是"提交成功了所以钩子肯定跑了"）；
 *  2. **`core.hooksPath`**：git 允许把钩子目录改到别处。界面会写
 *     "将运行 N 个钩子"——如果钩子目录找错，这个数字就是**假话**；
 *  3. **可执行性如实标注**：不可执行的钩子 git 不会运行，界面必须标明，
 *     否则用户会以为自己的检查已经跑过了。
 *
 * 这些都用真实 git 仓库验证，不 mock。
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitService } from '../src/git-service.ts';
import { GitWriteService } from '../src/git-write.ts';

const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return process.platform !== 'win32';
  } catch {
    return false;
  }
})();

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'syao-hook-')));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(dir, 'a.txt'), 'base\n');
  git(dir, ['add', '--', 'a.txt']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

describe.skipIf(!hasGit)('提交钩子', () => {
  it('钩子通过 → 提交产生，且钩子**真的运行过**（用副作用证明）', async () => {
    const root = await makeRepo();
    try {
      const hooksDir = path.join(root, '.git', 'hooks');
      await fs.mkdir(hooksDir, { recursive: true });
      const marker = path.join(root, 'hook-ran.txt');
      // 钩子写一个标记文件：提交后标记存在，才说明钩子**运行过**。
      await fs.writeFile(
        path.join(hooksDir, 'pre-commit'),
        `#!/bin/sh\nprintf 'ran' > ${JSON.stringify(marker)}\nexit 0\n`,
        { mode: 0o755 },
      );
      await fs.chmod(path.join(hooksDir, 'pre-commit'), 0o755);

      await fs.writeFile(path.join(root, 'a.txt'), 'base\nchanged\n');
      git(root, ['add', '--', 'a.txt']);

      const service = new GitService();
      const writer = new GitWriteService({ reader: service });
      const headBefore = git(root, ['rev-parse', 'HEAD']).trim();

      const result = await writer.commit(root, 'feat: with hook', {
        commandId: 'cmd-hook-ok-1',
        baseRevision: await service.revisionOf(root),
      });
      expect(result.status).toBe('accepted');
      expect(git(root, ['rev-parse', 'HEAD']).trim()).not.toBe(headBefore);
      // 关键：钩子的副作用存在 → 钩子真的运行了。
      expect(await fs.readFile(marker, 'utf8')).toBe('ran');
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 60_000);

  it('`core.hooksPath` 改写钩子目录时，检测到的钩子就是 git **实际会运行**的那些', async () => {
    const root = await makeRepo();
    try {
      // 把钩子放到仓库外的自定义目录。
      const custom = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'syao-hookdir-')));
      await fs.writeFile(path.join(custom, 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await fs.chmod(path.join(custom, 'pre-commit'), 0o755);
      git(root, ['config', 'core.hooksPath', custom]);

      const service = new GitService();
      const status = await service.status(root);
      // 界面据此显示"将运行 N 个钩子"——数字错了就是在骗用户。
      const names = status.hooks.map((hook) => hook.name);
      expect(names).toContain('pre-commit');
      // 默认目录里的钩子此时**不会**被 git 运行，不该被算进来。
      const defaultHooks = path.join(root, '.git', 'hooks');
      await fs.mkdir(defaultHooks, { recursive: true });
      await fs.writeFile(path.join(defaultHooks, 'pre-push'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await fs.chmod(path.join(defaultHooks, 'pre-push'), 0o755);
      const status2 = await service.status(root);
      expect(status2.hooks.map((hook) => hook.name)).not.toContain('pre-push');
      await fs.rm(custom, { recursive: true, force: true }).catch(() => undefined);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 60_000);

  it('不可执行的钩子被如实标注为不可执行（git 不会运行它）', async () => {
    const root = await makeRepo();
    try {
      const hooksDir = path.join(root, '.git', 'hooks');
      await fs.mkdir(hooksDir, { recursive: true });
      await fs.writeFile(path.join(hooksDir, 'pre-commit'), 'not executable\n', { mode: 0o644 });
      await fs.chmod(path.join(hooksDir, 'pre-commit'), 0o644);

      const service = new GitService();
      const status = await service.status(root);
      const preCommit = status.hooks.find((hook) => hook.name === 'pre-commit');
      expect(preCommit).toBeDefined();
      expect(preCommit?.executable).toBe(false);

      // 不可执行 = git 不会运行它 → 提交**照常成功**。
      await fs.writeFile(path.join(root, 'a.txt'), 'base\nchanged\n');
      git(root, ['add', '--', 'a.txt']);
      const writer = new GitWriteService({ reader: service });
      const result = await writer.commit(root, 'feat: non-exec hook', {
        commandId: 'cmd-hook-noexec-1',
        baseRevision: await service.revisionOf(root),
      });
      expect(result.status).toBe('accepted');
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 60_000);
});
