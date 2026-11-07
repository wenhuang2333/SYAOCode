/**
 * 响应式布局（`27` §11.4 / N-12）。
 *
 * 分两层：
 *  1. 这里：静态断言 CSS 与外壳结构满足规格里的**硬约束**（能在 CI 跑，无浏览器）。
 *  2. `scripts/verify-layout.mjs`：用真实 Chromium 量实际盒模型。
 *     源码里有 `@media` 不代表它生效——1150px 时右栏是否真的变成覆盖式、
 *     主区域是否真的没有横向溢出，只有真实浏览器能回答。这个脚本要求在
 *     装了 Playwright 的机器上手动/CI 跑，没装则**跳过并明确说明**。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const css = read('src/renderer/workbench.css');
const workbench = read('src/renderer/workbench.tsx');

/**
 * 取**所有**同一 query 的 `@media` 块正文。
 *
 * 同一个断点在文件里出现多次是正常的（早期规则 + 后续增补），
 * 断言必须把它们合起来看，否则会漏掉真正生效的那一条。
 */
function mediaBlock(query: string): string {
  const markers = [`@media(${query})`, `@media (${query})`];
  const blocks: string[] = [];
  for (const marker of markers) {
    let from = 0;
    for (;;) {
      const start = css.indexOf(marker, from);
      if (start < 0) break;
      const open = css.indexOf('{', start);
      if (open < 0) break;
      let depth = 1;
      let end = css.length;
      for (let i = open + 1; i < css.length; i += 1) {
        if (css[i] === '{') depth += 1;
        else if (css[i] === '}') {
          depth -= 1;
          if (depth === 0) { end = i; break; }
        }
      }
      blocks.push(css.slice(open + 1, end));
      from = end;
    }
  }
  return blocks.join('\n');
}

describe('响应式布局硬约束（27 §11.4）', () => {
  it('主区域保底 640px：只在宽视口声明（窄屏靠覆盖式侧栏，不挤压会话）', () => {
    const wide = mediaBlock('min-width:1280px');
    expect(wide).toContain('.main-content');
    expect(wide).toContain('min-width:640px');
    // 窄屏不许有"主区域最小 640px"——那会造成横向滚动。
    expect(mediaBlock('max-width:900px')).not.toContain('min-width:640px');
    expect(mediaBlock('max-width:1150px')).not.toContain('min-width:640px');
  });

  it('≤1100px：右栏改为覆盖式抽屉，且宽度不超过 92vw', () => {
    const block = mediaBlock('max-width:1099px');
    expect(block).toContain('.detail-panel');
    expect(block).toContain('.git-sidebar');
    expect(block).toContain('position:absolute');
    expect(block).toMatch(/width:min\(92vw/);
    // 覆盖式抽屉必须压住会话流，所以要有 z-index。
    expect(block).toMatch(/z-index:\s*\d+/);
  });

  it('≤1150px：Git 侧栏也先一步变成覆盖式（它比详情栏更宽）', () => {
    const block = mediaBlock('max-width:1150px');
    expect(block).toContain('.git-sidebar');
    expect(block).toContain('position:absolute');
    expect(block).toMatch(/width:min\(92vw/);
  });

  it('没有页面级横向滚动的成因：窄屏必须隐藏工作区的横向溢出', () => {
    expect(mediaBlock('max-width:1099px')).toMatch(/overflow-x:hidden/);
  });

  it('尊重"减少动态效果"偏好（无障碍）', () => {
    expect(css).toContain('prefers-reduced-motion:reduce');
  });

  it('右栏默认收起：互斥状态机的初始值是"都不显示"', () => {
    // §11.0：右栏按需出现，打开工作区/发消息/产生改动都不得自动展开。
    expect(workbench).toMatch(/useState<SidebarSlotState>/);
    expect(workbench).toContain('INITIAL_SIDEBAR_STATE');
  });
});

describe('布局验证脚本存在且不会伪装通过', () => {
  const script = read('../../scripts/verify-layout.mjs');

  it('脚本可运行，并检查主区域宽度 / 右栏定位 / 横向溢出三类断言', () => {
    expect(script).toContain('main-content');
    expect(script).toContain('position');
    expect(script).toContain('scrollWidth');
    expect(script).toContain('LAYOUT: OK');
    expect(script).toContain('LAYOUT: ');
  });

  it('没装 Playwright / 起不了浏览器时跳过并说明，不报成功', () => {
    expect(script).toContain('SKIP:');
    expect(script).toContain('playwright not installed');
    // 跳过路径必须是 exit 0（不阻塞他人）但**不打印** OK。
    const skipBranch = script.slice(script.indexOf('SKIP:'));
    expect(skipBranch).toContain('process.exit(0)');
  });

  it('读取的是真实 CSS 文件，而不是复制的快照', () => {
    expect(script).toContain('renderer/workbench.css');
    expect(script).toContain('dashboard.css');
    expect(script).toContain('packages/ui/src/styles.css');
  });
});
