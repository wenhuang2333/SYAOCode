/**
 * 数据目录解析 —— 唯一入口（实现 `OI-D-07` / `DesktopDoc/00-基线` §7.3.1）
 *
 * 现有 CLI 的问题是路径解析散落在四处，且只认 `$HOME`：
 *   - `cli/src/model-config.ts:73` `liwenHome()`
 *   - `cli/src/main.ts:74`（`config path` 直接拼字符串）
 *   - `cli/src/doctor.ts:43`（同样直接拼）
 *   - `tools/src/bash.ts:75`（`~` 展开）
 *
 * 后果：Windows 上 `HOME` 常未设置 → 静默回退到 `.` → `.liwencode` 落在**当前工作目录**。
 *
 * 本模块是桌面端的唯一解析入口，规则：
 *   `LIWENCODE_HOME` → `SYAOCODE_HOME`（旧变量，兼容）→ `os.homedir()/.liwencode` → **报错**（不再静默回退）
 *
 * 解析失败是**致命错误**，不是"用个默认值凑合"——数据写到错误位置比启动失败更糟。
 *
 * ── 改名迁移（SYAOCode → LIWENCode）─────────────────────────────────────
 *
 * 改名把默认家园目录从 `~/.syaocode` 换成了 `~/.liwencode`，所以升级用户必须
 * 能"看见"旧目录里的会话 / 凭据元信息 / Git 元数据。本模块只负责**纯解析**：
 *   - 新目录（唯一写入目标）：`LIWENCODE_HOME` → `SYAOCODE_HOME` → `~/.liwencode`
 *   - 旧目录候选（**只读**，仅用于迁移来源）：`SYAOCODE_HOME` → 目标目录的同级
 *     `.syaocode` → 家目录下的 `.syaocode`（仅当目标目录在家目录内时）
 *
 * 真正的复制 / 幂等 / 失败回滚在 `home-migration.ts`，由 `createHost` 在打开
 * `DesktopStateStore` **之前**调用。纯解析放在这里，是为了让 `paths.ts` 保持
 * 无副作用（任何 import 都不会碰磁盘）。
 */

import * as os from 'node:os';
import * as path from 'node:path';

/** 覆盖变量名。与 CLI 侧（待合入）保持一致。 */
export const LIWENCODE_HOME_ENV = 'LIWENCODE_HOME';

/**
 * 旧变量名（SYAOCode 时代）。
 *
 * 已废弃，但**仍然识别**：未设新变量时它决定数据目录（否则老用户设了自定义目录
 * 会被静默搬到别处）；同时它也是迁移来源的第一候选。迁移层会输出废弃提示。
 */
export const LEGACY_HOME_ENV = 'SYAOCODE_HOME';

/** 旧数据目录名（默认 `~/.syaocode`）。 */
export const LEGACY_HOME_DIR_NAME = '.syaocode';

/** 新数据目录名（默认 `~/.liwencode`）。 */
export const LIWENCODE_HOME_DIR_NAME = '.liwencode';

/** 迁移标记文件名（写在**新**目录根下；旧目录原样保留，可降级回旧版本）。 */
export const MIGRATION_MARKER_FILE = '.migrated-from-syaocode.json';

export interface LIWENPaths {
  /** 家园目录（`<home>/.liwencode` 或 `LIWENCODE_HOME`）。 */
  readonly home: string;
  readonly configFile: string;
  readonly envFile: string;
  readonly sessionsDir: string;
  readonly usageDir: string;
  readonly evidenceDir: string;
  readonly arfDir: string;
  /** 桌面端专属（窗口布局、草稿、最近工作区）。 */
  readonly desktopDir: string;
}

export class LIWENHomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LIWENHomeError';
  }
}

/** 旧目录候选的来源类别（写进迁移标记，便于审计"数据是从哪来的"）。 */
export type LegacyHomeSourceKind = 'env' | 'sibling' | 'home';

export interface LegacyHomeSource {
  /** 旧目录绝对路径。 */
  readonly dir: string;
  /** 来源类别：`env` = 旧环境变量；`sibling` = 新目录同级；`home` = 家目录下。 */
  readonly kind: LegacyHomeSourceKind;
}

/** 数据目录计划：一个写入目标 + 若干只读旧目录候选（按优先级）。 */
export interface HomePlan {
  /** 新目录（**唯一**写入目标）。 */
  readonly targetHome: string;
  /** 旧目录候选（**只读**，按优先级排列；已去重、已排除与目标相同的路径）。 */
  readonly legacySources: readonly LegacyHomeSource[];
  /** 是否识别到旧变量（需要提示废弃）。 */
  readonly legacyEnvUsed: boolean;
  /** 旧变量的原始值（用于提示；未设置时为 `null`）。 */
  readonly legacyEnvValue: string | null;
}

function isSetEnv(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/** `child` 是否位于 `parent` 之内（含相等）。跨平台，不依赖字符串前缀。 */
function isUnder(parent: string, child: string): boolean {
  if (parent === '') return false;
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 解析家园目录（纯函数，可注入 `env` / `homedir`）。
 *
 * 优先级：`LIWENCODE_HOME` → `SYAOCODE_HOME`（兼容）→ `<homedir>/.liwencode` → 报错。
 */
function resolveHomeWith(
  env: Record<string, string | undefined>,
  homedir: string,
): string {
  const override = env[LIWENCODE_HOME_ENV];
  if (isSetEnv(override)) {
    return path.resolve(override.trim());
  }
  const legacy = env[LEGACY_HOME_ENV];
  if (isSetEnv(legacy)) {
    // 旧变量仍生效：用户显式设过自定义目录，静默换位置比"用旧目录"更危险。
    return path.resolve(legacy.trim());
  }
  if (homedir === undefined || homedir === '') {
    // 明确报错而不是 `path.join('.', '.liwencode')` —— 后者会把用户的会话
    // 写到当前工作目录里，且用户完全不会察觉。
    throw new LIWENHomeError(
      `cannot resolve LIWENCode home: ${LIWENCODE_HOME_ENV} is unset and os.homedir() is empty. ` +
        `Set ${LIWENCODE_HOME_ENV} to an absolute path.`,
    );
  }
  return path.join(homedir, LIWENCODE_HOME_DIR_NAME);
}

/**
 * 解析家园目录。
 *
 * `env` 可注入，便于测试（也避免测试去改 `process.env` 造成并行污染）。
 */
export function resolveLIWENHome(env: Record<string, string | undefined> = process.env): string {
  return resolveHomeWith(env, os.homedir());
}

/**
 * 解析"写入目标 + 旧目录候选"。
 *
 * 旧目录候选的选取规则（**只读**，绝不写入）：
 *  1. `SYAOCODE_HOME`（显式指定，优先级最高）；
 *  2. 目标目录的同级 `.syaocode` —— 默认目标 `~/.liwencode` 时正好是 `~/.syaocode`，
 *     这也是测试能构造假旧目录而不碰真实家目录的原因；
 *  3. 家目录下的 `.syaocode` —— 仅当目标目录就在家目录内（`LIWENCODE_HOME=~/data/x`
 *     这类"仍在家目录里换个位置"的用法）；目标在家目录外时不猜，避免把
 *     `~/.syaocode` 复制到 `/data` 这类无关位置。
 *
 * 已存在的目标目录**永远优先**（`home-migration.ts` 不会覆盖它）。
 */
export function resolveHomePlan(
  env: Record<string, string | undefined> = process.env,
  options: { readonly homedir?: string } = {},
): HomePlan {
  const homedir = options.homedir ?? os.homedir();
  const targetHome = resolveHomeWith(env, homedir);

  const rawLegacy = env[LEGACY_HOME_ENV];
  const legacyEnvValue = isSetEnv(rawLegacy) ? rawLegacy.trim() : null;

  const candidates: LegacyHomeSource[] = [];
  const push = (dir: string, kind: LegacyHomeSourceKind): void => {
    if (dir === targetHome) return;
    if (candidates.some((c) => c.dir === dir)) return;
    candidates.push({ dir, kind });
  };

  if (legacyEnvValue !== null) push(path.resolve(legacyEnvValue), 'env');
  push(path.join(path.dirname(targetHome), LEGACY_HOME_DIR_NAME), 'sibling');
  if (isUnder(homedir, targetHome)) {
    push(path.join(homedir, LEGACY_HOME_DIR_NAME), 'home');
  }

  return { targetHome, legacySources: candidates, legacyEnvUsed: legacyEnvValue !== null, legacyEnvValue };
}

/**
 * 一次性构造全部路径。任何模块**不得**再手写拼接。
 *
 * `options.home` 用于迁移层：迁移失败回退到旧目录、或迁移成功后统一以
 * "实际生效的家园目录"为准（否则会算出一份与实际数据不一致的路径）。
 */
export function liwenPaths(
  env: Record<string, string | undefined> = process.env,
  options: { readonly home?: string } = {},
): LIWENPaths {
  const home = options.home ?? resolveLIWENHome(env);
  return {
    home,
    configFile: path.join(home, 'config.json'),
    envFile: path.join(home, 'env'),
    sessionsDir: path.join(home, 'sessions'),
    usageDir: path.join(home, 'usage'),
    evidenceDir: path.join(home, 'evidence'),
    arfDir: path.join(home, 'arf'),
    desktopDir: path.join(home, 'desktop'),
  };
}

/**
 * 把绝对路径里的家园前缀替换为 `~`，用于**诊断包与日志**。
 * 路径本身可能含用户名，不能原样进诊断包（`16` §5.3）。
 */
export function redactHomeInPath(p: string, home: string = os.homedir()): string {
  if (home === '') return p;
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** 会话日志路径：`<home>/sessions/<projectHash>/<sessionId>.jsonl`（与 CLI 同构）。 */
export function sessionLogPath(paths: LIWENPaths, projectHash: string, sessionId: string): string {
  return path.join(paths.sessionsDir, projectHash, `${sessionId}.jsonl`);
}
