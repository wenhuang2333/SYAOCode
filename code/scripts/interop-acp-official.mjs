/**
 * Real interop probe: the OFFICIAL @agentclientprotocol/sdk client against
 * SYAOCode's ACP edge.
 *
 * Not a unit test — it needs the official SDK and a spawned server — so it runs
 * on demand or in a CI job with network access.
 *
 * USAGE
 *   mkdir -p /tmp/acp-interop && cd /tmp/acp-interop
 *   npm init -y >/dev/null && npm i --no-audit --no-fund @agentclientprotocol/sdk@2.0.2 zod@3.25.76
 *
 *   node <repo>/code/scripts/interop-acp-official.mjs /tmp/acp-interop
 *
 * Exit code 0 = interoperable, 1 = not.
 */
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
const moduleBase = process.argv[2] ?? '/tmp/acp-interop';
let client;
let methods;
let ndJsonStream;
let PROTOCOL_VERSION;
try {
  ({ client, methods, ndJsonStream, PROTOCOL_VERSION } = await import(
    `${moduleBase}/node_modules/@agentclientprotocol/sdk/dist/v1/stable/acp.js`
  ));
} catch (e) {
  console.error(`cannot load @agentclientprotocol/sdk from ${moduleBase}/node_modules: ${e?.message}`);
  console.error('see the usage comment at the top of this file');
  process.exit(1);
}

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const child = spawn('./node_modules/.bin/tsx', ['packages/cli/src/main.ts', 'serve', '--acp', '--stdio'], {
  cwd: '/Users/zhanshishan/Desktop/SIYAO/SYCODE/code',
  stdio: ['pipe', 'pipe', 'ignore'],
  env: {
    ...process.env,
    HOME: '/tmp/acp-interop-home',
    SYAO_MOCK_SCRIPT: JSON.stringify([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: { path: 'package.json' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'official client turn done' }] },
    ]),
  },
});

const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const updates = [];

const app = client({ name: 'official-acp-probe' })
  .onRequest(methods.client.fs.readTextFile, async () => ({ content: 'from-client-fs' }))
  .onRequest(methods.client.fs.writeTextFile, async () => undefined)
  .onRequest(methods.client.session.requestPermission, async ({ params }) => ({
    outcome: { outcome: 'selected', optionId: params.options[0]?.optionId ?? 'allow_once' },
  }))
  .onNotification(methods.client.session.update, async ({ params }) => {
    updates.push(params.update);
  });

try {
  await app.connectWith(stream, async (ctx) => {
    const init = await ctx.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: 'official-acp-probe', version: '1.0.0' },
    });
    check('initialize negotiates the ACP version', init.protocolVersion === 1, `protocolVersion=${init.protocolVersion}`);
    check('the agent reports its info', init.agentInfo?.name === 'syaocode', `name=${init.agentInfo?.name}`);

    const session = await ctx.request(methods.agent.session.new, {
      cwd: '/Users/zhanshishan/Desktop/SIYAO/SYCODE/code',
      mcpServers: [],
    });
    check('session/new returns a session id', typeof session.sessionId === 'string' && session.sessionId !== '', `id=${session.sessionId}`);

    const prompt = await ctx.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'read package.json' }],
    });
    check('session/prompt completes with end_turn', prompt.stopReason === 'end_turn', `stopReason=${prompt.stopReason}`);

    const text = updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content?.text ?? '').join('');
    check('the agent streamed its answer back', text.includes('official client turn done'), `text=${JSON.stringify(text.slice(0, 50))}`);
    check('the turn emitted session updates', updates.length > 0, `updates=${updates.length}`);
  });
} catch (e) {
  check('the official ACP client can drive the edge', false, `${e?.constructor?.name}: ${String(e?.message).slice(0, 200)}`);
} finally {
  child.kill();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} interop checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
