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
  /**
   * 按选择器取**一个**声明块（大括号配对）。
   *
   * 早期实现用 `slice(indexOf(a), indexOf(b))` 切文本，于是"深色块"把后面的
   * 标度层 `:root` 与 reduced-motion 覆盖也算进去，两份名单天然不等。
   */
  function blockOf(css: string, selector: string): string {
    const start = css.indexOf(selector);
    expect(start, `缺少选择器 ${selector}`).toBeGreaterThan(-1);
    const open = css.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) return css.slice(open + 1, i);
      }
    }
    throw new Error(`选择器 ${selector} 的块没有闭合`);
  }

  const tokenNames = (block: string): string[] =>
    [...block.matchAll(/(--sy-[a-z0-9-]+)\s*:/g)].map((m) => m[1]!).sort();

  it('两种主题各有完整的一份令牌：深色缺一个就会回退成浅色值', () => {
    const light = tokenNames(blockOf(tokens, "[data-theme='light']"));
    const dark = tokenNames(blockOf(tokens, "[data-theme='dark']"));
    // 令牌层是"语义 + 标度"，刻意保持小而全；数量下限防的是**回退成裸色**，不是越多越好。
    expect(light.length).toBeGreaterThan(40);
    expect(dark).toEqual(light);
  });

  it('标度层（间距/圆角/字号/时长）与主题无关，只有一份', () => {
    // `:root,` 同时是浅色主题的载体，所以标度层只能按**独立成行的 `:root {`** 来取。
    const scale = tokenNames(blockOf(tokens, ':root {'));
    for (const needed of ['--sy-space-4', '--sy-radius-lg', '--sy-text-md', '--sy-leading-md', '--sy-duration', '--sy-ease']) {
      expect(scale, `标度层缺少 ${needed}`).toContain(needed);
    }
    // 字号必须成对给出：只调字号不调行高是界面显乱的主因。
    for (const size of ['xs', 'sm', 'md', 'base', 'lg', 'xl', '2xl', '3xl']) {
      expect(scale).toContain(`--sy-text-${size}`);
      expect(scale).toContain(`--sy-leading-${size}`);
    }
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

describe('界面语言跟随配置（FR-N-037 / config 是单一真相）', () => {
  const useWorkbenchSrc = read('src/renderer/use-workbench.ts');
  const workbenchSrc = read('src/renderer/workbench.tsx');

  it('渲染层不再把语言写死为 zh', () => {
    // 曾经是模块级 `const m = messages('zh')`：配置里的 language 改了也没用。
    expect(workbenchSrc).not.toMatch(/messages\('zh'\)/);
    expect(workbenchSrc).not.toMatch(/messages\('en'\)/);
    expect(workbenchSrc).toContain('messages(w.language)');
  });

  it('语言来自 config/get，而不是本地猜测或 localStorage', () => {
    expect(useWorkbenchSrc).toContain('Method.ConfigGet');
    // 只有用户显式表过态才跟随配置；否则用桌面默认值（内核默认 en 会造成中英混排）。
    expect(useWorkbenchSrc).toMatch(/setLanguage\(explicit \? config\.language : DESKTOP_DEFAULT_LANGUAGE\)/);
    // 不该出现"用 navigator.language 猜"这类做法。
    expect(useWorkbenchSrc).not.toContain('navigator.language');
    expect(useWorkbenchSrc).not.toMatch(/localStorage\.setItem\('liwen:language/);
  });

  it('设置页能真的切换语言（写 Host 配置，不是本地偏好）', () => {
    const settings = read('src/renderer/settings-page.tsx');
    const useHook = read('src/renderer/use-workbench.ts');
    expect(settings).toContain('role="radiogroup"');
    expect(settings).toContain("'en'");
    // 切换必须走 config/set，否则改了也没落盘。
    expect(useHook).toMatch(/Method\.ConfigSet,\s*\{\s*key:\s*'language'/);
  });

  it('未翻译的文案保持中文，不出现占位符或空白（诚实降级）', () => {
    // 部分界面仍是中文，设置页要如实说明，而不是让用户以为切换无效。
    // 文案已进目录（`settings.language.untranslatedNote`）：断言接线 + 目录内容。
    const settings = read('src/renderer/settings-page.tsx');
    expect(settings).toContain("tv(lang, 'settings.language.untranslatedNote')");
    expect(read('src/renderer/i18n-views.ts')).toContain('仍只有中文');
  });

  it('能力面板与文案最终一致：ui 包的 Messages 覆盖面没有缩小', () => {
    const i18n = read('../../packages/ui/src/i18n.ts');
    expect(i18n).toContain("export type Lang = 'en' | 'zh'");
    expect(i18n).toContain('⟦');
  });
});

/**
 * 令牌自身的对比度（纯函数，无浏览器）。
 *
 * `verify-theme.mjs` 量的是**真实渲染**结果，但它依赖 Playwright，没装就跳过。
 * 这里补一层不依赖环境的下限：把令牌表里的颜色自己算一遍 WCAG 对比度。
 * 它抓的是"改了一个色值就把可读性写坏"这类回归——过去 text-4 在着色底上
 * 掉到 4.1:1 就是这么来的。
 */
describe('令牌色值的 WCAG 下限（纯计算）', () => {
  const parse = (value: string): [number, number, number] | null => {
    const hex = value.trim().match(/^#([0-9a-f]{6})$/i);
    if (hex) {
      const h = hex[1]!;
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    return null; // alpha 发丝线/遮罩不参与文字对比度计算
  };
  const lum = ([r, g, b]: [number, number, number]): number => {
    const f = (x: number): number => (x <= 76.95 ? x / 3294.6 : ((x / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (fg: [number, number, number], bg: [number, number, number]): number => {
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  };
  const block = (selector: string): Record<string, string> => {
    const start = tokens.indexOf(selector);
    const open = tokens.indexOf('{', start);
    let depth = 0;
    let end = tokens.length;
    for (let i = open; i < tokens.length; i += 1) {
      if (tokens[i] === '{') depth += 1;
      else if (tokens[i] === '}' && (depth -= 1) === 0) { end = i; break; }
    }
    return Object.fromEntries([...tokens.slice(open, end).matchAll(/(--sy-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!]));
  };

  // 文字必须能在它**可能**出现的每一层底色上读清楚。
  const SURFACES = ['--sy-bg', '--sy-surface', '--sy-bg-subtle', '--sy-bg-muted', '--sy-surface-hover', '--sy-surface-active', '--sy-elevated', '--sy-code-bg', '--sy-nav-active', '--sy-nav-hover', '--sy-accent-soft', '--sy-primary-soft'];
  const TEXT = ['--sy-text-1', '--sy-text-2', '--sy-text-3'];

  for (const [name, selector] of [['light', "[data-theme='light']"], ['dark', "[data-theme='dark']"]] as const) {
    it(`${name}：正文三档在全部表面色上 ≥4.5:1`, () => {
      const t = block(selector);
      const offenders: string[] = [];
      for (const fg of TEXT) for (const bg of SURFACES) {
        const f = parse(t[fg]!), g = parse(t[bg]!);
        if (f && g && ratio(f, g) < 4.5) offenders.push(`${fg}/${bg}=${ratio(f, g).toFixed(2)}`);
      }
      expect(offenders).toEqual([]);
    });

    it(`${name}：第四档只用于偶发说明，仅在无着色表面上仍达标`, () => {
      const t = block(selector);
      // 规则：text-4 只允许出现在**无着色**表面上。落到 nav-active / surface-active /
      // accent-soft 这类着色底时它会掉到 4.5 以下，所以那些位置一律用 text-3
      // （见 workbench.css 末尾"文字分层的硬规则"）。
      const plain = ['--sy-bg', '--sy-surface', '--sy-elevated', '--sy-code-bg', '--sy-bg-subtle'];
      const f = parse(t['--sy-text-4']!);
      expect(f).not.toBeNull();
      for (const bg of plain) {
        const g = parse(t[bg]!);
        if (g) expect(ratio(f!, g), `text-4/${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      // 四档必须真的分得开。用**对底色的对比度**排序，方向无关：
      // 浅色主题里"更淡"是亮度更高，深色主题里正好相反。
      const bgc = parse(t['--sy-bg']!)!;
      expect(ratio(parse(t['--sy-text-4']!)!, bgc)).toBeLessThan(ratio(parse(t['--sy-text-3']!)!, bgc));
      expect(ratio(parse(t['--sy-text-3']!)!, bgc)).toBeLessThan(ratio(parse(t['--sy-text-2']!)!, bgc));
      expect(ratio(parse(t['--sy-text-2']!)!, bgc)).toBeLessThan(ratio(parse(t['--sy-text-1']!)!, bgc));
    });

    it(`${name}：主按钮与状态色的前景/底色成对达标`, () => {
      const t = block(selector);
      const pairs: Array<[string, string]> = [
        ['--sy-on-primary', '--sy-primary'], ['--sy-on-accent', '--sy-accent'],
        ['--sy-success', '--sy-success-bg'], ['--sy-warn', '--sy-warn-bg'], ['--sy-danger', '--sy-danger-bg'],
        ['--sy-accent-text', '--sy-accent-soft'],
      ];
      for (const [fg, bg] of pairs) {
        const f = parse(t[fg]!), g = parse(t[bg]!);
        expect(f, fg).not.toBeNull();
        expect(g, bg).not.toBeNull();
        expect(ratio(f!, g!), `${fg}/${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
