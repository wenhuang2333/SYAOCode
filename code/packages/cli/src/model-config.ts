import * as fs from 'node:fs';
import * as path from 'node:path';
import { t, type Lang, type MsgKey } from './i18n/index.js';

/**
 * Provider catalog + user-facing model configuration (FR-135 /model).
 *
 * Storage layout (never committed; secrets never enter the repo or sessions):
 * - ~/.syaocode/config.json  — non-secret: default model, apiKeyEnv ref, baseUrl
 * - ~/.syaocode/env          — KEY=VALUE secrets, chmod 0600, loaded at startup
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

// ── paths ────────────────────────────────────────────────────────────────

export function syaoHome(envHome: string | undefined = process.env.HOME): string {
  return path.join(envHome ?? '.', '.syaocode');
}
export function userConfigPath(home?: string): string {
  return path.join(syaoHome(home), 'config.json');
}
export function envFilePath(home?: string): string {
  return path.join(syaoHome(home), 'env');
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

/** 认证字段样式（密钥以 apiKeyEnv 存于 ~/.syaocode/env，绝不入 config.json） */
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
  /** 密钥所在的 env 字段名（值存 ~/.syaocode/env） */
  apiKeyEnv: string;
  createdAt: number;
  updatedAt: number;
}

/** 协议边（/peer、`syao mcp add`）：MCP server / A2A agent / ACP client */
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
  /** 协议边注册表（/peer、`syao mcp add`）：MCP server / A2A agent / ACP client */
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
  const dir = syaoHome(home);
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
  const env = process.env.SYAO_MODEL;
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
  const dir = syaoHome(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = envFilePath(home);
  fs.writeFileSync(file, formatEnvFile(entries), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best-effort on exotic filesystems */
  }
}

/** Merge ~/.syaocode/env into process env without overriding real env (BR-024 spirit). */
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
