/**
 * 布局验证（N-12）：用真实 Chromium 加载**真实 CSS**与等价结构，在多个视口下
 * 量主区域宽度、右栏定位与横向溢出。
 *
 * 为什么需要它：单元测试只能断言 CSS 源码里有某条 `@media`，无法证明
 * "1150px 时右栏真的变成覆盖式且主区域没有横向溢出"。N-12 就是这么挂着的。
 *
 * 用法：
 *   node scripts/verify-layout.mjs
 *   SYAO_PLAYWRIGHT=/path/to/playwright/index.mjs SYAO_CHROMIUM=/path/to/chrome node scripts/verify-layout.mjs
 *
 * 没装 Playwright 时**跳过并以 0 退出**（不伪装成通过，也不阻塞其它人）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 这两个位置取决于本机怎么装的 Playwright；用环境变量覆盖，没装就明确跳过。
 * 刻意**不加进 package.json**：Playwright 只有渲染布局验证需要，
 * 不该让每个装依赖的人都下载一份浏览器。
 */
const PW = process.env['SYAO_PLAYWRIGHT'] ?? 'playwright';
const EXE = process.env['SYAO_CHROMIUM'];

const css = [
  `${ROOT}/packages/ui/src/styles.css`,
  `${ROOT}/apps/desktop/src/renderer/dashboard.css`,
  `${ROOT}/apps/desktop/src/renderer/workbench.css`,
].map((p) => readFileSync(p, 'utf8')).join('\n');

const shell = (rightRail) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${css}</style></head>
<body><div class="workbench-app">
  <aside class="sidebar"><div class="brand-block"><span class="brand-symbol"></span><div><strong>LIWENCode</strong><small>DESKTOP</small></div></div>
    <button class="new-session">新会话</button><div class="session-search"><input placeholder="搜索会话" /></div>
    <nav><button class="nav-item active">会话</button><button class="nav-item">用量</button><button class="nav-item">设置</button></nav>
    <div class="project-tree"><div class="project"><div class="project-line selected"><button class="project-name"><span>项目</span></button></div></div></div>
    <div class="account-summary"><div class="today-summary"><span>今日</span><strong>$0.00</strong></div><div class="channel-cards"></div></div>
    <footer class="sidebar-footer"><span class="local-avatar">S</span><div><strong>本机</strong><small><i class="state-dot green"></i>就绪</small></div></footer>
  </aside>
  <div class="main-shell">
    <header class="workbench-topbar"><div class="breadcrumb"><strong>会话标题</strong></div><div class="topbar-actions"><button aria-label="Git">git</button><button aria-label="详情">i</button></div></header>
    <div class="workspace-body">
      <main class="main-content chat-content"><div class="conversation"><div class="conversation-scroll"><div class="welcome"><h1>开始构建</h1><p>说明文字</p></div></div>
        <div class="composer-shell"><div class="composer"><textarea placeholder="输入"></textarea></div><div class="composer-toolbar"><div class="composer-options"><select><option>标准权限</option></select></div></div></div>
        <div class="composer-footnote"><span>提示</span><span>Enter 发送</span></div>
      </div></main>
      ${rightRail}
    </div>
  </div>
</div></body></html>`;

const detailRail = `<aside class="detail-panel"><div class="detail-title"><span>会话详情</span><button aria-label="关闭">×</button></div>
  <div class="detail-scroll"><section class="detail-section"><summary>改动</summary><ul class="change-list"><li class="change-row-item"><button class="change-row-button" aria-expanded="false"><span class="change-status change-status-modified">M</span><span class="change-path">src/a.ts</span><span class="change-stat"><span class="change-stat-add">+12</span> <span class="change-stat-del">-3</span></span></button></li></ul></section></div></aside>`;

const gitRail = `<aside class="git-sidebar"><div class="git-sidebar-head"><div class="git-branch"><strong>main</strong></div><button aria-label="关闭">×</button></div>
  <div class="git-tabs" role="tablist"><button role="tab" class="selected">变更</button><button role="tab">提交图</button><button role="tab">分支</button><button role="tab">上传</button></div>
  <div class="git-tab-body"><ul class="git-file-list"><li class="git-file-row"><span class="change-path">src/a.ts</span><button class="git-file-action">暂存</button></li></ul></div></aside>`;

let chromium;
try {
  ({ chromium } = await import(PW));
} catch {
  console.log('SKIP: playwright not installed. Set SYAO_PLAYWRIGHT to its index.mjs to run this check.');
  process.exit(0);
}
const browser = await chromium.launch(EXE === undefined ? {} : { executablePath: EXE }).catch((error) => {
  console.log(`SKIP: cannot launch chromium (${error.message.split('\n')[0]}). Set SYAO_CHROMIUM to a browser binary.`);
  process.exit(0);
});
const results = [];
for (const rail of [['none', ''], ['detail', detailRail], ['git', gitRail]]) {
  for (const width of [1600, 1440, 1280, 1150, 1100, 1024, 900, 760]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.setContent(shell(rail[1]), { waitUntil: 'load' });
    const m = await page.evaluate(() => {
      const pick = (sel) => document.querySelector(sel);
      const rect = (sel) => { const el = pick(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) }; };
      const style = (sel, prop) => { const el = pick(sel); return el ? getComputedStyle(el)[prop] : null; };
      return {
        docScrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
        sidebar: rect('.sidebar'),
        main: rect('.main-content'),
        rail: rect('.detail-panel') ?? rect('.git-sidebar'),
        railPos: style('.detail-panel', 'position') ?? style('.git-sidebar', 'position'),
        composerW: rect('.composer-shell')?.w ?? null,
      };
    });
    results.push({ railName: String(rail[0]), width, ...m });
    await page.close();
  }
}
await browser.close();

let failures = 0;
const fail = (msg) => { failures += 1; console.log('  FAIL ' + msg); };
for (const r of results) {
  const overflow = r.docScrollW > r.clientW + 1;
  console.log(`${String(r.width).padStart(4)} rail=${r.railName.padEnd(6)} main=${String(r.main?.w ?? 0).padStart(4)} sidebar=${String(r.sidebar?.w ?? 0).padStart(3)} rail=${String(r.rail?.w ?? 0).padStart(3)} pos=${String(r.railPos).padEnd(8)} composer=${String(r.composerW ?? 0).padStart(4)} overflow=${overflow}`);
  if (overflow) fail(`${r.width}/${r.railName}: horizontal overflow (${r.docScrollW} > ${r.clientW})`);
  // §11.0 主区域最小 640px（窄屏侧栏改覆盖式，不得挤压主区域）
  if (r.railName !== 'none' && r.width >= 1280 && (r.main?.w ?? 0) < 640) fail(`${r.width}/${r.railName}: main ${r.main?.w} < 640`);
  if (r.railName !== 'none' && r.width <= 1100 && r.railPos !== 'absolute') fail(`${r.width}/${r.railName}: rail should be overlay (position=${r.railPos})`);
  if (r.railName !== 'none' && r.width >= 1280 && r.railPos !== 'static') fail(`${r.width}/${r.railName}: rail should be in-flow at wide viewports`);
}
console.log(failures === 0 ? '\nLAYOUT: OK (no failures)' : `\nLAYOUT: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
