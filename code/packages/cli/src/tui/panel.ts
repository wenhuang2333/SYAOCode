/**
 * 通用 TUI 面板渲染（纯函数，返回 ANSI 字符串行）：
 * 圆角面板 / 键值行 / 表格 / 进度条 / 徽标 / 分区标题。
 *
 * 供所有信息类命令（/status /cost /tools /permissions /doctor /model …）
 * 共用；TUI 用 printAbove 输出，REPL 直接 join('\n') 输出。
 * 所有行按显示宽度对齐（内容仅 ASCII + ANSI，CJK 值按 2 列计）。
 */

import { displayWidth, truncateToWidth } from './width.js';

export const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[39m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[39m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
  gray: (s: string) => `\x1b[38;5;245m${s}\x1b[39m`,
  white: (s: string) => `\x1b[38;5;255m${s}\x1b[39m`,
  c256: (n: number, s: string) => `\x1b[38;5;${n}m${s}\x1b[39m`,
  bg: (n: number, s: string) => `\x1b[48;5;${n}m${s}\x1b[49m`,
  reverse: (s: string) => `\x1b[7m${s}\x1b[27m`,
};

/** 可见列宽（已剥离 ANSI） */
function vis(s: string): number {
  return displayWidth(s);
}

function plainLen(s: string): number {
  return vis(s);
}

function padRight(s: string, w: number): string {
  const need = w - vis(s);
  return need > 0 ? s + ' '.repeat(need) : s;
}

/** 徽标：暗底 + 彩色文字 */
export function badge(text: string, color: number): string {
  return C.bg(236, C.c256(color, ` ${text} `));
}

/** 进度条：filled 部分用颜色，空槽用暗块 */
export function bar(ratio: number, width: number, color = 45): string {
  const r = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(r * width);
  return C.c256(color, '█'.repeat(filled)) + C.c256(238, '░'.repeat(Math.max(0, width - filled)));
}

/** 分区标题（左侧竖线 + 大写标题） */
export function section(title: string): string {
  return `${C.c256(45, '▍')}${C.bold(title.toUpperCase())}`;
}

/** 键值行（label 右对齐到固定宽度） */
export function kv(label: string, value: string, labelW = 12): string {
  return `${C.dim(padRight(label, labelW))} ${value}`;
}

export interface TableOptions {
  /** 各列最小宽度（内容驱动，未给出的列自动取内容最大宽） */
  minWidths?: number[];
  /** 表头颜色（256 色号） */
  headerColor?: number;
  /** 分隔线样式：none / thin */
  divider?: boolean;
}

/** 简单表格：表头加粗着色 + 行对齐；列宽按显示宽度自动计算 */
export function table(header: string[], rows: string[][], opts: TableOptions = {}): string[] {
  const cols = header.length;
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    const cellW = rows.reduce((m, r) => Math.max(m, plainLen(r[c] ?? '')), 0);
    widths.push(Math.max(opts.minWidths?.[c] ?? 0, plainLen(header[c] ?? ''), cellW));
  }
  const line = (cells: string[]) =>
    cells.map((cell, c) => padRight(cell, widths[c]!)).join('  ').trimEnd();
  const out: string[] = [];
  out.push(C.c256(opts.headerColor ?? 45, line(header.map((h) => C.bold(h)))));
  if (opts.divider !== false) {
    const total = widths.reduce((a, b) => a + b, 0) + (cols - 1) * 2;
    out.push(C.c256(238, '─'.repeat(total)));
  }
  for (const r of rows) out.push(line(r));
  return out;
}

/**
 * 圆角面板：标题居中于顶边；内容行按可用宽度截断并补齐。
 * width 缺省为内容最大宽度 + 4，最大 maxWidth。
 */
export function panel(title: string, body: string[], opts: { width?: number; maxWidth?: number } = {}): string[] {
  const maxWidth = opts.maxWidth ?? 96;
  const contentW = body.reduce((m, l) => Math.max(m, plainLen(l)), 0);
  const titleW = plainLen(title) + 2;
  const width = Math.min(maxWidth, Math.max(opts.width ?? 0, contentW + 4, titleW + 6));
  const innerW = width - 4;
  const fill = width - 2 - titleW;
  const left = Math.floor(fill / 2);
  const out: string[] = [];
  out.push(`╭${'─'.repeat(left)} ${C.bold(title)} ${'─'.repeat(fill - left)}╮`);
  for (const raw of body) {
    const [trunc] = truncateToWidth(raw, innerW);
    const padded = padRight(trunc, innerW);
    out.push(`│ ${padded} │`);
  }
  out.push(`╰${'─'.repeat(width - 2)}╯`);
  return out;
}
