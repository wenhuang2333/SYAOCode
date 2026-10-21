import { describe, expect, it } from 'vitest';
import { charWidth, displayWidth, padToWidth, truncateToWidth } from '../src/tui/width';

describe('tui/width 显示宽度', () => {
  it('ASCII 与控制字符', () => {
    expect(charWidth(0x41)).toBe(1); // A
    expect(charWidth(0x1b)).toBe(0); // ESC
    expect(charWidth(0x0a)).toBe(0); // \n
  });

  it('CJK 与全角按 2 列', () => {
    expect(charWidth(0x4e2d)).toBe(2); // 中
    expect(charWidth(0x30c3)).toBe(2); // ッ
    expect(charWidth(0xff21)).toBe(2); // Ａ
    expect(charWidth(0x1f600)).toBe(2); // emoji
  });

  it('displayWidth 剥离 ANSI 转义后计算', () => {
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('\x1b[31m中文\x1b[0m')).toBe(4);
    expect(displayWidth('\x1b[38;5;201m▀\x1b[0m')).toBe(1);
    expect(displayWidth('abc')).toBe(3);
  });

  it('truncateToWidth 不切半个宽字符', () => {
    const [s1, w1] = truncateToWidth('中文字', 5);
    expect(w1).toBe(4);
    expect(s1).toBe('中文');
    const [s2, w2] = truncateToWidth('abcd', 10);
    expect(s2).toBe('abcd');
    expect(w2).toBe(4);
  });

  it('padToWidth 按显示宽度补齐', () => {
    expect(padToWidth('中', 5)).toBe('中   ');
    expect(padToWidth('中文', 4)).toBe('中文');
    expect(padToWidth('abcde', 3)).toBe('abcde'); // 超宽不截断（由调用方控制）
  });
});
