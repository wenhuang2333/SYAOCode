import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@syaocode/core';
import { setLanguage } from '../src/i18n/index';
import { PhaseTracker, activityText, phaseLine } from '../src/tui/phase';
import {
  FLAP_CYCLE_MS,
  SCENE_BUTTERFLY_SCALE,
  drawSideButterfly,
  flightScenePixels,
  flapScale,
  skylinePixels,
  skylineStripHeight,
  spinnerFrame,
  type Canvas,
} from '../src/tui/flight';

function ev(e: AgentEvent): AgentEvent {
  return e;
}

describe('flight：欢迎面板飞行场景', () => {
  it('天际线是较高的底部带：冷色、随时间向左滚动', () => {
    const W = 40;
    const H = 26;
    const a = skylinePixels(W, H, 0);
    const b = skylinePixels(W, H, 1000);
    expect(a.size).toBeGreaterThan(10);
    expect(b.size).toBeGreaterThan(10);
    let diff = 0;
    for (const [k, v] of a) if (b.get(k) !== v) diff += 1;
    expect(diff).toBeGreaterThan(5);
    const cool = new Set([17, 25, 33, 39, 45, 51, 87]);
    expect([...a.values()].every((c) => cool.has(c))).toBe(true);
    // 带高 6~12 像素（比上一版更高更明显）
    const stripH = skylineStripHeight(H);
    expect(stripH).toBeGreaterThanOrEqual(6);
    expect(stripH).toBeLessThanOrEqual(12);
    for (const k of a.keys()) expect(Math.floor(k / W)).toBeGreaterThanOrEqual(H - stripH);
  });

  it('场景当前不含蝴蝶（按要求暂时关闭，代码保留备用）', () => {
    const W = 40;
    const H = 26;
    const scene = flightScenePixels(W, H, 0);
    const colors = new Set([...scene.values()]);
    // 蝶身专用色（蓝亮/紫亮+深/绿亮+深）不应出现；25 与天际线强调色冲突，不参与判断
    for (const c of [75, 177, 91, 84, 28]) expect(colors.has(c), `unexpected ${c}`).toBe(false);
  });

  it('备用侧视蝴蝶：蓝/紫/绿三层、尺寸 ≤ 16×10', () => {
    const canvas: Canvas = { w: 30, h: 18, map: new Map() };
    drawSideButterfly(canvas, 5, 3, SCENE_BUTTERFLY_SCALE, 0);
    const colors = new Set([...canvas.map.values()]);
    for (const c of [75, 25, 177, 91, 84, 28]) expect(colors.has(c), `missing ${c}`).toBe(true);
    let minX = 30;
    let maxX = 0;
    let minY = 18;
    let maxY = 0;
    for (const k of canvas.map.keys()) {
      const x = k % 30;
      const y = Math.floor(k / 30);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    expect(maxX - minX + 1).toBeLessThanOrEqual(Math.ceil(20 * SCENE_BUTTERFLY_SCALE) + 1);
    expect(maxY - minY + 1).toBeLessThanOrEqual(Math.ceil(12 * SCENE_BUTTERFLY_SCALE) + 1);
  });

  it('右上角是满月（完整圆盘，非弯月）', () => {
    const W = 40;
    const H = 26;
    const scene = flightScenePixels(W, H, 0, true);
    let moon = 0;
    for (const [k, v] of scene) {
      if (v !== 230) continue;
      const x = k % W;
      const y = Math.floor(k / W);
      if (x >= W - 10 && y <= 8) moon += 1;
    }
    // 半径 3 的圆盘约 29 像素（减去 3 处月海）——弯月只会有 ~15
    expect(moon).toBeGreaterThanOrEqual(24);
  });

  it('frozen 时场景完全静止', () => {
    expect(flightScenePixels(40, 26, 123, true)).toEqual(flightScenePixels(40, 26, 999, true));
  });
});

describe('flight：阶段行旋转字符（Claude Code 风格）', () => {
  it('按 120ms 换帧循环，单宽字符', () => {
    const frames = new Set<string>();
    for (let t = 0; t < 720; t += 120) frames.add(spinnerFrame(t));
    expect(frames.size).toBe(6);
    for (const f of frames) expect([...f]).toHaveLength(1);
    expect(spinnerFrame(0)).toBe('·');
    expect(spinnerFrame(120)).toBe('✢');
  });

  it('ASCII 终端降级为单宽 ASCII 帧', () => {
    expect(spinnerFrame(0, true)).toBe('.');
    expect(spinnerFrame(120, true)).toBe('o');
  });

  it('flapScale 周期与范围', () => {
    for (let t = 0; t < FLAP_CYCLE_MS; t += 100) {
      const v = flapScale(t);
      expect(v).toBeGreaterThanOrEqual(0.32);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(flapScale(0)).toBeCloseTo(1, 5);
  });
});

describe('PhaseTracker：Explore → Plan → Implement → Validate & Cleanup', () => {
  beforeEach(() => setLanguage('en'));
  afterEach(() => setLanguage('en'));

  it('起始探查；工具后输出文字进入规划；写文件进入实施；随后执行进入验证', () => {
    const tr = new PhaseTracker();
    tr.start();
    expect(tr.snapshot()).toMatchObject({ phase: 'explore', activity: { kind: 'thinking' }, networkError: false });

    tr.onEvent(ev({ type: 'tool.start', callId: 'c1', name: 'read', input: { path: 'src/a.ts' } }));
    expect(tr.snapshot().phase).toBe('explore');
    expect(activityText(tr.snapshot().activity)).toBe('reading src/a.ts');

    tr.onEvent(ev({ type: 'text.delta', text: 'plan' }));
    expect(tr.snapshot().phase).toBe('plan');

    tr.onEvent(ev({ type: 'tool.start', callId: 'c2', name: 'write', input: { path: 'out.txt' } }));
    expect(tr.snapshot().phase).toBe('implement');
    expect(activityText(tr.snapshot().activity)).toBe('writing out.txt');

    tr.onEvent(ev({ type: 'tool.start', callId: 'c3', name: 'bash', input: { command: 'g++ x.cpp' } }));
    expect(tr.snapshot().phase).toBe('validate');
    expect(activityText(tr.snapshot().activity)).toBe('running g++ x.cpp');
  });

  it('网络重试 → 红色状态；成功事件清除', () => {
    const tr = new PhaseTracker();
    tr.start();
    tr.onRetry({ attempt: 2, code: 'SY-PRV-003', delayMs: 3200 });
    expect(tr.snapshot().networkError).toBe(true);
    expect(activityText(tr.snapshot().activity)).toContain('retrying');
    expect(activityText(tr.snapshot().activity)).toContain('2');
    tr.onEvent(ev({ type: 'text.delta', text: 'back' }));
    expect(tr.snapshot().networkError).toBe(false);
    tr.onEvent(ev({ type: 'error', error: { code: 'SY-PRV-003', category: 'provider', severity: 'error', retryable: true, recovery: 'retry', message: 'down' }, fatal: false }));
    expect(tr.snapshot().networkError).toBe(true);
  });

  it('中文阶段与活动文案（单行）', () => {
    setLanguage('zh');
    const tr = new PhaseTracker();
    tr.start();
    tr.onEvent(ev({ type: 'tool.start', callId: 'c1', name: 'write', input: { path: 'a.cpp' } }));
    const line = phaseLine(tr.snapshot(), 0, 80);
    expect(line).toContain('实施');
    expect(line).toContain('写入 a.cpp');
    expect(line).toContain('\x1b[38;5;33m'); // 正常蓝色文字
    expect(line).not.toContain('\n');
  });

  it('阶段行：正常蓝色、异常红色；单行且含旋转字符', () => {
    const ok = phaseLine({ phase: 'implement', activity: { kind: 'responding' }, networkError: false }, 0, 80);
    expect(ok).toContain('\x1b[38;5;33m'); // 蓝字
    expect(ok).toContain('Implement');
    expect(ok).toContain('·'); // 旋转字符
    expect(ok).not.toContain('\n');
    const bad = phaseLine({ phase: 'implement', activity: { kind: 'retry', attempt: 1, seconds: 2 }, networkError: true }, 0, 80);
    expect(bad).toContain('\x1b[38;5;196m'); // 红字
    expect(bad).toContain('retrying');
    expect(bad).not.toContain('230m');
  });
});
