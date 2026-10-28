import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AGENT_EVENT_SCHEMA_VERSION,
  createAgent,
  executeToolCall,
  MemoryEventSink,
  MemoryPermissionRuleStore,
  MemoryReceiptStore,
  PermissionEngine,
  decodeChunkStream,
  sha256Hex,
  textContent,
  ToolRegistry,
  type AgentEvent,
  type Message,
  type ModelStreamEvent,
  type PermissionDecision,
  type PermissionRule,
  type ProcessHandle,
  type Provider,
  type Tool,
  type ToolReceipt,
} from '../src';
import { fakeRuntime } from './helpers';

/**
 * Kernel prerequisites C1–C6 (document/Agent-RPC/03 §4). Each block names the
 * report item it proves, because these are the contracts the three protocol
 * adapters will be built on.
 */

function scripted(script: Message[]): Provider {
  let turn = 0;
  return {
    id: 'scripted',
    capabilities: () => ({
      contextWindow: 100_000,
      maxOutputTokens: 4_096,
      parallelToolCalls: true,
      thinking: 'none',
      promptCache: 'none',
      vision: false,
      structuredOutput: true,
    }),
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      const message = script[turn];
      turn += 1;
      if (message === undefined) throw new Error('script exhausted');
      yield { type: 'message_start', messageId: message.id };
      yield { type: 'message_stop', stopReason: message.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', message };
    },
  };
}

const echo: Tool<{ text: string }> = {
  name: 'echo',
  description: 'echo',
  inputSchema: z.object({ text: z.string() }),
  risk: 'read',
  readOnly: true,
  concurrencySafe: true,
  async execute(input) {
    return { content: textContent(`echo:${input.text}`) };
  },
};

function msg(id: string, blocks: Message['content']): Message {
  return { id, role: 'assistant', content: blocks, meta: { createdAt: 0 } };
}

const echoScript = (): Provider =>
  scripted([
    msg('a1', [{ type: 'tool_use', id: 'c1', name: 'echo', input: { text: 'hi' } }]),
    msg('a2', [{ type: 'text', text: 'done' }]),
  ]);

describe('C1 · approval events are visible before the handler is awaited', () => {
  it('delivers permission.request to the event sink before the handler resolves', async () => {
    const sink = new MemoryEventSink();
    let seenInsideHandler = -1;
    let release!: (d: PermissionDecision) => void;
    const pending = new Promise<PermissionDecision>((r) => {
      release = r;
    });
    const agent = createAgent({
      provider: echoScript(),
      model: 'm',
      tools: [echo],
      permissionMode: 'strict',
      runtime: fakeRuntime(),
      eventSink: sink,
      permissionHandler: async () => {
        // The prompt must already be visible to subscribers at this point.
        seenInsideHandler = sink.ofType('permission.request').length;
        return pending;
      },
    });
    const running = agent.runOnce('go');
    // Give the loop a chance to reach the permission gate, then answer.
    await new Promise((r) => setTimeout(r, 0));
    expect(seenInsideHandler).toBe(1);
    expect(sink.ofType('permission.request')).toHaveLength(1);
    release({ decision: 'allow' });
    const summary = await running;
    expect(summary.endReason).toBe('completed');
    expect(sink.ofType('permission.result')).toHaveLength(1);
  });

  it('yields permission.request from the run stream while the handler is pending', async () => {
    let release!: (d: PermissionDecision) => void;
    const pending = new Promise<PermissionDecision>((r) => {
      release = r;
    });
    const agent = createAgent({
      provider: echoScript(),
      model: 'm',
      tools: [echo],
      permissionMode: 'strict',
      runtime: fakeRuntime(),
      permissionHandler: async () => pending,
    });
    const stream = agent.run('go');
    const seen: AgentEvent[] = [];
    let answered = false;
    for (;;) {
      const step = await stream.next();
      if (step.done) break;
      seen.push(step.value);
      if (step.value.type === 'permission.request') {
        // We observed the prompt before answering it: this is exactly the C1
        // contract a multi-client host depends on.
        expect(answered).toBe(false);
        answered = true;
        release({ decision: 'allow' });
      }
    }
    expect(answered).toBe(true);
    expect(seen.some((e) => e.type === 'permission.request')).toBe(true);
    // Stream order still matches seq order (event contract v2 invariant).
    expect(seen.map((e) => e.seq)).toEqual(seen.map((_, i) => i + 1));
  });

  it('keeps the approval request id stable across recheck rounds', async () => {
    const ids: string[] = [];
    let rounds = 0;
    const engine = new PermissionEngine({
      mode: 'default',
      rules: [],
      workspaceRoots: ['/ws'],
      runtime: fakeRuntime(),
      onRequestStart: (req) => ids.push(req.id),
      onRequest: async () => {
        rounds += 1;
        return rounds === 1 ? { recheck: true } : { decision: 'allow' };
      },
    });
    const outcome = await engine.checkSubject('write', 'write', { path: '/ws/a.txt' });
    expect(outcome.outcome).toBe('allow');
    expect(rounds).toBe(2);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });
});

describe('C2 · event envelope carries schemaVersion / ts / sessionId', () => {
  it('stamps every event and lifts sessionId out of session.start', async () => {
    const agent = createAgent({
      provider: scripted([msg('a1', [{ type: 'text', text: 'hi' }])]),
      model: 'm',
      runtime: fakeRuntime(),
    });
    const events: AgentEvent[] = [];
    for await (const ev of agent.run('go')) events.push(ev);
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev.schemaVersion).toBe(AGENT_EVENT_SCHEMA_VERSION);
      expect(typeof ev.ts).toBe('number');
      expect(ev.sessionId).toBe(agent.sessionId);
    }
    const start = events[0];
    expect(start?.type).toBe('session.start');
    if (start?.type === 'session.start') expect(start.sessionId).toBe(start.sessionId);
  });
});

describe('C3 · MemoryEventSink', () => {
  it('records every event and reports its closed state', async () => {
    const sink = new MemoryEventSink();
    const agent = createAgent({
      provider: scripted([msg('a1', [{ type: 'text', text: 'hi' }])]),
      model: 'm',
      runtime: fakeRuntime(),
      eventSink: sink,
    });
    await agent.runOnce('go');
    expect(sink.events.length).toBeGreaterThan(3);
    expect(sink.ofType('session.start')).toHaveLength(1);
    expect(sink.ofType('session.end')).toHaveLength(1);
    expect(sink.isClosed).toBe(false);
    sink.close();
    expect(sink.isClosed).toBe(true);
    const before = sink.events.length;
    sink.emit({ type: 'turn.start', turn: 9, seq: 99, runId: 'x' } as AgentEvent);
    expect(sink.events.length).toBe(before);
  });
});

describe('C4 · real trust and sandbox values reach the receipt and the block', () => {
  const remoteTool: Tool<{ text: string }> = {
    name: 'remote',
    description: 'mcp-style tool',
    inputSchema: z.object({ text: z.string() }),
    risk: 'read',
    readOnly: true,
    concurrencySafe: true,
    trust: 'untrusted',
    async execute(input) {
      return { content: textContent(input.text), meta: { sandbox: 'container' } };
    },
  };

  async function run(tool: Tool<{ text: string }>, input: { text: string }) {
    const runtime = fakeRuntime();
    const registry = new ToolRegistry();
    registry.register(tool);
    const engine = new PermissionEngine({ mode: 'bypass', rules: [], workspaceRoots: ['/ws'], runtime });
    const receipts: ToolReceipt[] = [];
    const block = await executeToolCall({ id: 'c1', name: tool.name, input }, registry, engine, runtime, {
      cwd: '/ws',
      signal: new AbortController().signal,
      receipts: new MemoryReceiptStore(),
      events: { onToolReceipt: (r) => receipts.push(r) },
    });
    return { receipt: receipts[0]!, block };
  }

  it("marks an untrusted tool's result and receipt accordingly", async () => {
    const { receipt, block } = await run(remoteTool, { text: 'from the internet' });
    expect(receipt.trust).toBe('untrusted');
    expect(receipt.sandbox).toBe('container');
    expect(block.trust).toBe('untrusted');
  });

  it('lets a per-result meta override the declared trust', async () => {
    const override: Tool<{ text: string }> = {
      ...remoteTool,
      name: 'local-but-declared',
      async execute(input) {
        return { content: textContent(input.text), meta: { trust: 'workspace', sandbox: 'platform' } };
      },
    };
    const { receipt, block } = await run(override, { text: 'x' });
    expect(receipt.trust).toBe('workspace');
    expect(receipt.sandbox).toBe('platform');
    // 'workspace' keeps the historical unset block field.
    expect(block.trust).toBeUndefined();
  });

  it('defaults to workspace/none for a plain local tool', async () => {
    const { receipt, block } = await run(echo, { text: 'x' });
    expect(receipt.trust).toBe('workspace');
    expect(receipt.sandbox).toBe('none');
    expect(block.trust).toBeUndefined();
  });
});

describe('C5 · approval memory semantics', () => {
  function engineWith(store: MemoryPermissionRuleStore, answer: PermissionDecision) {
    const state = { asked: 0 };
    const engine = new PermissionEngine({
      mode: 'default',
      rules: [],
      workspaceRoots: ['/ws'],
      runtime: fakeRuntime(),
      ruleStore: store,
      onRequest: async () => {
        state.asked += 1;
        return answer;
      },
    });
    return { engine, state };
  }

  it("remember:'once' adds no rule (the same call asks again)", async () => {
    const store = new MemoryPermissionRuleStore();
    const { engine, state } = engineWith(store, { decision: 'allow', remember: 'once' });
    expect((await engine.checkSubject('write', 'write', { path: '/ws/a.txt' })).outcome).toBe('allow');
    expect((await engine.checkSubject('write', 'write', { path: '/ws/a.txt' })).outcome).toBe('allow');
    expect(state.asked).toBe(2);
    expect(await store.load()).toEqual([]);
  });

  it("remember:'session' adds an in-memory rule only", async () => {
    const store = new MemoryPermissionRuleStore();
    const { engine, state } = engineWith(store, { decision: 'allow', remember: 'session' });
    expect((await engine.checkSubject('write', 'write', { path: '/ws/a.txt' })).outcome).toBe('allow');
    expect((await engine.checkSubject('write', 'write', { path: '/ws/a.txt' })).outcome).toBe('allow');
    expect(state.asked).toBe(1);
    expect(await store.load()).toEqual([]);
  });

  it("remember:'project' persists the rule and a new engine picks it up", async () => {
    const store = new MemoryPermissionRuleStore();
    const { engine } = engineWith(store, { decision: 'allow', remember: 'project' });
    expect((await engine.checkSubject('write', 'write', { path: '/ws/a.txt' })).outcome).toBe('allow');
    const saved = await store.load();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ effect: 'allow', tool: 'write', source: 'user', match: { path: '/ws/a.txt' } });

    // A fresh engine (new process) hydrates from the store and does not ask.
    let asked = 0;
    const restarted = new PermissionEngine({
      mode: 'default',
      rules: [],
      workspaceRoots: ['/ws'],
      runtime: fakeRuntime(),
      ruleStore: store,
      onRequest: async () => {
        asked += 1;
        return { decision: 'deny' };
      },
    });
    await restarted.init();
    expect((await restarted.checkSubject('write', 'write', { path: '/ws/a.txt' })).outcome).toBe('allow');
    expect(asked).toBe(0);
  });

  it('never remembers a sensitive approval', async () => {
    const store = new MemoryPermissionRuleStore();
    const { engine } = engineWith(store, { decision: 'allow', remember: 'project' });
    const outcome = await engine.checkSubject('write', 'write', { path: '/ws/.env' });
    expect(outcome.outcome).toBe('allow');
    expect(await store.load()).toEqual([]);
  });

  it('a remembered allow can never outrank a deny rule (BR-001)', async () => {
    const deny: PermissionRule = { effect: 'deny', tool: 'write', source: 'user' };
    const engine = new PermissionEngine({
      mode: 'default',
      rules: [deny],
      workspaceRoots: ['/ws'],
      runtime: fakeRuntime(),
      ruleStore: new MemoryPermissionRuleStore([
        { effect: 'allow', tool: 'write', source: 'user', match: { path: '/ws/a.txt' } },
      ]),
      onRequest: async () => ({ decision: 'allow' }),
    });
    await engine.init();
    const outcome = await engine.checkSubject('write', 'write', { path: '/ws/a.txt' });
    expect(outcome.outcome).toBe('deny');
  });
});

describe('C6 · governance digests are SHA-256', () => {
  it('hashes receipts with SHA-256, not the FNV fencing digest', async () => {
    const runtime = fakeRuntime();
    const registry = new ToolRegistry();
    registry.register(echo);
    const engine = new PermissionEngine({ mode: 'bypass', rules: [], workspaceRoots: ['/ws'], runtime });
    const receipts: ToolReceipt[] = [];
    await executeToolCall({ id: 'c1', name: 'echo', input: { text: 'x' } }, registry, engine, runtime, {
      cwd: '/ws',
      signal: new AbortController().signal,
      events: { onToolReceipt: (r) => receipts.push(r) },
    });
    const receipt = receipts[0]!;
    expect(receipt.outputHash).toBe(sha256Hex('echo:x'));
    expect(receipt.outputHash).toHaveLength(64);
    expect(receipt.inputHash).toHaveLength(64);
  });

  it('prefers an injected Runtime.hash provider', async () => {
    const runtime = { ...fakeRuntime(), hash: { sha256: () => 'injected-digest' } };
    const registry = new ToolRegistry();
    registry.register(echo);
    const engine = new PermissionEngine({ mode: 'bypass', rules: [], workspaceRoots: ['/ws'], runtime });
    const receipts: ToolReceipt[] = [];
    await executeToolCall({ id: 'c1', name: 'echo', input: { text: 'x' } }, registry, engine, runtime, {
      cwd: '/ws',
      signal: new AbortController().signal,
      events: { onToolReceipt: (r) => receipts.push(r) },
    });
    expect(receipts[0]?.outputHash).toBe('injected-digest');
  });

  it('MemoryReceiptStore content-addresses with SHA-256', async () => {
    const store = new MemoryReceiptStore();
    const stored = await store.put('hello');
    expect(stored.hash).toBe(sha256Hex('hello'));
    expect(stored.ref).toBe(`mem://${sha256Hex('hello')}`);
  });
});

describe('ProcessHandle raw chunk streams (stdio framing regression)', () => {
  it('decodeChunkStream preserves newlines and reassembles multi-byte characters', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('Content-Length: 20\r\n\r\n{"text":"你好"}\n');
    // Split inside the header AND inside the multi-byte character.
    const chunks = (async function* () {
      yield bytes.subarray(0, 9);
      yield bytes.subarray(9, 30);
      yield bytes.subarray(30);
    })();
    const parts: string[] = [];
    for await (const part of decodeChunkStream(chunks)) parts.push(part);
    const joined = parts.join('');
    // The header/body separator survives verbatim: this is what a line
    // iterator destroys.
    expect(joined).toContain('\r\n\r\n');
    expect(joined).toBe('Content-Length: 20\r\n\r\n{"text":"你好"}\n');
  });

  it('the type is optional on ProcessHandle so line-only hosts keep working', () => {
    const handle: ProcessHandle = {
      pid: 1,
      stdout: (async function* () {})(),
      stderr: (async function* () {})(),
      exited: Promise.resolve(0),
      kill() {},
    };
    expect(handle.stdoutChunks).toBeUndefined();
    expect(handle.stdin).toBeUndefined();
  });
});
