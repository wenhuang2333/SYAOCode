import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRegistry } from '../src/session-registry.ts';
import WebSocket from 'ws';
import { DHP_VERSION, Method, Notification, WorkbenchMethod as W, type AckResult, type DesktopOverview, type SessionInspection, type SessionSnapshot, type UsageReport } from '@syaocode/dhp';
import { createHost, type RunningHost } from '../src/host.ts';

let home: string; let root: string; let other: string;
let host: RunningHost;
const clients: WebSocket[] = [];
const cleanups: (() => Promise<void>)[] = [];
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-home-'));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-root-'));
  other = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-other-'));
  await fs.writeFile(path.join(root, 'README.md'), 'PROJECT A'); await fs.writeFile(path.join(other, 'README.md'), 'PROJECT B');
});
afterEach(async () => {
  for (const ws of clients.splice(0)) ws.close();
  await host?.close();
  for (const fn of cleanups.splice(0)) await fn();
  for (const dir of [home, root, other]) await fs.rm(dir, { recursive: true, force: true });
});
async function boot(env: Record<string, string> = {}) {
  host = await createHost({ workspaceRoot: root, env: { SYAOCODE_HOME: home, ...env }, logger: () => {} });
  return connect();
}
async function connect() {
  const ws = new WebSocket(host.server.url, { headers: { authorization: `Bearer ${host.server.token}` } }); clients.push(ws);
  const notifications: { method: string; params: any }[] = [];
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let seq = 0;
  ws.on('message', (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.method) { notifications.push(f); return; }
    const p = pending.get(f.id); if (!p) return; clearTimeout(p.timer); pending.delete(f.id);
    if (f.error) p.reject(Object.assign(new Error(f.error.message), f.error.data)); else p.resolve(f.result);
  });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const request = <T = any>(method: string, params?: unknown): Promise<T> => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 5000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  await request(Method.Hello, { clientName: 'workbench-test', dhpVersion: DHP_VERSION });
  return { request, notifications, ws };
}
type Client = Awaited<ReturnType<typeof connect>>;
async function session(c: Client, params: unknown = {}) { return (await c.request<{ snapshot: SessionSnapshot }>(Method.SessionCreate, params)).snapshot.meta.sessionId; }
async function command(c: Client, method: string, id: string, params: Record<string, unknown> = {}) {
  const snap = await c.request<SessionSnapshot>(Method.SessionSnapshot, { sessionId: id });
  return c.request<AckResult>(method, { sessionId: id, commandId: randomUUID(), baseRevision: snap.revision, ...params });
}
async function idle(c: Client, id: string) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const snapshot = await c.request<SessionSnapshot>(Method.SessionSnapshot, { sessionId: id });
    if (snapshot.runState === 'idle') return snapshot;
    if (Date.now() > deadline) throw new Error('Session remained busy');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Condition timed out'); await new Promise<void>((resolve) => setImmediate(resolve)); }
}
async function localProvider(handler: (body: any, res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    let body = ''; req.on('data', (b) => { body += String(b); }); req.on('end', () => handler(JSON.parse(body), res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('port');
  return `http://127.0.0.1:${address.port}/v1`;
}
function answer(res: ServerResponse, text = 'real local reply', usage = true) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ id: 'm', choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], ...(usage ? { usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } } } : {}) })}\n\n`);
  res.end('data: [DONE]\n\n');
}
const channel = (baseUrl: string) => ({ id: 'local', name: 'Local test', protocol: 'openai-compatible', baseUrl, apiKeyEnv: 'LOCAL_KEY', models: [{ id: 'a', name: 'A', contextWindow: 4096 }, { id: 'b', name: 'B', inputPricePerMillion: 2, outputPricePerMillion: 4, cacheReadPricePerMillion: 1 }] });

describe('workbench DHP integration', () => {
  it('canonical workspaces, per-project config/cwd, request counts, archive/rename and full history restart', async () => {
    await fs.mkdir(path.join(other, '.syaocode'));
    await fs.writeFile(path.join(other, '.syaocode/config.json'), JSON.stringify({ permissionMode: 'bypass', model: 'mock:default' }));
    const c = await boot();
    const w = await c.request(Method.WorkspaceOpen, { path: other });
    expect(w.workspaceRoot).toBe(await fs.realpath(other));
    await c.request(Method.WorkspaceOpen, { path: path.join(other, '.') });
    expect((await c.request<DesktopOverview>(W.Overview)).workspaces).toHaveLength(2);
    await expect(c.request(Method.WorkspaceOpen, { path: path.join(other, 'README.md') })).rejects.toMatchObject({ kind: 'path_rejected' });
    await expect(c.request(Method.SessionCreate, { workspaceRoot: '/not-registered' })).rejects.toMatchObject({ kind: 'path_rejected' });
    const a = await session(c); const b = await session(c, { workspaceRoot: w.workspaceRoot });
    expect((await c.request<SessionSnapshot>(Method.SessionSnapshot, { sessionId: b })).meta.permissionMode).toBe('default');
    for (const id of [a, b]) {
      await command(c, Method.TurnSend, id, { text: 'first' }); await idle(c, id);
      await command(c, Method.TurnSend, id, { text: 'read README' }); await idle(c, id);
    }
    const sa = await idle(c, a); const sb = await idle(c, b);
    expect(sa.rows.some((r) => r.kind === 'toolCall' && r.resultText?.includes('PROJECT A'))).toBe(true);
    expect(sb.rows.some((r) => r.kind === 'toolCall' && r.resultText?.includes('PROJECT B'))).toBe(true);
    expect((await c.request<SessionInspection>(W.SessionInspect, { sessionId: b })).totals).toMatchObject({ requests: 3, activeSessions: 1 });
    await c.request(Method.SessionRename, { sessionId: b, title: '  Saved project B  ' });
    await c.request(W.SessionArchive, { sessionId: b, archived: true });
    await expect(command(c, Method.TurnSend, b, { text: 'no' })).rejects.toMatchObject({ kind: 'denied' });
    await host.close();
    const raw = JSON.parse(await fs.readFile(path.join(home, 'desktop/state-v2.json'), 'utf8'));
    expect(raw.sessions.find((s: any) => s.snapshot.meta.sessionId === b).messages.some((m: any) => m.content.some((block: any) => block.type === 'tool_result'))).toBe(true);
    const c2 = await boot();
    const overview = await c2.request<DesktopOverview>(W.Overview);
    expect(overview.sessions.find((s) => s.sessionId === b)).toMatchObject({ title: 'Saved project B', archived: true, runState: 'idle', turnCount: 2 });
    expect(overview.today.requests).toBe(6);
    expect((await idle(c2, b)).epoch).toBe(sb.epoch + 1);
    await c2.request(W.SessionArchive, { sessionId: b, archived: false });
    await command(c2, Method.TurnSend, b, { text: 'continue' }); await idle(c2, b);
    await host.close();
    const after = JSON.parse(await fs.readFile(path.join(home, 'desktop/state-v2.json'), 'utf8'));
    const history = after.sessions.find((s: any) => s.snapshot.meta.sessionId === b).messages;
    expect(history.filter((m: any) => m.role === 'user' && m.content[0]?.text === 'first')).toHaveLength(1);
  });

  it('configured real provider/model takes effect, keeps history, unknown prices, usage filtering, no credentials returned', async () => {
    const requests: any[] = [];
    const url = await localProvider((body, res) => { requests.push(body); answer(res); });
    const c = await boot({ LOCAL_KEY: 'test-secret-not-returned' });
    await c.request(W.ChannelSave, { ...channel(url), balance: { amount: 3, currency: 'USD', updatedAt: 123, source: 'manual' } });
    const id = await session(c, { model: 'local:a', permissionMode: 'plan' });
    await command(c, Method.TurnSend, id, { text: 'first input' }); await idle(c, id);
    const before = await c.request<SessionInspection>(W.SessionInspect, { sessionId: id });
    expect(before.totals).toMatchObject({ requests: 1, inputTokens: 100, totalTokens: 110, cacheReadTokens: 20, costUsd: null, unknownCostRequests: 1 });
    expect(before.context).toMatchObject({ capacity: 4096, capacitySource: 'configured' });
    await c.request(Method.SessionSubscribe, { sessionId: id });
    const ack = await command(c, W.SessionConfigure, id, { model: 'local:b', permissionMode: 'strict' });
    expect(ack.status).toBe('accepted');
    expect(c.notifications.some((n) => n.params.snapshot?.revision === ack.revision && n.params.snapshot?.meta.model === 'local:b')).toBe(true);
    expect((await c.request<SessionInspection>(W.SessionInspect, { sessionId: id })).context.source).toBe('unknown');
    await command(c, Method.TurnSend, id, { text: 'second input' }); await idle(c, id);
    expect(requests.map((r) => r.model)).toEqual(['a', 'b']);
    expect(JSON.stringify(requests[1].messages)).toContain('first input');
    expect(JSON.stringify(requests[1].messages)).toContain('real local reply');
    const report = await c.request<UsageReport>(W.UsageQuery, { from: Date.now() - 86400000, to: Date.now(), workspaceRoot: await fs.realpath(root) });
    expect(report.totals).toMatchObject({ requests: 2, unknownCostRequests: 1, costUsd: 220 / 1e6 });
    expect(report.models).toHaveLength(2);
    const empty = await c.request<UsageReport>(W.UsageQuery, { from: Date.now() - 86400000, to: Date.now(), workspaceRoot: await fs.realpath(other) });
    expect(empty.totals.requests).toBe(0);
    const overview = await c.request<DesktopOverview>(W.Overview);
    expect(overview.channels.find((c) => c.id === 'local')).toMatchObject({ credentialReady: true, reasoningLevels: [], balance: { amount: 3, source: 'manual' } });
    expect(JSON.stringify(overview)).not.toContain('test-secret-not-returned');
    expect((await c.request(Method.CostWorkspace)).totals.requests).toBe(2);
    await host.close();
    const c2 = await boot({ LOCAL_KEY: 'test-secret-not-returned' });
    const recovered = await c2.request<SessionInspection>(W.SessionInspect, { sessionId: id });
    expect(recovered.totals).toEqual(report.totals);
    await command(c2, Method.TurnSend, id, { text: 'after restart' }); await idle(c2, id);
    expect(requests[2].messages.filter((m: any) => m.content === 'first input')).toHaveLength(1);
  });

  it('busy reservation, approval configure rejection, permission engine change, deduplicated subscriptions and unsubscribe', async () => {
    const c = await boot(); const id = await session(c, { permissionMode: 'default' });
    await c.request(Method.SessionSubscribe, { sessionId: id });
    await c.request(Method.SessionSubscribe, { sessionId: id });
    await command(c, Method.TurnSend, id, { text: 'first' }); await idle(c, id);
    const deltas = c.notifications.filter((n) => n.method === Notification.SessionEvent && n.params.delta.events.length);
    expect(new Set(deltas.map((n) => n.params.delta.fromSeq)).size).toBe(deltas.length);
    await command(c, W.SessionConfigure, id, { permissionMode: 'strict' });
    await command(c, Method.TurnSend, id, { text: 'read' });
    await until(() => c.notifications.some((n) => n.method === Notification.InteractionRequest));
    expect((await c.request<SessionSnapshot>(Method.SessionSnapshot, { sessionId: id })).runState).toBe('awaiting-approval');
    await expect(command(c, Method.TurnSend, id, { text: 'double' })).rejects.toMatchObject({ kind: 'conflict_in_flight' });
    await expect(command(c, W.SessionConfigure, id, { permissionMode: 'default' })).rejects.toMatchObject({ kind: 'conflict_in_flight' });
    await expect(c.request(W.SessionArchive, { sessionId: id, archived: true })).rejects.toMatchObject({ kind: 'conflict_in_flight' });
    await c.request(Method.SessionUnsubscribe, { sessionId: id }); const n = c.notifications.filter((x) => x.method === Notification.SessionEvent).length;
    const interaction = c.notifications.find((x) => x.method === Notification.InteractionRequest)!.params.interaction;
    await command(c, Method.InteractionResolve, id, { interactionId: interaction.id, optionId: 'once' }); await idle(c, id);
    expect(c.notifications.filter((x) => x.method === Notification.SessionEvent)).toHaveLength(n);
    const inspection = await c.request<SessionInspection>(W.SessionInspect, { sessionId: id });
    expect(inspection.totals.requests).toBe(3); expect(inspection.resources.every((r) => !r.supported)).toBe(true);
  });

  it('connection close releases every registry listener, resubscribe replaces rather than leaks', async () => {
    const original = SessionRegistry.prototype.subscribe;
    const releases: ReturnType<typeof vi.fn>[] = [];
    const spy = vi.spyOn(SessionRegistry.prototype, 'subscribe').mockImplementation(function (this: SessionRegistry, id, fn) {
      const release = vi.fn(original.call(this, id, fn)); releases.push(release); return release;
    });
    try {
      const c = await boot(); const id = await session(c);
      await c.request(Method.SessionSubscribe, { sessionId: id });
      await c.request(Method.SessionSubscribe, { sessionId: id });
      expect(releases[0]).toHaveBeenCalledTimes(1); expect(releases[1]).not.toHaveBeenCalled();
      c.ws.close(); await until(() => releases[1]!.mock.calls.length === 1);
      const c2 = await connect(); await c2.request(Method.SessionSubscribe, { sessionId: id });
      await c2.request(Method.SessionUnsubscribe, { sessionId: id });
      expect(releases[2]).toHaveBeenCalledTimes(1);
      c2.ws.close();
    } finally { spy.mockRestore(); }
  });

  it('invalid input, CAS, missing credentials and configured permission/model checks', async () => {
    const c = await boot(); const id = await session(c);
    for (const mode of ['god', '', null]) await expect(c.request(Method.SessionCreate, { permissionMode: mode })).rejects.toMatchObject({ kind: 'invalid_request' });
    await expect(c.request(Method.SessionRename, { sessionId: id, title: '  ' })).rejects.toMatchObject({ kind: 'invalid_request' });
    await expect(c.request(W.ChannelSave, { ...channel('https://user:secret@bad.test'), apiKey: 'secret' })).rejects.toMatchObject({ kind: 'invalid_request' });
    await expect(c.request(W.UsageQuery, { from: 3, to: 2 })).rejects.toMatchObject({ kind: 'invalid_request' });
    await c.request(W.ChannelSave, channel('https://example.test/v1'));
    await expect(command(c, W.SessionConfigure, id, { model: 'local:a' })).rejects.toMatchObject({ kind: 'unsupported_capability' });
    await expect(c.request(Method.SessionCreate, { model: 'unknown:model' })).rejects.toMatchObject({ kind: 'unsupported_capability' });
    const stale = await c.request<AckResult>(W.SessionConfigure, { sessionId: id, commandId: 'stale', baseRevision: 999, permissionMode: 'plan' });
    expect(stale.status).toBe('stale');
    expect((await c.request<SessionSnapshot>(Method.SessionSnapshot, { sessionId: id })).meta.permissionMode).toBe('default');
    await c.request(Method.ConfigSet, { key: 'language', value: 'zh' });
    await expect(fs.stat(path.join(home, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('concurrent sends, stop and no-usage/error requests are ledger facts', async () => {
    const responses: ServerResponse[] = [];
    let count = 0;
    const url = await localProvider((_body, res) => { count++; if (count === 1) responses.push(res); else if (count === 2) answer(res, 'no usage', false); else { res.writeHead(401); res.end('upstream-secret'); } });
    const c = await boot({ LOCAL_KEY: 'key' }); await c.request(W.ChannelSave, channel(url)); const id = await session(c, { model: 'local:a' });
    const snap = await c.request<SessionSnapshot>(Method.SessionSnapshot, { sessionId: id });
    const a = { sessionId: id, commandId: 'one', baseRevision: snap.revision, text: 'one' };
    const results = await Promise.allSettled([c.request<AckResult>(Method.TurnSend, a), c.request<AckResult>(Method.TurnSend, { ...a, commandId: 'two', text: 'two' })]);
    expect(results.filter((r) => r.status === 'fulfilled' && r.value.status === 'accepted')).toHaveLength(1);
    await until(() => responses.length === 1);
    await command(c, Method.TurnStop, id); await idle(c, id);
    await command(c, Method.TurnSend, id, { text: 'without usage' }); await idle(c, id);
    await command(c, Method.TurnSend, id, { text: 'error' }); await idle(c, id);
    const stats = await c.request<SessionInspection>(W.SessionInspect, { sessionId: id });
    expect(stats.totals).toMatchObject({ requests: 3, cancelled: 1, errors: 1, unknownUsageRequests: 3, unknownCostRequests: 3 });
    expect(JSON.stringify(await c.request<SessionSnapshot>(Method.SessionSnapshot, { sessionId: id }))).not.toContain('upstream-secret');
  }, 15000);
});
