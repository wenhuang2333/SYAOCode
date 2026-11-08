import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptySnapshot, type UsageRecord } from '@liwencode/dhp';
import type { Provider } from '@liwencode/core';
import { nodeRuntime } from '@liwencode/node';
import { DesktopStateStore, repairHistory } from '../src/desktop-state.ts';
import { SessionRegistry } from '../src/session-registry.ts';
import { observeProvider, pricedCost, queryUsage, totals } from '../src/usage.ts';
import { wireUsageRuntime } from '../src/provider-usage.ts';
import { channelSchema, usageQuerySchema } from '../src/workbench-validation.ts';

const dirs: string[] = [];
const stores: DesktopStateStore[] = [];
async function directory() { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-data-')); dirs.push(d); return d; }
async function open(d: string) { const s = await DesktopStateStore.open(d); stores.push(s); return s; }
afterEach(async () => { for (const s of stores.splice(0)) await s.close(); for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }); });

const record = (patch: Partial<UsageRecord> = {}): UsageRecord => ({ id: 'r1', sessionId: 's1', workspaceRoot: '/a', channelId: 'c', model: 'c:m', startedAt: 100, endedAt: 110, status: 'ok', inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, costUsd: null, ...patch });
describe('Desktop persistence', () => {
  it('serial atomic snapshots, separate homes, exclusive same-home lock and release', async () => {
    const d = await directory(); const a = await open(d); const b = await open(await directory());
    await expect(DesktopStateStore.open(d)).rejects.toThrow(/locked/);
    a.data.defaults.language = 'en'; const first = a.save();
    a.data.defaults.language = 'zh'; const second = a.save();
    await Promise.all([first, second]);
    expect(JSON.parse(await fs.readFile(a.file, 'utf8')).defaults.language).toBe('zh');
    expect(b.data.defaults).toEqual({});
    await a.close();
    expect((await open(d)).data.defaults.language).toBe('zh');
    expect((await fs.readdir(d)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
  it('recovers a proven dead process lock, never an incomplete lock', async () => {
    const d = await directory();
    const child = spawnSync(process.execPath, ['-e', '']);
    expect(child.status).toBe(0);
    await fs.writeFile(path.join(d, 'host.lock'), JSON.stringify({ pid: child.pid }));
    const s = await open(d); await s.close();
    await fs.writeFile(path.join(d, 'host.lock'), '');
    await expect(DesktopStateStore.open(d)).rejects.toThrow(/locked/);
    expect(await fs.readFile(path.join(d, 'host.lock'), 'utf8')).toBe('');
  });
  it.each(['{broken', '{"version":99}', '{"version":1,"sessions":[]}'])('corrupt or unknown schema retains original %s', async (raw) => {
    const d = await directory(); const file = path.join(d, 'state-v1.json'); await fs.writeFile(file, raw);
    await expect(DesktopStateStore.open(d)).rejects.toThrow(/original retained/);
    expect(await fs.readFile(file, 'utf8')).toBe(raw);
    expect(await fs.readdir(d)).toEqual(['state-v1.json']);
  });
  it('restores complete blocks, repairs interrupted tools, advances epoch and drops approvals', async () => {
    const d = await directory(); const s = await open(d);
    const snapshot = emptySnapshot({ sessionId: 's', title: 'saved', model: 'mock:default', permissionMode: 'strict', workspaceRoot: '/w', createdAt: 0, updatedAt: 1 });
    s.data.workspaces.push({ id: 'w', root: '/w', name: 'w', addedAt: 0 });
    s.data.sessions.push({ snapshot: { ...snapshot, pendingInteractions: [{ id: 'approval', kind: 'permission', createdAt: 1, sessionId: 's', subject: 'read', risk: 'read', options: [{ id: 'deny', label: 'deny', scope: 'deny' }] }], runState: 'awaiting-approval', rows: [{ kind: 'toolCall', key: 'c', seq: 0, callId: 'c', name: 'read', input: {}, state: 'running' }] }, turn: 2, archived: true, messages: [
      { id: 'u', role: 'user', content: [{ type: 'text', text: 'read' }] },
      { id: 'a', role: 'assistant', content: [{ type: 'thinking', text: 'think', signature: 'signature' }, { type: 'tool_use', id: 'c', name: 'read', input: { path: 'x' } }], meta: { createdAt: 2, providerData: { opaque: true } } },
    ] });
    await s.save(); await s.close(); const loaded = await open(d); const saved = loaded.data.sessions[0]!;
    const history = repairHistory(saved.messages);
    expect(history[1]).toEqual(saved.messages[1]);
    expect(history[2]?.content[0]).toMatchObject({ type: 'tool_result', toolUseId: 'c', isError: true });
    expect(repairHistory(history)).toEqual(history);
    const state = new SessionRegistry().restore(saved);
    expect(state.archived).toBe(true); expect(state.snapshot.epoch).toBe(2); expect(state.runState).toBe('idle');
    expect(state.snapshot.pendingInteractions).toEqual([]); expect(state.snapshot.rows[0]).toMatchObject({ state: 'error' });
  });
});

describe('request analytics', () => {
  it('counts requests not sessions, unknown fees, normalized cache and consistent filters/zero days', () => {
    const a = new Date(2026, 10, 1, 12).getTime(); const b = new Date(2026, 10, 3, 12).getTime();
    const rs = [record({ startedAt: a, endedAt: a + 5 }), record({ id: 'r2', startedAt: b, endedAt: b + 3, model: 'c:new', costUsd: 1 }), record({ id: 'r3', workspaceRoot: '/b', startedAt: a, endedAt: a, status: 'error', inputTokens: null, outputTokens: null, cacheReadTokens: null })];
    const report = queryUsage(rs, { from: a, to: b, workspaceRoot: '/a' });
    expect(report.totals).toMatchObject({ requests: 2, activeSessions: 1, totalTokens: 220, cacheReadTokens: 40, unknownCostRequests: 1, costUsd: 1 });
    expect(report.days).toHaveLength(3); expect(report.days[1]?.totals.requests).toBe(0);
    expect(report.models).toHaveLength(2); expect(report.projects.map((g) => g.id)).toEqual(['/a']);
    expect(report.channels[0]?.totals).toEqual(report.totals);
    expect(totals([rs[2]!])).toMatchObject({ requests: 1, errors: 1, unknownUsageRequests: 1, costUsd: null });
    expect(totals([]).requests).toBe(0);
    expect(queryUsage(rs, { from: b, to: b }).totals.requests).toBe(1);
  });
  it('only prices applicable usage and never double-adds cached tokens', () => {
    const u = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 };
    expect(pricedCost(u, { id: 'm', name: 'm' })).toBeNull();
    expect(pricedCost(u, { id: 'm', name: 'm', inputPricePerMillion: 2, outputPricePerMillion: 4, cacheReadPricePerMillion: 1 })).toBe(230 / 1e6);
    expect(pricedCost({ ...u, cacheWriteTokens: 1 }, { id: 'm', name: 'm', inputPricePerMillion: 2, outputPricePerMillion: 4 })).toBeNull();
    expect(pricedCost({ ...u, costUsd: 0.5 }, { id: 'm', name: 'm' })).toBe(0.5);
  });
  it('observes each actual attempt once, captures context, records failures and cancellation', async () => {
    const ledger = new Map<string, UsageRecord>(); const contexts: unknown[] = [];
    let calls = 0;
    const provider: Provider = { id: 'test', capabilities: () => ({ contextWindow: 1024, maxOutputTokens: 128, parallelToolCalls: false, thinking: 'none', promptCache: 'none', vision: false, structuredOutput: false }),
      async *stream() { calls++; if (calls === 2) throw new Error('failed'); if (calls === 3) return;
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } };
        yield { type: 'message_stop', stopReason: 'end_turn', message: { id: 'm', role: 'assistant', content: [] } };
      } };
    const p = observeProvider(provider, { sessionId: 's', workspaceRoot: '/a', channelId: 'test', model: { id: 'm', name: 'm', contextWindow: 2048 }, onContext: (c) => contexts.push(c), onUsage: async (r) => { ledger.set(r.id, r); } });
    const req = { model: 'm', system: 'system', messages: [], tools: [] };
    for await (const _ of p.stream(req, { signal: new AbortController().signal })) { /* drain */ }
    await expect((async () => { for await (const _ of p.stream(req, { signal: new AbortController().signal })) { /* drain */ } })()).rejects.toThrow();
    const ac = new AbortController(); ac.abort(); for await (const _ of p.stream(req, { signal: ac.signal })) { /* drain */ }
    expect(ledger.size).toBe(3); expect(totals([...ledger.values()])).toMatchObject({ requests: 3, errors: 1, cancelled: 1, inputTokens: 10, unknownUsageRequests: 2, costUsd: null });
    expect(contexts[0]).toMatchObject({ capacity: 2048, capacitySource: 'configured', source: 'estimated', compression: 'unsupported' });
  });
  it('Anthropic wire cache normalization and absent reporting stay unknown', async () => {
    const runtime = nodeRuntime();
    let text = 'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":5}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\n';
    runtime.http = { fetch: async () => ({ status: 200, headers: {}, text: async () => text }) };
    const wire = wireUsageRuntime(runtime, 'anthropic');
    await (await wire.runtime.http.fetch('https://unused')).text();
    expect(wire.usage()).toMatchObject({ inputTokens: 35, outputTokens: 3, cacheReadTokens: 20 });
    wire.reset(); text = 'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n';
    await (await wire.runtime.http.fetch('https://unused')).text();
    expect(wire.usage()).toMatchObject({ inputTokens: null, outputTokens: null, cacheReadTokens: null });
  });
});

describe('strict input boundaries', () => {
  const valid = { id: 'custom', name: 'custom', protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'MY_KEY', models: [{ id: 'my-model', name: 'model' }] };
  it.each([
    { baseUrl: 'http://example.com' }, { baseUrl: 'https://u:secret@example.com' }, { baseUrl: 'https://example.com?key=secret' },
    { apiKey: 'secret' }, { protocol: 'mock' }, { models: [{ id: 'm', name: 'm', contextWindow: Infinity }] },
    { models: [{ id: 'm', name: 'm', inputPricePerMillion: -1 }] },
    { models: [{ id: 'm', name: 'm' }, { id: 'm', name: 'm' }] },
    { balance: { amount: -1, currency: 'USD', source: 'manual', updatedAt: 0 } },
  ])('rejects invalid channel %j', (patch) => expect(channelSchema.safeParse({ ...valid, ...patch }).success).toBe(false));
  it('accepts loopback HTTP and manual zero, rejects invalid dates', () => {
    expect(channelSchema.safeParse({ ...valid, baseUrl: 'http://127.0.0.1:1234/v1', balance: { amount: 0, currency: 'CNY', source: 'manual', updatedAt: 0 } }).success).toBe(true);
    expect(channelSchema.safeParse({ ...valid, id: 'Work.Provider', baseUrl: undefined }).success).toBe(true);
    expect(usageQuerySchema.safeParse({ from: 3, to: 2 }).success).toBe(false);
    expect(usageQuerySchema.safeParse({ from: 0, to: Infinity }).success).toBe(false);
  });
});
