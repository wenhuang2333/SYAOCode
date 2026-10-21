import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSlash, helpText, commandDocs } from '../src/slash';
import { setLanguage } from '../src/i18n/index';
import {
  catalogEntry,
  keyStatusOf,
  parseEnvFile,
  formatEnvFile,
  writeEnvFile,
  envFilePath,
  userConfigPath,
  readUserConfig,
  writeUserConfig,
  resolveDefaultModel,
  maskKey,
  PROVIDER_CATALOG,
} from '../src/model-config';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-test-'));
  setLanguage('en');
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('slash parsing (FR-137)', () => {
  it('parses commands with and without args', () => {
    expect(parseSlash('/help')).toEqual({ name: '/help', args: [], raw: '/help' });
    expect(parseSlash('  /model use deepseek:deepseek-chat  ')).toEqual({
      name: '/model',
      args: ['use', 'deepseek:deepseek-chat'],
      raw: '/model use deepseek:deepseek-chat',
    });
    expect(parseSlash('hello world')).toBeNull();
    expect(parseSlash('/')).toBeNull();
  });

  it('help lists all v0.1 commands and marks planned ones', () => {
    const text = helpText();
    for (const cmd of commandDocs().filter((c) => c.since === 'v0.1')) {
      expect(text).toContain(cmd.name);
    }
    expect(text).toContain('/agents');
    expect(text).toContain('M3+');
    // single-command help
    expect(helpText('model')).toContain('/model');
    expect(helpText('/nope')).toContain('Unknown command');
    setLanguage('zh');
    expect(helpText('/nope')).toContain('未知命令');
    expect(helpText()).toContain('可用命令');
  });
});

describe('model-config (FR-121: secrets never in repo/sessions)', () => {
  it('catalog covers 4 providers with key requirements', () => {
    expect(PROVIDER_CATALOG.map((p) => p.id)).toEqual(['mock', 'deepseek', 'openai-compatible', 'anthropic']);
    expect(catalogEntry('deepseek')?.apiKeyEnv).toBe('DEEPSEEK_API_KEY');
    expect(catalogEntry('mock')?.needsKey).toBe(false);
  });

  it('env file round-trips and parses comments/quotes', () => {
    const parsed = parseEnvFile('# comment\n\nDEEPSEEK_API_KEY="sk-abc123"\nANTHROPIC_API_KEY=sk-ant-xyz\n');
    expect(parsed).toEqual({ DEEPSEEK_API_KEY: 'sk-abc123', ANTHROPIC_API_KEY: 'sk-ant-xyz' });
    expect(parseEnvFile(formatEnvFile(parsed))).toEqual(parsed);
  });

  it('writeEnvFile creates 0600 file under the given home', () => {
    writeEnvFile({ DEEPSEEK_API_KEY: 'sk-xyz' }, home);
    const file = envFilePath(home);
    expect(fs.existsSync(file)).toBe(true);
    const mode = (fs.statSync(file).mode & 0o777);
    expect(mode).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toContain('DEEPSEEK_API_KEY=sk-xyz');
  });

  it('user config round-trips; default model resolution honors flag > env > saved', () => {
    writeUserConfig({ model: { provider: 'deepseek', name: 'deepseek-chat' } }, home);
    expect(readUserConfig(home).model?.provider).toBe('deepseek');
    expect(userConfigPath(home)).toBe(path.join(home, '.syaocode', 'config.json'));

    expect(resolveDefaultModel('anthropic:claude-sonnet-4', home)).toEqual({ provider: 'anthropic', name: 'claude-sonnet-4' });
    expect(resolveDefaultModel(undefined, home)).toEqual({ provider: 'deepseek', name: 'deepseek-chat' });
  });

  it('keyStatusOf detects keys from the secrets file', () => {
    const entry = catalogEntry('deepseek')!;
    const before = keyStatusOf(entry, home);
    expect(before.set).toBe(false);
    writeEnvFile({ DEEPSEEK_API_KEY: 'sk-from-file' }, home);
    expect(keyStatusOf(entry, home)).toEqual({ set: true, source: 'env-file' });
  });

  it('maskKey never leaks full values', () => {
    expect(maskKey(undefined)).toBe('(not set)');
    expect(maskKey('sk-1234567890abcdef')).not.toContain('1234567890abcdef');
    expect(maskKey('sk-1234567890abcdef')).toContain('…');
  });
});
