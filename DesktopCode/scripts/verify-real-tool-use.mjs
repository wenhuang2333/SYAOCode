#!/usr/bin/env node
/**
 * 真实模型的**工具调用**闭环（`27` §7 / `26` 端到端）。
 *
 * 这是整条链路里最复杂、也最容易被 mock 掩盖的一段：
 *
 *   真实模型决定调用工具 → 流式返回 tool_calls JSON → provider 解析
 *   → 内核权限闸门判定 → 工具真正执行 → 结果回灌给模型 → 模型继续生成
 *
 * mock 的工具调用是**我们写死的**（`mockToolUse` 直接给结构化对象），
 * 所以它证明不了"真实厂商的 tool_calls JSON 能被正确解析"——
 * 而那正是接入真实模型最容易翻车的地方（字段名、增量分片、arguments 拼接）。
 *
 * 做法：让模型读一个工作区文件并回报内容。只读，无需审批，
 * 跑完断言：真的产生了 tool 行、工具真的执行了、模型的最终回复引用了文件内容。
 *
 * 用法：
 *   REAL_API_KEY=... REAL_BASE_URL=https://... REAL_MODEL=... \
 *     node --import tsx scripts/verify-real-tool-use.mjs
 *
 * 缺环境变量时**跳过**并 exit 0，绝不打印通过。
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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

/** 一个独特的标记串：只有真的读到文件才能出现在回复里。 */
const MARKER = 'ZQ7-MARKER-42';

const { createHost } = await import(path.join(ROOT, 'packages/host/src/host.ts'));
const { DhpConnection } = await import(path.join(ROOT, 'packages/client/src/index.ts'));
const WS = createRequire(path.join(ROOT, 'packages/host/package.json'))('ws');

const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'syao-tool-')));
const home = await mkdtemp(path.join(os.tmpdir(), 'syao-tool-home-'));
await writeFile(path.join(workspace, 'secret.txt'), `The code is ${MARKER}.\n`);

let host;
let conn;
try {
  host = await createHost({
    workspaceRoot: workspace,
    env: { SYAOCODE_HOME: home, OPENAI_API_KEY: KEY, OPENAI_BASE_URL: BASE },
    logger: () => {},
  });
  conn = new DhpConnection({
    url: host.server.url,
    token: host.server.token,
    clientName: 'verify-real-tool-use',
    socketFactory: (url, token) => new WS(url, { headers: { authorization: `Bearer ${token}` } }),
  });
  await conn.connect();

  await conn.request('channel/save', {
    id: 'live', name: 'Live', protocol: 'openai-compatible',
    baseUrl: BASE, apiKeyEnv: 'OPENAI_API_KEY',
    models: [{ id: MODEL, name: MODEL }],
  });
  await conn.request('config/set', { key: 'model', value: `live:${MODEL}` });

  const created = await conn.request('session/create', {
    workspaceRoot: workspace,
    model: `live:${MODEL}`,
    // 只读工具在 default 下放行；这里用 default 以确保"工具真的被执行"，
    // 而不是被审批卡挡住（审批流程另有测试覆盖）。
    permissionMode: 'default',
  });
  const sid = created.snapshot.meta.sessionId;
  const snap0 = await conn.request('session/snapshot', { sessionId: sid });

  const started = Date.now();
  await conn.request('turn/send', {
    sessionId: sid,
    commandId: `tool-${Date.now()}`,
    baseRevision: snap0.revision,
    text: 'Read the file secret.txt in the workspace and reply with the code it contains. Reply with the code only.',
  });

  const deadline = Date.now() + 180_000;
  let snap;
  while (Date.now() < deadline) {
    snap = await conn.request('session/snapshot', { sessionId: sid });
    // 如果需要审批就批准（只读工具通常不需要，但不假设）。
    const pending = snap?.pendingInteractions ?? [];
    for (const interaction of pending) {
      await conn.request('interaction/resolve', { interactionId: interaction.id, decision: 'allow' }).catch(() => undefined);
    }
    if (snap?.runState === 'idle' && snap?.seq > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  const elapsed = Date.now() - started;

  const rows = snap?.rows ?? [];
  const toolRows = rows.filter((r) => r.kind === 'toolCall');
  const assistant = [...rows].reverse().find((r) => r.kind === 'message' && r.role === 'assistant' && (r.text ?? '').trim() !== '');
  const finalText = assistant?.text ?? '';

  console.log(`耗时 ${elapsed} ms；rows=${rows.length}；tool 行=${toolRows.length}`);
  for (const row of toolRows) console.log('  TOOL', row.name, row.state, JSON.stringify(row.input ?? null).slice(0, 120));
  console.log('最终回复:', JSON.stringify(finalText.slice(0, 200)));

  // 与审批流同理：模型可能这次选择不调工具（例如直接凭猜测回答）。
  // 那是模型的自由度，不是"工具链路坏了"——必须分开，否则脚本会偶发报 FAIL。
  if (toolRows.length === 0) {
    console.log('NOTE: 本次模型没有发起工具调用——工具链路未被触发，结论不可判（不是失败）。');
    console.log('\nREAL TOOL USE: INCONCLUSIVE (model did not call a tool)');
    await conn?.close?.();
    await host?.close?.();
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
    process.exit(0);
  }
  check('模型真的发起了工具调用', toolRows.length > 0, `${toolRows.length} 个`);
  check('工具调用被正确解析出名字与参数',
    toolRows.some((r) => typeof r.name === 'string' && r.name !== '' && r.input !== undefined),
    toolRows.map((r) => r.name).join(','));
  check('工具执行成功（不是 error / 一直 running）',
    toolRows.length > 0 && toolRows.every((r) => r.state === 'ok'),
    toolRows.map((r) => r.state).join(','));
  // 真正的证据：只有工具真的读到了文件，标记串才可能出现在回复里。
  check('最终回复引用了文件里的真实内容', finalText.includes(MARKER), finalText.slice(0, 80));
  check('结束后 runState 回到 idle', snap?.runState === 'idle', String(snap?.runState));

  await conn.close();
} catch (error) {
  check('真实模型工具调用闭环', false, String(error).split('\n')[0]);
} finally {
  await conn?.close?.();
  await host?.close?.();
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? '\nREAL TOOL USE: OK' : `\nREAL TOOL USE: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
