import { describe, expect, it } from 'vitest';
import { FLAP_CYCLE_MS, artPixels, miniPoints, renderPanel, welcomeSupported } from '../src/tui/welcome';

const INFO = { version: 'v0.1.0', model: 'mock:default', tier: 'strict' };
const COLS = 100;
const PANEL_H = 20;

describe('tui/welcome 欢迎面板', () => {
  it('miniPoints：SYAOCode 点阵边界与宽度', () => {
    const { points, width } = miniPoints('SYAOCode', 0);
    expect(points.length).toBeGreaterThan(50);
    for (const p of points) {
      expect(p.row).toBeGreaterThanOrEqual(0);
      expect(p.row).toBeLessThan(5);
      expect(p.col).toBeLessThan(width);
    }
    // 紧凑排布 32 列（S4 Y5 A4 O4 C4 o4 d4 e3 = 32）
    expect(width).toBe(32);
  });

  it('artPixels：黑白阴影（主题色主字 + 阴影）且横向铺满宽度', () => {
    const W = 80;
    const theme = { main: 255, shadow: 234 };
    const px = artPixels(W, 'SYAOCode', theme);
    const colors = new Set(px.values());
    expect(colors.has(theme.main)).toBe(true); // 主字
    expect(colors.has(theme.shadow)).toBe(true); // 阴影
    expect(colors.size).toBe(2); // 纯黑白灰，无彩色
    // 铺满：最左 6 列与最右 6 列内均有像素
    let minCol = W;
    let maxCol = 0;
    for (const key of px.keys()) {
      const c = key % W;
      if (c < minCol) minCol = c;
      if (c > maxCol) maxCol = c;
    }
    expect(minCol).toBeLessThanOrEqual(6);
    expect(maxCol).toBeGreaterThanOrEqual(W - 7);
  });

  it('renderPanel：结构、等宽、纯英文', () => {
    const lines = renderPanel(COLS, PANEL_H, 1000, INFO);
    expect(lines.length).toBe(PANEL_H);
    expect(lines[0]!.startsWith('╭')).toBe(true);
    expect(lines[lines.length - 1]!.startsWith('╰')).toBe(true);
    // 每行去掉 ANSI 后显示宽度一致（= panelW）
    const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const w0 = plain[0]!.length;
    for (const l of plain) expect(l.length).toBe(w0);
    // 英文欢迎语与提示
    const joined = plain.join('\n');
    expect(joined).toContain('Welcome to SYAOCode');
    expect(joined).toContain('mock:default');
    expect(joined).toContain('/help');
    expect(joined).toContain('Type / for command palette');
    // 全英文：无 CJK 字符（右侧文本区）
    expect(joined.match(/[\u4e00-\u9fff]/)).toBeNull();
    // 无中缝：内容行的首尾 │ 之外不再出现竖线
    for (let i = 1; i < plain.length - 1; i++) {
      const row = plain[i]!;
      expect(row.slice(1, -1).includes('│')).toBe(false);
    }
    // 艺术字铺满底部：底部 6 个内容行的左右两端 8 列内均有像素
    const artRows = plain.slice(plain.length - 7, plain.length - 1);
    expect(artRows.length).toBe(6);
    for (const row of artRows) {
      expect(row.slice(1, 9).match(/[▀▄]/)).not.toBeNull();
      expect(row.slice(-9, -1).match(/[▀▄]/)).not.toBeNull();
    }
  });

  it('renderPanel：飞行场景随时间变化（天际线滚动/蝴蝶划翅）', () => {
    const a = renderPanel(COLS, PANEL_H, 0, INFO).join('');
    const b = renderPanel(COLS, PANEL_H, Math.floor(FLAP_CYCLE_MS / 3), INFO).join('');
    expect(a).not.toBe(b);
  });

  it('frozen：任意时刻渲染完全一致（首键冻结，场景静止）', () => {
    const a = renderPanel(COLS, PANEL_H, 0, INFO, true);
    const b = renderPanel(COLS, PANEL_H, Math.floor(FLAP_CYCLE_MS * 0.37), INFO, true);
    expect(a.join('')).toBe(b.join(''));
  });

  it('终端过小返回空（调用方回退旧横幅）', () => {
    expect(welcomeSupported(63, 30)).toBe(false);
    expect(welcomeSupported(64, 19)).toBe(false);
    expect(welcomeSupported(64, 20)).toBe(true);
    expect(renderPanel(60, 20, 0, INFO)).toEqual([]);
  });
});
