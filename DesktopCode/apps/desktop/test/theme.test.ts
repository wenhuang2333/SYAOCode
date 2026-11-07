/**
 * 主题（FR-N-037）。
 *
 * 分两层：
 *  1. 这里的纯函数 + 静态断言（无浏览器，CI 可跑）。
 *  2. `scripts/verify-theme.mjs`：真实 Chromium 里渲染两套主题，量 WCAG 对比度。
 *     颜色对比度无法用字符串断言证明，必须实测。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  THEME_OPTIONS, THEME_STORAGE_KEY, applyTheme, parseThemePreference, readStoredTheme,
  resolveTheme, storeTheme, systemPrefersDark,
} from '../src/renderer/theme.ts';

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const tokens = read('src/renderer/theme-tokens.css');
const workbenchCss = read('src/renderer/workbench.css');
const dashboardCss = read('src/renderer/dashboard.css');
const indexTsx = read('src/renderer/index.tsx');

describe('主题偏好的解析与持久化', () => {
  it('三档偏好，默认跟随系统', () => {
    expect(THEME_OPTIONS.map((o) => o.value)).toEqual(['system', 'light', 'dark']);
    expect(parseThemePreference(null)).toBe('system');
    expect(parseThemePreference(undefined)).toBe('system');
    expect(parseThemePreference('nonsense')).toBe('system');
    expect(parseThemePreference('dark')).toBe('dark');
    expect(parseThemePreference('light')).toBe('light');
  });

  it('system 解析为系统实际偏好；显式选择不受系统影响', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('applyTheme：深色写 data-theme，浅色**删除**属性（浅色等于无覆盖）', () => {
    const root = { dataset: {} as { theme?: string }, style: { colorScheme: '' } };
    applyTheme('dark', root);
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    applyTheme('light', root);
    expect(root.dataset.theme).toBeUndefined();
    expect(root.style.colorScheme).toBe('light');
  });

  it('存储不可用时不抛错（隐私模式 / 配额）', () => {
    expect(readStoredTheme(undefined)).toBe('system');
    expect(readStoredTheme({ getItem: () => { throw new Error('denied'); } })).toBe('system');
    expect(() => storeTheme({ setItem: () => { throw new Error('quota'); } }, 'dark')).not.toThrow();
    const store = new Map<string, string>();
    storeTheme({ setItem: (k, v) => { store.set(k, v); } }, 'dark');
    expect(store.get(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('无 matchMedia 时按浅色处理', () => {
    expect(systemPrefersDark(undefined)).toBe(false);
    expect(systemPrefersDark(() => ({ matches: true }))).toBe(true);
  });
});

describe('主题验证脚本', () => {
  const script = read('../../scripts/verify-theme.mjs');

  it('真实浏览器里渲染两套主题并量对比度，而不是断言 CSS 文本', () => {
    expect(script).toContain("data-theme=\"dark\"");
    expect(script).toContain('getComputedStyle');
    expect(script).toContain('luminance');
    expect(script).toContain('THEME: OK');
    // 要覆盖正文、次要文字、状态色与按钮，不能只测一个标题。
    expect(script).toContain('.change-stat-add');
    expect(script).toContain('.btn-primary');
  });

  it('缺 Playwright / 起不了浏览器时跳过，且不打印通过', () => {
    expect(script).toContain('SKIP:');
    const skip = script.slice(script.indexOf('SKIP:'), script.indexOf('const browser'));
    expect(skip).toContain('process.exit(0)');
  });
});

describe('令牌层（深色主题的基石）', () => {
  it('两种主题各有完整的一份令牌：深色缺一个就会回退成浅色值', () => {
    const light = tokens.slice(tokens.indexOf("[data-theme='light']"), tokens.indexOf("[data-theme='dark']"));
    const dark = tokens.slice(tokens.indexOf("[data-theme='dark']"));
    const names = (block: string): string[] => [...block.matchAll(/^\s+(--sy-[a-z0-9-]+):/gm)].map((m) => m[1]!);
    const lightNames = names(light).sort();
    const darkNames = names(dark).sort();
    expect(lightNames.length).toBeGreaterThan(300);
    expect(darkNames).toEqual(lightNames);
  });

  it('CSS 里不再有裸颜色（否则深色主题必然漏掉那些地方）', () => {
    const bare = (css: string): number => (css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).length;
    expect(bare(workbenchCss)).toBe(0);
    expect(bare(dashboardCss)).toBe(0);
    // 关键字颜色同样会绕过主题。
    expect(workbenchCss).not.toMatch(/(?:^|[;{])\s*(?:color|background)\s*:\s*(?:white|black)\b/);
  });

  it('每个被引用的令牌都有定义（悬空 var() 会让颜色变成透明/继承）', () => {
    const all = workbenchCss + dashboardCss;
    const used = new Set([...all.matchAll(/var\((--sy-[a-z0-9-]+)\)/g)].map((m) => m[1]!));
    const declared = new Set([
      ...[...tokens.matchAll(/^\s+(--sy-[a-z0-9-]+):/gm)].map((m) => m[1]!),
      ...[...all.matchAll(/(--sy-[a-z0-9-]+)\s*:/g)].map((m) => m[1]!),
      ...[...read('../../packages/ui/src/styles.css').matchAll(/(--sy-[a-z0-9-]+)\s*:/g)].map((m) => m[1]!),
    ]);
    const missing = [...used].filter((t) => !declared.has(t));
    expect(missing).toEqual([]);
  });

  it('令牌层在 workbench/dashboard 之前加载（否则 var() 拿不到值）', () => {
    const order = indexTsx.indexOf('theme-tokens.css');
    expect(order).toBeGreaterThan(-1);
    expect(order).toBeLessThan(indexTsx.indexOf('workbench.css'));
    expect(order).toBeLessThan(indexTsx.indexOf('dashboard.css'));
  });

  it('声明了 color-scheme，让原生控件（滚动条/表单）跟随主题', () => {
    expect(tokens).toContain('color-scheme: light');
    expect(tokens).toContain('color-scheme: dark');
  });
});
