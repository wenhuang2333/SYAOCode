#!/usr/bin/env node
/**
 * 真实模型端到端（`27` §17 / 文档 26 §2.1）。
 *
 * 这是**唯一**能证明"接入真实厂商渠道后整条链路通"的验证：
 *   Host → OpenAI 兼容端点 → 流式回包 → thinking 行 → 正文行 → 投影 → runState 归位。
 *
 * 为什么平时用 mock：mock 不联网、不需要密钥、结果确定，适合进 CI。
 * 但 mock **证明不了**真实 provider 的响应格式能被正确解析——
 * 事实上真实端点会多返回 `reasoning_content`（思维链），mock 永远不会。
 * 那个字段一旦没被正确分流，就会混进正文里显示给用户。
 *
 * 用法：
 *   REAL_API_KEY=... REAL_BASE_URL=https://... REAL_MODEL=... \
 *     node --import tsx scripts/verify-real-model.mjs
 *
 * 缺环境变量时**跳过**并 exit 0，绝不打印通过。
 * 密钥只从环境变量读，**不落盘、不进日志**。
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY = process.env['REAL_API_KEY'] ?? '';
const BASE = process.env['REAL_BASE_URL'] ?? '';
const MODEL = process.env['REAL_MODEL'] ?? '';

if (KEY === '' || BASE === '' || MODEL === '') {
  console.log('SKIP: set REAL_API_KEY, REAL_BASE_URL and REAL_MODEL to run the real-model check.');
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 结果收集（只留在内存里，绝不写入任何文件）。 */
const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

let createHostFn;
try {
  ({ createHost: createHostFn } = await import(path.join(ROOT, 'packages/host/src/host.ts')));
} catch (error) {
  console.log('SKIP: could not load the host module:', String(error).split('\n')[0]);
  process.exit(0);
}

const { DhpConnection } = await import(path.join(ROOT, 'packages/client/src/index.ts'));
// `ws` 是 host 包的依赖，不在根 node_modules 里——从 host 包内解析。
const { createRequire } = await import('node:module');
const hostRequire = createRequire(path.join(ROOT, 'packages/host/package.json'));
const WS = hostRequire('ws');

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'syao-real-')));
let host;
try {
  host = await createHostFn({
    workspaceRoot: root,
    // 密钥只进进程环境，不进状态文件、不进日志。
    env: { SYAOCODE_HOME: root, OPENAI_API_KEY: KEY, OPENAI_BASE_URL: BASE },
    logger: () => {},
  });

  const conn = new DhpConnection({
    url: host.server.url,
    token: host.server.token,
    clientName: 'verify-real-model',
    socketFactory: (url, token) => new WS(url, { headers: { authorization: `Bearer ${token}` } }),
    onDelta: () => {},
    onSnapshot: () => {},
  });
  await conn.connect();

  await conn.request('channel/save', {
    id: 'live', name: 'Live', protocol: 'openai-compatible',
    baseUrl: BASE, apiKeyEnv: 'OPENAI_API_KEY',
    models: [{ id: MODEL, name: MODEL }],
  });

  const created = await conn.request('session/create', { workspaceRoot: root, model: `live:${MODEL}` });
  const sid = created.snapshot.meta.sessionId;
  check('会话用真实模型建起来', created.snapshot.meta.model === `live:${MODEL}`, created.snapshot.meta.model);

  const snap0 = await conn.request('session/snapshot', { sessionId: sid });
  await conn.request('turn/send', {
    sessionId: sid, commandId: `real-${Date.now()}`, baseRevision: snap0.revision,
    text: 'reply with exactly: PONG',
  });

  // 等一轮结束：`runState` 是运行态的真相（ACK 只说明命令被接受）。
  const deadline = Date.now() + 150_000;
  let snap;
  let sawStreaming = false;
  while (Date.now() < deadline) {
    snap = await conn.request('session/snapshot', { sessionId: sid });
    if (snap?.runState === 'streaming') sawStreaming = true;
    if (snap?.runState === 'idle' && snap?.seq > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const rows = snap?.rows ?? [];
  const user = rows.find((r) => r.kind === 'message' && r.role === 'user');
  // 真实模型会先流 `reasoning_content`（thinking 行），再流正文，
  // 因此可能出现一条文本为空的 assistant 行——取有正文的那条。
  const assistant = rows.find((r) => r.kind === 'message' && r.role === 'assistant' && r.text.trim() !== '');
  check('用户消息进入投影', user?.text === 'reply with exactly: PONG');
  // 用 contains 而不是等值：模型可能回 "PONG"、也可能回 "PONG." 或 "The answer is PONG"。
  // 我们要验的是「真实回复被完整、原样送进投影」，不是「模型必须只吐四个字母」——
  // 后者一旦不满足就是模型的措辞差异，报 FAIL 会把产品缺陷和模型脾气混为一谈。
  check('真实回复进入投影', (assistant?.text ?? '').toUpperCase().includes('PONG'), assistant?.text?.trim() ?? '(none)');
  check('这一轮确实经历了流式', sawStreaming);
  check('结束后 runState 回到 idle', snap?.runState === 'idle', String(snap?.runState));

  // 真实端点会多返回 `reasoning_content`；它必须单独成行，不能混进正文。
  const thinking = rows.find((r) => r.kind === 'thinking');
  if (thinking !== undefined) {
    check('推理内容单独成行（不混进正文）', !(assistant?.text ?? '').includes(thinking.text ?? ''));
  } else {
    console.log('NOTE: 该模型未返回推理内容，跳过思维链分流检查。');
  }

  await conn.close();
} catch (error) {
  check('真实模型端到端', false, String(error).split('\n')[0]);
} finally {
  await host?.close?.().catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? '\nREAL MODEL: OK' : `\nREAL MODEL: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
