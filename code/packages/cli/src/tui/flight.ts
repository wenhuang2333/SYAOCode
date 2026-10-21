/**
 * 视觉元素：侧视蝴蝶 + 城市天际线（欢迎面板），以及运行阶段行的旋转字符。
 *
 * 欢迎面板场景：
 * - 蝴蝶为**侧视**：狭长身体横向朝右、触角向前探伸、前翅上举呈半透扇面
 *   （翅脉可见）、后翅垂在身体后下方并拖长尾突；双翅一上一下缓慢划动，
 *   身体不移动。整体很小（约 15×9 像素）。
 * - 配色按**上下三层**：上蓝、中紫、下绿；每层用 base/light/dark 三档表现
 *   翅面、翅脉与斑点。
 * - 天际线是画面下方一条较高的建筑带（6~12 像素），深蓝底 + 青蓝窗，向左
 *   循环滚动；右上角有一弯月亮。
 *
 * 阶段行：纯 ANSI 终端里像素蝴蝶太占空间，改用 Claude Code 式**单字符**
 * 旋转动画（· ✢ ✳ ✶ ✻ ✽），正常蓝色、网络异常红色；ASCII 终端降级为
 * . o O * + x。
 *
 * 纯函数（同参数同输出），便于确定性单测。
 */

/** 欢迎面板蝴蝶的划翅周期（缓慢） */
export const FLAP_CYCLE_MS = 3600;
/** 阶段行旋转字符的换帧间隔 */
export const SPINNER_INTERVAL_MS = 120;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 周期相位 0..1 */
function phaseOf(tMs: number, cycleMs: number): number {
  return ((tMs % cycleMs) + cycleMs) % cycleMs / cycleMs;
}

/** 扇翅系数：1 = 全开，0.32 = 收拢 */
export function flapScale(tMs: number, cycleMs = FLAP_CYCLE_MS): number {
  return 0.32 + 0.68 * Math.abs(Math.cos(Math.PI * 2 * phaseOf(tMs, cycleMs)));
}

// ---------- 像素画布工具 ----------

export interface Canvas {
  w: number;
  h: number;
  map: Map<number, number>;
}

function put(c: Canvas, x: number, y: number, color: number, over = true): void {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || xi >= c.w || yi < 0 || yi >= c.h) return;
  if (!over && c.map.has(yi * c.w + xi)) return;
  c.map.set(yi * c.w + xi, color);
}

function line(c: Canvas, x0: number, y0: number, x1: number, y1: number, color: number, over = true): void {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const tx = Math.round(x1);
  const ty = Math.round(y1);
  const dx = Math.abs(tx - x);
  const dy = Math.abs(ty - y);
  const sx = x < tx ? 1 : -1;
  const sy = y < ty ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    put(c, x, y, color, over);
    if (x === tx && y === ty) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

function span(c: Canvas, y: number, x0: number, x1: number, color: number): void {
  for (let x = Math.round(x0); x <= Math.round(x1); x++) put(c, x, y, color);
}

// ---------- 侧视蝴蝶（欢迎面板，三层配色：蓝/紫/绿） ----------

/**
 * 纵向三层色：上蓝（0~3 行）、中紫（4~7 行）、下绿（8~11 行）。
 * 每层提供 base（翅面/描边）、light（半透膜/斑点）、dark（翅脉/身体）。
 */
const LAYERS = [
  { base: 33, light: 75, dark: 25 }, // 蓝
  { base: 135, light: 177, dark: 91 }, // 紫
  { base: 46, light: 84, dark: 28 }, // 绿
] as const;

function layerOf(y: number): (typeof LAYERS)[number] {
  return LAYERS[y < 4 ? 0 : y < 8 ? 1 : 2]!;
}

/** 蝴蝶设计稿尺寸（绘制前会整体缩放到更小的屏幕尺寸） */
const SPRITE_DESIGN_W = 20;
const SPRITE_DESIGN_H = 12;
/** 整体缩放：0.75 → 约 15×9 像素，比上一版再小一档 */
export const SCENE_BUTTERFLY_SCALE = 0.75;

/**
 * 画一只侧视蝴蝶（设计稿 20×12，按 scale 缩放），朝右。
 * wingDy：前翅上下划动偏移（后翅反向）。
 */
export function drawSideButterfly(c: Canvas, ox: number, oy: number, scale: number, wingDy: number): void {
  const sx = (x: number): number => ox + Math.round(x * scale);
  const sy = (y: number): number => oy + Math.round(y * scale);
  const hd = -wingDy; // 后翅与前翅反向错开

  // 后翅（远侧，身体后下方，长尾）
  const hindRows: [number, number, number][] = [
    [7, 9, 12],
    [8, 6, 10],
    [9, 4, 8],
    [10, 2, 5],
    [11, 0, 2],
  ];
  for (const [y, x0, x1] of hindRows) {
    const pal = layerOf(y);
    span(c, sy(y) + hd, sx(x0), sx(x1), pal.base);
  }
  // 尾突：从后翅后端继续向左下飘出
  line(c, sx(2), sy(11) + hd, sx(0), sy(11) + hd + 1, layerOf(11).dark);
  // 后翅内部斑点（同层亮色）
  for (const [x, y] of [[5, 8], [6, 8], [7, 8], [8, 7], [9, 7], [10, 7]] as const) {
    put(c, sx(x), sy(y) + hd, layerOf(y).light);
  }
  // 外缘深色描边
  const margin: [number, number][] = [[1, 10], [2, 10], [3, 9], [4, 9], [5, 9], [6, 8], [7, 8], [8, 8], [9, 7]];
  for (const [x, y] of margin) put(c, sx(x), sy(y) + hd, layerOf(y).dark);

  // 身体：狭长横向朝右 + 头（取所在层的中性色）
  for (let x = 6; x <= 17; x++) put(c, sx(x), sy(6), LAYERS[1]!.dark);
  put(c, sx(16), sy(6), LAYERS[1]!.base);
  put(c, sx(17), sy(6), LAYERS[1]!.base);
  // 细长触角向前（右上）探伸
  line(c, sx(17), sy(5), sx(19), sy(0), LAYERS[0]!.base);
  line(c, sx(16), sy(5), sx(19), sy(2), LAYERS[0]!.light);
  // 足收拢贴腹下
  put(c, sx(9), sy(7), LAYERS[1]!.dark);
  put(c, sx(11), sy(7), LAYERS[1]!.dark);
  // 腹面斑点沿身体侧线
  put(c, sx(14), sy(7), LAYERS[1]!.light);
  put(c, sx(15), sy(7), LAYERS[1]!.light);

  // 前翅（近侧，上举后掠的薄扇面）——最后画，覆盖翅基
  const fd = wingDy;
  const fore = [
    [13, 6], [10, 2], [6, 0], [2, 1], [3, 4], [6, 5], [13, 6],
  ] as const;
  for (let i = 0; i < fore.length - 1; i++) {
    const [x0, y0] = fore[i]!;
    const [x1, y1] = fore[i + 1]!;
    const pal = layerOf(y0);
    line(c, sx(x0), sy(y0) + fd, sx(x1), sy(y1) + fd, pal.base);
  }
  // 半透膜面：棋盘格稀疏填充（同层亮色，保持上下分层）
  for (let y = 1; y <= 5; y++) {
    for (let x = 2; x <= 13; x++) {
      const inside = y <= 5 - Math.floor(Math.abs(x - 7) / 4);
      if (inside && (x + y) % 2 === 0) put(c, sx(x), sy(y) + fd, layerOf(y).light, false);
    }
  }
  // 翅脉：从翅基向扇面辐射（同层深色）
  for (const [tx, ty] of [[3, 2], [5, 1], [7, 1], [9, 2], [11, 3]] as const) {
    line(c, sx(13), sy(6) + fd, sx(tx), sy(ty) + fd, layerOf(ty).dark);
  }
}

/** 蝴蝶在当前画布中的锚点：水平居中，放在天际线带上方 */
export function sceneButterflyOrigin(w: number, h: number, stripH: number): { ox: number; oy: number; wPx: number; hPx: number } {
  const wPx = Math.max(1, Math.round(SPRITE_DESIGN_W * SCENE_BUTTERFLY_SCALE));
  const hPx = Math.max(1, Math.round(SPRITE_DESIGN_H * SCENE_BUTTERFLY_SCALE));
  const ox = Math.round((w - wPx) / 2);
  const usable = h - stripH;
  const oy = Math.max(0, Math.round((usable - hPx) / 2));
  return { ox, oy, wPx, hPx };
}

// ---------- 城市天际线（较高、更明显、循环滚动） ----------

interface SkylineStrip {
  w: number;
  stripH: number;
  height: Int16Array;
  edge: Int8Array;
  windows: number[][];
}

const stripCache = new Map<string, SkylineStrip>();

function buildStrip(w: number, stripH: number): SkylineStrip {
  const key = `${w}x${stripH}`;
  const hit = stripCache.get(key);
  if (hit !== undefined) return hit;
  const rand = mulberry32(w * 7919 + stripH * 104729);
  const height = new Int16Array(w);
  const edge = new Int8Array(w);
  const windows: number[][] = Array.from({ length: w }, () => []);
  // 冷色描边（更亮，提升可见度）
  const cool = [33, 39, 45, 51, 87];
  let x = 0;
  let bi = 0;
  while (x < w) {
    const bw = 3 + Math.floor(rand() * 3);
    // 楼层更高：占带高的 55%~100%
    const bh = Math.max(2, Math.floor(stripH * (0.55 + rand() * 0.45)));
    const ec = cool[bi % cool.length]!;
    for (let i = 0; i < bw; i++) {
      const col = (x + i) % w;
      height[col] = bh;
      edge[col] = ec;
    }
    for (let wy = 1; wy < bh - 1; wy += 2) {
      for (let wx = x + 1; wx < x + bw - 1; wx += 2) {
        if (rand() < 0.7) windows[wx % w]!.push(wy);
      }
    }
    // 楼与楼之间留出空隙，轮廓更清楚
    x += bw + 1 + (rand() < 0.4 ? 1 : 0);
    bi++;
  }
  const strip: SkylineStrip = { w, stripH, height, edge, windows };
  stripCache.set(key, strip);
  return strip;
}

/** 天际线带高度：更高更明显（6~12 像素，约 3~6 个终端行） */
export function skylineStripHeight(h: number): number {
  return Math.min(12, Math.max(6, Math.floor(h * 0.38)));
}

/** 右上角满月（完整圆盘 + 几处暗色月海） */
function drawMoon(c: Canvas, w: number): void {
  const r = 3;
  const mx = w - 5;
  const my = 3;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r) put(c, mx + dx, my + dy, 230);
    }
  }
  // 月海：几处略暗的斑点，让满月有细节但不改变"满月"观感
  for (const [dx, dy] of [[-1, -1], [1, 0], [0, 2]] as const) {
    put(c, mx + dx, my + dy, 223);
  }
}

/** 底部天际线带像素（向左滚动；冷色） */
export function skylinePixels(w: number, h: number, tMs: number): Map<number, number> {
  const stripH = skylineStripHeight(h);
  const strip = buildStrip(w, stripH);
  const px = new Map<number, number>();
  const offset = Math.floor(tMs / 60) % w;
  const base = h - 1;
  for (let x = 0; x < w; x++) {
    const src = (x + offset) % w;
    const bh = strip.height[src]!;
    if (bh === 0) continue;
    const top = base - bh + 1;
    const ec = strip.edge[src]!;
    // 楼体深蓝底 + 顶边/边缘亮色 + 青色窗
    for (let y = top; y <= base; y++) px.set(y * w + x, 17);
    px.set(top * w + x, ec);
    if (x % 3 === 0) px.set(Math.min(base, top + 1) * w + x, 25);
    for (const wy of strip.windows[src]!) {
      const y = top + wy;
      if (y < base) px.set(y * w + x, 51);
    }
  }
  return px;
}

/**
 * 欢迎面板左侧场景：较高天际线带 + 右上满月。
 *
 * 侧视蝴蝶暂时不绘制（按要求保留代码备用）。恢复方法：取消下面注释即可
 * （drawSideButterfly / sceneButterflyOrigin / SCENE_BUTTERFLY_SCALE 均保留）。
 */
export function flightScenePixels(w: number, h: number, tMs: number, frozen = false): Map<number, number> {
  const t = frozen ? 0 : tMs;
  const stripH = skylineStripHeight(h);
  const px = skylinePixels(w, h, t);
  const canvas: Canvas = { w, h, map: px };
  drawMoon(canvas, w);

  // ── 蝴蝶（暂时关闭，留作备用）────────────────────────────────────────
  // const { ox, oy } = sceneButterflyOrigin(w, h, stripH);
  // // 缓缓划动：一个周期内上下各一次（±1px），身体不动
  // const wingDy = frozen ? 0 : Math.round(Math.sin(Math.PI * 2 * phaseOf(t, FLAP_CYCLE_MS)) * 1.2);
  // drawSideButterfly(canvas, ox, oy, SCENE_BUTTERFLY_SCALE, wingDy);
  // ─────────────────────────────────────────────────────────────────────
  void stripH;
  return canvas.map;
}

// ---------- 运行阶段行的旋转字符（Claude Code 风格） ----------

const SPINNER_UNICODE = ['·', '✢', '✳', '✶', '✻', '✽'] as const;
const SPINNER_ASCII = ['.', 'o', 'O', '*', '+', 'x'] as const;

/** 当前帧的旋转字符（单宽，占 1 列） */
export function spinnerFrame(tMs: number, ascii = false): string {
  const frames = ascii ? SPINNER_ASCII : SPINNER_UNICODE;
  const i = Math.floor((((tMs % (SPINNER_INTERVAL_MS * frames.length)) + SPINNER_INTERVAL_MS * frames.length) % (SPINNER_INTERVAL_MS * frames.length)) / SPINNER_INTERVAL_MS);
  return frames[i] ?? frames[0]!;
}
