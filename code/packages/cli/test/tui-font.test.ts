import { describe, expect, it } from 'vitest';
import { GRID_HEIGHT, gridWidth, textToPoints } from '../src/tui/font5x7';

describe('tui/font5x7 点阵字形', () => {
  it('LIWEN CODE 点阵坐标在边界内', () => {
    const text = 'LIWEN CODE';
    const points = textToPoints(text);
    // 9 个字符（含 1 个空格）× 每字最多 5×7=35 点，至少应有实质数量
    expect(points.length).toBeGreaterThan(120);
    for (const p of points) {
      expect(p.col).toBeGreaterThanOrEqual(0);
      expect(p.col).toBeLessThan(gridWidth(text));
      expect(p.row).toBeGreaterThanOrEqual(0);
      expect(p.row).toBeLessThan(GRID_HEIGHT);
      expect('LIWEN CODE'.includes(p.ch)).toBe(true);
    }
  });

  it('gridWidth = 字符数×6−1（含 1 列字间距）', () => {
    expect(gridWidth('LIWEN CODE')).toBe('LIWEN CODE'.length * 6 - 1);
    expect(gridWidth('LIWEN CODE')).toBe(10 * 6 - 1);
    expect(gridWidth('L')).toBe(5);
  });

  it('未知字符按空格处理（不产生亮点）', () => {
    const known = textToPoints('L').length;
    const unknown = textToPoints('?').length;
    expect(unknown).toBe(0);
    expect(known).toBeGreaterThan(0);
  });

  it('同一字形确定性（两次渲染一致）', () => {
    expect(textToPoints('LIWEN CODE')).toEqual(textToPoints('LIWEN CODE'));
  });
});
