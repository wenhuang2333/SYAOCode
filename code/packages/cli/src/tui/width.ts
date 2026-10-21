/**
 * 终端显示宽度计算（CJK 感知）。
 *
 * TUI 的输入框边框、状态栏、粒子渲染都依赖"一个字符串在终端里占几列"。
 * ASCII 按 1 列；CJK/全角按 2 列；ANSI 转义序列按 0 列。
 * 仅覆盖 v0.1 交互所需区间（参考 Unicode East Asian Width 的 W/F 判定），
 * 不引入外部依赖（wcwidth 宽度算法的简化实现）。
 */

/** 覆盖 East Asian Width = W / F 的主要码点区段（含边界） */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK 部首、注音等
  [0x3041, 0x33ff], // 平假名/片假名/CJK 补充
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意
  [0xa000, 0xa4cf], // 彝文
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3], // Hangul 音节
  [0xf900, 0xfaff], // CJK 兼容表意
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60], // 全角 ASCII/标点
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], // Emoji（常见块）
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd], // CJK 扩展 B+
  [0x30000, 0x3fffd],
];

/** 宽度为 0 的组合字符区段（装饰符/变体选择符等） */
const ZERO_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // 组合附加符号
  [0x200b, 0x200f], // 零宽字符
  [0xfe00, 0xfe0f], // 变体选择符
  [0xfe20, 0xfe2f],
  [0x20d0, 0x20ff],
];

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = ranges[mid]!;
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** 单个码点的显示列宽：0 / 1 / 2 */
export function charWidth(cp: number): 0 | 1 | 2 {
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0; // 控制字符不占列
  if (inRanges(cp, ZERO_RANGES)) return 0;
  if (inRanges(cp, WIDE_RANGES)) return 2;
  return 1;
}

/** ANSI SGR/光标转义序列（粗略匹配 ESC [ ... 字母） */
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** 字符串的终端显示列宽（剥离 ANSI 转义后按码点累加） */
export function displayWidth(s: string): number {
  const plain = s.replace(ANSI_RE, '');
  let w = 0;
  for (const ch of plain) {
    w += charWidth(ch.codePointAt(0) ?? 0);
  }
  return w;
}

/** 按显示宽度截断字符串（保留前 maxCols 列，ANSI 转义序列零宽透传，
 * 不会被截断在转义序列中间），返回 [文本, 实际列宽] */
export function truncateToWidth(s: string, maxCols: number): [string, number] {
  const esc = /\x1b\[[0-9;?]*[A-Za-z]/y;
  let w = 0;
  let out = '';
  let i = 0;
  while (i < s.length) {
    esc.lastIndex = i;
    const m = esc.exec(s);
    if (m !== null) {
      out += m[0];
      i = esc.lastIndex;
      continue;
    }
    const cp = s.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > maxCols) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return [out, w];
}

/** 用 pad 填充到指定显示宽度（s 已是纯文本，不剥离 ANSI） */
export function padToWidth(s: string, cols: number, pad = ' '): string {
  const w = displayWidth(s);
  if (w >= cols) return s;
  return s + pad.repeat(cols - w);
}
