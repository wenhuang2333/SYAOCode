import { beforeEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../src/i18n/index';
import { guessProtocol, sanitizeProfileName } from '../src/tui/setup-wizard';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SyaoError } from '@syaocode/core';
import { buildProvider } from '../src/provider-select';
import { saveProfile } from '../src/model-config';
import {
  wizardSteps,
  authOptionsFor,
  newWizard,
  renderWizard,
  selectOptions,
  setExistingNamesProvider,
  submitAnswer,
  wizardIsSelect,
  wizardIsSecret,
  wizardQuestion,
} from '../src/tui/setup-wizard';

function isolatedHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'syao-wizard-'));
}

describe('tui/setup-wizard 状态机', () => {
  beforeEach(() => setLanguage('en'));
  it('步骤顺序与需求一致（名称→地址→Key→协议→认证→档案名）', () => {
    expect(wizardSteps().map((s) => s.id)).toEqual(['model', 'baseUrl', 'apiKey', 'protocol', 'authField', 'profileName']);
    expect(wizardSteps().map((s) => s.kind)).toEqual(['text', 'text', 'secret', 'select', 'select', 'text']);
  });

  it('authOptionsFor：四种协议的认证字段集合', () => {
    expect(authOptionsFor('anthropic')).toEqual(['x-api-key']);
    expect(authOptionsFor('openai-chat')).toEqual(['bearer', 'x-api-key', 'query-key']);
    expect(authOptionsFor('openai-responses')).toEqual(['bearer', 'x-api-key']);
    expect(authOptionsFor('gemini')).toEqual(['query-key', 'x-goog-api-key']);
  });

  it('完整流转：六步全部作答后 done=true，答案齐备', () => {
    let s = newWizard();
    s = submitAnswer(s, 'deepseek-chat').state;
    s = submitAnswer(s, 'https://api.example.com/v1').state;
    s = submitAnswer(s, 'sk-abc').state;
    // 协议步：默认高亮 anthropic，按两次 ↓ 到 openai-chat
    s = { ...s, selIdx: 1 };
    s = submitAnswer(s, '').state;
    expect(s.answers.protocol).toBe('openai-chat');
    // 认证步：默认 bearer
    expect(selectOptions(s)[s.selIdx]).toBe('bearer');
    const fin = submitAnswer(s, '');
    expect(fin.done).toBe(false); // 还有档案名
    const done = submitAnswer(fin.state, 'my-provider');
    expect(done.done).toBe(true);
    expect(done.state.answers).toMatchObject({
      model: 'deepseek-chat',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-abc',
      protocol: 'openai-chat',
      authField: 'bearer',
      profileName: 'my-provider',
    });
  });

  it('校验：空模型名/非法 URL/非法或重复档案名报错并停留原步', () => {
    setExistingNamesProvider(() => ['taken']);
    let s = newWizard();
    let r = submitAnswer(s, '');
    expect(r.state.error).toContain('required');
    expect(r.state.stepIdx).toBe(0);
    s = submitAnswer(s, 'm').state;
    r = submitAnswer(s, 'ftp://bad');
    expect(r.state.error).toContain('http');
    s = submitAnswer(s, 'https://ok/v1').state;
    s = submitAnswer(s, '').state; // key 可空
    s = { ...s, stepIdx: 5 };
    r = submitAnswer(s, 'has space');
    expect(r.state.error).toContain('profile name');
    r = submitAnswer(s, 'taken');
    expect(r.state.error).toContain('already exists');
    r = submitAnswer(s, 'fresh');
    expect(r.done).toBe(true);
    setExistingNamesProvider(() => []);
  });

  it('协议切换使认证字段失效时回退协议默认', () => {
    let s = newWizard({ protocol: 'openai-chat', authField: 'query-key' });
    s = { ...s, stepIdx: 3, selIdx: 3 }; // 选 gemini
    s = submitAnswer(s, '').state;
    expect(s.answers.protocol).toBe('gemini');
    expect(s.answers.authField).toBe('query-key'); // gemini 默认恰好也是 query-key
    s = { ...s, stepIdx: 3, selIdx: 0 };
    s = submitAnswer(s, '').state; // 切回 anthropic
    expect(s.answers.authField).toBe('x-api-key'); // query-key 不适用 → 回退
  });

  it('编辑模式：文本步空输入沿用现有值', () => {
    let s = newWizard({ model: 'old-model', baseUrl: 'https://old/v1' }, 'editing-target');
    s = submitAnswer(s, '').state;
    expect(s.answers.model).toBe('old-model');
    expect(s.stepIdx).toBe(1);
    // 同名覆盖在编辑模式下允许
    s = submitAnswer(s, '').state; // baseUrl 沿用
    expect(s.answers.baseUrl).toBe('https://old/v1');
  });

  it('wizardQuestion / wizardIsSelect / wizardIsSecret', () => {
    const s = newWizard();
    expect(wizardQuestion(s)).toContain('[1/6] model name');
    expect(wizardIsSecret(s)).toBe(false);
    expect(wizardIsSelect(s)).toBe(false);
    const proto = { ...s, stepIdx: 3 };
    expect(wizardIsSelect(proto)).toBe(true);
    const key = { ...s, stepIdx: 2 };
    expect(wizardIsSecret(key)).toBe(true);
  });
});

describe('tui/setup-wizard 渲染（Vite 式进度线）', () => {
  it('等宽行、含全部步骤标签、当前步高亮与已完成答案', () => {
    let s = newWizard();
    s = submitAnswer(s, 'deepseek-chat').state;
    const lines = renderWizard(s, 64);
    expect(lines[0]!.startsWith('╭')).toBe(true);
    expect(lines[lines.length - 1]!.startsWith('╰')).toBe(true);
    const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const w0 = plain[0]!.length;
    for (const l of plain) expect(l.length).toBe(w0);
    const joined = plain.join('\n');
    for (const step of wizardSteps()) expect(joined).toContain(step.label);
    expect(joined).toContain('◉'); // 当前步
    expect(joined).toContain('●'); // 完成步
    expect(joined).toContain('deepseek-chat'); // 已填答案
    expect(joined).toContain('○'); // 未到步
  });

  it('选择步渲染选项列表，选中项带 ❯；错误信息渲染', () => {
    let s = newWizard();
    const err = submitAnswer(s, '').state; // 空模型名错误
    s = submitAnswer(err, 'm').state;
    s = submitAnswer(s, 'https://x/v1').state;
    s = submitAnswer(s, 'k').state; // 进入协议步
    const lines = renderWizard(s, 64).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const joined = lines.join('\n');
    expect(joined).toContain('Anthropic Messages');
    expect(joined).toContain('OpenAI ChatCompletion');
    expect(joined).toContain('Gemini Native GenerateContent');
    expect(joined).toContain('❯');
    // 错误渲染
    const errLines = renderWizard(err, 64).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    expect(errLines).toContain('model name is required');
  });

  it('面板文本为英文（标签/提示无 CJK）', () => {
    const lines = renderWizard(newWizard(), 64).join('\n');
    expect(lines.match(/[\u4e00-\u9fff]/)).toBeNull();
  });
});

describe('@profile → Provider 解析', () => {
  it('openai-chat 档案构建适配器；未实现协议抛 SY-PRV-010', () => {
    // 重定向 HOME 到隔离目录（buildProvider 经 model-config 读取）
    const realHome = process.env.HOME;
    process.env.HOME = isolatedHome();
    try {
      saveProfile(
        'myprov',
        {
          model: 'm1',
          baseUrl: 'https://api.example.com/v1',
          protocol: 'openai-chat',
          authField: 'x-api-key',
          apiKeyEnv: 'SYAO_KEY_WIZ_TEST',
          createdAt: 0,
          updatedAt: 0,
        },
        'sk-wiz',
      );
      process.env.SYAO_KEY_WIZ_TEST = 'sk-wiz';
      const p = buildProvider({ provider: '@myprov', model: '' });
      expect(p.id).toBe('@myprov');
      expect(p.model).toBe('m1');

      saveProfile(
        'gem',
        { model: 'g', baseUrl: 'https://x', protocol: 'gemini', authField: 'query-key', apiKeyEnv: 'SYAO_KEY_GEM', createdAt: 0, updatedAt: 0 },
        'k',
      );
      expect(() => buildProvider({ provider: '@gem', model: '' })).toThrow(SyaoError);
      try {
        buildProvider({ provider: '@gem', model: '' });
      } catch (e) {
        expect(SyaoError.is(e) && e.code === 'SY-PRV-010').toBe(true);
      }
      expect(() => buildProvider({ provider: '@nosuch', model: '' })).toThrow(/not found/);
    } finally {
      process.env.HOME = realHome;
      delete process.env.SYAO_KEY_WIZ_TEST;
    }
  });

  it('智能默认：模型名推导档案名、URL 推断协议，回车即接受', () => {
    expect(sanitizeProfileName('deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash');
    expect(sanitizeProfileName('DeepSeek V4/Flash!')).toBe('DeepSeek-V4-Flash');
    expect(sanitizeProfileName('///')).toBe('');

    expect(guessProtocol('https://fun.zionlin.com/v1', 'deepseek-v4.1-flash')).toBe('openai-chat');
    expect(guessProtocol('https://api.anthropic.com/v1/messages', 'claude-sonnet-4')).toBe('anthropic');
    expect(guessProtocol('https://generativelanguage.googleapis.com/v1beta', 'gemini-2.0-flash')).toBe('gemini');

    // 模型名 → 档案名预填；URL → 协议与认证字段预填；文本步回车沿用预填值
    let state = newWizard();
    ({ state } = submitAnswer(state, 'deepseek-v4.1-flash'));
    expect(state.answers.profileName).toBe('deepseek-v4.1-flash');
    ({ state } = submitAnswer(state, 'https://fun.zionlin.com/v1'));
    expect(state.answers.protocol).toBe('openai-chat');
    expect(state.answers.authField).toBe('bearer');
    ({ state } = submitAnswer(state, 'sk-test'));
    expect(wizardIsSelect(state)).toBe(true);
    ({ state } = submitAnswer(state, '')); // 协议步：回车 = 接受推断
    expect(state.answers.protocol).toBe('openai-chat');
    ({ state } = submitAnswer(state, ''));
    expect(state.answers.authField).toBe('bearer');
    const done = submitAnswer(state, ''); // 档案名步：回车 = 接受预填
    expect(done.done).toBe(true);
    expect(done.state.answers.profileName).toBe('deepseek-v4.1-flash');
  });
});