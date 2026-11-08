#!/usr/bin/env node
/**
 * 真实模型的**审批流**闭环（`27` §7.3 / `26` N-24）。
 *
 * 这里验的不是"审批卡能显示"，而是**安全性质**：
 *
 *   1. 真实模型请求写工具 → 会话进入 `awaiting-approval`；
 *   2. **批准之前，文件绝不能被改动**（这是整条审批链的意义所在）；
 *   3. 选择 `once` 批准后，工具真的执行、模型继续生成并收敛。
 *
 * mock 的剧本永远"直接给结果"，覆盖不到"模型主动请求写、内核拦住、等人点"。
 * 而这段恰恰是权限引擎最容易写错的地方——写漏一个分支，审批就变成装饰。
 *
 * 用法：
 *   REAL_API_KEY=... REAL_BASE_URL=https://... REAL_MODEL=... \
 *     node --import tsx scripts/verify-real-approval.mjs
 *
 * 缺环境变量时**跳过**并 exit 0，绝不打印通过。
 */
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises';
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

/** 写工具的目标文件；批准前它的内容必须原封不动。 */
const TARGET = 'note.txt';
const ORIGINAL = 'original content\n';
const MARKER = 'APPROVED-BY-HUMAN-9F2';

const { createHost } = await import(path.join(ROOT, 'packages/host/src/host.ts'));
const { DhpConnection } = await import(path.join(ROOT, 'packages/client/src/index.ts'));
const WS = createRequire(path.join(ROOT, 'packages/host/package.json'))('ws');

const { writeFile } = await import('node:fs/promises');
const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'syao-approval-')));
const home = await mkdtemp(path.join(os.tmpdir(), 'syao-approval-home-'));
await writeFile(path.join(workspace, TARGET), ORIGINAL);

let host;
let conn;
let sawAwaitingBeforeApproval = false;
let fileUntouchedBeforeApproval = false;
let approvedSomething = false;
let writeChecked = false;
try {
  host = await createHost({
    workspaceRoot: workspace,
    env: { SYAOCODE_HOME: home, OPENAI_API_KEY: KEY, OPENAI_BASE_URL: BASE },
    logger: () => {},
  });
  conn = new DhpConnection({
    url: host.server.url,
    token: host.server.token,
    clientName: 'verify-real-approval',
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
    // default：工作区内写 = 必须审批。这正是要验的那条规则。
    permissionMode: 'default',
  });
  const sid = created.snapshot.meta.sessionId;
  let snap = await conn.request('session/snapshot', { sessionId: sid });
  await conn.request('turn/send', {
    sessionId: sid,
    commandId: `approval-${Date.now()}`,
    baseRevision: snap.revision,
    text: `Overwrite the file ${TARGET} in the workspace so that it contains exactly this single line: ${MARKER}`,
  });

  const deadline = Date.now() + 240_000;
  // 一个真实任务可能触发**多次**审批（模型先跑 bash 看文件、再 read、最后 write），
  // 每次都批准。只批准一次会让脚本停在第二个审批卡上——那是脚本的限制。
  const approved = new Set();
  while (Date.now() < deadline) {
    snap = await conn.request('session/snapshot', { sessionId: sid });

    const pending = (snap?.pendingInteractions ?? []).filter((i) => i.kind === 'permission' && !approved.has(i.id));
    if (pending.length > 0) {
      const interaction = pending[0];
      if (snap.runState === 'awaiting-approval') sawAwaitingBeforeApproval = true;
      console.log(`  待审批：risk=${interaction.risk} subject=${JSON.stringify(interaction.subject).slice(0, 80)}`);
      // **安全性质**：在"写"审批被批准之前，文件必须保持原样。
      //
      // 只在 risk==='write' 的审批上采样：一个真实任务会先跑 bash/read 看文件、
      // 再 write，之后再 exec 校验——后面的审批发生在写入之后，文件本来就该变了。
      // 拿那些时刻去断言"未改动"是错的（第一版就是这么误报的）。
      if (interaction.risk === 'write' && !writeChecked) {
        const current = await readFile(path.join(workspace, TARGET), 'utf8').catch(() => '(missing)');
        fileUntouchedBeforeApproval = current === ORIGINAL;
        writeChecked = true;
        console.log(`  写审批前的文件内容：${JSON.stringify(current)}`);
      }

      // 选 `once`（只批准这一次），最保守的选项。
      const once = (interaction.options ?? []).find((o) => o.scope === 'once');
      const optionId = once?.id ?? 'once';
      approved.add(interaction.id);
      await conn.request('interaction/resolve', {
        sessionId: sid,
        interactionId: interaction.id,
        optionId,
        commandId: `approve-${Date.now()}`,
        baseRevision: snap.revision,
      });
      approvedSomething = true;
    }

    if (snap?.runState === 'idle' && snap?.seq > 0 && approvedSomething) break;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }

  const finalContent = await readFile(path.join(workspace, TARGET), 'utf8').catch(() => '(missing)');
  const rows = snap?.rows ?? [];
  const toolRows = rows.filter((r) => r.kind === 'toolCall');

  console.log(`最终文件内容：${JSON.stringify(finalContent.slice(0, 120))}`);
  for (const row of toolRows) {
    console.log('  TOOL', row.name, row.state, JSON.stringify(row.input ?? null).slice(0, 100));
    if (row.state === 'error') console.log('    错误文本：', JSON.stringify(String(row.resultText ?? '').slice(0, 200)));
  }

  check('真实模型请求了写操作并触发审批', sawAwaitingBeforeApproval, approved.size === 0 ? '从未进入 awaiting-approval' : `批准 ${approved.size} 次`);
  check('写操作在审批通过之前没有生效（审批不是装饰）', writeChecked && fileUntouchedBeforeApproval,
    !writeChecked ? '没有观察到写审批' : fileUntouchedBeforeApproval ? '' : '写审批前文件已被改写——权限闸门失效');
  check('批准后工具真的执行了', toolRows.some((r) => r.state === 'ok'), toolRows.map((r) => r.state).join(','));
  check('文件确实被写成模型要求的内容', finalContent.includes(MARKER), finalContent.trim().slice(0, 60));
  check('一轮结束后 runState 回到 idle', snap?.runState === 'idle', String(snap?.runState));
  // 多步工具调用（N-25）：真实任务通常要先看、再改、再核验，
  // 这不是"一次工具调用"，而是同一轮内多次调用并能收敛。
  check('同一轮内发生多次工具调用并收敛', toolRows.length >= 2, `${toolRows.length} 次`);
  // 工具失败必须是"命令失败"，而不是被权限拒绝却伪装成工具错误——
  // 后者会让用户以为命令有问题，实际是没批准。
  const deniedAsError = toolRows.some((r) => r.state === 'error'
    && /denied|not permitted|approval|permission/i.test(String(r.resultText ?? '')));
  check('没有把"权限拒绝"伪装成普通工具错误', deniedAsError === false, '');

  await conn.close();
} catch (error) {
  check('真实模型审批流', false, String(error).split('\n')[0]);
} finally {
  await conn?.close?.();
  await host?.close?.();
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? '\nREAL APPROVAL: OK' : `\nREAL APPROVAL: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
