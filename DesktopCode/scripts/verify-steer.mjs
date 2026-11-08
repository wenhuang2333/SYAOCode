#!/usr/bin/env node
/**
 * 真实窗口 + 本地 OpenAI 兼容 SSE stub 的多轮 steer 端到端
 * （N-2 / FR-N-032，`28-多轮steer行为契约` §7 第 13 行）。
 *
 * 为什么不用内置 mock 渠道：它的剧本固定为「文本 → read 工具 → 收尾」，
 * 不会回显收到的补充指令，因此**无法**证明"后续模型请求里真的出现了 steer 文本"。
 * 这里起一个本地 OpenAI 兼容 SSE stub：
 *  - 记录**每一次**请求的 `messages`（核心证据）；
 *  - 第一轮先吐一小段并**保持连接**，让真实窗口有足够时间在流式期间提交 steer；
 *  - 第二轮检查 `messages` 里是否出现 steer 文本，且顺序在首轮 assistant 消息之后。
 *
 * 流程（全部在真实 Electron 窗口里点击/输入）：
 *   A. 运行中提交 → 时间线出现"已排队" → 放行首轮流 → 第二轮请求确实收到该文本
 *      → 同一行变"已注入" → runState 回到 idle。
 *   B. 再次运行中提交 → 立即停止 → 该行变"未注入（aborted）"，且**不再**发起后续请求
 *      （不自动重放）。
 *
 * 用法（需要先 `pnpm build`）：
 *   LIWEN_PLAYWRIGHT=/path/to/playwright/index.mjs node --import tsx scripts/verify-steer.mjs
 *
 * 缺 Playwright / Electron / 构建产物时**跳过**并 exit 0，绝不打印通过。
 * 密钥只经进程环境传递，脚本里不出现任何真实密钥。
 */
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'apps/desktop');
const PW = process.env['LIWEN_PLAYWRIGHT'] ?? 'playwright';

// ── 预检：缺任何一项都 SKIP，绝不打印通过 ──────────────────────────────
if (!existsSync(path.join(APP, 'dist/main/index.js'))) {
  console.log('SKIP: apps/desktop/dist/main/index.js missing. Run `pnpm build` first.');
  process.exit(0);
}

let _electron;
try {
  ({ _electron } = await import(PW));
} catch {
  console.log('SKIP: playwright not installed. Set LIWEN_PLAYWRIGHT to its index.mjs.');
  process.exit(0);
}
if (_electron === undefined || typeof _electron.launch !== 'function') {
  console.log('SKIP: this playwright build has no _electron driver.');
  process.exit(0);
}

function resolveElectron() {
  if (process.env['LIWEN_ELECTRON_BIN'] !== undefined) return process.env['LIWEN_ELECTRON_BIN'];
  try {
    const req = createRequire(path.join(APP, 'package.json'));
    const bin = req('electron');
    if (typeof bin === 'string' && existsSync(bin)) return bin;
  } catch {
    /* 落到下方 */
  }
  return undefined;
}
const electronBin = resolveElectron();
if (electronBin === undefined) {
  console.log('SKIP: electron binary not found. Install dev deps or set LIWEN_ELECTRON_BIN.');
  process.exit(0);
}

const STUB_KEY = 'steer-stub-key';
const FIRST_PROMPT = '请先输出一段较长的内容，我会在运行中补充指令。';
const STEER_TEXT = 'STEER-ECHO-MARKER: 收尾前请确认你收到了这条补充指令。';
const ABORT_PROMPT = '再输出一段长内容，这次我会在中途停止。';
const ABORT_STEER_TEXT = 'STEER-ABORT-MARKER: 这条补充指令应当显示为未注入。';

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

// ── 本地 OpenAI 兼容 SSE stub ─────────────────────────────────────────
/** 每次请求都记录 `messages`：这是"后续模型确实收到 steer"的唯一硬证据。 */
const requests = [];
let releaseFirst = () => undefined;
const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
let secondArrived = () => undefined;
const secondGate = new Promise((resolve) => { secondArrived = resolve; });
let thirdArrived = () => undefined;
const thirdGate = new Promise((resolve) => { thirdArrived = resolve; });

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  let raw = '';
  // 客户端 abort（stop）会直接销毁连接：吞掉 socket 级错误，避免脚本被未捕获异常带崩。
  req.on('error', () => undefined);
  res.on('error', () => undefined);
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end('bad json'); return; }
    const index = requests.length;
    requests.push({ index, messages: Array.isArray(body.messages) ? body.messages : [] });
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (payload) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`); };
    const finish = (text) => {
      if (text !== '') send({ choices: [{ delta: { content: text }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      send({ usage: { prompt_tokens: 12, completion_tokens: 6 } });
      if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
    };

    if (index === 0) {
      // 第一轮：先吐一小段，然后**保持连接**——流式期间由真实窗口提交 steer。
      send({ choices: [{ delta: { content: '第一段输出。' }, finish_reason: null }] });
      firstGate.then(() => finish('第一轮收尾。'));
    } else if (index === 1) {
      // 第二轮：内核把 steer 作为 user 消息注入后才会发起这次请求。
      secondArrived(requests[1]);
      finish('已收到补充指令，继续。');
    } else {
      // 第三轮（未消费场景）：同样保持连接，等真实窗口点"停止"。
      thirdArrived(requests[2]);
      send({ choices: [{ delta: { content: '第二段长输出。' }, finish_reason: null }] });
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const port = typeof address === 'object' && address !== null ? address.port : 0;
const baseUrl = `http://127.0.0.1:${port}/v1`;

const home = await mkdtemp(path.join(os.tmpdir(), 'liwen-steer-'));
const workspace = APP;

/**
 * 用同一个 HOME 先起一次 Host，把 stub 渠道与默认模型**持久化**下去。
 * 随后启动的 Electron 读到同一份配置——不给渲染层开后门。
 */
async function seedConfiguration(workspaceRoot) {
  const { createHost } = await import(path.join(ROOT, 'packages/host/src/host.ts'));
  const { DhpConnection } = await import(path.join(ROOT, 'packages/client/src/index.ts'));
  const hostRequire = createRequire(path.join(ROOT, 'packages/host/package.json'));
  const WS = hostRequire('ws');

  const host = await createHost({
    workspaceRoot,
    env: { LIWENCODE_HOME: home, OPENAI_API_KEY: STUB_KEY },
    logger: () => {},
  });
  try {
    const conn = new DhpConnection({
      url: host.server.url,
      token: host.server.token,
      clientName: 'seed-steer',
      socketFactory: (url, token) => new WS(url, { headers: { authorization: `Bearer ${token}` } }),
    });
    await conn.connect();
    await conn.request('channel/save', {
      id: 'steer-stub', name: 'Steer Stub', protocol: 'openai-compatible',
      baseUrl, apiKeyEnv: 'OPENAI_API_KEY',
      models: [{ id: 'steer-stub', name: 'Steer Stub' }],
    });
    await conn.request('config/set', { key: 'model', value: 'steer-stub:steer-stub' });
    await conn.close();
  } finally {
    await host.close();
  }
}

const env = {
  ...process.env,
  HOME: home,
  // Host 只认 `LIWENCODE_HOME`；写成别的名字会读到另一份配置（真实踩过的坑）。
  LIWENCODE_HOME: home,
  // 凭据只经环境变量进入 Host；stub 渠道的 apiKeyEnv 指向它。
  OPENAI_API_KEY: STUB_KEY,
};
delete env['ELECTRON_RUN_AS_NODE'];

let app;
const closeOnSignal = (signal) => {
  void (async () => {
    await app?.close?.().catch(() => undefined);
    server.close();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  })();
};
process.once('SIGINT', () => closeOnSignal('SIGINT'));
process.once('SIGTERM', () => closeOnSignal('SIGTERM'));

const pageErrors = [];

/** 用 DOM 事件写受控输入（无头 Electron 里键盘注入不产生字符，见 verify-interaction）。 */
async function typeIntoComposer(page, text) {
  await page.evaluate((value) => {
    const el = document.querySelector('textarea');
    if (el === null) throw new Error('textarea not found');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await page.waitForTimeout(120);
}

const composerMode = (page) => page.evaluate(() => document.querySelector('.composer-actions .btn-primary')?.getAttribute('data-submit-mode') ?? '');
const composerLabel = (page) => page.evaluate(() => document.querySelector('.composer-actions .btn-primary')?.textContent?.trim() ?? '');
const runBadge = (page) => page.evaluate(() => document.querySelector('.run-badge')?.textContent?.trim() ?? '');
const steerRowTexts = (page, selector) => page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((el) => (el.textContent ?? '').trim()), selector);

async function submitComposer(page) {
  await page.locator('.composer-actions .btn-primary').first().click({ timeout: 15_000 });
}

try {
  await seedConfiguration(workspace);
  check('stub 渠道与默认模型已持久化（真实窗口读同一份配置）', true);

  app = await _electron.launch({ args: ['.'], cwd: APP, env, executablePath: electronBin });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('text=运行时已连接', { timeout: 40_000 });
  check('真实窗口启动并连上 Host', true);

  // 新建会话。
  await page.locator('.welcome-create, .new-session').first().click();
  await page.waitForTimeout(1_500);
  const modelLabel = await page.locator('.model-trigger').first().innerText().catch(() => '');
  check('界面用的是 stub 渠道模型（不是内置 mock）', modelLabel.includes('steer-stub'), modelLabel.replace(/\s+/g, ' ').trim());

  // ── 场景 A：运行中提交 → queued → 第二轮请求收到 → consumed → idle ──
  await typeIntoComposer(page, FIRST_PROMPT);
  check('运行前输入区是普通发送模式', (await composerMode(page)) === 'send', await composerMode(page));
  await submitComposer(page);

  // 等第一段流式内容出现（stub 已吐第一段并保持连接）。
  await page.waitForFunction(() => {
    const el = document.querySelector('.msg-assistant .content');
    return (el?.textContent ?? '').includes('第一段输出');
  }, { timeout: 30_000 });
  check('首轮流式输出已进入时间线', true);
  check('运行中：输入区切换为补充指令排队模式', (await composerMode(page)) === 'steer' && (await composerLabel(page)).includes('排队'), `${await composerMode(page)} / ${await composerLabel(page)}`);

  // 流式期间提交 steer。
  await typeIntoComposer(page, STEER_TEXT);
  await submitComposer(page);

  // 1) 界面出现"已排队"行（来自 Host 的 steer.queued 事件，不是本地乐观行）。
  await page.waitForSelector('.steer-queued', { timeout: 20_000 });
  const queued = await steerRowTexts(page, '.steer-queued');
  check('界面出现"已排队"的 steer 行', queued.some((text) => text.includes(STEER_TEXT)), queued.join(' | ').slice(0, 120));
  const stateAttr = await page.evaluate(() => document.querySelector('.steer-queued')?.getAttribute('data-steer-state') ?? '');
  check('steer 行状态可区分（data-steer-state=queued）', stateAttr === 'queued', stateAttr);

  // 2) 当前流没有被中断：流式指示仍在。
  const streamingDuringSteer = await page.locator('.streaming-dot').count();
  check('提交 steer 不打断当前流式输出', streamingDuringSteer > 0, `streaming-dot ${streamingDuringSteer}`);

  // 3) 放行首轮：内核应在下一安全边界注入 steer 并**再发一次模型请求**。
  releaseFirst();
  const secondRequest = await Promise.race([
    secondGate,
    new Promise((_, reject) => setTimeout(() => reject(new Error('等待第二轮模型请求超时')), 60_000)),
  ]);
  const messages = secondRequest.messages;
  const steerIndex = messages.findIndex((m) => m.role === 'user' && JSON.stringify(m.content).includes(STEER_TEXT));
  const assistantIndex = messages.findIndex((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('第一段输出'));
  const lastUserIndex = messages.reduce((last, m, i) => (m.role === 'user' ? i : last), -1);
  check('后续模型请求确实收到 steer 文本（核心断言）', steerIndex >= 0, `messages=${messages.length}`);
  check('steer 文本出现在首轮 assistant 消息之后（消息顺序正确）', steerIndex > assistantIndex && assistantIndex >= 0, `steer=${steerIndex} assistant=${assistantIndex}`);
  check('steer 是请求里最后一条 user 消息（没有乱序/覆盖）', steerIndex === lastUserIndex, `steer=${steerIndex} lastUser=${lastUserIndex}`);

  // 4) 界面：同一行变"已注入"，并显示被消费到的轮次。
  await page.waitForSelector('.steer-consumed', { timeout: 30_000 });
  const consumed = await steerRowTexts(page, '.steer-consumed');
  check('同一 steer 行变为"已注入"', consumed.some((text) => text.includes(STEER_TEXT) && text.includes('已注入')), consumed.join(' | ').slice(0, 140));
  const consumedState = await page.evaluate(() => document.querySelector('.steer-consumed')?.getAttribute('data-steer-state') ?? '');
  check('已注入状态可区分（data-steer-state=consumed）', consumedState === 'consumed', consumedState);

  // 5) runState 归位 idle。
  await page.waitForFunction(() => (document.querySelector('.run-badge')?.textContent ?? '').includes('空闲'), { timeout: 30_000 });
  check('第二轮结束后 runState 归位（空闲）', (await runBadge(page)).includes('空闲'), await runBadge(page));
  check('queued 行没有残留（已转为终态）', (await page.locator('.steer-queued').count()) === 0, `剩余 ${await page.locator('.steer-queued').count()}`);
  await page.screenshot({ path: path.join(os.tmpdir(), 'liwen-steer-consumed.png') }).catch(() => undefined);

  // ── 场景 B：运行中提交后立即停止 → notConsumed，且不自动重放 ──
  await typeIntoComposer(page, ABORT_PROMPT);
  check('首轮结束后输入区回到普通发送模式', (await composerMode(page)) === 'send', await composerMode(page));
  await submitComposer(page);
  await Promise.race([
    thirdGate,
    new Promise((_, reject) => setTimeout(() => reject(new Error('等待第三轮模型请求超时')), 60_000)),
  ]);
  check('第二轮运行已开始（stub 收到第三次请求）', requests.length === 3, `requests=${requests.length}`);

  await typeIntoComposer(page, ABORT_STEER_TEXT);
  check('运行中再次切换为排队模式', (await composerMode(page)) === 'steer', await composerMode(page));
  await submitComposer(page);
  await page.waitForFunction((text) => Array.from(document.querySelectorAll('.steer-queued .content')).some((el) => (el.textContent ?? '').includes(text)), ABORT_STEER_TEXT, { timeout: 20_000 });
  check('停止前界面显示"已排队"', true);

  // 立即停止：queued 项必须明确未消费。
  await page.locator('.stop-button').first().click({ timeout: 15_000 });
  await page.waitForSelector('.steer-notConsumed', { timeout: 30_000 });
  const notConsumed = await steerRowTexts(page, '.steer-notConsumed');
  check('queued 后立即 stop：steer 行变为"未注入"', notConsumed.some((text) => text.includes(ABORT_STEER_TEXT) && text.includes('未注入')), notConsumed.join(' | ').slice(0, 140));
  const notConsumedState = await page.evaluate(() => document.querySelector('.steer-notConsumed')?.getAttribute('data-steer-state') ?? '');
  check('未注入状态可区分（data-steer-state=notConsumed）', notConsumedState === 'notConsumed', notConsumedState);
  check('未注入行显示了原因（aborted）', notConsumed.some((text) => text.includes('aborted')), notConsumed.join(' | ').slice(0, 140));
  await page.waitForFunction(() => (document.querySelector('.run-badge')?.textContent ?? '').includes('空闲'), { timeout: 30_000 });
  check('停止后 runState 归位（空闲）', (await runBadge(page)).includes('空闲'), await runBadge(page));
  // 停止后不得再发起模型请求（不自动重放）。
  await page.waitForTimeout(1_500);
  check('停止后没有自动重放（请求数未增加）', requests.length === 3, `requests=${requests.length}`);

  // 未捕获异常。
  check('真实窗口无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ').slice(0, 160));
  await page.screenshot({ path: path.join(os.tmpdir(), 'liwen-steer-not-consumed.png') }).catch(() => undefined);
  console.log(`截图: ${path.join(os.tmpdir(), 'liwen-steer-consumed.png')} / ${path.join(os.tmpdir(), 'liwen-steer-not-consumed.png')}`);
} catch (error) {
  check('真实窗口 + SSE stub 的多轮 steer 闭环', false, String(error).split('\n')[0]);
} finally {
  await app?.close().catch(() => undefined);
  // 场景 B 的第三次请求可能仍挂着：先强制断开所有连接，再等 server 关闭，
  // 否则 server.close() 会一直等 keep-alive 连接，脚本卡在 finally。
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `\nSTEER: OK (${results.length} 项)` : `\nSTEER: ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
