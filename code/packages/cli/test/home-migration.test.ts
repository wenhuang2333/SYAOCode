import { describe, expect, it, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_HOME_DIRNAME,
  LEGACY_HOME_ENV,
  LIWEN_HOME_DIRNAME,
  LIWEN_HOME_ENV,
  MIGRATION_MARKER_FILE,
  ensureLiwenHome,
  liwenHome,
  migrateLegacyHome,
  resetLiwenHomeForTests,
  resolveDataHome,
  type HomeFs,
  type MigrationMarker,
} from '../src/model-config';

/**
 * 数据目录迁移（SYAOCode → LIWENCode）。
 *
 * 硬规则：旧目录 `~/.syaocode` 只能被**复制**，永不 rename/move（旧版本要能降级）；
 * 复制失败不得留下半成品新目录，也不得静默丢数据。
 */

function tempHome(prefix = 'liwen-home-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function legacyDir(home: string): string {
  return path.join(home, LEGACY_HOME_DIRNAME);
}

function newDir(home: string): string {
  return path.join(home, LIWEN_HOME_DIRNAME);
}

/** 造一棵旧目录：config.json + 0600 的 env 文件 + 一个子目录。 */
function seedLegacy(home: string): string {
  const dir = legacyDir(home);
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ model: { provider: 'deepseek', name: 'deepseek-chat' } }));
  fs.writeFileSync(path.join(dir, 'env'), 'DEEPSEEK_API_KEY=sk-legacy-secret\n', { mode: 0o600 });
  fs.chmodSync(path.join(dir, 'env'), 0o600);
  fs.writeFileSync(path.join(dir, 'sessions', 's1.jsonl'), '{"id":"s1"}\n');
  return dir;
}

/** 注入故障：复制指定文件时抛错，模拟权限/磁盘类失败。 */
function faultyFs(failOn: string): HomeFs {
  return {
    existsSync: (p) => fs.existsSync(p),
    mkdirSync: (p, options) => fs.mkdirSync(p, options),
    readdirSync: (p, options) => fs.readdirSync(p, options),
    lstatSync: (p) => fs.lstatSync(p),
    readlinkSync: (p) => fs.readlinkSync(p),
    symlinkSync: (target, p) => fs.symlinkSync(target, p),
    copyFileSync: (src, dest) => {
      if (src.includes(failOn)) throw new Error(`EACCES: permission denied, copy '${src}'`);
      fs.copyFileSync(src, dest);
    },
    chmodSync: (p, mode) => fs.chmodSync(p, mode),
    readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
    writeFileSync: (p, data, options) => fs.writeFileSync(p, data, options),
    rmSync: (p, options) => fs.rmSync(p, options),
    renameSync: (oldPath, newPath) => fs.renameSync(oldPath, newPath),
  };
}

function listTmpMigrations(home: string): string[] {
  return fs.readdirSync(home).filter((n) => n.includes('.migrating-'));
}

// ── 真实 CLI 入口（E2E） ────────────────────────────────────────────────

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const cliEntry = path.join(repoRoot, 'packages', 'cli', 'src', 'main.ts');

function runCli(
  home: string,
  argv: string[],
  extraEnv: Record<string, string | undefined> = {},
): { stdout: string; stderr: string; code: number } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    LIWEN_MODEL: 'mock:default',
    ...extraEnv,
  };
  // 父进程里可能残留同名变量：显式清掉，保证用例只测自己注入的那一个
  if (extraEnv[LIWEN_HOME_ENV] === undefined) delete env[LIWEN_HOME_ENV];
  if (extraEnv[LEGACY_HOME_ENV] === undefined) delete env[LEGACY_HOME_ENV];
  const res = spawnSync(tsx, [cliEntry, ...argv], {
    encoding: 'utf8',
    timeout: 60_000,
    cwd: repoRoot,
    env,
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.status ?? 1 };
}

afterEach(() => {
  resetLiwenHomeForTests();
});

describe('数据目录解析（LIWENCODE_HOME > SYAOCODE_HOME > ~/.liwencode）', () => {
  it('默认数据目录是 ~/.liwencode，旧目录名只作迁移源', () => {
    const home = tempHome();
    const resolved = resolveDataHome({ home, env: {} });
    expect(resolved.source).toBe('default');
    expect(resolved.dataDir).toBe(newDir(home));
    expect(resolved.defaultLegacyDir).toBe(legacyDir(home));
    expect(resolved.notices).toEqual([]);
  });

  it('SYAOCODE_HOME 仍可用（兼容）：作为数据目录候选并给出提示', () => {
    const home = tempHome();
    const legacyData = path.join(home, 'custom-legacy');
    fs.mkdirSync(legacyData, { recursive: true });
    const resolved = resolveDataHome({ home, env: { [LEGACY_HOME_ENV]: legacyData } });
    expect(resolved.source).toBe('env-legacy');
    expect(resolved.dataDir).toBe(legacyData);
    expect(resolved.notices).toHaveLength(1);
    expect(resolved.notices[0]?.code).toBe('legacy-env-var');
    expect(resolved.notices[0]?.message).toContain(LEGACY_HOME_ENV);
  });

  it('LIWENCODE_HOME 优先于 SYAOCODE_HOME（新变量优先）', () => {
    const home = tempHome();
    const newData = path.join(home, 'new-data');
    const legacyData = path.join(home, 'legacy-data');
    const resolved = resolveDataHome({
      home,
      env: { [LIWEN_HOME_ENV]: newData, [LEGACY_HOME_ENV]: legacyData },
    });
    expect(resolved.source).toBe('env-new');
    expect(resolved.dataDir).toBe(newData);
    expect(resolved.notices).toEqual([]);
  });

  it('liwenHome() 无参时按环境变量解析；显式传参时按旧语义拼用户主目录', () => {
    const home = tempHome();
    const oldHome = process.env[LIWEN_HOME_ENV];
    const oldLegacy = process.env[LEGACY_HOME_ENV];
    process.env[LIWEN_HOME_ENV] = path.join(home, 'env-data');
    try {
      expect(liwenHome()).toBe(path.join(home, 'env-data'));
      expect(liwenHome(home)).toBe(newDir(home));
    } finally {
      if (oldHome === undefined) delete process.env[LIWEN_HOME_ENV];
      else process.env[LIWEN_HOME_ENV] = oldHome;
      if (oldLegacy === undefined) delete process.env[LEGACY_HOME_ENV];
      else process.env[LEGACY_HOME_ENV] = oldLegacy;
    }
  });
});

describe('旧目录迁移（复制语义 + 幂等 + 失败回滚）', () => {
  it('旧目录存在 → 整棵复制到新目录，旧目录原样保留，写入迁移标记', () => {
    const home = tempHome();
    const legacy = seedLegacy(home);

    const result = migrateLegacyHome({ home, env: {} });

    expect(result.migrated).toBe(true);
    expect(result.usedLegacyFallback).toBe(false);
    expect(result.dataDir).toBe(newDir(home));
    expect(result.warnings).toEqual([]);

    // 新目录内容齐了
    expect(fs.existsSync(path.join(newDir(home), 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(newDir(home), 'sessions', 's1.jsonl'))).toBe(true);
    expect(fs.readFileSync(path.join(newDir(home), 'env'), 'utf8')).toContain('sk-legacy-secret');

    // 旧目录原样保留（复制而非移动，旧版本可降级）
    expect(fs.existsSync(path.join(legacy, 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(legacy, 'env'))).toBe(true);
    expect(fs.existsSync(path.join(legacy, 'sessions', 's1.jsonl'))).toBe(true);

    // 迁移标记：含时间与来源
    const markerPath = path.join(newDir(home), MIGRATION_MARKER_FILE);
    expect(result.markerPath).toBe(markerPath);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as MigrationMarker;
    expect(marker.source).toBe(legacy);
    expect(marker.destination).toBe(newDir(home));
    expect(marker.mode).toBe('copy');
    expect(marker.tool).toBe('liwencode');
    expect(Number.isNaN(Date.parse(marker.migratedAt))).toBe(false);
  });

  it('env 文件权限保持 0600', () => {
    const home = tempHome();
    seedLegacy(home);

    migrateLegacyHome({ home, env: {} });

    const mode = fs.statSync(path.join(newDir(home), 'env')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('旧+新并存 → 新目录优先，不覆盖新目录内容', () => {
    const home = tempHome();
    seedLegacy(home);
    fs.mkdirSync(newDir(home), { recursive: true });
    fs.writeFileSync(path.join(newDir(home), 'config.json'), '{"model":{"provider":"mock","name":"default"}}');

    const result = migrateLegacyHome({ home, env: {} });

    expect(result.migrated).toBe(false);
    expect(result.usedLegacyFallback).toBe(false);
    expect(result.dataDir).toBe(newDir(home));
    const newConfig = JSON.parse(fs.readFileSync(path.join(newDir(home), 'config.json'), 'utf8')) as {
      model: { provider: string };
    };
    expect(newConfig.model.provider).toBe('mock');
    // 新目录里没有混入旧目录的文件，也没有迁移标记（没有发生迁移）
    expect(fs.existsSync(path.join(newDir(home), 'env'))).toBe(false);
    expect(fs.existsSync(path.join(newDir(home), MIGRATION_MARKER_FILE))).toBe(false);
  });

  it('重复调用幂等：不重复复制、不报错、不覆盖', () => {
    const home = tempHome();
    seedLegacy(home);

    const first = migrateLegacyHome({ home, env: {} });
    const envStat = fs.statSync(path.join(newDir(home), 'env'));
    const second = migrateLegacyHome({ home, env: {} });
    const third = migrateLegacyHome({ home, env: {} });

    expect(first.migrated).toBe(true);
    expect(second.migrated).toBe(false);
    expect(third.migrated).toBe(false);
    expect(second.dataDir).toBe(newDir(home));
    expect(third.warnings).toEqual([]);
    expect(second.usedLegacyFallback).toBe(false);
    // 内容与 mtime 未被二次迁移改动
    expect(fs.statSync(path.join(newDir(home), 'env')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(newDir(home), 'env')).mtimeMs).toBe(envStat.mtimeMs);
    expect(listTmpMigrations(home)).toEqual([]);
  });

  it('复制失败 → 回滚（不留半成品新目录/临时目录）+ 旧目录仍可用 + 告警可见', () => {
    const home = tempHome();
    const legacy = seedLegacy(home);

    const result = migrateLegacyHome({ home, env: {}, fs: faultyFs('env') });

    expect(result.migrated).toBe(false);
    expect(result.usedLegacyFallback).toBe(true);
    expect(result.dataDir).toBe(legacy);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]?.code).toBe('home-migration-failed');
    expect(result.warnings[0]?.message).toContain(legacy);
    expect(result.warnings[0]?.cause).toContain('EACCES');

    // 没有半成品新目录，也没有临时目录残留
    expect(fs.existsSync(newDir(home))).toBe(false);
    expect(listTmpMigrations(home)).toEqual([]);

    // 旧目录完好可用（数据没丢）
    expect(fs.readFileSync(path.join(legacy, 'env'), 'utf8')).toContain('sk-legacy-secret');
    expect(fs.readFileSync(path.join(legacy, 'config.json'), 'utf8')).toContain('deepseek-chat');
  });

  it('ensureLiwenHome：迁移失败后 liwenHome() 回退旧目录', () => {
    const home = tempHome();
    const legacy = seedLegacy(home);

    const result = ensureLiwenHome({ home, env: {}, fs: faultyFs('env') });

    expect(result.usedLegacyFallback).toBe(true);
    expect(result.warnings[0]?.code).toBe('home-migration-failed');
    expect(liwenHome()).toBe(legacy);
  });

  it('ensureLiwenHome：迁移成功后 liwenHome() 指向新目录', () => {
    const home = tempHome();
    seedLegacy(home);

    const result = ensureLiwenHome({ home, env: {} });

    expect(result.migrated).toBe(true);
    expect(liwenHome()).toBe(newDir(home));
  });

  it('SYAOCODE_HOME 指定的数据目录不做搬迁，只提示（用户显式配置优先）', () => {
    const home = tempHome();
    const legacy = seedLegacy(home);
    const custom = path.join(home, 'custom');
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, 'config.json'), '{"language":"zh"}');

    const result = migrateLegacyHome({ home, env: { [LEGACY_HOME_ENV]: custom } });

    expect(result.source).toBe('env-legacy');
    expect(result.migrated).toBe(false);
    expect(result.dataDir).toBe(custom);
    expect(result.notices[0]?.code).toBe('legacy-env-var');
    // 旧目录没被动过，新目录也没被创建
    expect(fs.existsSync(path.join(legacy, 'config.json'))).toBe(true);
    expect(fs.existsSync(newDir(home))).toBe(false);
  });

  it('LIWENCODE_HOME 指定的数据目录优先于旧目录，不触发默认迁移', () => {
    const home = tempHome();
    seedLegacy(home);
    const custom = path.join(home, 'new-data');
    fs.mkdirSync(custom, { recursive: true });

    const result = migrateLegacyHome({ home, env: { [LIWEN_HOME_ENV]: custom } });

    expect(result.source).toBe('env-new');
    expect(result.migrated).toBe(false);
    expect(result.dataDir).toBe(custom);
    expect(result.notices).toEqual([]);
    expect(fs.existsSync(newDir(home))).toBe(false);
  });

  it('没有旧目录时不迁移、不报错', () => {
    const home = tempHome();
    const result = migrateLegacyHome({ home, env: {} });
    expect(result.migrated).toBe(false);
    expect(result.usedLegacyFallback).toBe(false);
    expect(result.dataDir).toBe(newDir(home));
    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(newDir(home))).toBe(false);
  });

  it('注入 fs/home/env：模块不产生 import 期副作用', () => {
    const home = tempHome();
    const before = fs.readdirSync(home);
    resolveDataHome({ home, env: {} });
    migrateLegacyHome({ home, env: {} });
    expect(fs.readdirSync(home)).toEqual(before);
  });
});

describe('CLI 启动时真实迁移（E2E）', () => {
  it('liwen version：首次启动把旧目录复制到新目录，旧目录保留', () => {
    const home = tempHome();
    const legacy = seedLegacy(home);

    const run = runCli(home, ['--version']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('liwen v');
    // 新目录已就位且内容完整
    expect(fs.existsSync(path.join(newDir(home), 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(newDir(home), 'env'))).toBe(true);
    expect(fs.statSync(path.join(newDir(home), 'env')).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(newDir(home), MIGRATION_MARKER_FILE))).toBe(true);
    // 旧目录仍在（复制而非移动）
    expect(fs.existsSync(path.join(legacy, 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(legacy, 'env'))).toBe(true);
    // 没有迁移失败告警
    expect(run.stderr).not.toContain('home-migration-failed');
  });

  it('SYAOCODE_HOME 兼容：沿用旧变量目录并输出弃用提示', () => {
    const home = tempHome();
    const legacyData = path.join(home, 'custom-legacy');
    fs.mkdirSync(legacyData, { recursive: true });
    fs.writeFileSync(path.join(legacyData, 'config.json'), JSON.stringify({ language: 'zh' }));

    const run = runCli(home, ['--version'], { [LEGACY_HOME_ENV]: legacyData });

    expect(run.code).toBe(0);
    expect(run.stderr).toContain('deprecated');
    expect(run.stderr).toContain(LEGACY_HOME_ENV);
    // 显式环境变量目录不搬迁，也不创建默认新目录
    expect(fs.existsSync(newDir(home))).toBe(false);
  });
});
