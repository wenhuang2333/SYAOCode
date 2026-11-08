/**
 * 数据目录迁移测试（SYAOCode `~/.syaocode` → LIWENCode `~/.liwencode`）。
 *
 * 覆盖任务要求的安全性质：
 *  - 旧目录 → 新目录：**复制**成功，旧目录原样保留；
 *  - 新目录优先、幂等（重复启动不重复复制、不破坏新目录内容）；
 *  - 复制失败：清理半成品、继续用旧目录、返回结构化告警；
 *  - `SYAOCODE_HOME` 兼容 + `LIWENCODE_HOME` 优先；
 *  - 文件内容逐字节一致（含二进制 / 权限位 / 符号链接）；
 *  - `createHost` 在 `DesktopStateStore.open` **之前**完成迁移（旧会话可见）。
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHost, type RunningHost } from '../src/host.ts';
import {
  migrateLegacyHome,
  nodeMigrationFs,
  type MigrationFs,
} from '../src/home-migration.ts';
import { resolveHomePlan, resolveLIWENHome } from '../src/paths.ts';

const tmpDirs: string[] = [];
const hosts: RunningHost[] = [];

async function mkTmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'liwen-home-migration-'));
  tmpDirs.push(d);
  return d;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
  for (const dir of tmpDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function writeTree(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** 包装真实 fs：让指定路径的 copyFile 失败（模拟磁盘错误 / 权限错误）。 */
function fsFailingOnCopy(predicate: (src: string) => boolean): MigrationFs {
  const base = nodeMigrationFs();
  return {
    ...base,
    async copyFile(src, dest) {
      if (predicate(src)) throw new Error(`EIO: injected copy failure for ${src}`);
      await base.copyFile(src, dest);
    },
  };
}

function warningCodes(result: Awaited<ReturnType<typeof migrateLegacyHome>>): string[] {
  return result.warnings.map((w) => w.code);
}

describe('数据目录计划（纯解析）', () => {
  it('LIWENCODE_HOME 优先于 SYAOCODE_HOME', () => {
    const env = { LIWENCODE_HOME: '/new/home', SYAOCODE_HOME: '/old/home' };
    expect(resolveLIWENHome(env)).toBe('/new/home');
  });

  it('未设新变量时 SYAOCODE_HOME 仍然生效（旧用户不被换位置）', () => {
    expect(resolveLIWENHome({ SYAOCODE_HOME: '/old/custom' })).toBe('/old/custom');
  });

  it('两个都没设时回退 ~/.liwencode', () => {
    const tmp = '/tmp/fake-home';
    expect(resolveHomePlan({}, { homedir: tmp }).targetHome).toBe(path.join(tmp, '.liwencode'));
  });

  it('旧目录候选：默认家目录下是 ~/.syaocode', () => {
    const tmp = '/tmp/fake-home';
    const plan = resolveHomePlan({}, { homedir: tmp });
    expect(plan.legacySources.map((s) => s.dir)).toContain(path.join(tmp, '.syaocode'));
  });

  it('旧目录候选：目标在家目录外时不猜家目录', () => {
    const plan = resolveHomePlan({ LIWENCODE_HOME: '/data/liwencode' }, { homedir: '/Users/someone' });
    expect(plan.targetHome).toBe('/data/liwencode');
    expect(plan.legacySources.map((s) => s.dir)).not.toContain('/Users/someone/.syaocode');
    expect(plan.legacySources.map((s) => s.dir)).toContain('/data/.syaocode');
  });

  it('空字符串视为未设置（旧变量同理）', () => {
    expect(resolveLIWENHome({ SYAOCODE_HOME: '   ' })).toBe(path.join(os.homedir(), '.liwencode'));
  });
});

describe('数据目录迁移', () => {
  it('旧目录 → 新目录：复制成功，旧目录原样保留', async () => {
    const tmp = await mkTmp();
    const legacy = path.join(tmp, '.syaocode');
    const target = path.join(tmp, 'liwencode');
    await writeTree(legacy, {
      'config.json': '{"model":"mock:default"}\n',
      'sessions/proj1/ses_1.jsonl': '{"type":"turn.start"}\n',
      'desktop/state-v2.json': '{"version":2}\n',
    });

    const plan = resolveHomePlan({ LIWENCODE_HOME: target }, { homedir: tmp });
    const result = await migrateLegacyHome({ plan, toolVersion: '0.1.0-test' });

    expect(result.migrated).toBe(true);
    expect(result.home).toBe(target);
    expect(result.source).toBe(legacy);
    expect(result.warnings.map((w) => w.code)).toContain('legacy_home_migrated');

    // 旧目录必须原样保留（支持降级回旧版本）。
    expect((await fs.stat(legacy)).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(legacy, 'config.json'), 'utf8')).toBe('{"model":"mock:default"}\n');

    // 新目录拿到全部内容。
    expect(await fs.readFile(path.join(target, 'config.json'), 'utf8')).toBe('{"model":"mock:default"}\n');
    expect(await fs.readFile(path.join(target, 'sessions/proj1/ses_1.jsonl'), 'utf8')).toBe('{"type":"turn.start"}\n');
    expect(await fs.readFile(path.join(target, 'desktop/state-v2.json'), 'utf8')).toBe('{"version":2}\n');
  });

  it('文件内容逐字节一致（含二进制数据）', async () => {
    const tmp = await mkTmp();
    const legacy = path.join(tmp, '.syaocode');
    const target = path.join(tmp, 'liwencode');
    const binary = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0x0a, 0x0d, 0x1b]);
    await writeTree(legacy, { 'sessions/s1.bin': binary, 'config.json': '{"k":"中文"}\n' });

    const result = await migrateLegacyHome({
      plan: resolveHomePlan({ LIWENCODE_HOME: target }, { homedir: tmp }),
    });
    expect(result.migrated).toBe(true);

    const copiedBinary = await fs.readFile(path.join(target, 'sessions/s1.bin'));
    expect(Buffer.compare(copiedBinary, binary)).toBe(0);
    expect(await fs.readFile(path.join(target, 'config.json'), 'utf8')).toBe('{"k":"中文"}\n');
  });

  it('新目录优先：两个目录都在时不动新目录、不碰旧目录', async () => {
    const tmp = await mkTmp();
    const legacy = path.join(tmp, '.syaocode');
    const target = path.join(tmp, 'liwencode');
    await writeTree(legacy, { 'config.json': 'old\n' });
    await writeTree(target, { 'config.json': 'new\n', 'keep.txt': 'keep\n' });

    const result = await migrateLegacyHome({
      plan: resolveHomePlan({ LIWENCODE_HOME: target }, { homedir: tmp }),
    });

    expect(result.migrated).toBe(false);
    expect(result.home).toBe(target);
    expect(warningCodes(result)).toContain('legacy_home_skipped');
    expect(await fs.readFile(path.join(target, 'config.json'), 'utf8')).toBe('new\n');
    expect(await fs.readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(await fs.readFile(path.join(legacy, 'config.json'), 'utf8')).toBe('old\n');
  });

  it('幂等：重复迁移不重复复制、不留残骸', async () => {
    const tmp = await mkTmp();
    const legacy = path.join(tmp, '.syaocode');
    const target = path.join(tmp, 'liwencode');
    await writeTree(legacy, { 'config.json': 'v1\n', 'sessions/a.jsonl': 'a\n' });

    const first = await migrateLegacyHome({
      plan: resolveHomePlan({ LIWENCODE_HOME: target }, { homedir: tmp }),
      toolVersion: '0.1.0-test',
      now: () => 1_700_000_000_000,
    });
    expect(first.migrated).toBe(true);
    const markerBefore = await fs.readFile(path.join(target, '.migrated-from-syaocode.json'), 'utf8');

    const second = await migrateLegacyHome({
      plan: resolveHomePlan({ LIWENCODE_HOME: target }, { homedir: tmp }),
      toolVersion: '0.1.0-test',
      now: () => 1_700_000_999_999,
    });
    expect(second.migrated).toBe(false);
    expect(second.home).toBe(target);
    expect(warningCodes(second)).toContain('legacy_home_skipped');

    // 新目录内容（含标记）没有被第二次启动改写。
    expect(await fs.readFile(path.join(target, '.migrated-from-syaocode.json'), 'utf8')).toBe(markerBefore);
    expect(await fs.readFile(path.join(target, 'config.json'), 'utf8')).toBe('v1\n');
    // 没有残留的暂存目录。
    expect(await exists(`${target}.migrating`)).toBe(false);
  });

  it('复制失败：回滚半成品、继续用旧目录、返回结构化告警', async () => {
    const tmp = await mkTmp();
    const legacy = path.join(tmp, '.syaocode');
    const target = path.join(tmp, 'liwencode');
    await writeTree(legacy, {
      'config.json': '{"ok":true}\n',
      'sessions/s1.jsonl': 'line\n',
      'sessions/boom.jsonl': 'boom\n',
    });

    const result = await migrateLegacyHome({
      plan: resolveHomePlan({ LIWENCODE_HOME: target }, { homedir: tmp }),
      fs: fsFailingOnCopy((src) => src.endsWith('boom.jsonl')),
    });

    const failed = result.warnings.find((w) => w.code === 'copy_failed');
    expect(failed).toBeDefined();
    expect(failed?.level).toBe('error');
    expect(failed?.detail?.['source']).toBe(legacy);

    // 半成品被清理：新目录根本不出现（下次启动可以重试）。
    expect(await exists(target)).toBe(false);
    expect(await exists(`${target}.migrating`)).toBe(false);
    // 继续用旧目录，数据一条不少。
    expect(result.home).toBe(legacy);
    expect(result.migrated).toBe(false);
    expect(await fs.readFile(path.join(legacy, 'config.json'), 'utf8')).toBe('{"ok":true}\n');
    expect(await fs.readFile(path.join(legacy, 'sessions/s1.jsonl'), 'utf8')).toBe('line\n');
  });

  it('SYAOCODE_HOME 兼容：旧变量仍指向数据目录，并输出废弃提示', async () => {
    const tmp = await mkTmp();
    const legacy = path.join(tmp, 'custom-syao-home');
    await writeTree(legacy, { 'config.json': '{"old":true}\n' });

    const env = { SYAOCODE_HOME: legacy };
    expect(resolveLIWENHome(env)).toBe(legacy);

    const result = await migrateLegacyHome({ plan: resolveHomePlan(env, { homedir: tmp }) });
    expect(result.home).toBe(legacy);
    const deprecated = result.warnings.find((w) => w.code === 'legacy_env_deprecated');
    expect(deprecated).toBeDefined();
    expect(deprecated?.detail?.['value']).toBe(legacy);
  });

  it('LIWENCODE_HOME 优先：两个变量都在时写新目录，数据从旧变量目录搬过来', async () => {
    const tmp = await mkTmp();
    const oldHome = path.join(tmp, 'custom-syao-home');
    const newHome = path.join(tmp, 'new-liwen-home');
    await writeTree(oldHome, { 'config.json': '{"from":"old-var"}\n', 'sessions/s.jsonl': 's\n' });

    const env = { LIWENCODE_HOME: newHome, SYAOCODE_HOME: oldHome };
    expect(resolveLIWENHome(env)).toBe(newHome);

    const result = await migrateLegacyHome({ plan: resolveHomePlan(env, { homedir: tmp }) });
    expect(result.home).toBe(newHome);
    expect(result.migrated).toBe(true);
    expect(result.source).toBe(oldHome);
    expect(await fs.readFile(path.join(newHome, 'config.json'), 'utf8')).toBe('{"from":"old-var"}\n');
    expect((await fs.stat(oldHome)).isDirectory()).toBe(true);
  });

  it('迁移标记记录时间、来源与工具版本', async () => {
    const tmp = await mkTmp();
    const legacy = path.join(tmp, '.syaocode');
    const target = path.join(tmp, 'liwencode');
    await writeTree(legacy, { 'a.txt': 'a' });

    const fixedNow = 1_760_000_000_000;
    const result = await migrateLegacyHome({
      plan: resolveHomePlan({ LIWENCODE_HOME: target }, { homedir: tmp }),
      toolVersion: '9.9.9-test',
      now: () => fixedNow,
    });
    expect(result.markerFile).toBe(path.join(target, '.migrated-from-syaocode.json'));
    const marker = JSON.parse(await fs.readFile(result.markerFile as string, 'utf8')) as Record<string, unknown>;
    expect(marker['migratedAt']).toBe(new Date(fixedNow).toISOString());
    expect(marker['migratedAtMs']).toBe(fixedNow);
    expect(marker['source']).toBe(legacy);
    expect(marker['sourceKind']).toBe('sibling');
    expect(marker['toolVersion']).toBe('9.9.9-test');
    expect(marker['files']).toBe(1);
    expect(marker['bytes']).toBe(1);
  });

  it('保留权限位（env 文件 0600 不能被放大）', async () => {
    const tmp = await mkTmp();
    const legacy = path.join(tmp, '.syaocode');
    const target = path.join(tmp, 'liwencode');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, 'env'), 'API_KEY=secret\n', { mode: 0o600 });

    const result = await migrateLegacyHome({
      plan: resolveHomePlan({ LIWENCODE_HOME: target }, { homedir: tmp }),
    });
    expect(result.migrated).toBe(true);
    const mode = (await fs.stat(path.join(target, 'env'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('符号链接按链接复制（不跟随、不解引用）', async () => {
    const tmp = await mkTmp();
    const legacy = path.join(tmp, '.syaocode');
    const target = path.join(tmp, 'liwencode');
    await fs.mkdir(legacy, { recursive: true });
    await fs.symlink('/some/outside/target', path.join(legacy, 'link'));

    const result = await migrateLegacyHome({
      plan: resolveHomePlan({ LIWENCODE_HOME: target }, { homedir: tmp }),
    });
    expect(result.migrated).toBe(true);
    const st = await fs.lstat(path.join(target, 'link'));
    expect(st.isSymbolicLink()).toBe(true);
    expect(await fs.readlink(path.join(target, 'link'))).toBe('/some/outside/target');
  });

  it('运行时锁文件不搬（否则升级后 DesktopStateStore 会以为状态被锁）', async () => {
    const tmp = await mkTmp();
    const legacy = path.join(tmp, '.syaocode');
    const target = path.join(tmp, 'liwencode');
    await writeTree(legacy, {
      'desktop/host.lock': '{"pid":999999}',
      'desktop/state-v2.json': '{"version":2}\n',
    });

    const result = await migrateLegacyHome({
      plan: resolveHomePlan({ LIWENCODE_HOME: target }, { homedir: tmp }),
    });
    expect(result.migrated).toBe(true);
    expect(await exists(path.join(target, 'desktop/host.lock'))).toBe(false);
    expect(await fs.readFile(path.join(target, 'desktop/state-v2.json'), 'utf8')).toBe('{"version":2}\n');
  });

  it('导入模块 / 纯解析不会自动迁移（无副作用）', async () => {
    const tmp = await mkTmp();
    const legacy = path.join(tmp, '.syaocode');
    const target = path.join(tmp, 'liwencode');
    await writeTree(legacy, { 'config.json': '{}' });

    const plan = resolveHomePlan({ LIWENCODE_HOME: target }, { homedir: tmp });
    expect(plan.targetHome).toBe(target);
    // 只做了纯解析：目标目录不存在，旧目录也没被动过。
    expect(await exists(target)).toBe(false);
    expect(await fs.readFile(path.join(legacy, 'config.json'), 'utf8')).toBe('{}');
  });
});

describe('createHost 集成：迁移必须发生在 DesktopStateStore.open 之前', () => {
  function legacyState(workspaceRoot: string): string {
    return `${JSON.stringify({
      version: 2,
      workspaces: [{ id: 'ws_legacy', name: 'legacy', root: workspaceRoot, addedAt: 1_700_000_000_000 }],
      sessions: [
        {
          snapshot: {
            meta: {
              sessionId: 'ses_legacy0001',
              title: '旧版本留下的会话',
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_000_000,
              model: 'mock:default',
              permissionMode: 'default',
              workspaceRoot,
            },
            rows: [],
            seq: 0,
            epoch: 1,
            revision: 1,
            pendingInteractions: [],
            runState: 'idle',
          },
          messages: [],
          turn: 0,
          archived: false,
        },
      ],
      channels: [],
      ledger: [],
      contexts: {},
      defaults: {},
      changes: {},
      artifacts: {},
      sources: {},
      coverage: {},
      mcp: [],
      agentGroups: [],
      agentActive: null,
      gitRemotes: {},
      gitAuth: {},
      gitAudit: [],
      commandAudit: [],
    }, null, 2)}\n`;
  }

  it('旧目录里的会话在启动后可见（迁移先于状态存储打开）', async () => {
    const tmp = await mkTmp();
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'liwen-home-migration-ws-'));
    tmpDirs.push(ws);
    const workspaceRoot = await fs.realpath(ws);

    const legacy = path.join(tmp, '.syaocode');
    const target = path.join(tmp, 'liwencode');
    await writeTree(legacy, {
      'desktop/state-v2.json': legacyState(workspaceRoot),
      'sessions/proj/ses_legacy0001.jsonl': '{"type":"turn.start"}\n',
    });

    const host = await createHost({
      workspaceRoot: ws,
      env: { LIWENCODE_HOME: target },
      homeMigration: { homedir: tmp },
      logger: () => {},
      exitOnShutdown: false,
    });
    hosts.push(host);

    expect(host.paths.home).toBe(target);
    expect(host.migration.migrated).toBe(true);
    // Host 打开状态存储时读到的就是迁移后的数据：旧会话仍在注册表里。
    expect(host.migration.source).toBe(legacy);
    const saved = JSON.parse(await fs.readFile(path.join(target, 'desktop', 'state-v2.json'), 'utf8')) as {
      sessions: { snapshot: { meta: { sessionId: string } } }[];
    };
    expect(saved.sessions.map((s) => s.snapshot.meta.sessionId)).toContain('ses_legacy0001');
    // 旧目录仍然原样保留。
    expect(await fs.readFile(path.join(legacy, 'sessions/proj/ses_legacy0001.jsonl'), 'utf8')).toBe('{"type":"turn.start"}\n');
  });

  it('没有旧目录时照常启动（新目录为唯一写入位置）', async () => {
    const tmp = await mkTmp();
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'liwen-home-migration-ws-'));
    tmpDirs.push(ws);
    const target = path.join(tmp, 'liwencode');

    const host = await createHost({
      workspaceRoot: ws,
      env: { LIWENCODE_HOME: target },
      homeMigration: { homedir: tmp },
      logger: () => {},
      exitOnShutdown: false,
    });
    hosts.push(host);

    expect(host.paths.home).toBe(target);
    expect(host.migration.migrated).toBe(false);
    expect(warningCodes(host.migration)).toContain('legacy_home_missing');
    expect((await fs.stat(path.join(target, 'desktop'))).isDirectory()).toBe(true);
  });
});
