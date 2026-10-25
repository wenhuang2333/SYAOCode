import { SyaoError, type Provider } from '@syaocode/core';
import { nodeRuntime } from '@syaocode/node';
import { createAnthropicProvider, createOpenAICompatibleProvider } from '@syaocode/providers';
import { MockProvider } from '@syaocode/testing';
import type { Message } from '@syaocode/core';
import type { CliArgs } from './args.js';
import { catalogEntry, getProfile, resolveDefaultModel } from './model-config.js';
import { t } from './i18n/index.js';

/**
 * Provider resolution for the CLI. `mock:` runs fully offline; real providers
 * need their key in process env (secrets from ~/.syaocode/env are merged at
 * startup — see model-config.loadSecretsIntoEnv).
 * `@<profile>` 引用 /setup 创建的自定义模型档案。
 */

export interface ProviderSpec {
  provider: string;
  model: string;
}

export function parseModelSpec(spec: string | undefined): ProviderSpec {
  const raw = spec ?? process.env.SYAO_MODEL ?? 'mock:default';
  const idx = raw.indexOf(':');
  if (idx <= 0) {
    throw new Error(t('args.modelSpec', { value: raw }));
  }
  return { provider: raw.slice(0, idx), model: raw.slice(idx + 1) };
}

function requireKey(envName: string): string {
  const value = process.env[envName];
  if (value === undefined || value === '') {
    throw new Error(t('provider.needKeyEnv', { env: envName }));
  }
  return value;
}

/** Build a Provider from a spec, honoring catalog base URLs and env overrides. */
export function buildProvider(spec: ProviderSpec): Provider & { model: string } {
  if (spec.provider.startsWith('@')) {
    return buildProfileProvider(spec.provider.slice(1), spec.model);
  }
  const entry = catalogEntry(spec.provider);
  if (entry === undefined) {
    throw new Error(t('provider.unknown', { provider: spec.provider, list: catalogEntryList() }));
  }
  const runtime = nodeRuntime();
  switch (entry.kind) {
    case 'mock': {
      const scripted: Message[] = mockScriptFromEnv();
      return Object.assign(new MockProvider({ script: scripted.length > 0 ? scripted : defaultMockScript() }), { model: spec.model });
    }
    case 'openai-compatible': {
      const apiKey = requireKey(entry.apiKeyEnv ?? '');
      const baseUrl =
        process.env[`${spec.provider.toUpperCase().replace(/-/g, '_')}_BASE_URL`] ??
        process.env.OPENAI_BASE_URL ??
        entry.baseUrl;
      return Object.assign(
        createOpenAICompatibleProvider({ runtime, baseUrl, apiKey, id: spec.provider }),
        { model: spec.model },
      );
    }
    case 'anthropic': {
      const apiKey = requireKey(entry.apiKeyEnv ?? 'ANTHROPIC_API_KEY');
      const baseUrl = process.env.ANTHROPIC_BASE_URL ?? entry.baseUrl;
      return Object.assign(createAnthropicProvider({ runtime, apiKey, baseUrl }), { model: spec.model });
    }
  }
}

/** 自定义档案 → Provider。协议适配器未实现的抛 SY-PRV-010（规划 M2）。 */
function buildProfileProvider(profileName: string, modelOverride: string): Provider & { model: string } {
  const profile = getProfile(profileName);
  if (profile === undefined) {
    throw new Error(t('provider.profileNotFound', { name: profileName }));
  }
  const model = modelOverride !== '' && modelOverride !== 'default' ? modelOverride : profile.model;
  const runtime = nodeRuntime();
  switch (profile.protocol) {
    case 'openai-chat': {
      const apiKey = requireKey(profile.apiKeyEnv);
      const authStyle = profile.authField === 'query-key' ? 'query-key' : profile.authField === 'x-api-key' ? 'x-api-key' : 'bearer';
      return Object.assign(
        createOpenAICompatibleProvider({ runtime, baseUrl: profile.baseUrl, apiKey, id: `@${profileName}`, authStyle }),
        { model },
      );
    }
    case 'anthropic': {
      const apiKey = requireKey(profile.apiKeyEnv);
      return Object.assign(createAnthropicProvider({ runtime, apiKey, baseUrl: profile.baseUrl }), { model });
    }
    case 'openai-responses':
    case 'gemini':
      throw new SyaoError({
        code: 'SY-PRV-010',
        message: t('provider.protocolNotImplemented', { name: profileName, protocol: profile.protocol }),
      });
  }
}

function catalogEntryList(): string {
  return t('provider.list');
}

export function resolveProvider(
  args: CliArgs,
  deps: { mockProvider: (script: (Message | ((req: { messages: Message[] }, turn: number) => Message))[]) => Provider },
  overrides?: { spec?: ProviderSpec },
): Provider & { model: string } {
  if (overrides?.spec !== undefined) return buildProvider(overrides.spec);
  // 与交互模式同源：--model > SYAO_MODEL > ~/.syaocode/config.json > mock。
  // （此前 -p/exec 直接 parseModelSpec，会忽略已保存的模型而退回 mock。）
  const resolved = resolveDefaultModel(args.model);
  const spec: ProviderSpec = { provider: resolved.provider, model: resolved.name };
  if (spec.provider === 'mock') {
    const scripted: Message[] = mockScriptFromEnv();
    const provider = deps.mockProvider(scripted.length > 0 ? scripted : defaultMockScript());
    return Object.assign(provider, { model: spec.model });
  }
  return buildProvider(spec);
}

export { resolveDefaultModel };

function defaultMockScript(): Message[] {
  return [
    {
      id: 'mock_1',
      role: 'assistant',
      content: [{ type: 'text', text: t('mock.noScript') }],
      meta: { createdAt: 0 },
    },
  ];
}

function mockScriptFromEnv(): Message[] {
  const raw = process.env.SYAO_MOCK_SCRIPT;
  if (raw === undefined || raw === '') return [];
  try {
    const parsed = JSON.parse(raw) as Message[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
