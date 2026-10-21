import { displayWidth } from './width.js';
import { artColors } from './terminal.js';
import { flightScenePixels } from './flight.js';
import { t } from '../i18n/index.js';

/**
 * 欢迎面板（Welcome Panel）：进入正式工作区时的初始区域（仿 Claude Code /
 * MiMo 的欢迎框，但布局自定）。
 *
 * 布局：一个圆角矩形，左半部分 = "蝴蝶向右飞"的城市天际线场景（蝴蝶原地
 * 扇翅、天际线循环后退）+ 下方黑白阴影画风的 SYAOCode 艺术字；右半部分 =
 * 当前语言的欢迎语与指令提示。
 *
 * 纯函数渲染：renderPanel(cols, panelH, tMs, info) → string[]（每行等宽），
 * t 驱动蝴蝶扇翅，便于确定性单测。终端过小返回 []（调用方跳过面板）。
 */

export interface WelcomeInfo {
  version: string;
  model: string;
  tier: string;
}

export function welcomeSupported(cols: number, rows: number): boolean {
  return cols >= 64 && rows >= 20;
}

// ---------- 迷你像素字体（"SYAOCode" 专用，变宽 5 行） ----------

const MINI: Record<string, { w: number; rows: string[] }> = {
  S: { w: 4, rows: ['0111', '1000', '0110', '0001', '1110'] },
  Y: { w: 5, rows: ['10001', '10001', '01010', '00100', '00100'] },
  A: { w: 4, rows: ['0110', '1001', '1111', '1001', '1001'] },
  L: { w: 3, rows: ['100', '100', '100', '100', '111'] },
  I: { w: 1, rows: ['1', '1', '1', '1', '1'] },
  W: { w: 5, rows: ['10001', '10001', '10101', '10101', '01010'] },
  E: { w: 4, rows: ['1111', '1000', '1110', '1000', '1111'] },
  N: { w: 4, rows: ['1001', '1101', '1011', '1001', '1001'] },
  O: { w: 4, rows: ['0110', '1001', '1001', '1001', '0110'] },
  C: { w: 4, rows: ['0111', '1000', '1000', '1000', '0111'] },
  o: { w: 4, rows: ['0110', '1001', '1001', '1001', '0110'] },
  d: { w: 4, rows: ['0001', '0111', '1001', '1001', '0111'] },
  e: { w: 3, rows: ['110', '100', '111', '101', '011'] },
};

export interface MiniPoint {
  col: number;
  row: number;
}

/** 迷你字渲染为点阵；spacing 为字间距（放不下时用 0） */
export function miniPoints(text: string, spacing = 1): { points: MiniPoint[]; width: number } {
  const points: MiniPoint[] = [];
  let x = 0;
  for (const ch of text) {
    const g = MINI[ch];
    if (g === undefined) {
      x += 2 + spacing;
      continue;
    }
    for (let r = 0; r < 5; r++) {
      const line = g.rows[r]!;
      for (let c = 0; c < g.w; c++) {
        if (line[c] === '1') points.push({ col: x + c, row: r });
      }
    }
    x += g.w + spacing;
  }
  return { points, width: Math.max(0, x - spacing) };
}

// ---------- 蝴蝶与天际线飞行场景 ----------
// 生成逻辑在 flight.ts（欢迎面板与运行阶段行共用）；这里 re-export 保持旧接口可用。

export { FLAP_CYCLE_MS, flightScenePixels } from './flight.js';

/** 黑白阴影艺术字像素：主字/阴影色随主题（深色终端白+深灰，浅色终端深灰+浅灰）。
 * 字形纵向 ×2（半块像素为正方形）；横向按目标宽度自动整数倍缩放 +
 * 均匀字距，铺满整个底部宽度。像素高 = 5×2+2 = 12 = 6 终端行 */
export function artPixels(w: number, text = 'SYAOCode', colors: { main: number; shadow: number } = artColors()): Map<number, number> {
  const glyphs = [...text].map((ch) => MINI[ch]).filter((g): g is { w: number; rows: string[] } => g !== undefined);
  if (glyphs.length === 0) return new Map();
  const baseW = glyphs.reduce((acc, g) => acc + g.w, 0);
  const gaps = Math.max(1, glyphs.length - 1);
  const xScale = Math.max(1, Math.min(3, Math.floor((w * 0.92) / baseW)));
  const scaledW = baseW * xScale;
  const gap = Math.max(0, Math.floor((w - scaledW) / gaps));
  const ox = Math.max(0, Math.floor((w - (scaledW + gap * gaps)) / 2));
  const shadowOff = 1; // 阴影仅露出右下 1 列，避免糊在字底

  const px = new Map<number, number>();
  let x = ox;
  glyphs.forEach((g, gi) => {
    for (let r = 0; r < 5; r++) {
      const line = g.rows[r]!;
      for (let c = 0; c < g.w; c++) {
        if (line[c] !== '1') continue;
        for (let s = 0; s < xScale; s++) {
          const col = x + c * xScale + s;
          // 阴影（先行，被主字覆盖处重写）：深灰 234 与亮白 255 拉开对比
          px.set((r * 2 + 2) * w + (col + shadowOff), colors.shadow);
          px.set((r * 2 + 3) * w + (col + shadowOff), colors.shadow);
          px.set((r * 2) * w + col, colors.main);
          px.set((r * 2 + 1) * w + col, colors.main);
        }
      }
    }
    x += g.w * xScale + (gi < glyphs.length - 1 ? gap : 0);
  });
  return px;
}

// ---------- 半块渲染（单条带） ----------

function stripOf(px: Map<number, number>, w: number, row: number): string {
  const parts: string[] = [];
  let fg: number | null = null;
  let bg: number | null = null;
  const setFg = (c: number | null) => {
    if (fg !== c) {
      parts.push(c === null ? '\x1b[39m' : `\x1b[38;5;${c}m`);
      fg = c;
    }
  };
  const setBg = (c: number | null) => {
    if (bg !== c) {
      parts.push(c === null ? '\x1b[49m' : `\x1b[48;5;${c}m`);
      bg = c;
    }
  };
  for (let c = 0; c < w; c++) {
    const up = px.get(row * 2 * w + c);
    const down = px.get((row * 2 + 1) * w + c);
    if (up === undefined && down === undefined) {
      setFg(null);
      setBg(null);
      parts.push(' ');
    } else if (down === undefined) {
      setBg(null);
      setFg(up!);
      parts.push('▀');
    } else if (up === undefined) {
      setFg(null);
      setBg(down);
      parts.push('▄');
    } else {
      setFg(up);
      setBg(down);
      parts.push('▀');
    }
  }
  parts.push('\x1b[39m\x1b[49m');
  return parts.join('');
}

// ---------- 面板组装 ----------

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;

/** 纯 ASCII 行（右列内容在构造期就控制在宽度内，无需 ANSI 感知截断） */
function rightColumn(info: WelcomeInfo): string[] {
  const hints: [string, string][] = [
    ['/help', t('welcome.hintHelp')],
    ['/model', t('welcome.hintModel')],
    ['/status', t('welcome.hintStatus')],
    ['/exit', t('welcome.hintExit')],
  ];
  const extra: [string, string][] = [
    ['@file', t('welcome.hintAt')],
    ['!cmd', t('welcome.hintBang')],
    ['Ctrl+C', t('welcome.hintCtrlC')],
  ];
  return [
    '',
    bold(t('welcome.title')),
    dim(t('welcome.version', { version: info.version, model: cyan(info.model) })),
    dim(t('welcome.permission', { tier: yellow(info.tier) })),
    '',
    ...hints.map(([k, v]) => `  ${green(k.padEnd(9))} ${dim(v)}`),
    '',
    ...extra.map(([k, v]) => `  ${green(k.padEnd(9))} ${dim(v)}`),
    '',
    dim(t('welcome.typeSlash')),
  ];
}

/**
 * 渲染欢迎面板：返回等宽行数组（不含换行）；终端过小返回 []。
 * panelH 由调用方按可用行数给出（12..22）。
 * frozen = true 时蝴蝶取固定姿态（t=0 全开），用户敲任意键后调用方置位，
 * 动画立即停止（防频繁重绘），面板保持静态直到首次输出收起。
 *
 * 布局（无中缝分隔线）：
 *   ┌────────────────────────────────────┐
 *   │  蝴蝶(左)         Welcome/提示(右)  │   上半区：左右并排，空隙分隔
 *   │                                    │
 *   │  L I W E N C o d e（铺满底部宽度） │   底部 6 行：黑白阴影艺术字
 *   └────────────────────────────────────┘
 */
export function renderPanel(
  cols: number,
  panelH: number,
  tMs: number,
  info: WelcomeInfo,
  frozen = false,
): string[] {
  const panelW = Math.min(cols - 2, 88);
  if (!welcomeSupported(cols, panelH + 2) || panelH < 12) return [];
  const innerH = panelH - 2;
  // 内容宽度：│_C_│（边框2 + 左右各 1 空隙）
  const innerW = panelW - 4;
  // 上半区左右分割（无分隔线，仅空隙）：蝴蝶 leftW + 2 空格 + 右侧文本
  const leftW = Math.floor(innerW * 0.46);
  const rightW = innerW - leftW - 2;
  const rightStart = leftW + 2;

  // 底部艺术字 6 行 + 1 空行分隔
  const artH = 6;
  const upperRows = innerH - artH - 1;
  // 左侧场景：蝴蝶原地扇翅 + 城市天际线循环向后退（= 向右飞）
  const butterfly = flightScenePixels(leftW, upperRows * 2, tMs, frozen);
  const art = artPixels(innerW);

  // 右侧文本在上半区垂直居中；行数不足时先删空行、再从顶部裁剪
  const right = rightColumn(info);
  while (right.length > upperRows && right.includes('')) right.splice(right.indexOf(''), 1);
  while (right.length > upperRows && right.length > 1) right.shift();
  const padTop = Math.max(0, Math.floor((upperRows - right.length) / 2));
  const rightAt = (i: number): string => {
    const line = i >= padTop ? right[i - padTop] : undefined;
    return line ?? '';
  };

  const lines: string[] = [];
  const title = ' SYAOCode ';
  const fill = panelW - 2 - title.length;
  const l = Math.floor(fill / 2);
  lines.push(`╭${'─'.repeat(l)}${title}${'─'.repeat(fill - l)}╮`);
  for (let r = 0; r < innerH; r++) {
    if (r < upperRows) {
      const bf = stripOf(butterfly, leftW, r);
      // 右列最长行约 40 列；rightW 不足时置空（面板宽度已由 welcomeSupported 兜底）
      const rt = plainLen(rightAt(r)) > rightW ? '' : rightAt(r);
      const pad = rightW - plainLen(rt);
      // bf(leftW 可见列) + 2 空格 + rt+pad(rightW) = innerW，无中缝分隔线
      lines.push(`│ ${bf}  ${rt}${' '.repeat(Math.max(0, pad))} │`);
    } else if (r === upperRows) {
      lines.push(`│ ${' '.repeat(innerW)} │`);
    } else {
      const artRow = stripOf(art, innerW, r - upperRows - 1);
      lines.push(`│ ${artRow} │`);
    }
  }
  lines.push(`╰${'─'.repeat(panelW - 2)}╯`);
  return lines;
}

/** 右列可见列宽（ANSI 零宽；CJK 按 2 列，避免动态文本撑破边框对齐） */
function plainLen(s: string): number {
  return displayWidth(s);
}
