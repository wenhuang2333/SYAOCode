import { describe, expect, it } from 'vitest';
import { BootAnimation, BOOT_TOTAL_MS, bootSupported, PHASES, type BootPhase } from '../src/tui/boot';
import { parseArgs } from '../src/args';

const COLS = 100;
const ROWS = 30;

function makeAnim(): BootAnimation {
  return new BootAnimation({ cols: COLS, rows: ROWS, seed: 42 });
}

/** 像素快照的横向半展（相对画面中心）——用于断言翅膀开合 */
function wingExtent(pixels: Map<number, number>): number {
  let max = 0;
  for (const key of pixels.keys()) {
    const x = key % COLS;
    const d = Math.abs(x - COLS / 2);
    if (d > max) max = d;
  }
  return max;
}

describe('tui/boot 启动动画', () => {
  it('相位时间轴与总时长一致', () => {
    expect(PHASES.map((p) => p.name)).toEqual(['skyline', 'butterfly', 'art', 'hold']);
    const last = PHASES[PHASES.length - 1]!;
    expect(last.start + last.dur).toBe(BOOT_TOTAL_MS);
    for (let i = 1; i < PHASES.length; i++) {
      expect(PHASES[i]!.start).toBe(PHASES[i - 1]!.start + PHASES[i - 1]!.dur);
    }
  });

  it('phaseAt 在边界正确切换', () => {
    const anim = makeAnim();
    const expectPhase = (t: number, p: BootPhase) => expect(anim.phaseAt(t)).toBe(p);
    expectPhase(0, 'skyline');
    expectPhase(1999, 'skyline');
    expectPhase(2000, 'butterfly');
    expectPhase(4399, 'butterfly');
    expectPhase(4400, 'art');
    expectPhase(5399, 'art');
    expectPhase(5400, 'hold');
    expectPhase(BOOT_TOTAL_MS, 'done');
    expect(anim.isDone(BOOT_TOTAL_MS)).toBe(true);
    expect(anim.isDone(BOOT_TOTAL_MS - 1)).toBe(false);
  });

  it('pixelSnapshot 确定性（同种子同输出）', () => {
    const a = makeAnim();
    const b = makeAnim();
    expect(a.pixelSnapshot(1234)).toEqual(b.pixelSnapshot(1234));
    expect(a.pixelSnapshot(5000)).toEqual(b.pixelSnapshot(5000));
  });

  it('tick() 输出含半块渲染字符且尺寸合规', () => {
    const anim = makeAnim();
    const frame = anim.tick(5500);
    expect(frame).toContain('▀');
    expect(frame.startsWith('\x1b[H')).toBe(true);
    // 行数 = rows（末行无换行）
    expect(frame.endsWith('\x1b[0m')).toBe(true);
    const lines = frame.slice('\x1b[H'.length, frame.length - '\x1b[0m'.length).split('\n');
    expect(lines.length).toBe(ROWS);
  });

  it('天际线阶段：像素大量存在（建筑+窗+星）', () => {
    const anim = makeAnim();
    const pixels = anim.pixelSnapshot(1500); // 聚合完成后（800ms）
    expect(pixels.size).toBeGreaterThan(150);
    // 暖色窗（220/226）与冷色轮廓（39/45/81）同时出现
    const colors = new Set(pixels.values());
    const hasWindow = [...colors].some((c) => c === 220 || c === 226);
    const hasEdge = [...colors].some((c) => c === 39 || c === 45 || c === 81);
    expect(hasWindow).toBe(true);
    expect(hasEdge).toBe(true);
  });

  it('蝴蝶阶段：扇动两下（开→收→开→收→开）', () => {
    const anim = makeAnim();
    // 扇动窗口 [2500, 3900]：f=0 开、f=0.25 收、f=0.5 开、f=0.75 收、f=1 开
    const open1 = wingExtent(anim.pixelSnapshot(2500));
    const closed1 = wingExtent(anim.pixelSnapshot(2850));
    const open2 = wingExtent(anim.pixelSnapshot(3200));
    const closed2 = wingExtent(anim.pixelSnapshot(3550));
    const open3 = wingExtent(anim.pixelSnapshot(3899));
    expect(closed1).toBeLessThan(open1 * 0.6);
    expect(open2).toBeGreaterThan(closed1 * 2);
    expect(closed2).toBeLessThan(open2 * 0.6);
    expect(open3).toBeGreaterThan(closed2 * 2);
    // 收势阶段（3900 后）翅膀保持全开
    const settled = wingExtent(anim.pixelSnapshot(4100));
    expect(settled).toBeGreaterThan(closed2 * 2);
  });

  it('艺术字阶段：纵向三层色（蓝/绿/紫）同时出现', () => {
    const anim = makeAnim();
    const pixels = anim.pixelSnapshot(5900); // hold 静止 + 脉动
    const colors = new Set(pixels.values());
    // 蓝 33/39、绿 46/48、紫 135/141（hold 脉动在同层两档间切换）
    const blue = [...colors].some((c) => c === 33 || c === 39);
    const green = [...colors].some((c) => c === 46 || c === 48);
    const purple = [...colors].some((c) => c === 135 || c === 141);
    expect(blue).toBe(true);
    expect(green).toBe(true);
    expect(purple).toBe(true);
  });

  it('三层色纵向分布：蓝在上、紫在下', () => {
    const anim = makeAnim();
    const pixels = anim.pixelSnapshot(5401); // hold 刚开始，静止
    const blueRows: number[] = [];
    const purpleRows: number[] = [];
    for (const [key, color] of pixels) {
      const y = Math.floor(key / COLS);
      if (color === 33) blueRows.push(y);
      if (color === 135) purpleRows.push(y);
    }
    expect(blueRows.length).toBeGreaterThan(0);
    expect(purpleRows.length).toBeGreaterThan(0);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(blueRows)).toBeLessThan(avg(purpleRows));
  });

  it('hold 静止：两帧像素几何相同（仅颜色脉动）', () => {
    const anim = makeAnim();
    const keysA = [...anim.pixelSnapshot(5500).keys()].sort((a, b) => a - b);
    const keysB = [...anim.pixelSnapshot(6000).keys()].sort((a, b) => a - b);
    expect(keysB).toEqual(keysA);
  });

  it('终端过小不播放（bootSupported 门控）', () => {
    expect(bootSupported(39, 24)).toBe(false);
    expect(bootSupported(40, 11)).toBe(false);
    expect(bootSupported(40, 12)).toBe(true);
    expect(bootSupported(80, 24)).toBe(true);
    const tiny = new BootAnimation({ cols: 30, rows: 8 });
    expect(tiny.pixelSnapshot(1000).size).toBe(0);
    expect(tiny.isDone(0)).toBe(true);
  });

  it('--no-boot 解析', () => {
    const args = parseArgs(['--no-boot']);
    expect(args.noBoot).toBe(true);
    expect(parseArgs([]).noBoot).toBe(false);
  });
});
