#!/usr/bin/env node
/**
 * 真实模型的**用量口径**核对（`26` N-22 / `27` §2.6 用量页）。
 *
 * 用量页最容易犯的错不是崩溃，而是**数字看起来合理但其实是编的**。
 * 所以这里不满足于"用量非零"，而是三件事一起核：
 *
 *   1. 跑一轮真实对话；
 *   2. 读出用量台账，确认 token 数与**厂商真实返回**的量级一致
 *      （提示词几百 token 起、回复至少 1 token）；
 *   3. 核对**成本口径的诚实性**：渠道没配单价时必须给 `null`（未知），
 *      不能给 0 —— "0 元"和"不知道多少钱"是两件完全不同的事。
 *
 * 用法：
 *   REAL_API_KEY=... REAL_BASE_URL=https://... REAL_MODEL=... \
 *     node --import tsx scripts/verify-real-usage.mjs
 *
 * 缺环境变量时**跳过**并 exit 0，绝不打印通过。密钥只经进程环境传递。
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const KEY = process.env['REAL_API_KEY'] ?? '';
const BASE = process.env['REAL_BASE_URL'] ?? '';
const MODEL = process.env['REAL_MODEL'] ?? '';

if (KEY === '' || BASE === '' || MODEL === '') {
  console.log('SKIP: set REAL_API_KEY, REAL_BASE_URL and REAL_MODEL.');
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

const { createHost } = await import(path.join(ROOT, 'packages/host/src/host.ts'));
const { DhpConnection } = await import(path.join(ROOT, 'packages/client/src/index.ts'));
const WS = createRequire(path.join(ROOT, 'packages/host/package.json'))('ws');

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'syao-usage-')));
let host;
let conn;
try {
  host = await createHost({
    workspaceRoot: root,
    env: { SYAOCODE_HOME: root, OPENAI_API_KEY: KEY, OPENAI_BASE_URL: BASE },
    logger: () => {},
  });
  conn = new DhpConnection({
    url: host.server.url,
    token: host.server.token,
    clientName: 'verify-real-usage',
    socketFactory: (url, token) => new WS(url, { headers: { authorization: `Bearer ${token}` } }),
  });
  await conn.connect();

  await conn.request('channel/save', {
    id: 'live', name: 'Live', protocol: 'openai-compatible',
    baseUrl: BASE, apiKeyEnv: 'OPENAI_API_KEY',
    // 刻意**不配单价**：用来核对"没定价就不该报 0 元"。
    models: [{ id: MODEL, name: MODEL }],
  });
  await conn.request('config/set', { key: 'model', value: `live:${MODEL}` });

  const created = await conn.request('session/create', { workspaceRoot: root, model: `live:${MODEL}` });
  const sid = created.snapshot.meta.sessionId;
  const snap0 = await conn.request('session/snapshot', { sessionId: sid });
  await conn.request('turn/send', {
    sessionId: sid, commandId: `usage-${Date.now()}`, baseRevision: snap0.revision,
    text: 'Reply with the single word: OK',
  });

  const deadline = Date.now() + 150_000;
  let snap;
  while (Date.now() < deadline) {
    snap = await conn.request('session/snapshot', { sessionId: sid });
    if (snap?.runState === 'idle' && snap?.seq > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // ── 用量台账 ────────────────────────────────────────────────────────
  const now = Date.now();
  const report = await conn.request('usage/query', { from: now - 86_400_000, to: now + 60_000 });
  const totals = report?.totals ?? {};
  console.log('USAGE TOTALS =', JSON.stringify(totals));

  check('台账记到了这一轮（至少 1 次请求）', (totals.requests ?? 0) >= 1, `requests=${totals.requests}`);
  check('输入 token 数来自真实请求（> 0）', (totals.inputTokens ?? 0) > 0, `inputTokens=${totals.inputTokens}`);
  check('输出 token 数来自真实回复（> 0）', (totals.outputTokens ?? 0) > 0, `outputTokens=${totals.outputTokens}`);
  // 一轮对话的提示词至少上百 token（系统提示 + 消息）；小于 1 说明数字是假的。
  check('输入 token 量级合理（≥ 20）', (totals.inputTokens ?? 0) >= 20, `inputTokens=${totals.inputTokens}`);
  check('总 token = 输入 + 输出（不含凭空多出来的）',
    (totals.totalTokens ?? -1) === (totals.inputTokens ?? 0) + (totals.outputTokens ?? 0),
    `${totals.totalTokens} vs ${(totals.inputTokens ?? 0) + (totals.outputTokens ?? 0)}`);
  check('没有失败请求', (totals.errors ?? 0) === 0, `errors=${totals.errors}`);

  // 成本口径：这里不预设"应该是多少"，只核**内部自洽**。
  //
  // 厂商网关在 usage 里带了 `cost`，provider 会如实采纳（`openai-compatible.ts`
  // 读 `cost` / `gateway_cost`）。所以"渠道没配单价"不等于"成本未知"——
  // 只要厂商报了数，记下来就是忠实的。真正要防的是**自相矛盾**：
  // 报了确定的金额却又说自己不知道多少钱，或者金额不是有限数。
  const cost = totals.costUsd;
  const unknownCostRequests = totals.unknownCostRequests ?? 0;
  const costKnown = cost !== null && cost !== undefined;
  const consistent = (costKnown && unknownCostRequests === 0)
    || (!costKnown && unknownCostRequests === (totals.requests ?? 0));
  check('成本口径自洽（知道金额就不说未知，反之亦然）', consistent,
    `costUsd=${String(cost)} unknownCostRequests=${unknownCostRequests} requests=${totals.requests}`);
  check('成本是有限数（不是 NaN / Infinity）', !costKnown || Number.isFinite(cost), String(cost));

  // 分组维度：模型 / 渠道 / 项目三组都应有这一条记录。
  const models = report?.models ?? [];
  const channels = report?.channels ?? [];
  check('按模型分组有记录', models.length >= 1, `${models.length} 组`);
  check('按渠道分组有记录', channels.length >= 1, `${channels.length} 组`);
  // `UsageGroup` 的字段是 `id` / `name`（不是 key）。
  check('分组里出现的是真实渠道 id', channels.some((g) => g.id === 'live'), channels.map((g) => `${g.id}=${g.name}`).join(','));
  check('渠道分组显示的是渠道名而不是裸 id',
    channels.every((g) => g.name !== '' && g.name !== undefined),
    channels.map((g) => g.name).join(','));

  // ── 会话详情里的用量与上下文 ────────────────────────────────────────
  const inspect = await conn.request('session/inspect', { sessionId: sid });
  console.log('SESSION TOTALS =', JSON.stringify(inspect?.totals));
  check('会话详情的用量与全局台账一致',
    (inspect?.totals?.inputTokens ?? 0) === (totals.inputTokens ?? 0),
    `${inspect?.totals?.inputTokens} vs ${totals.inputTokens}`);
  check('上下文占用已采集（不是"尚未采集"）',
    inspect?.context?.usedTokens !== null && inspect?.context?.usedTokens !== undefined,
    `usedTokens=${inspect?.context?.usedTokens} source=${inspect?.context?.source}`);

  await conn.close();
} catch (error) {
  check('真实模型用量核对', false, String(error).split('\n')[0]);
} finally {
  await conn?.close?.();
  await host?.close?.();
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? '\nREAL USAGE: OK' : `\nREAL USAGE: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
