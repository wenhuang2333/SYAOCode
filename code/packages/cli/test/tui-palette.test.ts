import { beforeEach, describe, expect, it } from 'vitest';
import { commandHints, exactIndex, paletteWindow, suggestCommands } from '../src/tui/palette';
import { setLanguage, type Lang } from '../src/i18n/index';
import { LineEditor } from '../src/tui/editor';

describe('tui/palette 指令联想', () => {
  beforeEach(() => setLanguage('en'));

  it('提示表：全部以 / 开头、名字唯一、文案随语言切换', () => {
    for (const lang of ['en', 'zh'] as Lang[]) {
      setLanguage(lang);
      const hints = commandHints();
      const names = hints.map((h) => h.name);
      expect(new Set(names).size).toBe(names.length);
      for (const h of hints) {
        expect(h.name.startsWith('/')).toBe(true);
        expect(h.brief.length).toBeGreaterThan(3);
        const cjk = h.brief.match(/[\u4e00-\u9fff]/) !== null;
        expect(cjk).toBe(lang === 'zh');
      }
    }
    setLanguage('en');
  });

  it('前缀过滤："/" 返回全部命令（不截断）、非 / 开头或带空格不触发', () => {
    expect(suggestCommands('hello')).toEqual([]);
    expect(suggestCommands('')).toEqual([]);
    expect(suggestCommands('/model use deepseek')).toEqual([]); // 已带参数
    const all = suggestCommands('/');
    expect(all.length).toBe(commandHints().length); // 全量，不再截断为固定条数
    expect(all[0]!.name).toBe('/help');
    expect(all.map((h) => h.name)).toContain('/permission');
    expect(all.map((h) => h.name)).toContain('/permissions');
  });

  it('前缀过滤：/m、/p 命中新命令；大小写不敏感', () => {
    expect(suggestCommands('/m').map((h) => h.name)).toEqual(['/model', '/manage', '/mcp']);
    expect(suggestCommands('/p').map((h) => h.name)).toEqual(['/permission', '/permissions']);
    expect(suggestCommands('/MO').map((h) => h.name)).toEqual(['/model']);
    expect(suggestCommands('/c').map((h) => h.name)).toEqual(['/cost', '/compact', '/clear']);
    expect(suggestCommands('/s').map((h) => h.name)).toEqual(['/status', '/setup', '/set-agents', '/setting']);
  });

  it('exactIndex：完整命令名命中', () => {
    const hints = suggestCommands('/mo');
    expect(exactIndex(hints, '/model')).toBe(0);
    expect(exactIndex(hints, '/mo')).toBe(-1);
  });
});

describe('tui/palette 视窗滚动（列表长于视窗时）', () => {
  it('列表不超视窗：全量显示', () => {
    expect(paletteWindow(5, 0, 10)).toEqual({ start: 0, end: 5 });
    expect(paletteWindow(10, 3, 10)).toEqual({ start: 0, end: 10 });
  });

  it('顶部/中部/底部：窗口滑动且选中项始终可见', () => {
    expect(paletteWindow(18, 0, 8)).toEqual({ start: 0, end: 8 });
    const mid = paletteWindow(18, 9, 8);
    expect(mid.end - mid.start).toBe(8);
    expect(mid.start).toBeLessThanOrEqual(9);
    expect(mid.end).toBeGreaterThan(9);
    expect(paletteWindow(18, 17, 8)).toEqual({ start: 10, end: 18 });
  });

  it('可一路向下选取：任意选中位置都在视窗内，直到最后一条', () => {
    for (let sel = 0; sel < 18; sel++) {
      const { start, end } = paletteWindow(18, sel, 8);
      expect(sel).toBeGreaterThanOrEqual(start);
      expect(sel).toBeLessThan(end);
      expect(end - start).toBe(8);
    }
  });

  it('偶数/奇数视窗尺寸均不越界', () => {
    for (const size of [4, 5, 7, 8, 9]) {
      const { start, end } = paletteWindow(18, 0, size);
      expect(start).toBe(0);
      expect(end).toBe(size);
      const last = paletteWindow(18, 17, size);
      expect(last.end).toBe(18);
      expect(last.start).toBe(18 - size);
    }
  });
});

describe('tui/editor 联想键位（nav 捕获 / Esc / Tab / setLine）', () => {
  it('navCapture 关闭（默认）：↑↓ 浏览历史', () => {
    const ed = new LineEditor();
    ed.feed('one\r');
    ed.feed('\x1b[A');
    expect(ed.text()).toBe('one');
  });

  it('navCapture 开启：↑↓ 产生 nav 事件，不改内容', () => {
    const ed = new LineEditor();
    ed.feed('one\r');
    ed.setLine('/');
    ed.setNavCapture(true);
    const up = ed.feed('\x1b[A');
    expect(up).toEqual([{ type: 'nav', dir: 'up' }]);
    const down = ed.feed('\x1b[B');
    expect(down).toEqual([{ type: 'nav', dir: 'down' }]);
    expect(ed.text()).toBe('/'); // 历史未被调入
  });

  it('独立 Esc 与 Tab 事件；Tab 不再插入空格（由 TUI 决定）', () => {
    const ed = new LineEditor();
    expect(ed.feed('\x1b')).toEqual([{ type: 'escape' }]);
    expect(ed.feed('\t')).toEqual([{ type: 'tab' }]);
    expect(ed.text()).toBe('');
  });

  it('setLine 整行替换并清历史浏览状态', () => {
    const ed = new LineEditor();
    ed.feed('old\r');
    ed.setLine('/model ');
    expect(ed.text()).toBe('/model ');
    expect(ed.cursorCol()).toBe(7);
  });
});
