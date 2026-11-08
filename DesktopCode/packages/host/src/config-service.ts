/**
 * 配置服务：分层配置的读取 / 合并 / 写回。
 *
 * 层级（低 → 高优先级）：
 *   1. 默认值（代码内）
 *   2. 用户配置 `~/.liwencode/config.json`
 *   3. 项目配置 `<workspace>/.liwencode/config.json`
 *   4. 环境变量（`LIWEN_MODEL` / `LIWEN_PERMISSION_MODE`）
 *
 * 与 CLI 的**关键差异**：写回只写用户配置，且用 `tmp + rename` 原子替换。
 * 非原子写会在与 CLI 并行运行时产生"半写文件"，那是静默数据损坏。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LIWENPaths } from './paths.ts';

export type Language = 'en' | 'zh';

export interface EffectiveConfig {
  readonly model: string;
  readonly permissionMode: string;
  readonly language: Language;
  readonly workspaceRoot: string;
  /** 每个键的来源层 —— UI **必须**显示，否则用户不知道值从哪来。 */
  readonly sources: Readonly<Record<string, string>>;
}

interface RawConfig {
  model?: unknown;
  permissionMode?: unknown;
  language?: unknown;
  [key: string]: unknown;
}

const DEFAULTS = {
  model: 'mock:default',
  permissionMode: 'default',
  language: 'en' as Language,
} as const;

const VALID_MODES = new Set(['strict', 'default', 'acceptEdits', 'plan', 'bypass']);

export class ConfigService {
  constructor(
    private readonly paths: LIWENPaths,
    private readonly workspaceRoot: string,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  /** 计算生效配置（不写盘）。 */
  async effective(): Promise<EffectiveConfig> {
    const user = await this.readJson(this.paths.configFile);
    const project = await this.readJson(path.join(this.workspaceRoot, '.liwencode', 'config.json'));

    const sources: Record<string, string> = {};
    const pick = (key: 'model' | 'permissionMode' | 'language'): unknown => {
      const envKey = key === 'model' ? 'LIWEN_MODEL' : key === 'permissionMode' ? 'LIWEN_PERMISSION_MODE' : undefined;
      const envVal = envKey === undefined ? undefined : this.env[envKey];
      if (envVal !== undefined && envVal !== '') {
        sources[key] = 'env';
        return envVal;
      }
      // Project-controlled files cannot opt the user into bypass or unknown modes.
      if (project[key] !== undefined && (key !== 'permissionMode' || (typeof project[key] === 'string' && project[key] !== 'bypass' && VALID_MODES.has(project[key])))) {
        sources[key] = 'project';
        return project[key];
      }
      if (user[key] !== undefined) {
        sources[key] = 'user';
        return user[key];
      }
      sources[key] = 'default';
      return DEFAULTS[key];
    };

    const model = String(pick('model'));
    const rawMode = String(pick('permissionMode'));
    const permissionMode = VALID_MODES.has(rawMode) ? rawMode : DEFAULTS.permissionMode;
    const rawLang = String(pick('language'));
    const language: Language = rawLang === 'zh' ? 'zh' : 'en';

    return { model, permissionMode, language, workspaceRoot: this.workspaceRoot, sources };
  }

  /**
   * 写回用户配置。**只**改该键，保留文件中其他字段
   * （否则会把用户手工加的 `models` 档案一并抹掉）。
   */
  async set(key: 'model' | 'permissionMode' | 'language', value: string): Promise<void> {
    if (key === 'permissionMode' && !VALID_MODES.has(value)) {
      throw new Error(`invalid permissionMode: ${value}`);
    }
    if (key === 'language' && value !== 'en' && value !== 'zh') {
      throw new Error(`invalid language: ${value}`);
    }
    const current = await this.readJson(this.paths.configFile);
    const next: RawConfig = { ...current, [key]: value };
    await this.writeJsonAtomic(this.paths.configFile, next);
  }

  private async readJson(file: string): Promise<RawConfig> {
    try {
      const text = await fs.readFile(file, 'utf8');
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'object' && parsed !== null ? (parsed as RawConfig) : {};
    } catch {
      // 缺失或损坏都按空配置处理（与 CLI 的容错一致），但**不**静默覆盖。
      return {};
    }
  }

  /** 原子写：写 tmp → fsync → rename。 */
  private async writeJsonAtomic(file: string, data: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  }
}
