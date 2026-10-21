import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  deleteProfile,
  getProfile,
  listProfiles,
  saveProfile,
  validProfileName,
  parseEnvFile,
  userConfigPath,
  envFilePath,
  type ModelProfile,
} from '../src/model-config';

/** 隔离 HOME，避免污染真实 ~/.syaocode */
function isolatedHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'syao-profiles-'));
}

function sampleProfile(over: Partial<ModelProfile> = {}): ModelProfile {
  return {
    model: 'my-model',
    baseUrl: 'https://api.example.com/v1',
    protocol: 'openai-chat',
    authField: 'bearer',
    apiKeyEnv: 'SYAO_KEY_TEST',
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

describe('model profiles（/setup · /manage 数据层）', () => {
  let home: string;
  beforeEach(() => {
    home = isolatedHome();
    delete process.env.SYAO_KEY_TEST;
  });

  it('saveProfile：档案入 config.json，密钥只入 env 文件（BR-023）', () => {
    saveProfile('test', sampleProfile(), 'sk-secret-value', home);
    const configRaw = fs.readFileSync(userConfigPath(home), 'utf8');
    expect(configRaw).toContain('"test"');
    expect(configRaw).toContain('my-model');
    // 红线：密钥本体绝不进 config.json
    expect(configRaw).not.toContain('sk-secret-value');
    // 密钥在 env 文件（0600）且已同步进程环境
    const env = parseEnvFile(fs.readFileSync(envFilePath(home), 'utf8'));
    expect(env.SYAO_KEY_TEST).toBe('sk-secret-value');
    expect(process.env.SYAO_KEY_TEST).toBe('sk-secret-value');
    expect(getProfile('test', home)?.model).toBe('my-model');
  });

  it('saveProfile：空密钥不覆盖已存密钥（编辑场景）', () => {
    saveProfile('test', sampleProfile(), 'sk-first', home);
    saveProfile('test', sampleProfile({ model: 'v2' }), undefined, home);
    const env = parseEnvFile(fs.readFileSync(envFilePath(home), 'utf8'));
    expect(env.SYAO_KEY_TEST).toBe('sk-first');
    expect(getProfile('test', home)?.model).toBe('v2');
  });

  it('listProfiles / deleteProfile：删除后消失；当前默认指向被删档案时回退 mock', () => {
    saveProfile('a', sampleProfile(), undefined, home);
    fs.writeFileSync(userConfigPath(home), JSON.stringify({ model: { provider: '@a', name: 'x' }, models: { a: sampleProfile() } }));
    expect(Object.keys(listProfiles(home))).toEqual(['a']);
    expect(deleteProfile('a', home)).toBe(true);
    expect(deleteProfile('a', home)).toBe(false);
    const config = JSON.parse(fs.readFileSync(userConfigPath(home), 'utf8')) as { model?: { provider: string } };
    expect(config.model?.provider).toBe('mock');
  });

  it('validProfileName：合法命名规则', () => {
    expect(validProfileName('my-model')).toBe(true);
    expect(validProfileName('a.b_c-1')).toBe(true);
    expect(validProfileName('')).toBe(false);
    expect(validProfileName('-bad')).toBe(false);
    expect(validProfileName('has space')).toBe(false);
    expect(validProfileName('x:y')).toBe(false);
    expect(validProfileName('a'.repeat(49))).toBe(false);
  });
});
