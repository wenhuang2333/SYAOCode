#!/usr/bin/env node
/**
 * 真实窗口 + 真实模型的端到端（`26` N-19 / `27` §17）。
 *
 * 与 `verify-interaction.mjs` 的区别：那个用 mock 渠道，证明的是**界面闭环**；
 * 这个用**真实厂商端点**，证明的是"真实响应格式能被界面正确渲染"。
 *
 * 真实端点会多返回 `reasoning_content`（思维链）。mock 永远不会返回它，
 * 所以 mock 测试覆盖不到"思维链会不会混进正文显示给用户"这件事——
 * 而这恰恰是真实接入最容易出错的地方。
 *
 * 流程：
 *   1. 用同一个 HOME 起一次 Host，通过 DHP 持久化「真实渠道」与「默认模型」；
 *   2. 启动 Electron（继承 HOME，于是配置已就位）；
 *   3. 在**真实窗口**里新建会话、发一条消息、等真实回复出现在时间线上；
 *   4. 断言：正文有内容、思维链单独成行（不混进正文）、无未捕获异常。
 *
 * 用法：
 *   REAL_API_KEY=... REAL_BASE_URL=https://... REAL_MODEL=... \
 *   SYAO_PLAYWRIGHT=... node scripts/verify-real-window.mjs
 *
 * 缺任一条件时**跳过**并 exit 0，绝不打印通过。密钥只经进程环境传递。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'apps/desktop');
const KEY = process.env['REAL_API_KEY'] ?? '';
const BASE = process.env['REAL_BASE_URL'] ?? '';
const MODEL = process.env['REAL_MODEL'] ?? '';

if (KEY === '' || BASE === '' || MODEL === '') {
  console.log('SKIP: set REAL_API_KEY, REAL_BASE_URL and REAL_MODEL.');
  process.exit(0);
}
if (!existsSync(path.join(APP, 'dist/main/index.js'))) {
  console.log('SKIP: apps/desktop/dist/main/index.js missing. Run `pnpm build` first.');
  process.exit(0);
}

let _electron;
try {
  ({ _electron } = await import(process.env['SYAO_PLAYWRIGHT'] ?? 'playwright'));
} catch {
  console.log('SKIP: playwright not installed. Set SYAO_PLAYWRIGHT to its index.mjs.');
  process.exit(0);
}

const appRequire = createRequire(path.join(APP, 'package.json'));
const electronBin = process.env['SYAO_ELECTRON_BIN'] ?? appRequire('electron');
if (typeof electronBin !== 'string' || !existsSync(electronBin)) {
  console.log('SKIP: electron binary not found.');
  process.exit(0);
}

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

const home = await mkdtemp(path.join(os.tmpdir(), 'syao-real-window-'));
// Electron 以 `process.cwd()`（= apps/desktop）为工作区根，所以配置必须在同一处生效。
const workspace = APP;

/**
 * 先用同一个 HOME 起一次 Host，把真实渠道与默认模型**持久化**下去。
 * 界面随后启动时读到的是同一份配置——不需要给渲染层开后门。
 */
async function seedConfiguration(workspaceRoot) {
  const { createHost } = await import(path.join(ROOT, 'packages/host/src/host.ts'));
  const { DhpConnection } = await import(path.join(ROOT, 'packages/client/src/index.ts'));
  const hostRequire = createRequire(path.join(ROOT, 'packages/host/package.json'));
  const WS = hostRequire('ws');

  const host = await createHost({
    workspaceRoot,
    env: { SYAOCODE_HOME: home, OPENAI_API_KEY: KEY, OPENAI_BASE_URL: BASE },
    logger: () => {},
  });
  try {
    const conn = new DhpConnection({
      url: host.server.url,
      token: host.server.token,
      clientName: 'seed-real',
      socketFactory: (url, token) => new WS(url, { headers: { authorization: `Bearer ${token}` } }),
    });
    await conn.connect();
    await conn.request('channel/save', {
      id: 'live', name: 'Live', protocol: 'openai-compatible',
      baseUrl: BASE, apiKeyEnv: 'OPENAI_API_KEY',
      models: [{ id: MODEL, name: MODEL }],
    });
    const cfgResult = await conn.request('config/set', { key: 'model', value: `live:${MODEL}` });
    console.log('SEED config/set →', JSON.stringify(cfgResult));
    const cfgGet = await conn.request('config/get', {});
    console.log('SEED config/get →', JSON.stringify(cfgGet));
    await conn.close();
  } finally {
    await host.close();
  }
}

const env = {
  ...process.env,
  HOME: home,
  // Host 只认 `SYAOCODE_HOME`（`packages/host/src/paths.ts`）；
  // 写成 `SYAO_HOME` 会让它回退到 `os.homedir()/.syaocode`，于是读到的是
  // **另一份**配置——界面显示 mock:default 就是这么来的。
  SYAOCODE_HOME: home,
  // Host 子进程继承主进程环境；模型凭据只走这里，不进状态文件。
  OPENAI_API_KEY: KEY,
  OPENAI_BASE_URL: BASE,
};
delete env['ELECTRON_RUN_AS_NODE'];

let app;
/**
 * 被中断时也要收掉 Electron 子进程。
 *
 * 若脚本被 Ctrl-C / 超时杀掉而没走 `finally`，Electron 会变成孤儿进程活下来，
 * 占着窗口与单实例锁，导致**下一次**运行报
 * "Target page, context or browser has been closed" —— 看起来像功能坏了，
 * 其实只是上一次没退干净。（本仓库真踩过。）
 */
const closeOnSignal = (signal) => {
  void (async () => {
    await app?.close?.().catch(() => undefined);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  })();
};
process.once('SIGINT', () => closeOnSignal('SIGINT'));
process.once('SIGTERM', () => closeOnSignal('SIGTERM'));
try {
  await seedConfiguration(workspace);
  check('真实渠道与默认模型已持久化', true);

  app = await _electron.launch({ args: ['.'], cwd: APP, env, executablePath: electronBin });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('text=运行时已连接', { timeout: 40_000 });
  check('真实窗口启动并连上 Host', true);

  // 新建会话（真实窗口里的真实点击）。
  const create = page.locator('.welcome-create, .new-session').first();
  await create.click();
  await page.waitForTimeout(2_000);

  // 选真实模型：模型选择器里应能看到刚持久化的渠道。
  const modelTrigger = page.locator('.model-trigger').first();
  const modelLabel = await modelTrigger.innerText().catch(() => '');
  check('界面用的是真实模型', modelLabel.includes(MODEL), modelLabel.replace(/\s+/g, ' ').trim());

  // 发一条消息（用 DOM 事件走 React 的 onChange；无头环境下按键注入不产生字符）。
  const typed = await page.evaluate(() => {
    const el = document.querySelector('textarea');
    if (el === null) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, 'reply with exactly: PONG');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  });
  check('输入区可输入', typed);

  const sendButton = page.locator('.composer-actions .btn').first();
  await sendButton.click({ timeout: 15_000 }).catch(() => undefined);

  // 等真实回复落到时间线上（真实模型要几秒到几十秒）。
  const assistantText = await page
    .waitForFunction(() => {
      const rows = Array.from(document.querySelectorAll('.msg-assistant .content'));
      const texts = rows.map((r) => (r.textContent ?? '').trim()).filter((t) => t !== '');
      return texts.length > 0 ? texts[texts.length - 1] : null;
    }, { timeout: 150_000 })
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  check('真实回复出现在时间线上', typeof assistantText === 'string' && assistantText.length > 0, String(assistantText).slice(0, 80));

  // 思维链必须单独成行（真实端点才会返回它，mock 覆盖不到）。
  const thinkingCount = await page.locator('.row.thinking').count();
  const bodyHasThinking = typeof assistantText === 'string' && /reasoning|思考过程|思维链/i.test(assistantText);
  check('推理内容没有混进正文', bodyHasThinking === false, `thinking 行 ${thinkingCount} 个`);

  // 一轮结束后流式指示必须消失。
  await page.waitForTimeout(2_000);
  const stillStreaming = await page.locator('.streaming-dot').count();
  check('结束后不再显示流式指示', stillStreaming === 0, `剩余 ${stillStreaming} 个`);

  await page.screenshot({ path: path.join(os.tmpdir(), 'syao-real-window.png') }).catch(() => undefined);
  console.log(`截图: ${path.join(os.tmpdir(), 'syao-real-window.png')}`);
} catch (error) {
  check('真实窗口 + 真实模型', false, String(error).split('\n')[0]);
} finally {
  await app?.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true }).catch(() => undefined);

}

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `\nREAL WINDOW: OK (${results.length} 项)` : `\nREAL WINDOW: ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
