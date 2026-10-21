/**
 * 5x7 像素点阵字体：用于启动动画的 "SYAO CODE" 艺术字粒子目标形态。
 *
 * 每个字形 5 列 × 7 行，用 7 个 5 位二进制串表示（'1' = 亮点）。
 * 只收录启动画面需要的字符：S Y A O C D 空格（SYAO CODE 艺术字）。
 * L I W E N 为历史字形，保留供字符宽度与未知字符降级的回归测试使用。
 */

export const GLYPH_W = 5;
export const GLYPH_H = 7;

const GLYPHS: Record<string, ReadonlyArray<string>> = {
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

export interface GridPoint {
  /** 字符网格坐标（列，向右增长） */
  col: number;
  /** 字符网格坐标（行，向下增长） */
  row: number;
  /** 该点所属字符（用于按字母分配颜色微调） */
  ch: string;
}

/**
 * 将文本渲染为 5x7 点阵坐标集合。
 * 字符间有 1 列间隔；只支持 GLYPHS 中的字符，未知字符按空格处理。
 */
export function textToPoints(text: string): GridPoint[] {
  const points: GridPoint[] = [];
  let colOffset = 0;
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch] ?? GLYPHS[' ']!;
    for (let row = 0; row < GLYPH_H; row++) {
      const line = glyph[row]!;
      for (let col = 0; col < GLYPH_W; col++) {
        if (line[col] === '1') points.push({ col: colOffset + col, row, ch });
      }
    }
    colOffset += GLYPH_W + 1;
  }
  return points;
}

/** 点阵总列数（含字符间隔） */
export function gridWidth(text: string): number {
  let w = 0;
  for (const ch of text.toUpperCase()) w += GLYPH_W + 1;
  return Math.max(0, w - 1);
}

export const GRID_HEIGHT = GLYPH_H;
