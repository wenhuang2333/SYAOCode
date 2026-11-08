/**
 * 数据目录迁移：`~/.syaocode`（SYAOCode 时代）→ `~/.liwencode`（LIWENCode 时代）。
 *
 * 改名把默认家园目录换了个名字，升级用户的会话 / 凭据元信息 / Git 元数据还在旧目录里。
 * 这一层负责把它们**安全地**搬到新目录，纪律只有四条：
 *
 *  1. **只复制，不移动**：旧目录原样保留，用户随时可以降级回旧版本；
 *  2. **只在新目录不存在时搬**：新目录已存在 → 新目录优先，绝不覆盖新内容（幂等）；
 *  3. **失败不丢数据**：复制失败 → 清理半成品 → 继续用旧目录，并返回结构化告警；
 *  4. **无副作用**：本模块不 import 即执行任何 IO；迁移只在 `createHost` 显式调用。
 *
 * 解析（写入目标 + 旧目录候选）在 `paths.ts`，那里保持纯函数、无磁盘访问。
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {
  LEGACY_HOME_ENV,
  MIGRATION_MARKER_FILE,
  type HomePlan,
  type LegacyHomeSourceKind,
} from './paths.ts';

/** 迁移标记（写在新目录根下）。 */
export interface MigrationMarker {
  /** ISO 时间戳。 */
  readonly migratedAt: string;
  /** 毫秒时间戳（排序 / 比对用）。 */
  readonly migratedAtMs: number;
  /** 旧目录绝对路径（来源）。 */
  readonly source: string;
  /** 来源类别：`env` / `sibling` / `home`。 */
  readonly sourceKind: LegacyHomeSourceKind;
  /** 执行迁移的工具版本。 */
  readonly toolVersion: string;
  /** 复制的文件数。 */
  readonly files: number;
  /** 复制的字节数。 */
  readonly bytes: number;
}

/** 迁移过程中的结构化告警。 */
export type HomeMigrationWarningCode =
  /** 旧环境变量仍在使用（需要提示废弃）。 */
  | 'legacy_env_deprecated'
  /** 没有找到旧目录（无需迁移）。 */
  | 'legacy_home_missing'
  /** 新目录已存在 → 新目录优先，跳过迁移。 */
  | 'legacy_home_skipped'
  /** 迁移成功。 */
  | 'legacy_home_migrated'
  /** 复制失败 → 已回滚并回退到旧目录。 */
  | 'copy_failed';

export interface HomeMigrationWarning {
  readonly code: HomeMigrationWarningCode;
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly detail?: Record<string, unknown>;
}

export interface HomeMigrationResult {
  /** **实际生效**的家园目录：迁移成功 = 新目录；失败回退 = 旧目录。 */
  readonly home: string;
  /** 计划中的新目录（写入目标）。 */
  readonly targetHome: string;
  /** 本次是否真的搬运了数据。 */
  readonly migrated: boolean;
  /** 迁移来源（旧目录）；没有来源时为 `null`。 */
  readonly source: string | null;
  /** 迁移标记文件路径；没有写入时为 `null`。 */
  readonly markerFile: string | null;
  readonly warnings: readonly HomeMigrationWarning[];
}

/** 最小化的文件状态视图（只暴露复制需要的字段，便于注入假 fs）。 */
export interface MigrationStat {
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly size: number;
  /** POSIX 权限位（复制后要还原：`env` 里存着 API Key，权限不能被放大）。 */
  readonly mode: number;
}

/**
 * 迁移用到的文件操作（可注入，便于测试失败分支）。
 *
 * 刻意做小：只有"复制一棵目录树"真正需要的操作，没有 `readFile` 之类的旁路，
 * 这样注入的假实现不可能意外读到别的东西。
 */
export interface MigrationFs {
  /** 不存在返回 `undefined`；其它错误照常抛出。 */
  lstat(target: string): Promise<MigrationStat | undefined>;
  mkdir(target: string, options?: { readonly recursive?: boolean }): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  chmod(target: string, mode: number): Promise<void>;
  readdir(target: string): Promise<readonly string[]>;
  readlink(target: string): Promise<string>;
  symlink(target: string, link: string): Promise<void>;
  /** 递归删除；目标不存在时不得报错。 */
  rm(target: string): Promise<void>;
  rename(src: string, dest: string): Promise<void>;
  writeFile(target: string, data: string): Promise<void>;
}

/** 生产用实现（`node:fs/promises`）。 */
export function nodeMigrationFs(): MigrationFs {
  return {
    async lstat(target) {
      try {
        const st = await fsPromises.lstat(target);
        return { isDirectory: st.isDirectory(), isSymbolicLink: st.isSymbolicLink(), size: st.size, mode: st.mode & 0o777 };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw e;
      }
    },
    async mkdir(target, options) {
      await fsPromises.mkdir(target, { recursive: options?.recursive ?? false });
    },
    async copyFile(src, dest) {
      await fsPromises.copyFile(src, dest);
    },
    async chmod(target, mode) {
      await fsPromises.chmod(target, mode);
    },
    async readdir(target) {
      return await fsPromises.readdir(target);
    },
    async readlink(target) {
      return await fsPromises.readlink(target);
    },
    async symlink(target, link) {
      await fsPromises.symlink(target, link);
    },
    async rm(target) {
      await fsPromises.rm(target, { recursive: true, force: true });
    },
    async rename(src, dest) {
      await fsPromises.rename(src, dest);
    },
    async writeFile(target, data) {
      await fsPromises.writeFile(target, data, { mode: 0o600 });
    },
  };
}

export interface HomeMigrationOptions {
  /** 解析好的计划（写入目标 + 旧目录候选）。 */
  readonly plan: HomePlan;
  /** 可注入的文件系统（测试用；默认 `nodeMigrationFs()`）。 */
  readonly fs?: MigrationFs;
  /** 可注入时钟（测试用；默认 `Date.now`）。 */
  readonly now?: () => number;
  /** 工具版本（写进迁移标记）。 */
  readonly toolVersion?: string;
}

/**
 * 不该被搬过去的运行时产物。
 *
 * `desktop/host.lock` 是旧版本崩溃/强杀留下的锁文件：新目录里如果带着它，
 * `DesktopStateStore.open` 会报"状态被锁"（甚至因为 pid 复用而误判成活锁），
 * 让升级后的应用**开不起来**。锁不是数据，不搬。
 */
function isExcluded(relPath: string): boolean {
  if (relPath === 'desktop/host.lock') return true;
  if (relPath === 'desktop/host-lock-recovery') return true;
  if (relPath.startsWith('desktop/host-lock-recovery/')) return true;
  return false;
}

interface CopyStats {
  files: number;
  bytes: number;
}

/** 递归复制一棵目录树（文件逐字节复制，符号链接按链接复制，权限位还原）。 */
async function copyTree(
  fs: MigrationFs,
  src: string,
  dest: string,
  relBase: string,
  stats: CopyStats,
): Promise<void> {
  const entries = await fs.readdir(src);
  for (const entry of entries) {
    const from = path.join(src, entry);
    const to = path.join(dest, entry);
    const rel = relBase === '' ? entry : `${relBase}/${entry}`;
    if (isExcluded(rel)) continue;
    const st = await fs.lstat(from);
    if (st === undefined) continue;
    if (st.isSymbolicLink) {
      const link = await fs.readlink(from);
      await fs.symlink(link, to);
      continue;
    }
    if (st.isDirectory) {
      await fs.mkdir(to);
      await copyTree(fs, from, to, rel, stats);
      // 目录权限也要还原（`desktop/` 原本是 0700）。
      await fs.chmod(to, st.mode);
      continue;
    }
    await fs.copyFile(from, to);
    await fs.chmod(to, st.mode);
    stats.files += 1;
    stats.bytes += st.size;
  }
}

/**
 * 执行迁移。
 *
 * 返回值里的 `home` 是**实际生效**的家园目录：
 *   - 迁移成功（或新目录本来就在）→ 新目录；
 *   - 复制失败 → 旧目录（数据一条不少，只是没搬过去）。
 */
export async function migrateLegacyHome(options: HomeMigrationOptions): Promise<HomeMigrationResult> {
  const fs = options.fs ?? nodeMigrationFs();
  const now = options.now ?? Date.now;
  const toolVersion = options.toolVersion ?? '0.1.0';
  const { plan } = options;
  const warnings: HomeMigrationWarning[] = [];

  if (plan.legacyEnvValue !== null) {
    warnings.push({
      code: 'legacy_env_deprecated',
      level: 'warn',
      message: `${LEGACY_HOME_ENV} 已废弃，请改用 LIWENCODE_HOME；本次仍按它解析数据目录（${plan.legacyEnvValue}）。`,
      detail: { env: LEGACY_HOME_ENV, value: plan.legacyEnvValue, targetHome: plan.targetHome },
    });
  }

  const target = plan.targetHome;
  const targetStat = await fs.lstat(target);
  if (targetStat !== undefined && targetStat.isDirectory) {
    // 新目录已在 → 新目录优先。绝不覆盖既有内容（幂等的第一条纪律）。
    warnings.push({
      code: 'legacy_home_skipped',
      level: 'info',
      message: `数据目录已存在，使用新目录（不迁移、不覆盖）：${target}`,
      detail: { targetHome: target },
    });
    return { home: target, targetHome: target, migrated: false, source: null, markerFile: null, warnings };
  }

  // 找第一个存在的旧目录（按候选优先级）。
  let source: { dir: string; kind: LegacyHomeSourceKind } | undefined;
  for (const candidate of plan.legacySources) {
    const st = await fs.lstat(candidate.dir);
    if (st !== undefined && st.isDirectory) {
      source = { dir: candidate.dir, kind: candidate.kind };
      break;
    }
  }
  if (source === undefined) {
    warnings.push({
      code: 'legacy_home_missing',
      level: 'info',
      message: '未发现旧数据目录，无需迁移。',
      detail: { searched: plan.legacySources.map((c) => c.dir) },
    });
    return { home: target, targetHome: target, migrated: false, source: null, markerFile: null, warnings };
  }

  // 先搬到暂存目录，成功后再改名到位：失败时新目录**根本不会出现**，
  // 不存在"半个新目录"这种状态。
  const staging = `${target}.migrating`;
  try {
    await fs.rm(staging); // 清掉上次崩溃留下的残骸
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.mkdir(staging);
    const stats: CopyStats = { files: 0, bytes: 0 };
    await copyTree(fs, source.dir, staging, '', stats);
    const marker: MigrationMarker = {
      migratedAt: new Date(now()).toISOString(),
      migratedAtMs: now(),
      source: source.dir,
      sourceKind: source.kind,
      toolVersion,
      files: stats.files,
      bytes: stats.bytes,
    };
    await fs.writeFile(path.join(staging, MIGRATION_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
    await fs.chmod(staging, 0o700);
    await fs.rename(staging, target);
    warnings.push({
      code: 'legacy_home_migrated',
      level: 'info',
      message: `旧数据目录已复制到新目录（旧目录原样保留，可降级回旧版本）：${source.dir} → ${target}`,
      detail: { source: source.dir, targetHome: target, files: stats.files, bytes: stats.bytes, toolVersion },
    });
    return {
      home: target,
      targetHome: target,
      migrated: true,
      source: source.dir,
      markerFile: path.join(target, MIGRATION_MARKER_FILE),
      warnings,
    };
  } catch (error) {
    // 回滚：清掉半成品，新目录保持"不存在"（下次启动可以重试）。
    await fs.rm(staging).catch(() => undefined);
    const raced = await fs.lstat(target).catch(() => undefined);
    if (raced !== undefined && raced.isDirectory) {
      // 搬运途中别人把新目录建起来了：那份数据已经是"新目录优先"，不用回退。
      warnings.push({
        code: 'legacy_home_skipped',
        level: 'warn',
        message: `迁移未完成，但新目录已存在，改用新目录：${target}`,
        detail: { targetHome: target, source: source.dir, error: errorMessage(error) },
      });
      return { home: target, targetHome: target, migrated: false, source: null, markerFile: null, warnings };
    }
    // 复制失败 → 继续用旧目录（数据一条不少），并给出结构化告警。
    warnings.push({
      code: 'copy_failed',
      level: 'error',
      message: `旧数据目录迁移失败，已回滚并继续使用旧目录：${source.dir}（新目录 ${target} 未创建）`,
      detail: { source: source.dir, targetHome: target, error: errorMessage(error) },
    });
    return { home: source.dir, targetHome: target, migrated: false, source: source.dir, markerFile: null, warnings };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
