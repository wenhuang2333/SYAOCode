import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args';
import { resolveProvider } from '../src/provider-select';
import { modelSpecLabel } from '../src/model-config';
import { MockProvider } from '@syaocode/testing';
import type { Message, Provider } from '@syaocode/core';

/**
 * 默认通用配置：交互与非交互（-p/exec）必须使用同一套解析顺序
 * （--model > SYAO_MODEL > ~/.syaocode/config.json > mock）。
 */

let home: string;
const savedEnv = { ...process.env };

function writeConfig(config: unknown): void {
  fs.mkdirSync(path.join(home, '.syaocode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.syaocode', 'config.json'), JSON.stringify(config));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-defaults-'));
  process.env.HOME = home;
  delete process.env.SYAO_MODEL;
  delete process.env.SYAO_KEY_P1;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

const deps: {
  mockProvider: (script: (Message | ((req: { messages: Message[] }, turn: number) => Message))[]) => Provider;
} = {
  mockProvider: (script) => new MockProvider({ script: script as Message[] }),
};

describe('provider resolution defaults (interactive == -p/exec)', () => {
  it('falls back to mock when nothing is configured', () => {
    const provider = resolveProvider(parseArgs([]), deps);
    expect(provider.id).toBe('mock');
  });

  it('honors the saved profile from ~/.syaocode/config.json (no --model needed)', () => {
    writeConfig({
      models: {
        p1: {
          model: 'm-1',
          baseUrl: 'https://example.test/v1',
          protocol: 'openai-chat',
          authField: 'bearer',
          apiKeyEnv: 'SYAO_KEY_P1',
          createdAt: 0,
          updatedAt: 0,
        },
      },
      model: { provider: '@p1', name: 'm-1' },
    });
    process.env.SYAO_KEY_P1 = 'sk-test-key';
    const provider = resolveProvider(parseArgs([]), deps);
    expect(provider.id).toBe('@p1');
    expect(provider.model).toBe('m-1');
  });

  it('precedence: --model beats SYAO_MODEL beats saved config', () => {
    writeConfig({ model: { provider: 'deepseek', name: 'from-config' } });
    process.env.DEEPSEEK_API_KEY = 'sk-test-key';
    process.env.SYAO_MODEL = 'deepseek:from-env';
    expect(resolveProvider(parseArgs([]), deps).model).toBe('from-env');
    expect(resolveProvider(parseArgs(['--model', 'deepseek:from-flag']), deps).model).toBe('from-flag');
  });

  it('saved config alone is enough for a built-in provider too', () => {
    writeConfig({ model: { provider: 'deepseek', name: 'deepseek-chat' } });
    process.env.DEEPSEEK_API_KEY = 'sk-test-key';
    const provider = resolveProvider(parseArgs([]), deps);
    expect(provider.id).toBe('deepseek');
    expect(provider.model).toBe('deepseek-chat');
  });

  it('modelSpecLabel renders profiles readably and keeps built-ins as provider:model', () => {
    expect(modelSpecLabel({ provider: '@deepseek-v4.1-flash', model: 'deepseek-v4.1-flash' })).toBe(
      '@deepseek-v4.1-flash (deepseek-v4.1-flash)',
    );
    expect(modelSpecLabel({ provider: 'mock', model: 'default' })).toBe('mock:default');
  });
});
