import * as fs from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import * as path from 'node:path';
import { t, type Lang, type MsgKey } from './i18n/index.js';

/**
 * Provider catalog + user-facing model configuration (FR-135 /model).
 *
 * Storage layout (never committed; secrets never enter the repo or sessions):
 * - ~/.liwencode/config.json  — non-secret: default model, apiKeyEnv ref, baseUrl
 * - ~/.liwencode/env          — KEY=VALUE secrets, chmod 0600, loaded at startup
 */

export interface ProviderCatalogEntry {
  id: string;
  /** 展示名（i18n 键，按当前语言解析） */
  labelKey: MsgKey;
  kind: 'mock' | 'openai-compatible' | 'anthropic';
  apiKeyEnv: string | undefined;
  baseUrl: string;
  models: string[];
  needsKey: boolean;
}

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    id: 'mock',
    labelKey: 'provider.mock.label',
    kind: 'mock',
    apiKeyEnv: undefined,
    baseUrl: '',
    models: ['default'],
    needsKey: false,
  },
  {
    id: 'deepseek',
    labelKey: 'provider.deepseek.label',
    kind: 'openai-compatible',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    needsKey: true,
  },
  {
    id: 'openai-compatible',
    labelKey: 'provider.openai.label',
    kind: 'openai-compatible',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini'],
    needsKey: true,
  },
  {
    id: 'anthropic',
    labelKey: 'provider.anthropic.label',
    kind: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4', 'claude-haiku-4'],
    needsKey: true,
  },
];

export function providerLabel(entry: ProviderCatalogEntry): string {
  return t(entry.labelKey);
}

export function catalogEntry(providerId: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === providerId);
}

// ── 数据目录（data home）解析与旧目录迁移 ─────────────────────────────────

/** 新数据目录名（唯一写入目录）。 */
export const LIWEN_HOME_DIRNAME = '.liwencode';
/** 旧数据目录名（SYAOCode 时代）：只读兜底/迁移源，永不删除、永不移动。 */
export const LEGACY_HOME_DIRNAME = '.syaocode';
/** 新数据目录环境变量（优先级最高）。 */
export const LIWEN_HOME_ENV = 'LIWENCODE_HOME';
/** 旧数据目录环境变量（兼容：新变量存在时忽略）。 */
export const LEGACY_HOME_ENV = 'SYAOCODE_HOME';
/** 迁移标记文件：写入新目录，记录迁移时间与来源（供审计与人工核对）。 */
export const MIGRATION_MARKER_FILE = '.migrated-from-syaocode.json';

/** 数据目录来源：环境变量（新）> 环境变量（旧，兼容）> 默认 ~/.liwencode。 */
export type HomeSource = 'env-new' | 'env-legacy' | 'default';

/** 面向用户的提示（不阻断启动）。 */
export interface HomeNotice {
  code: string;
  message: string;
}

/** 结构化告警（迁移失败等；必须可见，不得静默丢数据）。 */
export interface HomeWarning extends HomeNotice {
  /** 原始错误文本（便于定位权限/磁盘问题）。 */
  cause?: string;
}

/** 迁移所需的最小 fs 面（结构兼容 node:fs；测试可注入故障实现）。 */
export interface HomeFs {
  existsSync(p: string): boolean;
  mkdirSync(p: string, options?: { recursive?: boolean; mode?: number }): string | undefined;
  readdirSync(p: string, options: { withFileTypes: true }): Dirent[];
  lstatSync(p: string): Stats;
  readlinkSync(p: string): string;
  symlinkSync(target: string, p: string): void;
  copyFileSync(src: string, dest: string): void;
  chmodSync(p: string, mode: number): void;
  readFileSync(p: string, encoding: 'utf8'): string;
  writeFileSync(p: string, data: string, options?: { mode?: number }): void;
  rmSync(p: string, options?: { recursive?: boolean; force?: boolean }): void;
  renameSync(oldPath: string, newPath: string): void;
}

/** 注入面：fs / 用户主目录 / 环境变量 / 时钟均可替换，模块 import 时零副作用。 */
export interface HomeOptions {
  /** 文件系统实现（默认 node:fs）。 */
  fs?: HomeFs;
  /** 用户主目录（默认 env.HOME，缺省 '.'）。 */
  home?: string;
  /** 环境变量快照（默认 process.env）。 */
  env?: Readonly<Record<string, string | undefined>>;
  /** 时间源（默认 Date.now），用于迁移标记与临时目录名。 */
  now?: () => number;
}

/** 数据目录解析结果（纯函数，无副作用）。 */
export interface ResolvedDataHome {
  /** 本进程应使用的数据目录（读与写都走这里；迁移失败时回退旧目录）。 */
  dataDir: string;
  /** 数据目录来源。 */
  source: HomeSource;
  /** 用户主目录。 */
  userHome: string;
  /** 默认新目录 ~/.liwencode（source=default 时既是目标也是唯一写入目录）。 */
  defaultNewDir: string;
  /** 默认旧目录 ~/.syaocode（source=default 时是迁移源，只读）。 */
  defaultLegacyDir: string;
  /** 提示（弃用提醒等）。 */
  notices: HomeNotice[];
}

/** 迁移结果。 */
export interface HomeMigrationResult {
  /** 本进程应使用的数据目录。 */
  dataDir: string;
  /** 数据目录来源。 */
  source: HomeSource;
  /** 是否真的执行了复制。 */
  migrated: boolean;
  /** 是否因迁移失败回退到旧目录（旧目录数据完好，只读兜底）。 */
  usedLegacyFallback: boolean;
  /** 迁移标记文件路径（仅迁移成功时存在）。 */
  markerPath?: string;
  /** 提示。 */
  notices: HomeNotice[];
  /** 结构化告警。 */
  warnings: HomeWarning[];
}

function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** `~` / `~/x` 展开到用户主目录；相对路径按 cwd 解析。 */
function expandUserPath(value: string, userHome: string): string {
  if (value === '~') return userHome;
  if (value.startsWith('~/')) return path.join(userHome, value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(value);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isDirectory(fsx: HomeFs, p: string): boolean {
  try {
    return fsx.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 解析数据目录（纯函数，无副作用）。
 *
 * 优先级：`LIWENCODE_HOME` > `SYAOCODE_HOME`（旧变量，兼容并提示）> `~/.liwencode`。
 * 仅默认来源才涉及旧目录 `~/.syaocode` 的迁移；显式环境变量优先于一切。
 */
export function resolveDataHome(options: HomeOptions = {}): ResolvedDataHome {
  const env = options.env ?? process.env;
  const userHome = options.home ?? env['HOME'] ?? '.';
  const defaultNewDir = path.join(userHome, LIWEN_HOME_DIRNAME);
  const defaultLegacyDir = path.join(userHome, LEGACY_HOME_DIRNAME);
  const notices: HomeNotice[] = [];

  const newEnv = envValue(env, LIWEN_HOME_ENV);
  if (newEnv !== undefined) {
    return {
      dataDir: expandUserPath(newEnv, userHome),
      source: 'env-new',
      userHome,
      defaultNewDir,
      defaultLegacyDir,
      notices,
    };
  }

  const legacyEnv = envValue(env, LEGACY_HOME_ENV);
  if (legacyEnv !== undefined) {
    const dir = expandUserPath(legacyEnv, userHome);
    notices.push({
      code: 'legacy-env-var',
      message:
        `${LEGACY_HOME_ENV} is deprecated; using ${dir} as the data directory. ` +
        `Set ${LIWEN_HOME_ENV} to the same path to silence this warning.`,
    });
    return {
      dataDir: dir,
      source: 'env-legacy',
      userHome,
      defaultNewDir,
      defaultLegacyDir,
      notices,
    };
  }

  return { dataDir: defaultNewDir, source: 'default', userHome, defaultNewDir, defaultLegacyDir, notices };
}

/** 进程级数据目录（模块级；仅由 ensureLiwenHome 显式设置，含迁移失败回退）。 */
let activeDataDir: string | undefined;

/**
 * 数据目录。
 * - 显式传入 `envHome`（旧 API 语义：用户主目录）时返回 `<envHome>/.liwencode`；
 * - 否则按环境变量解析（`LIWENCODE_HOME` > `SYAOCODE_HOME` > `~/.liwencode`）；
 *   迁移失败回退时返回旧目录。
 */
export function liwenHome(envHome?: string): string {
  if (envHome !== undefined) return path.join(envHome, LIWEN_HOME_DIRNAME);
  if (activeDataDir !== undefined) return activeDataDir;
  return resolveDataHome().dataDir;
}

export function userConfigPath(home?: string): string {
  return path.join(liwenHome(home), 'config.json');
}
export function envFilePath(home?: string): string {
  return path.join(liwenHome(home), 'env');
}

// ── 旧目录迁移（SYAOCode → LIWENCode） ────────────────────────────────────

/** 迁移标记内容（写入新目录，供审计/人工核对）。 */
export interface MigrationMarker {
  version: 1;
  tool: 'liwencode';
  /** ISO 时间戳。 */
  migratedAt: string;
  /** 旧目录绝对路径。 */
  source: string;
  /** 新目录绝对路径。 */
  destination: string;
  /** 复制（不是移动）：旧目录保留，旧版本仍可降级使用。 */
  mode: 'copy';
}

/** 递归复制一棵目录树：保留文件权限（env 文件必须仍是 0600）、保留符号链接。 */
function copyTree(fsx: HomeFs, src: string, dest: string): void {
  const st = fsx.lstatSync(src);
  if (st.isSymbolicLink()) {
    fsx.symlinkSync(fsx.readlinkSync(src), dest);
    return;
  }
  if (st.isDirectory()) {
    fsx.mkdirSync(dest, { recursive: true });
    for (const entry of fsx.readdirSync(src, { withFileTypes: true })) {
      copyTree(fsx, path.join(src, entry.name), path.join(dest, entry.name));
    }
    fsx.chmodSync(dest, st.mode & 0o777);
    return;
  }
  if (st.isFile()) {
    fsx.copyFileSync(src, dest);
    // 关键：保留源权限，env 文件迁移后仍必须是 0600
    fsx.chmodSync(dest, st.mode & 0o777);
    return;
  }
  // socket / fifo 等特殊文件跳过：复制它们没有意义，也可能阻塞
}

function writeMigrationMarker(
  fsx: HomeFs,
  dir: string,
  source: string,
  destination: string,
  nowMs: number,
): string {
  const marker: MigrationMarker = {
    version: 1,
    tool: 'liwencode',
    migratedAt: new Date(nowMs).toISOString(),
    source,
    destination,
    mode: 'copy',
  };
  const file = path.join(dir, MIGRATION_MARKER_FILE);
  fsx.writeFileSync(file, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/**
 * 旧数据目录迁移（复制语义，绝不 rename/move）。
 *
 * 规则：
 * - 目标 `~/.liwencode` 已存在 → 直接使用，不复制、不覆盖（幂等，可反复调用）；
 * - 目标不存在且源 `~/.syaocode` 存在 → 复制整棵树到临时目录 → 写迁移标记 → 原子改名到目标；
 * - 任一步失败 → 清理临时目录（不留半成品新目录），回退旧目录并返回结构化告警；
 * - 旧目录自始至终只读、原样保留（旧版本可降级）。
 */
export function migrateLegacyHome(options: HomeOptions = {}): HomeMigrationResult {
  const fsx: HomeFs = options.fs ?? fs;
  const resolved = resolveDataHome(options);
  const notices = resolved.notices;

  if (resolved.source !== 'default') {
    // 显式环境变量指定了数据目录：新变量优先，旧变量只作提示，不做目录搬迁。
    return {
      dataDir: resolved.dataDir,
      source: resolved.source,
      migrated: false,
      usedLegacyFallback: false,
      notices,
      warnings: [],
    };
  }

  const target = resolved.defaultNewDir;
  const legacy = resolved.defaultLegacyDir;

  if (fsx.existsSync(target)) {
    if (!isDirectory(fsx, target)) {
      return {
        dataDir: legacy,
        source: resolved.source,
        migrated: false,
        usedLegacyFallback: true,
        notices,
        warnings: [
          {
            code: 'home-target-not-directory',
            message: `${target} exists but is not a directory; falling back to ${legacy}.`,
          },
        ],
      };
    }
    // 幂等：新目录已在，绝不覆盖。
    return {
      dataDir: target,
      source: resolved.source,
      migrated: false,
      usedLegacyFallback: false,
      notices,
      warnings: [],
    };
  }

  if (!fsx.existsSync(legacy)) {
    // 首次使用：没有旧目录可迁移。
    return {
      dataDir: target,
      source: resolved.source,
      migrated: false,
      usedLegacyFallback: false,
      notices,
      warnings: [],
    };
  }
  if (!isDirectory(fsx, legacy)) {
    return {
      dataDir: target,
      source: resolved.source,
      migrated: false,
      usedLegacyFallback: false,
      notices,
      warnings: [
        {
          code: 'home-legacy-not-directory',
          message: `${legacy} exists but is not a directory; skipped migration.`,
        },
      ],
    };
  }

  const nowMs = (options.now ?? Date.now)();
  const temp = `${target}.migrating-${process.pid}-${nowMs}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fsx.mkdirSync(path.dirname(target), { recursive: true });
    copyTree(fsx, legacy, temp);
    writeMigrationMarker(fsx, temp, legacy, target, nowMs);
    fsx.renameSync(temp, target);
    return {
      dataDir: target,
      source: resolved.source,
      migrated: true,
      usedLegacyFallback: false,
      markerPath: path.join(target, MIGRATION_MARKER_FILE),
      notices,
      warnings: [],
    };
  } catch (e) {
    const cause = errorText(e);
    const warnings: HomeWarning[] = [
      {
        code: 'home-migration-failed',
        message:
          `Failed to migrate ${legacy} to ${target}: ${cause}. ` +
          `Continuing with ${legacy}; the old directory is left untouched (no data lost).`,
        cause,
      },
    ];
    try {
      // 回滚：清掉临时目录，绝不留半成品新目录。
      fsx.rmSync(temp, { recursive: true, force: true });
    } catch (cleanupError) {
      warnings.push({
        code: 'home-migration-cleanup-failed',
        message: `Failed to clean up the partial migration directory ${temp}: ${errorText(cleanupError)}`,
        cause: errorText(cleanupError),
      });
    }
    if (isDirectory(fsx, target)) {
      // 竞态：另一个进程刚完成了迁移 → 用它，不要回退。
      return {
        dataDir: target,
        source: resolved.source,
        migrated: false,
        usedLegacyFallback: false,
        notices,
        warnings: [
          ...warnings,
          {
            code: 'home-migration-raced',
            message: `Another process completed the migration to ${target}; using it.`,
          },
        ],
      };
    }
    return {
      dataDir: legacy,
      source: resolved.source,
      migrated: false,
      usedLegacyFallback: true,
      notices,
      warnings,
    };
  }
}

/**
 * CLI 启动时调用：解析数据目录 + 必要时执行一次性迁移。
 * 迁移失败时把后续 `liwenHome()` 调用回退到旧目录（提示与告警由调用方打印）。
 */
export function ensureLiwenHome(options: HomeOptions = {}): HomeMigrationResult {
  const result = migrateLegacyHome(options);
  // 进程内固定下来：后续 liwenHome() 与本函数返回的 dataDir 保持一致
  // （迁移失败时即回退到旧目录，旧目录数据完好）。
  activeDataDir = result.dataDir;
  return result;
}

/** 仅供测试：清除模块级回退状态。 */
export function resetLiwenHomeForTests(): void {
  activeDataDir = undefined;
}

// ── user config (non-secret) ─────────────────────────────────────────────

export interface UserModelConfig {
  provider: string;
  name: string;
  apiKeyEnv?: string;
  baseUrl?: string;
}

/** /setup 支持的四种 API 协议（后两种的适配器规划于 M2，配置先行保存） */
export type ProtocolKind = 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini';

/** 认证字段样式（密钥以 apiKeyEnv 存于 ~/.liwencode/env，绝不入 config.json） */
export type AuthFieldKind = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'query-key';

export const PROTOCOL_LABELS: Readonly<Record<ProtocolKind, string>> = {
  'anthropic': 'Anthropic Messages',
  'openai-chat': 'OpenAI ChatCompletion',
  'openai-responses': 'OpenAI Responses API (adapter M2)',
  'gemini': 'Gemini Native GenerateContent (adapter M2)',
};

export const AUTH_FIELD_LABELS: Readonly<Record<AuthFieldKind, string>> = {
  'bearer': 'Authorization: Bearer header',
  'x-api-key': 'x-api-key header',
  'x-goog-api-key': 'x-goog-api-key header',
  'query-key': '?key= query parameter',
};

/** 自定义模型档案（/setup 创建、/manage 管理）。密钥本体在 env 文件。 */
export interface ModelProfile {
  /** 模型名称，如 deepseek-chat */
  model: string;
  /** 请求地址 */
  baseUrl: string;
  /** API 协议 */
  protocol: ProtocolKind;
  /** 认证字段样式 */
  authField: AuthFieldKind;
  /** 密钥所在的 env 字段名（值存 ~/.liwencode/env） */
  apiKeyEnv: string;
  createdAt: number;
  updatedAt: number;
}

/** 协议边（/peer、`liwen mcp add`）：MCP server / A2A agent / ACP client */
export interface PeerConfig {
  /** 协议：mcp（stdio 命令）/ a2a（agent card URL）/ acp（客户端） */
  protocol: 'mcp' | 'a2a' | 'acp';
  /** 目标：mcp/acp 为命令行，a2a 为 agent card URL */
  target: string;
  /** 面板里显示的名称 */
  label?: string;
  /** 令牌的环境变量名（令牌本体永不写入配置文件） */
  tokenEnv?: string;
  addedAt: number;
}

export interface UserConfigFile {
  model?: UserModelConfig;
  permissionMode?: 'strict' | 'default' | 'acceptEdits' | 'plan' | 'bypass';
  /** CLI 语言（默认 en；/language 写入，下次启动生效） */
  language?: Lang;
  /** /setup 创建的自定义模型档案，key = 请求名称（profile 名） */
  models?: Record<string, ModelProfile>;
  /** /set-agents 创建的 agent 群，key = 群名 */
  agentGroups?: Record<string, AgentGroup>;
  /** 当前激活的 agent 群（/model use @群名 或 --agents 设置） */
  activeAgentGroup?: string;
  /** 协议边注册表（/peer、`liwen mcp add`）：MCP server / A2A agent / ACP client */
  peers?: Record<string, PeerConfig>;
}

/** 已保存的 CLI 语言（缺省英语） */
export function savedLanguage(home?: string): Lang {
  const saved = readUserConfig(home).language;
  return saved === 'zh' ? 'zh' : 'en';
}

/** 写入 CLI 语言（下次启动生效） */
export function saveLanguage(lang: Lang, home?: string): void {
  writeUserConfig({ ...readUserConfig(home), language: lang }, home);
}

// ── agent 群（/set-agents · /setting · /model） ──────────────────────────

/** 三角色：hyaki 提取总结（低成本）/ sota 思考规划（高能力）/ common 落实执行（均衡） */
export type AgentRole = 'hyaki' | 'sota' | 'common';

export const AGENT_ROLES: readonly AgentRole[] = ['hyaki', 'sota', 'common'];

export const ROLE_META: Readonly<Record<AgentRole, { title: string; color: number; desc: string }>> = {
  hyaki: { title: 'hyaki', color: 45, desc: 'large text intake & summarization (low-cost model advised)' },
  sota: { title: 'sota', color: 213, desc: 'thinking, planning & review (high-capability model advised)' },
  common: { title: 'common', color: 46, desc: 'implementation & execution (balanced model advised)' },
};

/** 一个 agent 群：三个角色各自绑定模型引用（"provider:model" 或 "@profile"）。
 * 允许同一模型担任多个角色（低成本场景可三角色同一模型）。 */
export interface AgentGroup {
  hyaki: string;
  sota: string;
  common: string;
  createdAt: number;
  updatedAt: number;
}

export function validGroupName(name: string): boolean {
  return validProfileName(name);
}

export function listAgentGroups(home?: string): Record<string, AgentGroup> {
  return readUserConfig(home).agentGroups ?? {};
}

export function getAgentGroup(name: string, home?: string): AgentGroup | undefined {
  return readUserConfig(home).agentGroups?.[name];
}

export function saveAgentGroup(name: string, group: AgentGroup, home?: string): void {
  const config = readUserConfig(home);
  config.agentGroups = config.agentGroups ?? {};
  config.agentGroups[name] = group;
  writeUserConfig(config, home);
}

export function deleteAgentGroup(name: string, home?: string): boolean {
  const config = readUserConfig(home);
  if (config.agentGroups?.[name] === undefined) return false;
  delete config.agentGroups[name];
  if (config.activeAgentGroup === name) delete config.activeAgentGroup;
  writeUserConfig(config, home);
  return true;
}

/** 激活群：主工作模型取 common 角色（执行面），并记录 activeAgentGroup 供未来 /agents 模式使用 */
export function activateAgentGroup(name: string, home?: string): { ok: boolean; common?: string } {
  const group = getAgentGroup(name, home);
  if (group === undefined) return { ok: false };
  const config = readUserConfig(home);
  config.activeAgentGroup = name;
  config.model = refToModelConfig(group.common);
  writeUserConfig(config, home);
  return { ok: true, common: group.common };
}

export function deactivateAgentGroup(home?: string): void {
  const config = readUserConfig(home);
  delete config.activeAgentGroup;
  writeUserConfig(config, home);
}

/** 展示用模型标签：@档案 → "@档案 (模型)"；内置 provider → "provider:model" */
export function modelSpecLabel(spec: { provider: string; model: string }): string {
  return spec.provider.startsWith('@') ? `${spec.provider} (${spec.model})` : `${spec.provider}:${spec.model}`;
}

/** 模型引用 → UserModelConfig（"provider:model" 或 "@profile"） */
export function refToModelConfig(ref: string): UserModelConfig {
  if (ref.startsWith('@')) {
    const profile = getProfile(ref.slice(1));
    return { provider: ref, name: profile?.model ?? 'default' };
  }
  const idx = ref.indexOf(':');
  return idx > 0 ? { provider: ref.slice(0, idx), name: ref.slice(idx + 1) } : { provider: 'mock', name: 'default' };
}

/** 可选模型引用清单：内置 Provider 全部模型 + 自定义档案（供向导选择） */
export function availableModelRefs(home?: string): string[] {
  const refs: string[] = [];
  for (const entry of PROVIDER_CATALOG) {
    for (const m of entry.models) refs.push(`${entry.id}:${m}`);
  }
  for (const name of Object.keys(listProfiles(home))) refs.push(`@${name}`);
  return refs;
}

export function readUserConfig(home?: string): UserConfigFile {
  const file = userConfigPath(home);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as UserConfigFile;
  } catch {
    return {};
  }
}

export function writeUserConfig(config: UserConfigFile, home?: string): void {
  const dir = liwenHome(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(userConfigPath(home), `${JSON.stringify(config, null, 2)}\n`);
}

// ── 模型档案存取（/setup · /manage） ─────────────────────────────────────

/** 档案名合法字符：字母数字、- _ .（不允许空格/冒号/斜杠，避免与 provider 语法冲突） */
export function validProfileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) && name.length <= 48;
}

export function listProfiles(home?: string): Record<string, ModelProfile> {
  return readUserConfig(home).models ?? {};
}

export function getProfile(name: string, home?: string): ModelProfile | undefined {
  return readUserConfig(home).models?.[name];
}

/** 保存/覆盖档案；apiKey 非空时写入 env 文件（0600）并同步进程环境。 */
export function saveProfile(name: string, profile: ModelProfile, apiKey: string | undefined, home?: string): void {
  const config = readUserConfig(home);
  config.models = config.models ?? {};
  config.models[name] = profile;
  writeUserConfig(config, home);
  if (apiKey !== undefined && apiKey !== '') {
    const envName = profile.apiKeyEnv;
    let entries: Record<string, string> = {};
    try {
      entries = parseEnvFile(fs.readFileSync(envFilePath(home), 'utf8'));
    } catch {
      /* 首次创建 */
    }
    entries[envName] = apiKey;
    writeEnvFile(entries, home);
    if (process.env[envName] === undefined || process.env[envName] === '') process.env[envName] = apiKey;
  }
}

export function deleteProfile(name: string, home?: string): boolean {
  const config = readUserConfig(home);
  if (config.models?.[name] === undefined) return false;
  delete config.models[name];
  // 当前默认模型指向该档案时一并回退到 mock，避免悬空引用
  if (config.model?.provider === `@${name}`) config.model = { provider: 'mock', name: 'default' };
  writeUserConfig(config, home);
  return true;
}

/** 档案密钥状态（进程环境 / env 文件 / 未设置） */
export function profileKeyStatus(profile: ModelProfile, home?: string): { set: boolean; source: 'process-env' | 'env-file' | 'none' } {
  if (process.env[profile.apiKeyEnv] !== undefined && process.env[profile.apiKeyEnv] !== '') {
    return { set: true, source: 'process-env' };
  }
  try {
    const parsed = parseEnvFile(fs.readFileSync(envFilePath(home), 'utf8'));
    if (parsed[profile.apiKeyEnv] !== undefined && parsed[profile.apiKeyEnv] !== '') return { set: true, source: 'env-file' };
  } catch {
    /* no file */
  }
  return { set: false, source: 'none' };
}

/** Resolve the default model spec: flag > env > user config > mock. */
export function resolveDefaultModel(flagModel: string | undefined, home?: string): { provider: string; name: string } {
  if (flagModel !== undefined && flagModel.includes(':')) {
    const [provider, name] = flagModel.split(':');
    return { provider: provider ?? 'mock', name: name ?? 'default' };
  }
  const env = process.env.LIWEN_MODEL;
  if (env !== undefined && env.includes(':')) {
    const [provider, name] = env.split(':');
    return { provider: provider ?? 'mock', name: name ?? 'default' };
  }
  const saved = readUserConfig(home).model;
  if (saved !== undefined) return { provider: saved.provider, name: saved.name };
  return { provider: 'mock', name: 'default' };
}

// ── secrets file (KEY=VALUE, 0600) ───────────────────────────────────────

/** Parse KEY=VALUE lines; '#' comments and blanks ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key.length > 0) out[key] = value;
  }
  return out;
}

export function formatEnvFile(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([k, v]) => `${k}=${v}\n`)
    .join('');
}

export function writeEnvFile(entries: Record<string, string>, home?: string): void {
  const dir = liwenHome(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = envFilePath(home);
  fs.writeFileSync(file, formatEnvFile(entries), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best-effort on exotic filesystems */
  }
}

/** Merge ~/.liwencode/env into process env without overriding real env (BR-024 spirit). */
export function loadSecretsIntoEnv(home?: string): number {
  let count = 0;
  try {
    const parsed = parseEnvFile(fs.readFileSync(envFilePath(home), 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined || process.env[k] === '') {
        process.env[k] = v;
        count += 1;
      }
    }
  } catch {
    /* no env file — fine */
  }
  return count;
}

export function maskKey(value: string | undefined): string {
  if (value === undefined || value === '') return t('common.notSet');
  if (value.length <= 10) return `${value.slice(0, 2)}****`;
  return t('key.masked', { prefix: value.slice(0, 5), suffix: value.slice(-4) });
}

export function keyStatusOf(entry: ProviderCatalogEntry, home?: string): { set: boolean; source: 'process-env' | 'env-file' | 'none' } {
  if (!entry.needsKey || entry.apiKeyEnv === undefined) return { set: true, source: 'process-env' };
  const name = entry.apiKeyEnv;
  if (process.env[name] !== undefined && process.env[name] !== '') return { set: true, source: 'process-env' };
  try {
    const parsed = parseEnvFile(fs.readFileSync(envFilePath(home), 'utf8'));
    if (parsed[name] !== undefined && parsed[name] !== '') return { set: true, source: 'env-file' };
  } catch {
    /* no file */
  }
  return { set: false, source: 'none' };
}
