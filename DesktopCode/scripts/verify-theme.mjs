/**
 * 主题验证（FR-N-037）：在真实 Chromium 里渲染两套主题，量 WCAG 对比度。
 *
 * 为什么必须实测：对比度是算出来的，不是断言出来的。单元测试能证明
 * "深色令牌一份不少"，但证明不了"深色下正文真的看得清"。
 *
 * 用法：
 *   node scripts/verify-theme.mjs
 *   LIWEN_PLAYWRIGHT=... LIWEN_CHROMIUM=... node scripts/verify-theme.mjs
 *
 * 没装 Playwright / 起不了浏览器时跳过并以 0 退出，且绝不打印通过。
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PW = process.env['LIWEN_PLAYWRIGHT'] ?? 'playwright';
const EXE = process.env['LIWEN_CHROMIUM'];
const OUT = path.join(os.tmpdir(), `liwen-theme-${Date.now().toString(36)}`);
mkdirSync(OUT, { recursive: true });

const css = [
  `${ROOT}/packages/ui/src/styles.css`,
  `${ROOT}/apps/desktop/src/renderer/theme-tokens.css`,
  `${ROOT}/apps/desktop/src/renderer/workbench.css`,
  `${ROOT}/apps/desktop/src/renderer/dashboard.css`,
]
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');

/** 一份覆盖真实类名的静态页面，不含任何交互逻辑。 */
const page = (dark) => `<!doctype html><html lang="zh-CN"${dark ? ' data-theme="dark"' : ''}>
<head><meta charset="utf-8"><style>${css}</style></head>
<body><div class="workbench-app">
  <aside class="sidebar">
    <div class="brand-block"><span class="brand-symbol"></span><div><strong>LIWENCode</strong><small>DESKTOP</small></div></div>
    <button class="new-session">新会话</button>
    <div class="session-search"><input placeholder="搜索会话" /></div>
    <nav><button class="nav-item active">会话</button><button class="nav-item">用量</button></nav>
    <div class="project-tree"><div class="project"><div class="project-line selected"><button class="project-name"><span>项目</span></button></div></div></div>
    <div class="account-summary"><div class="today-summary"><span>今日</span><strong>$0.00</strong></div></div>
    <footer class="sidebar-footer"><span class="local-avatar">S</span><div><strong>本机</strong><small><i class="state-dot green"></i>就绪</small></div></footer>
  </aside>
  <div class="main-shell">
    <header class="workbench-topbar"><div class="breadcrumb"><strong>会话标题</strong></div>
      <div class="topbar-actions"><button aria-label="外观">theme</button></div></header>
    <div class="workspace-body">
      <main class="main-content chat-content"><div class="conversation"><div class="conversation-scroll">
        <div class="msg msg-assistant"><div class="role">LIWENCode</div><div class="content">助手正文，用于检查正文对比度。</div></div>
        <div class="tool"><span>bash</span><pre class="tool-input">echo hi</pre></div>
      </div>
      <div class="composer-shell">
        <div class="composer"><textarea placeholder="输入"></textarea></div>
        <div class="composer-toolbar"><div class="composer-options"><select><option>标准权限</option></select></div>
          <button class="btn btn-primary">发送</button></div>
      </div>
      <div class="composer-shell-hint" role="status">! 直接执行命令</div>
      <div class="composer-footnote"><span>提示</span></div>
      </div></main>
      <aside class="detail-panel">
        <div class="detail-title"><span>会话详情</span><button aria-label="关闭">×</button></div>
        <div class="detail-scroll">
          <section class="detail-section"><summary>改动</summary>
            <ul class="change-list"><li class="change-row-item">
              <button class="change-row-button"><span class="change-status change-status-modified">M</span>
                <span class="change-path">src/a.ts</span>
                <span class="change-stat"><span class="change-stat-add">+12</span> <span class="change-stat-del">-3</span></span>
              </button></li></ul></section>
        </div></aside>
    </div>
  </div>
</div>
<div class="shell-lines"><div class="shell-line">
  <span class="shell-line-tag">本地命令</span>
  <pre class="shell-line-command">$ echo hi</pre>
  <pre class="shell-line-output">hi</pre>
</div></div>
</body></html>`;

/** 需要达标的样点：覆盖正文、次要文字、状态色、按钮、命令块。 */
const SAMPLES = [
  '.msg-assistant .content', '.detail-title span', '.change-path', '.composer-shell textarea',
  '.nav-item.active', '.shell-line-tag', '.composer-shell-hint', '.brand-block strong',
  '.change-stat-add', '.change-stat-del', '.tool span', '.detail-section summary',
  '.today-summary', '.btn-primary',
];

const parseColor = (text) => {
  const m = /rgba?\(([^)]+)\)/.exec(text);
  if (!m) return null;
  const [r, g, b, a = 1] = m[1].split(',').map((v) => Number.parseFloat(v));
  return { r, g, b, a };
};
const over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
});
const luminance = (c) => {
  const f = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const contrast = (fg, bg) => {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
};

let chromium;
try {
  ({ chromium } = await import(PW));
} catch {
  console.log('SKIP: playwright not installed. Set LIWEN_PLAYWRIGHT to its index.mjs to run this check.');
  process.exit(0);
}
const browser = await chromium.launch(EXE === undefined ? {} : { executablePath: EXE }).catch((error) => {
  console.log(`SKIP: cannot launch chromium (${error.message.split('\n')[0]}). Set LIWEN_CHROMIUM to a browser binary.`);
  process.exit(0);
});

let failures = 0;
for (const dark of [false, true]) {
  const label = dark ? 'dark ' : 'light';
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const html = page(dark);
  await tab.setContent(html, { waitUntil: 'load' });
  writeFileSync(`${OUT}/${dark ? 'dark' : 'light'}.html`, html);
  await tab.screenshot({ path: `${OUT}/${dark ? 'dark' : 'light'}.png` });

  const measured = await tab.evaluate((selectors) => {
    const out = [];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const cs = getComputedStyle(el);
      // 向上找第一个不透明背景，模拟真实观感。
      let bg = cs.backgroundColor;
      let node = el;
      while ((bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') && node.parentElement) {
        node = node.parentElement;
        bg = getComputedStyle(node).backgroundColor;
      }
      out.push({ sel, color: cs.color, bg, size: Number.parseFloat(cs.fontSize), weight: cs.fontWeight });
    }
    return out;
  }, SAMPLES);

  for (const row of measured) {
    const fg0 = parseColor(row.color);
    const bg0 = parseColor(row.bg);
    if (!fg0 || !bg0) continue;
    const bg = bg0.a < 1 ? over(bg0, { r: 255, g: 255, b: 255, a: 1 }) : bg0;
    const fg = fg0.a < 1 ? over(fg0, bg) : fg0;
    const ratio = contrast(fg, bg);
    // WCAG AA：大字 3:1，正文 4.5:1。
    const large = row.size >= 18.66 || (row.size >= 14 && Number(row.weight) >= 700);
    const need = large ? 3 : 4.5;
    const ok = ratio >= need;
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label} ${ratio.toFixed(2).padStart(5)} (need ${need}) ${row.sel}`);
  }
  await tab.close();
}
await browser.close();

console.log(`\nscreenshots: ${OUT}`);
console.log(failures === 0 ? 'THEME: OK (both themes meet WCAG AA)' : `THEME: ${failures} sample(s) below AA`);
process.exit(failures === 0 ? 0 : 1);
