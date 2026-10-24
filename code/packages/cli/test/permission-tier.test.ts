import { beforeEach, describe, expect, it } from 'vitest';
import {
  parsePermissionArg,
  permissionModeShort,
  permissionTierPanel,
  permissionTiers,
} from '../src/slash';
import { setLanguage } from '../src/i18n/index';

describe('slash /permission 档位解析（三档 + 高级模式 + 别名）', () => {
  it('三个档位名正映射到引擎模式', () => {
    expect(parsePermissionArg('strict')).toEqual({ key: 'strict', mode: 'strict' });
    expect(parsePermissionArg('yao')).toEqual({ key: 'yao', mode: 'default' });
    expect(parsePermissionArg('si')).toEqual({ key: 'si', mode: 'bypass' });
  });

  it('大小写与连字符/下划线不敏感', () => {
    expect(parsePermissionArg('yao')!.mode).toBe('default');
    expect(parsePermissionArg('YaO')!.mode).toBe('default');
    expect(parsePermissionArg('si')!.mode).toBe('bypass');
    expect(parsePermissionArg('  Strict  ')!.mode).toBe('strict');
  });

  it('模式别名与高级模式', () => {
    expect(parsePermissionArg('default')!.key).toBe('yao');
    expect(parsePermissionArg('bypass')!.key).toBe('si');
    expect(parsePermissionArg('acceptEdits')!.mode).toBe('acceptEdits');
    expect(parsePermissionArg('plan')!.mode).toBe('plan');
  });

  it('无法识别返回 null（调用方给出用法提示）', () => {
    expect(parsePermissionArg('nope')).toBeNull();
    expect(parsePermissionArg('')).toBeNull();
    expect(parsePermissionArg('mode')).toBeNull();
    expect(parsePermissionArg('allow')).toBeNull();
  });
});

describe('slash /permission 展示文本', () => {
  beforeEach(() => setLanguage('en'));

  it('默认英语短标签覆盖全部模式', () => {
    expect(permissionModeShort('strict')).toBe('strict: ask for everything');
    expect(permissionModeShort('default')).toBe('partial: reads allowed');
    expect(permissionModeShort('bypass')).toBe('full: no confirmations');
    expect(permissionModeShort('plan')).toBe('plan: read-only');
    expect(permissionModeShort('acceptEdits')).toBe('acceptEdits');
  });

  it('中文模式短标签（/language zh）', () => {
    setLanguage('zh');
    expect(permissionModeShort('strict')).toBe('严格档：均需确认');
    expect(permissionModeShort('default')).toBe('部分权限：读免确认');
    expect(permissionModeShort('bypass')).toBe('完全权限：免确认');
    setLanguage('en');
  });

  it('速查面板列出三档并用 ● 标记当前档位（两种语言）', () => {
    for (const lang of ['en', 'zh'] as const) {
      setLanguage(lang);
      const panel = permissionTierPanel('default').join('\n');
      for (const tier of permissionTiers()) expect(panel).toContain(tier.key);
      expect(panel).toMatch(/● yao/);
      expect(panel).not.toMatch(/● strict/);
    }
    setLanguage('zh');
    expect(permissionTierPanel('default').join('\n')).toContain('/permission <档位> 直接切换');
    setLanguage('en');
    expect(permissionTierPanel('default').join('\n')).toContain('/permission <tier> switches immediately');
  });

  it('高级模式（plan/acceptEdits）下也能标出当前模式', () => {
    expect(permissionTierPanel('plan').join('\n')).toMatch(/● plan/);
    expect(permissionTierPanel('acceptEdits').join('\n')).toMatch(/● acceptEdits/);
  });
});
