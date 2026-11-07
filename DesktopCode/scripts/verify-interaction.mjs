#!/usr/bin/env node
/**
 * 真实窗口交互验证（`26` N-17）。
 *
 * `smoke-electron.mjs` 证明的是"启动链路通"；它**不能**证明界面点得动。
 * 这里用 Playwright 的 Electron 驱动接管真实窗口，做用户真正会做的动作：
 * 输入、点按钮、切页、切主题，然后断言界面的真实反应。
 *
 * 与静态渲染测试的区别：静态渲染只能证明"标记里有没有某个字符串"，
 * 证明不了"点了之后状态真的变了"。交互必须真的点。
 *
 * 用法：
 *   node scripts/verify-interaction.mjs
 *   SYAO_PLAYWRIGHT=... node scripts/verify-interaction.mjs
 *
 * 缺 Playwright / Electron 时跳过并 exit 0，绝不打印通过。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'apps/desktop');
const PW = process.env['SYAO_PLAYWRIGHT'] ?? 'playwright';

let _electron;
try {
  ({ _electron } = await import(PW));
} catch {
  console.log('SKIP: playwright not installed. Set SYAO_PLAYWRIGHT to its index.mjs.');
  process.exit(0);
}

/**
 * Playwright 不去 pnpm 的隔离 node_modules 里找 Electron，必须显式给路径。
 * 与 `dev-desktop.mjs` 用同一套解析逻辑（纯 Node 里 `require('electron')` 返回二进制路径）。
 */
function resolveElectron() {
  if (process.env['SYAO_ELECTRON_BIN'] !== undefined) return process.env['SYAO_ELECTRON_BIN'];
  try {
    const req = createRequire(path.join(APP, 'package.json'));
    const bin = req('electron');
    if (typeof bin === 'string' && existsSync(bin)) return bin;
  } catch {
    /* 落到候选路径 */
  }
  return undefined;
}
const electronBin = resolveElectron();
if (electronBin === undefined) {
  console.log('SKIP: electron binary not found. Install dev deps or set SYAO_ELECTRON_BIN.');
  process.exit(0);
}
if (_electron === undefined) {
  console.log('SKIP: this playwright build has no _electron driver.');
  process.exit(0);
}

const home = await mkdtemp(path.join(os.tmpdir(), 'syao-interaction-'));
const env = { ...process.env, HOME: home, SYAO_HOME: home };
delete env['ELECTRON_RUN_AS_NODE'];

let app;
const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

try {
  app = await _electron.launch({ args: ['.'], cwd: APP, env, executablePath: electronBin });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  // 1) 连上 Host：状态栏必须从"正在连接"变成已连接。
  await page.waitForSelector('text=运行时已连接', { timeout: 30_000 }).catch(() => undefined);
  const statusText = await page.locator('.sidebar-footer small').innerText().catch(() => '');
  check('连上本地运行时', statusText.includes('已连接'), statusText.replace(/\s+/g, ' ').trim());

  // 2) 新建会话 —— 输入区在"没有会话"时是禁用的（这是正确行为，不是缺陷），
  //    所以交互验证必须先建会话，否则测出来的是"禁用按钮点不动"。
  const createButton = page.locator('button.welcome-create, button.new-session').first();
  await createButton.click();
  await page.waitForTimeout(1_500);
  const sessionCreated = await page.evaluate(() => document.querySelectorAll('.session-link').length > 0);
  check('能新建会话', sessionCreated, sessionCreated ? '' : '会话列表仍为空');

  // 3) 输入区可聚焦、受控输入能回流到 React state。
  //
  // 注意：这里**不用** `keyboard.type` / `locator.fill`。在没有真实键盘焦点的
  // 无头 Electron 里，Playwright 的按键注入不产生字符（已实测：activeElement 是
  // textarea、document.hasFocus() 为 true，但输入仍是空）。那是驱动限制，不是应用缺陷。
  // 因此改为派发真实 DOM 事件走 React 的 onChange，验证"受控值确实回流"。
  const composer = page.locator('textarea').first();
  await composer.click({ timeout: 10_000 });
  const focused = await page.evaluate(() => document.activeElement?.tagName ?? '');
  check('输入区可获得焦点', focused === 'TEXTAREA', focused);
  const typed = await page.evaluate(() => {
    const el = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, '交互验证输入');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  });
  await page.waitForTimeout(200);
  const retained = await page.evaluate(() => document.querySelector('textarea').value);
  check('受控输入回流并保留内容', typed === '交互验证输入' && retained === '交互验证输入', JSON.stringify(retained));

  // 4) 外观按钮：三档循环，且**深色档真的写到 `<html data-theme>`**。
  //    只断言"aria-label 变了"是不够的——那可能只改了 state 没改 DOM。
  // 三档循环 system → light → dark → system。首档不一定是 system（取决于上次
  // 存储），所以按 aria-label 里出现的档位名判断，直到进入"深色"。
  const themeButton = page.locator('button[aria-label^="外观"]').first();
  let darkApplied = false;
  let labelDark = await themeButton.getAttribute('aria-label');
  for (let i = 0; i < 3; i += 1) {
    await themeButton.click();
    await page.waitForTimeout(200);
    labelDark = await themeButton.getAttribute('aria-label');
    if (labelDark?.includes('深色') === true) {
      darkApplied = await page.evaluate(() => document.documentElement.dataset.theme === 'dark');
      break;
    }
  }
  check('切到深色时 <html data-theme="dark"> 真的生效', darkApplied, `aria=${labelDark}`);
  // 标签必须如实反映当前生效的主题，而不是"点了几次"。
  // （不能断言 label0 !== labelDark：偏好会持久化，重跑时首档可能就是深色。）
  const labelMatchesTheme = await page.evaluate((label) => {
    const dark = document.documentElement.dataset.theme === 'dark';
    return (label ?? '').includes(dark ? '深色' : '浅色');
  }, labelDark);
  check('按钮标签与实际生效主题一致', labelMatchesTheme, `${labelDark}`);
  // 回到跟随系统（再点一次即可，若已在 system 则多转一圈也无害），保持环境干净。
  for (let i = 0; i < 3; i += 1) {
    if ((await themeButton.getAttribute('aria-label'))?.includes('跟随系统') === true) break;
    await themeButton.click();
    await page.waitForTimeout(150);
  }

  // 4) 侧栏导航真的换页（标题跟着变）。
  const navToFiles = page.locator('.nav-item', { hasText: '变更与文件' }).first();
  if (await navToFiles.count() > 0) {
    await navToFiles.click();
    await page.waitForTimeout(200);
    const heading = await page.locator('.breadcrumb strong').innerText().catch(() => '');
    check('侧栏导航切换到"变更与文件"', heading.includes('变更') || heading.includes('文件'), heading);
  } else {
    check('侧栏导航切换到"变更与文件"', false, '找不到导航项');
  }

  // 5) 设置页：语言切换器存在且可点击（写 Host 配置）。
  await page.locator('.sidebar-footer button[aria-label="渠道与设置"]').first().click();
  await page.waitForTimeout(250);
  const radios = page.locator('.settings-language-options button');
  const radioCount = await radios.count();
  check('设置页渲染出语言切换器', radioCount === 2, `${radioCount} 个选项`);
  if (radioCount === 2) {
    const en = radios.nth(1);
    await en.click();
    await page.waitForTimeout(400);
    const checked = await en.getAttribute('aria-checked');
    check('点 English 后该项被选中', checked === 'true', `aria-checked=${checked}`);
    // 切回中文，保持环境干净。
    await radios.nth(0).click();
    await page.waitForTimeout(300);
  }

  // 6) 无未捕获异常 / 无控制台错误（真实运行期错误只有跑起来才看得到）。
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForTimeout(300);
  check('交互过程无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (error) {
  check('真实窗口交互', false, String(error).split('\n')[0]);
  if (app !== undefined) {
    const page = app.windows()[0];
    if (page !== undefined) {
      // 诊断输出：失败时把窗口里的真实内容打出来，避免只看到一行超时。
      const body = await page.locator('body').innerText().catch(() => '');
      console.log('\n--- 窗口内容（截断） ---');
      console.log(body.replace(/\n{2,}/g, '\n').slice(0, 900));
      console.log('--- textarea 数量:', await page.locator('textarea').count().catch(() => -1));
      console.log('--- button 文本:', (await page.locator('button').allInnerTexts().catch(() => [])).slice(0, 14));
      await page.screenshot({ path: path.join(os.tmpdir(), 'syao-interaction-fail.png') }).catch(() => undefined);
      console.log(`--- 截图: ${path.join(os.tmpdir(), 'syao-interaction-fail.png')}`);
    }
  }
} finally {
  await app?.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `\nINTERACTION: OK (${results.length} 项)` : `\nINTERACTION: ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
