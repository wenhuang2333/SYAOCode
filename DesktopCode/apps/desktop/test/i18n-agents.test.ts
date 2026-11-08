/**
 * Agent 群页文案目录（`27` FR-N-003）。
 *
 * 与另外两套目录同一套纪律，外加两条这一页特有的：
 *  - 「执行模型取 common」这句必须中英都在（这是产品的核心承诺，不能只在一侧）；
 *  - 删除必须**先确认再执行**（以前点一下就删）。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agentsMessages, ta } from '../src/renderer/i18n-agents.ts';

const PAGE = readFileSync(new URL('../src/renderer/agents-page.tsx', import.meta.url), 'utf8');

const flatten = (value: unknown, prefix = ''): string[] => {
  if (typeof value === 'string') return [prefix];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix === '' ? key : `${prefix}.${key}`));
};

describe('Agent 群文案目录', () => {
  it('中英键集完全相同且都非空', () => {
    const zh = flatten(agentsMessages('zh')).sort();
    const en = flatten(agentsMessages('en')).sort();
    expect(zh.length).toBeGreaterThan(30);
    expect(en).toEqual(zh);
    for (const path of zh) {
      expect(ta('zh', path)).not.toBe('');
      expect(ta('en', path)).not.toBe('');
    }
  });

  it('未知键显式可见，插值缺参保留原样', () => {
    expect(ta('zh', 'nope.nope')).toBe('⟦nope.nope⟧');
    expect(ta('zh', 'summaryActive')).toContain('{name}');
    expect(ta('zh', 'summaryActive')).not.toContain('undefined');
  });

  it('三种角色标签在两侧都提到角色名（不能只翻译职责）', () => {
    for (const lang of ['zh', 'en'] as const) {
      expect(ta(lang, 'roles.hyaki')).toContain('hyaki');
      expect(ta(lang, 'roles.sota')).toContain('sota');
      expect(ta(lang, 'roles.common')).toContain('common');
    }
  });

  it('「执行模型取 common」这条承诺中英都在', () => {
    expect(ta('zh', 'pageSubtitle')).toContain('common');
    expect(ta('en', 'pageSubtitle')).toContain('common');
    expect(ta('zh', 'roleHints.common')).toContain('执行模型');
    expect(ta('en', 'roleHints.common').toLowerCase()).toContain('execution model');
  });

  it('页面里不再有裸中文字面量', () => {
    const code = PAGE
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const literals = code.match(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g) ?? [];
    expect(literals.filter((literal) => /[\u4e00-\u9fa5]/.test(literal))).toEqual([]);
  });
});

describe('删除 Agent 群必须先确认（回归）', () => {
  it('删除按钮不再直接调用 onDelete', () => {
    // 以前是 `onClick={() => { void onDelete(group.name); }}`——点一下群就没了。
    expect(PAGE).not.toMatch(/onClick=\{\(\)\s*=>\s*\{\s*void onDelete\(group\.name\);\s*\}\}/);
  });

  it('存在确认状态与 alertdialog，且确认后才真正删除', () => {
    expect(PAGE).toContain('pendingDelete');
    expect(PAGE).toContain('role="alertdialog"');
    expect(PAGE).toMatch(/setPendingDelete\(''\)[\s\S]{0,80}void onDelete\(name\)/);
  });

  it('确认文案说明后果，不只问"确定吗"', () => {
    expect(ta('zh', 'removeConfirmBody')).toContain('{name}');
    expect(ta('zh', 'removeConfirmBody')).toContain('激活');
    expect(ta('en', 'removeConfirmBody')).toContain('{name}');
  });
});
