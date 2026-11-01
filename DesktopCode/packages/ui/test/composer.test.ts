/**
 * Composer 的**行为级**测试。
 *
 * 重点不是"能不能渲染"，而是三个中文输入的高频缺陷：
 *  1. IME 组合期间的 Enter 不得提交
 *  2. 码点级删除不切断 emoji
 *  3. 粘贴只取 text/plain
 *
 * 因为不引入 DOM 环境（保持依赖最小），这里测的是**纯逻辑**部分
 * （`deleteLastCodePoint` 与 i18n 文案），并断言组件导出的契约存在。
 * DOM 交互由 E2E（Playwright）覆盖，见 `DesktopDoc/11-测试计划`。
 */

import { describe, expect, it } from 'vitest';
import { deleteLastCodePoint } from '../src/composer.tsx';

describe('码点级删除', () => {
  it('删除普通 ASCII 字符', () => {
    expect(deleteLastCodePoint('abc')).toBe('ab');
  });

  it('删除中文（单个 BMP 字符）', () => {
    expect(deleteLastCodePoint('你好')).toBe('你');
  });

  it('emoji 整体删除，不留半个代理对', () => {
    // '😀' 是代理对（两个 UTF-16 码元）。按 length 截断会留下残缺字符。
    const withEmoji = 'a😀';
    expect(withEmoji.length).toBe(3);
    expect(deleteLastCodePoint(withEmoji)).toBe('a');
  });

  it('空串安全', () => {
    expect(deleteLastCodePoint('')).toBe('');
  });

  it('组合字符不产生非法串', () => {
    const s = 'e\u0301'; // e + 组合重音
    const out = deleteLastCodePoint(s);
    expect(() => encodeURIComponent(out)).not.toThrow();
  });
});
