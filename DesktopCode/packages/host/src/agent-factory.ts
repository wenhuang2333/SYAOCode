/**
 * Agent 工厂：把 `provider:model` 规格解析成内核可用的 `Agent`。
 *
 * 支持的 provider：
 *  - `mock`               —— 确定性剧本，用于测试与离线演示
 *  - `deepseek`           —— OpenAI 兼容
 *  - `openai-compatible`  —— 任意兼容端点
 *  - `anthropic`          —— 原生 Messages
 *
 * 密钥**只**从环境变量读取（Host 启动时由 Shell 注入或从 `~/.syaocode/env` 合并）。
 * 本模块不读写密钥文件，也不把密钥放进任何返回值。
 */

import {
  createAgent,
  type Agent,
  type PermissionHandler,
  type PermissionMode,
  type Provider,
  type Runtime,
} from '@syaocode/core';
import { nodeRuntime } from '@syaocode/node';
import { createAnthropicProvider, createOpenAICompatibleProvider } from '@syaocode/providers';
import { createBuiltinTools } from '@syaocode/tools';
import { MockProvider, mockText, mockToolUse } from '@syaocode/testing';

export interface ModelSpec {
  readonly provider: string;
  readonly model: string;
}

/** 解析 `provider:model`。缺失 provider 时回退 `mock`（与 CLI 的默认一致）。 */
export function parseModelSpec(raw: string | undefined): ModelSpec {
  if (raw === undefined || raw.trim() === '') return { provider: 'mock', model: 'default' };
  const idx = raw.indexOf(':');
  if (idx < 0) return { provider: raw.trim(), model: 'default' };
  const provider = raw.slice(0, idx).trim();
  const model = raw.slice(idx + 1).trim();
  return { provider: provider === '' ? 'mock' : provider, model: model === '' ? 'default' : model };
}

export type ProviderBuildResult =
  | { readonly ok: true; readonly provider: Provider; readonly model: string }
  | { readonly ok: false; readonly reason: string };

const KEY_ENV: Readonly<Record<string, string>> = {
  deepseek: 'DEEPSEEK_API_KEY',
  'openai-compatible': 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/**
 * 构造 provider。
 *
 * **不**在这里做网络探测——探测会让启动变慢，且离线时误报。
 * 「密钥是否就绪」由 `model/list` 的 `hasKey` 表达，真正的失败在第一次请求时以
 * `SY-PRV-*` 返回。
 */
export function buildProvider(
  spec: ModelSpec,
  runtime: Runtime,
  env: Record<string, string | undefined> = process.env,
): ProviderBuildResult {
  switch (spec.provider) {
    case 'mock': {
      // 默认剧本：第一轮纯文本，第二轮带一次 read 工具调用，第三轮收尾。
      // 让离线演示也能看到"文本 → 工具 → 收尾"的完整过程。
      const provider = new MockProvider({
        script: [
          mockText('m1', '这是 mock provider 的回复。当前处于离线模式。'),
          mockToolUse('m2', [{ id: 'call_1', name: 'read', input: { path: 'README.md' } }]),
          mockText('m3', '已完成。'),
        ],
      });
      return { ok: true, provider, model: spec.model };
    }
    case 'deepseek': {
      const key = env['DEEPSEEK_API_KEY'];
      if (key === undefined || key === '') {
        return { ok: false, reason: `missing ${KEY_ENV['deepseek']}` };
      }
      return {
        ok: true,
        provider: createOpenAICompatibleProvider({
          runtime,
          apiKey: key,
          baseUrl: env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com/v1',
          id: 'deepseek',
        }),
        model: spec.model,
      };
    }
    case 'openai-compatible': {
      const key = env['OPENAI_API_KEY'];
      if (key === undefined || key === '') {
        return { ok: false, reason: `missing ${KEY_ENV['openai-compatible']}` };
      }
      return {
        ok: true,
        provider: createOpenAICompatibleProvider({
          runtime,
          apiKey: key,
          baseUrl: env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1',
          id: 'openai-compatible',
        }),
        model: spec.model,
      };
    }
    case 'anthropic': {
      const key = env['ANTHROPIC_API_KEY'];
      if (key === undefined || key === '') {
        return { ok: false, reason: `missing ${KEY_ENV.anthropic}` };
      }
      return {
        ok: true,
        provider: createAnthropicProvider({ runtime, apiKey: key }),
        model: spec.model,
      };
    }
    default:
      return { ok: false, reason: `unknown provider: ${spec.provider}` };
  }
}

/** 该 provider 是否需要密钥（用于 `model/list` 的 `hasKey`）。 */
export function providerNeedsKey(provider: string): boolean {
  return provider !== 'mock';
}

export function hasKeyFor(provider: string, env: Record<string, string | undefined> = process.env): boolean {
  const name = KEY_ENV[provider];
  if (name === undefined) return true; // mock 或未知 provider 不因缺 key 阻断
  const v = env[name];
  return v !== undefined && v !== '';
}

export interface CreateDesktopAgentOptions {
  readonly modelSpec: string;
  readonly cwd: string;
  readonly permissionMode: PermissionMode;
  readonly permissionHandler: PermissionHandler;
  readonly env?: Record<string, string | undefined>;
}

export type CreateAgentResult =
  | { readonly ok: true; readonly agent: Agent; readonly model: string }
  | { readonly ok: false; readonly reason: string };

/**
 * 创建一个桌面端可用的 agent。
 *
 * 与 CLI 的差异（**有意**）：
 *  - 不在内部读配置文件（配置由 `ConfigService` 统一给出，单一真相）
 *  - `permissionHandler` 必须由调用方注入（即 `InteractionBroker`），
 *    这样审批一定经过 UI，不会被静默放行
 */
export function createDesktopAgent(opts: CreateDesktopAgentOptions): CreateAgentResult {
  const spec = parseModelSpec(opts.modelSpec);
  const runtime = nodeRuntime();
  const built = buildProvider(spec, runtime, opts.env ?? process.env);
  if (!built.ok) return { ok: false, reason: built.reason };

  const { tools } = createBuiltinTools();

  const agent = createAgent({
    provider: built.provider,
    model: built.model,
    cwd: opts.cwd,
    tools,
    permissionMode: opts.permissionMode,
    permissionHandler: opts.permissionHandler,
    runtime,
  });

  return { ok: true, agent, model: `${spec.provider}:${built.model}` };
}
