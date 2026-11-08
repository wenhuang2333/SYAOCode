/**
 * Agent 工厂：把 `provider:model` 规格解析成内核可用的 `Agent`。
 *
 * 支持的 provider：
 *  - `mock`               —— 确定性剧本，用于测试与离线演示
 *  - `deepseek`           —— OpenAI 兼容
 *  - `openai-compatible`  —— 任意兼容端点
 *  - `anthropic`          —— 原生 Messages
 *
 * 密钥**只**从环境变量读取（Host 启动时由 Shell 注入或从 `~/.liwencode/env` 合并）。
 * 本模块不读写密钥文件，也不把密钥放进任何返回值。
 */

import {
  createAgent,
  LIWENError,
  type Agent,
  type PermissionHandler,
  type PermissionMode,
  type Provider,
  type Runtime,
  type Tool,
  type ToolContext,
  type ToolOutput,
  type ToolProgress,
} from '@liwencode/core';
import { nodeRuntime } from '@liwencode/node';
import { createAnthropicProvider, createOpenAICompatibleProvider } from '@liwencode/providers';
import { createBuiltinTools } from '@liwencode/tools';
import { MockProvider, mockText, mockToolUse } from '@liwencode/testing';
import type { ChannelConfig, ChannelModel, ContextInfo, UsageRecord } from '@liwencode/dhp';
import type { Message } from '@liwencode/core';
import { observeProvider } from './usage.ts';
import { wireUsageRuntime } from './provider-usage.ts';
import { channelSchema } from './workbench-validation.ts';

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

/**
 * 工具钩子（`27` §7.2 的"宿主侧工具装饰器"）。
 *
 * 只用于**观测**：钩子抛错不会让工具失败，也不会改变工具的权限与超时语义。
 */
export interface ToolHooks {
  before(tool: string, input: unknown): Promise<void>;
  after(tool: string, input: unknown, isError: boolean): Promise<void>;
}

/** 需要被装饰的工具：只有这三个会改动工作区或执行命令。 */
const HOOKED_TOOL_NAMES: ReadonlySet<string> = new Set(['write', 'edit', 'bash']);

export interface CreateDesktopAgentOptions {
  readonly channel?: ChannelConfig;
  readonly history?: readonly Message[];
  readonly observation?: {
    sessionId: string; model: ChannelModel;
    onContext(context: ContextInfo): void;
    onUsage(record: UsageRecord): Promise<void>;
  };
  readonly modelSpec: string;
  readonly cwd: string;
  readonly permissionMode: PermissionMode;
  readonly permissionHandler: PermissionHandler;
  readonly env?: Record<string, string | undefined>;
  /**
   * 可选的工具钩子：给 `write` / `edit` / `bash` 套一层观测装饰器，
   * 用于采集会话改动 / 产出（`27` §7）。不传时行为与原来完全一致。
   */
  readonly toolHooks?: ToolHooks;
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
  const wire = opts.channel && opts.channel.protocol !== 'mock' ? wireUsageRuntime(runtime, opts.channel.protocol) : undefined;
  const built = opts.channel
    ? buildChannelProvider(opts.channel, spec.model, wire?.runtime ?? runtime, opts.env ?? process.env)
    : buildProvider(spec, runtime, opts.env ?? process.env);
  if (!built.ok) return { ok: false, reason: built.reason };
  const base: Provider = {
    id: built.provider.id,
    capabilities: (model) => built.provider.capabilities(model),
    async *stream(req, args) {
      try { yield* built.provider.stream(req, args); }
      catch (e) {
        // Upstream error bodies may contain credentials/URLs. Keep only typed code.
        throw new LIWENError({ code: LIWENError.is(e) ? e.code : 'SY-PRV-008', message: 'Provider request failed; check channel credentials and endpoint.' });
      }
    },
  };
  const observed = opts.observation ? observeProvider(base, {
    ...opts.observation, workspaceRoot: opts.cwd, channelId: spec.provider,
    ...(wire ? { wireUsage: wire.usage } : {}),
  }) : base;
  const provider: Provider = { ...observed, async *stream(req, args) { wire?.reset(); yield* observed.stream(req, args); } };
  const { tools } = createBuiltinTools();
  const hooks = opts.toolHooks;
  const wiredTools = hooks === undefined
    ? tools
    : tools.map((tool) => (HOOKED_TOOL_NAMES.has(tool.name) ? wrapToolWithHooks(tool, hooks) : tool));

  const agent = createAgent({
    provider,
    model: built.model,
    cwd: opts.cwd,
    tools: wiredTools,
    permissionMode: opts.permissionMode,
    permissionHandler: opts.permissionHandler,
    runtime,
  });

  agent.history.push(...structuredClone(opts.history ?? []));
  return { ok: true, agent, model: `${spec.provider}:${built.model}` };
}

export function buildChannelProvider(channel: ChannelConfig, model: string, runtime: Runtime, env: Record<string, string | undefined>): ProviderBuildResult {
  if (!channelSchema.safeParse(channel).success || !channel.models.some((m) => m.id === model)) return { ok: false, reason: 'invalid channel/model' };
  if (channel.protocol === 'mock') return buildProvider({ provider: 'mock', model }, runtime, env);
  const key = channel.apiKeyEnv ? env[channel.apiKeyEnv] : undefined;
  if (!key?.trim()) return { ok: false, reason: 'channel credentials are not ready' };
  const baseUrl = (channel.baseUrl ?? (channel.protocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1')).replace(/\/$/, '');
  const provider = channel.protocol === 'anthropic'
    ? createAnthropicProvider({ runtime, apiKey: key, baseUrl })
    : createOpenAICompatibleProvider({ runtime, apiKey: key, baseUrl, id: channel.id });
  return { ok: true, provider, model };
}

/**
 * 给工具套一层观测钩子（`27` §7.2 的"宿主侧工具装饰器"）。
 *
 * 装饰器**只**改变"什么时候被观察"，不改变工具本身：
 * `name` / `description` / `inputSchema` / `risk` / `readOnly` / `timeoutMs` /
 * `trust` / `permissionSubject` / `concurrencySafe` 全部原样保留，
 * 权限管线与超时行为完全不变。
 *
 * 执行顺序固定为：`before` → 原 `execute` → `after`；
 * 原 `execute` 抛错或返回 `isError` 时，`after` 依然被调用且 `isError = true`。
 */
function wrapToolWithHooks<I>(tool: Tool<I>, hooks: ToolHooks): Tool<I> {
  const original = tool.execute;
  return {
    ...tool,
    execute(input: I, ctx: ToolContext): Promise<ToolOutput> {
      return (async () => {
        await callHook(() => hooks.before(tool.name, input));
        try {
          const result = original(input, ctx);
          if (isAsyncGenerator(result)) {
            // 生成器形态：逐段消费并把进度转发给 `ctx.progress`，最后再结算。
            let step = await result.next();
            while (!step.done) {
              ctx.progress(step.value.note);
              step = await result.next();
            }
            await callHook(() => hooks.after(tool.name, input, step.value.isError === true));
            return step.value;
          }
          const output = await result;
          await callHook(() => hooks.after(tool.name, input, output.isError === true));
          return output;
        } catch (e) {
          await callHook(() => hooks.after(tool.name, input, true));
          throw e;
        }
      })();
    },
  };
}

/** 钩子是观测手段：钩子自己出错也不能让工具失败。 */
async function callHook(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch {
    // 吞掉钩子异常——观测失败不该改变工具行为。
  }
}

function isAsyncGenerator(
  value: unknown,
): value is AsyncGenerator<ToolProgress, ToolOutput, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AsyncGenerator<ToolProgress, ToolOutput, unknown>).next === 'function' &&
    typeof (value as AsyncGenerator<ToolProgress, ToolOutput, unknown>).return === 'function'
  );
}
