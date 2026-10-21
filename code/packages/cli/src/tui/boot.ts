/**
 * 启动粒子动画：城市天际线 → 蝴蝶（扇动两下）→ SYAO CODE 三层色艺术字。
 *
 * 设计要点：
 * - 纯时间驱动：tick(tMs) 为纯函数式计算（同参数同输出），便于确定性单测。
 * - 半块渲染：每个终端格子拆成上/下两个像素（▀ fg=上、bg=下；▄ 单下半），
 *   垂直分辨率 ×2，像素近似正方形。
 * - 相位：skyline(2.0s，前 0.8s 从散点聚合成型) → butterfly(2.4s，0.5s 变形
 *   + 1.4s 扇动两下 + 0.5s 收势) → art(1.0s) → hold(1.0s)。
 * - 颜色用 256 色索引（38;5;N / 48;5;N），兼容主流终端。
 */

import { GRID_HEIGHT, gridWidth, textToPoints } from './font5x7.js';

export type BootPhase = 'skyline' | 'butterfly' | 'art' | 'hold' | 'done';

interface PhaseSpec {
  name: Exclude<BootPhase, 'done'>;
  start: number;
  dur: number;
}

export const PHASES: ReadonlyArray<PhaseSpec> = [
  { name: 'skyline', start: 0, dur: 2000 },
  { name: 'butterfly', start: 2000, dur: 2400 },
  { name: 'art', start: 4400, dur: 1000 },
  { name: 'hold', start: 5400, dur: 1000 },
];

export const BOOT_TOTAL_MS = 6400;

// butterfly 相位内的时间切分（毫秒）
const FLY_MORPH_MS = 500;
const FLY_FLAP_MS = 1400;
// skyline 相位内聚合耗时
const SKY_MORPH_MS = 800;

/** 三层色（自上而下：蓝 / 绿 / 紫），hold 阶段在同层两档间脉动 */
const ART_LAYER_COLORS: ReadonlyArray<readonly [number, number]> = [
  [33, 39], // blue
  [46, 48], // green
  [135, 141], // purple
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function easeInOutCubic(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------- 三种目标形态 ----------

interface SkyTarget { x: number; y: number; color: number; twinkle: boolean; twPhase: number; }
interface FlyTarget { rx: number; y: number; color: number; }
interface ArtTarget { x: number; y: number; layer: number; }

/** 城市天际线：建筑轮廓 + 亮窗（闪烁）+ 星星 + 月亮 */
function genSkyline(cols: number, pixelH: number, rand: () => number): SkyTarget[] {
  const out: SkyTarget[] = [];
  const ground = pixelH - 2;
  const edgeColors = [39, 45, 81];

  // 月亮：右上角实心圆盘
  const mr = Math.max(2, Math.round(pixelH * 0.06));
  const mx = cols * 0.8;
  const my = pixelH * 0.16;
  for (let dy = -mr; dy <= mr; dy++) {
    for (let dx = -mr; dx <= mr; dx++) {
      if (dx * dx + dy * dy <= mr * mr) {
        out.push({ x: mx + dx, y: my + dy, color: 229, twinkle: false, twPhase: 0 });
      }
    }
  }

  // 星星
  const starCount = Math.floor(cols / 5);
  for (let i = 0; i < starCount; i++) {
    out.push({
      x: rand() * cols,
      y: 1 + rand() * pixelH * 0.4,
      color: 245,
      twinkle: true,
      twPhase: rand() * Math.PI * 2,
    });
  }

  // 建筑群
  let x = 0;
  let bi = 0;
  while (x < cols - 2) {
    const w = 4 + Math.floor(rand() * 7);
    const h = Math.floor(pixelH * (0.22 + rand() * 0.4));
    const top = ground - h;
    const ec = edgeColors[bi % edgeColors.length]!;
    // 天际线顶边 + 侧边
    for (let i = 0; i < w && x + i < cols; i++) out.push({ x: x + i, y: top, color: ec, twinkle: false, twPhase: 0 });
    for (let yy = top + 1; yy <= ground; yy += 2) {
      out.push({ x, y: yy, color: ec, twinkle: false, twPhase: 0 });
      if (x + w - 1 < cols) out.push({ x: x + w - 1, y: yy, color: ec, twinkle: false, twPhase: 0 });
    }
    // 天线（较高的楼）
    if (h > pixelH * 0.45 && rand() < 0.7) {
      const ax = x + Math.floor(w / 2);
      for (let k = 1; k <= 3 + Math.floor(rand() * 4); k++) {
        out.push({ x: ax, y: top - k, color: 250, twinkle: false, twPhase: 0 });
      }
    }
    // 亮窗
    for (let wy = top + 2; wy < ground - 1; wy += 3) {
      for (let wx = x + 1; wx < x + w - 1; wx += 3) {
        if (wx >= cols || rand() >= 0.72) continue;
        out.push({
          x: wx,
          y: wy,
          color: rand() < 0.5 ? 220 : 226,
          twinkle: true,
          twPhase: rand() * Math.PI * 2,
        });
      }
    }
    x += w + (rand() < 0.35 ? 1 : 0);
    bi++;
  }
  return out;
}

/** 蝴蝶：参数曲线 r = e^sinθ − 2cos4θ + sin^5((2θ−π)/24) + 身体 + 触角 */
function genButterfly(cols: number, pixelH: number, rand: () => number): FlyTarget[] {
  const out: FlyTarget[] = [];
  const cx = cols / 2;
  const cy = pixelH / 2 - 1;
  const scale = Math.min(cols * 0.46, pixelH * 0.46) / 4.0;

  const samples = 300;
  for (let i = 0; i < samples; i++) {
    const th = (i / samples) * Math.PI * 12;
    const r = Math.exp(Math.sin(th)) - 2 * Math.cos(4 * th) + Math.pow(Math.sin((2 * th - Math.PI) / 24), 5);
    const rx = r * Math.sin(th) * scale;
    const y = cy - r * Math.cos(th) * scale;
    // 靠近身体轴线的点用青色勾边，其余洋红，稀疏点提亮
    let color = 201;
    if (Math.abs(Math.cos(th)) > 0.985) color = 45;
    else if (i % 13 === 0) color = 213;
    out.push({ rx, y, color });
  }

  // 身体（竖线，rx=0 → 扇动缩放不影响）
  const bodyLen = Math.max(6, Math.floor(pixelH * 0.16));
  for (let k = -bodyLen; k <= bodyLen; k += 1) {
    if (k % 2 === 0 || Math.abs(k) > bodyLen - 2) out.push({ rx: 0, y: cy + k, color: 45 });
  }

  // 触角（两条短弧）
  for (const dir of [-1, 1]) {
    for (let k = 1; k <= 6; k++) {
      out.push({ rx: dir * k * 0.8, y: cy - bodyLen - k * 1.2, color: 45 });
    }
  }
  void rand;
  return out;
}

/** SYAO CODE 艺术字：5x7 点阵等比放大居中，纵向三层色 */
function genArt(cols: number, pixelH: number): ArtTarget[] {
  const text = 'SYAO CODE';
  const gw = gridWidth(text);
  const sx = Math.floor((cols * 0.92) / gw);
  const sy = Math.floor((pixelH * 0.62) / GRID_HEIGHT);
  const s = Math.max(1, Math.min(sx, sy));
  const ox = Math.floor((cols - gw * s) / 2);
  const oy = Math.floor((pixelH - GRID_HEIGHT * s) / 2);

  const out: ArtTarget[] = [];
  for (const p of textToPoints(text)) {
    const layer = p.row <= 1 ? 0 : p.row <= 4 ? 1 : 2;
    for (let dy = 0; dy < s; dy++) {
      for (let dx = 0; dx < s; dx++) {
        out.push({ x: ox + p.col * s + dx, y: oy + p.row * s + dy, layer });
      }
    }
  }
  return out;
}

function tileSky(src: SkyTarget[], n: number, rand: () => number): SkyTarget[] {
  const out: SkyTarget[] = [];
  for (let i = 0; i < n; i++) {
    const base = src[i % src.length]!;
    if (i < src.length) out.push(base);
    else out.push({ ...base, x: base.x + (rand() - 0.5), y: base.y + (rand() - 0.5) });
  }
  return out;
}
function tileFly(src: FlyTarget[], n: number, rand: () => number): FlyTarget[] {
  const out: FlyTarget[] = [];
  for (let i = 0; i < n; i++) {
    const base = src[i % src.length]!;
    if (i < src.length) out.push(base);
    else out.push({ ...base, rx: base.rx + (rand() - 0.5), y: base.y + (rand() - 0.5) });
  }
  return out;
}
function tileArt(src: ArtTarget[], n: number, rand: () => number): ArtTarget[] {
  const out: ArtTarget[] = [];
  for (let i = 0; i < n; i++) {
    const base = src[i % src.length]!;
    if (i < src.length) out.push(base);
    else out.push({ ...base, x: base.x + (rand() - 0.5), y: base.y + (rand() - 0.5) });
  }
  return out;
}

// ---------- 动画主体 ----------

export interface BootOptions {
  cols: number;
  rows: number;
  /** 随机种子（默认按尺寸派生，保证同尺寸稳定） */
  seed?: number;
}

/** 终端过小则不播放动画 */
export function bootSupported(cols: number, rows: number): boolean {
  return cols >= 40 && rows >= 12;
}

export class BootAnimation {
  readonly cols: number;
  readonly rows: number;
  private readonly pixelH: number;
  private readonly n: number;
  private readonly initX: Float64Array;
  private readonly initY: Float64Array;
  private readonly delay: Float64Array;
  private readonly jPhase: Float64Array;
  private readonly sky: SkyTarget[];
  private readonly fly: FlyTarget[];
  private readonly art: ArtTarget[];

  constructor(opts: BootOptions) {
    this.cols = Math.floor(opts.cols);
    this.rows = Math.floor(opts.rows);
    this.pixelH = this.rows * 2;
    const seed = opts.seed ?? (this.cols * 7919 + this.rows * 104729);
    const rand = mulberry32(seed);

    this.n = clamp(Math.round((this.cols * this.rows) / 2.2), 260, 900);
    this.initX = new Float64Array(this.n);
    this.initY = new Float64Array(this.n);
    this.delay = new Float64Array(this.n);
    this.jPhase = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      this.initX[i] = rand() * this.cols;
      this.initY[i] = rand() * this.pixelH;
      this.delay[i] = rand() * 0.3;
      this.jPhase[i] = rand() * Math.PI * 2;
    }
    this.sky = tileSky(genSkyline(this.cols, this.pixelH, rand), this.n, rand);
    this.fly = tileFly(genButterfly(this.cols, this.pixelH, rand), this.n, rand);
    this.art = tileArt(genArt(this.cols, this.pixelH), this.n, rand);
  }

  phaseAt(tMs: number): BootPhase {
    if (tMs >= BOOT_TOTAL_MS) return 'done';
    for (const p of PHASES) {
      if (tMs >= p.start && tMs < p.start + p.dur) return p.name;
    }
    return 'hold';
  }

  /** 蝴蝶扇动系数：1 = 全开；扇动窗口内完成恰好两个收合周期（扇两下） */
  private wingScale(tMs: number): number {
    const t = tMs - PHASES[1]!.start;
    if (t < FLY_MORPH_MS) return 1;
    if (t >= FLY_MORPH_MS + FLY_FLAP_MS) return 1;
    const f = (t - FLY_MORPH_MS) / FLY_FLAP_MS;
    // |cos(2πf)|：f∈[0,1] 恰好两个波峰（开）两个波谷（收）→ 扇动两下
    return 0.22 + 0.78 * Math.abs(Math.cos(Math.PI * 2 * f));
  }

  /** 扇动时的身体轻微起伏（与翅膀同步，两个周期） */
  private wingBob(tMs: number): number {
    const t = tMs - PHASES[1]!.start;
    if (t < FLY_MORPH_MS || t >= FLY_MORPH_MS + FLY_FLAP_MS) return 0;
    const f = (t - FLY_MORPH_MS) / FLY_FLAP_MS;
    return Math.sin(Math.PI * 2 * f) * 1.2;
  }

  /** 计算 tMs 时刻的像素着色（key = y*cols+x，value = 256 色索引）。供测试断言。 */
  pixelSnapshot(tMs: number): Map<number, number> {
    const pixels = new Map<number, number>();
    if (tMs >= BOOT_TOTAL_MS || !bootSupported(this.cols, this.rows)) return pixels;
    const phase = this.phaseAt(tMs);
    const spec = PHASES.find((p) => p.name === phase)!;
    const u = clamp((tMs - spec.start) / spec.dur, 0, 1);
    const wing = this.wingScale(tMs);
    const bob = this.wingBob(tMs);
    const cx = this.cols / 2;

    for (let i = 0; i < this.n; i++) {
      const delay = this.delay[i]!;
      // 变形窗口：skyline 前 0.8s 聚合、butterfly 前 0.5s 成形，之后粒子锁定目标
      // （翅膀开合由动态目标本身驱动，不再依赖缓动进度）
      const transitEnd =
        phase === 'skyline' ? SKY_MORPH_MS / spec.dur : phase === 'butterfly' ? FLY_MORPH_MS / spec.dur : 1;
      const v = Math.min(u, transitEnd) / transitEnd;
      const e = easeInOutCubic(clamp((v - delay) / (1 - delay), 0, 1));
      let fx: number;
      let fy: number;
      let tx: number;
      let ty: number;
      let color: number | -1;

      // 起点是上一相位的终点（butterfly 终态 = 翅膀全开）
      if (phase === 'skyline') {
        fx = this.initX[i]!;
        fy = this.initY[i]!;
        const tg = this.sky[i]!;
        tx = tg.x;
        ty = tg.y;
        color = tg.twinkle && Math.sin(tMs / 260 + tg.twPhase) < -0.35 ? -1 : tg.color;
      } else if (phase === 'butterfly') {
        const prev = this.sky[i]!;
        fx = prev.x;
        fy = prev.y;
        const tg = this.fly[i]!;
        tx = cx + tg.rx * wing;
        ty = tg.y + bob;
        color = tg.color;
      } else {
        const prev = this.fly[i]!;
        const tg = this.art[i]!;
        if (phase === 'hold') {
          // hold 静止：起点=终点（art 阶段末已就位），只做色彩脉动
          fx = tg.x;
          fy = tg.y;
        } else {
          // art 阶段：从蝴蝶全开态飞向艺术字
          fx = cx + prev.rx;
          fy = prev.y;
        }
        tx = tg.x;
        ty = tg.y;
        if (phase === 'hold') {
          const pair = ART_LAYER_COLORS[tg.layer]!;
          color = Math.sin(tMs / 160 + this.jPhase[i]!) > 0 ? pair[0] : pair[1];
        } else {
          color = ART_LAYER_COLORS[tg.layer]![0];
        }
      }

      let x = fx + (tx - fx) * e;
      let y = fy + (ty - fy) * e;
      // 抖动：让粒子群有生命感（到位后幅度恢复；hold 阶段艺术字完全静止，
      // 只保留色彩脉动）
      const jAmp = phase === 'hold' ? 0 : 0.35 + 0.65 * (1 - e);
      x += Math.sin(tMs / 170 + this.jPhase[i]!) * 0.45 * jAmp;
      y += Math.cos(tMs / 210 + this.jPhase[i]! * 1.7) * 0.45 * jAmp;

      if (color === -1) continue; // 闪烁熄灭
      const px = clamp(Math.round(x), 0, this.cols - 1);
      const py = clamp(Math.round(y), 0, this.pixelH - 1);
      pixels.set(py * this.cols + px, color);
    }
    return pixels;
  }

  /** 渲染整帧（ESC[H 定位，不清屏；行间 \n，末行不带换行避免滚动） */
  tick(tMs: number): string {
    const pixels = this.pixelSnapshot(tMs);
    const parts: string[] = ['\x1b[H'];
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

    for (let r = 0; r < this.rows; r++) {
      if (r > 0) parts.push('\n');
      for (let cIdx = 0; cIdx < this.cols; cIdx++) {
        const up = pixels.get(r * 2 * this.cols + cIdx);
        const down = pixels.get((r * 2 + 1) * this.cols + cIdx);
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
    }
    parts.push('\x1b[0m');
    return parts.join('');
  }

  isDone(tMs: number): boolean {
    return tMs >= BOOT_TOTAL_MS || !bootSupported(this.cols, this.rows);
  }
}
