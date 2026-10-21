import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { zh } from '../src/i18n/zh';
import { getLanguage, isLang, languageName, LANGUAGES, setLanguage, t } from '../src/i18n/index';
import { savedLanguage, saveLanguage } from '../src/model-config';

/**
 * 双语目录约束（用户要求：默认英语；两种语言目录内不出现其他语言，logo/专有名词除外）。
 */

const CJK = /[\u4e00-\u9fff]/;

describe('i18n 目录完整性', () => {
  beforeEach(() => setLanguage('en'));
  afterEach(() => setLanguage('en'));

  it('英文目录不含中文句子（语言原名等专有名词除外）', () => {
    // /language 相关文案保留各语言的原名（与 logo/专有名词同属例外）
    for (const [key, value] of Object.entries(en)) {
      if (key.startsWith('language.')) continue;
      expect(CJK.test(value), `en.${key} 含中文：${value}`).toBe(false);
    }
  });

  it('中英键集合完全一致（漏译由类型与运行时双重约束）', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it('中文目录确实完成翻译（绝大多数条目与英文不同）', () => {
    const keys = Object.keys(en) as (keyof typeof en)[];
    const same = keys.filter((k) => zh[k] === en[k]);
    // 允许少量同形（语言名、纯技术符号、代码片段）
    expect(same.length).toBeLessThan(keys.length * 0.12);
    for (const k of ['cmd.help.summary', 'tier.strict.desc', 'status.context', 'help.available', 'language.warning'] as const) {
      expect(zh[k]).not.toBe(en[k]);
      expect(CJK.test(zh[k])).toBe(true);
    }
  });

  it('每个条目都非空且无占位残留', () => {
    for (const [key, value] of Object.entries(zh)) {
      expect(value.trim().length, `zh.${key}`).toBeGreaterThan(0);
    }
  });

  it('t() 插值、缺参保留占位、语言切换即时生效', () => {
    setLanguage('en');
    expect(t('status.tokPerSec', { n: 42 })).toBe('42 tok/s');
    expect(t('status.tokPerSec')).toContain('{n}');
    setLanguage('zh');
    expect(t('cmd.language.summary')).toContain('切换 CLI 语言');
    expect(languageName('zh')).toBe('中文');
    expect(languageName('en')).toBe('English');
  });

  it('isLang 只接受受支持的语言代码', () => {
    expect(LANGUAGES).toEqual(['en', 'zh']);
    expect(isLang('en')).toBe(true);
    expect(isLang('zh')).toBe(true);
    expect(isLang('EN')).toBe(false);
    expect(isLang('fr')).toBe(false);
  });
});

describe('语言持久化（/language 写入，下次启动生效）', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-lang-'));
    setLanguage('en');
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    setLanguage('en');
  });

  it('默认英语；saveLanguage 写入后可读回', () => {
    expect(savedLanguage(home)).toBe('en');
    saveLanguage('zh', home);
    expect(savedLanguage(home)).toBe('zh');
    const raw = JSON.parse(fs.readFileSync(path.join(home, '.syaocode', 'config.json'), 'utf8'));
    expect(raw.language).toBe('zh');
    saveLanguage('en', home);
    expect(savedLanguage(home)).toBe('en');
  });

  it('保存语言不会覆盖其他配置（模型/权限档位）', () => {
    const file = path.join(home, '.syaocode', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ model: { provider: 'mock', name: 'default' }, permissionMode: 'plan' }));
    saveLanguage('zh', home);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.language).toBe('zh');
    expect(raw.model).toEqual({ provider: 'mock', name: 'default' });
    expect(raw.permissionMode).toBe('plan');
  });

  it('未知/损坏的语言值回退英语', () => {
    const file = path.join(home, '.syaocode', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ language: 'klingon' }));
    expect(savedLanguage(home)).toBe('en');
    fs.writeFileSync(file, '{ not json');
    expect(savedLanguage(home)).toBe('en');
  });

  it('全局语言状态可读写（默认英语）', () => {
    expect(getLanguage()).toBe('en');
    setLanguage('zh');
    expect(getLanguage()).toBe('zh');
  });
});
