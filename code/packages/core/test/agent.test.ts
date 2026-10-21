import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createAgent,
  textContent,
  type AgentEvent,
  type Message,
  type ModelStreamEvent,
  type Provider,
  type Tool,
} from '../src';
import { fakeRuntime } from './helpers';

/** Scripted provider local to core tests (kernel depends on no other package). */
function scripted(script: Message[]): Provider & { requests: unknown[] } {
  const requests: unknown[] = [];
  let turn = 0;
  return {
    id: 'scripted',
    requests,
    capabilities: () => ({
      contextWindow: 100_000,
      maxOutputTokens: 4_096,
      parallelToolCalls: true,
      thinking: 'none',
      promptCache: 'none',
      vision: false,
      structuredOutput: true,
    }),
    async *stream(req): AsyncGenerator<ModelStreamEvent> {
      requests.push(req);
      const message = script[turn];
      turn += 1;
      if (message === undefined) throw new Error('script exhausted');
      yield { type: 'message_start', messageId: message.id };
      yield { type: 'block_start', index: 0, block: message.content[0]! };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield {
        type: 'message_stop',
        stopReason: message.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        message,
      };
    },
  };
}

function msg(id: string, blocks: Message['content']): Message {
  return { id, role: 'assistant', content: blocks, meta: { createdAt: 0 } };
}

/** echo tool: read-only, concurrency-safe */
const echoTool: Tool<{ text: string }> = {
  name: 'echo',
  description: 'echo the text back',
  inputSchema: z.object({ text: z.string() }),
  risk: 'read',
  readOnly: true,
  concurrencySafe: true,
  async execute(input) {
    return { content: textContent(`echo:${input.text}`) };
  },
};

const failTool: Tool<{ key: string }> = {
  name: 'fail',
  description: 'always fails',
  inputSchema: z.object({ key: z.string() }),
  risk: 'read',
  readOnly: true,
  concurrencySafe: true,
  async execute() {
    throw new Error('boom');
  },
};

const slowTool: Tool<{ ms: number }> = {
  name: 'slow',
  description: 'sleeps',
  inputSchema: z.object({ ms: z.number() }),
  risk: 'read',
  readOnly: true,
  concurrencySafe: true,
  timeoutMs: 50,
  async execute(input, ctx) {
    await new Promise((r) => setTimeout(r, input.ms));
    void ctx;
    return { content: textContent('done') };
  },
};

describe('agent loop (FR-001..006)', () => {
  it('FR-002/003: runs tool round-trips until no tool call, then completes', async () => {
    const provider = scripted([
      msg('a1', [{ type: 'tool_use', id: 'c1', name: 'echo', input: { text: 'hi' } }]),
      msg('a2', [{ type: 'text', text: 'all done' }]),
    ]);
    const agent = createAgent({ provider, model: 'm', tools: [echoTool], runtime: fakeRuntime() });
    const summary = await agent.runOnce('go');
    expect(summary.endReason).toBe('completed');
    expect(summary.finalText).toBe('all done');
    // history: user, assistant(tool_use), user(tool_result), assistant(text)
    expect(agent.history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('FR-004/BR-008: consecutive read-only calls batch in parallel and results keep order', async () => {
    const provider = scripted([
      msg('a1', [
        { type: 'tool_use', id: 'c1', name: 'echo', input: { text: 'one' } },
        { type: 'tool_use', id: 'c2', name: 'echo', input: { text: 'two' } },
        { type: 'tool_use', id: 'c3', name: 'echo', input: { text: 'three' } },
      ]),
      msg('a2', [{ type: 'text', text: 'ok' }]),
    ]);
    const agent = createAgent({ provider, model: 'm', tools: [echoTool], runtime: fakeRuntime() });
    const events: AgentEvent[] = [];
    const stream = agent.run('go');
    for (;;) {
      const r = await stream.next();
      if (r.done) break;
      events.push(r.value);
    }
    const toolResults = events.filter((e): e is Extract<AgentEvent, { type: 'tool.result' }> => e.type === 'tool.result');
    expect(toolResults.map((e) => e.callId)).toEqual(['c1', 'c2', 'c3']);
    // BR-009: each tool_use has exactly one tool_result in history
    const resultMsg = agent.history.find((m) => m.content.some((b) => b.type === 'tool_result'));
    const results = resultMsg?.content.filter((b) => b.type === 'tool_result') ?? [];
    expect(results).toHaveLength(3);
  });

  it('FR-005/BR-009: abort backfills pending tool_use with SY-LOOP-003 and history stays legal', async () => {
    const provider = scripted([
      msg('a1', [
        { type: 'tool_use', id: 'c1', name: 'slow', input: { ms: 10_000 } },
        { type: 'tool_use', id: 'c2', name: 'echo', input: { text: 'never' } },
      ]),
    ]);
    const agent = createAgent({ provider, model: 'm', tools: [slowTool, echoTool], runtime: fakeRuntime() });
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('stop')), 30);
    const summary = await agent.runOnce('go', { signal: ac.signal });
    expect(summary.endReason).toBe('aborted');
    const toolResults = agent.history.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    expect(toolResults).toHaveLength(2);
    const texts = JSON.stringify(toolResults.map((b) => (b.type === 'tool_result' ? b.content : null)));
    expect(texts).toContain('SY-LOOP-003');
  });

  it('FR-006/BR-010: maxTurns stops with SY-LOOP-001 and exit-classifying reason', async () => {
    const looping = Array.from({ length: 10 }, (_, i) =>
      msg(`a${i}`, [{ type: 'tool_use', id: `c${i}`, name: 'echo', input: { text: 'again' } }]),
    );
    const provider = scripted(looping);
    const agent = createAgent({ provider, model: 'm', tools: [echoTool], runtime: fakeRuntime(), limits: { maxTurns: 3 } });
    const summary = await agent.runOnce('go');
    expect(summary.endReason).toBe('max_turns');
    expect(summary.turns).toBe(3);
  });

  it('BR-011: same failing call 3x appends a warning note; 5x ends with repeated_failure', async () => {
    const calls = Array.from({ length: 6 }, (_, i) =>
      msg(`a${i}`, [{ type: 'tool_use', id: `c${i}`, name: 'fail', input: { key: 'same' } }]),
    );
    const provider = scripted(calls);
    const agent = createAgent({ provider, model: 'm', tools: [failTool], runtime: fakeRuntime(), limits: { maxTurns: 10 } });
    const summary = await agent.runOnce('go');
    expect(summary.endReason).toBe('repeated_failure');
    const allResults = JSON.stringify(agent.history);
    expect(allResults).toContain('failed 3 times in a row');
  });

  it('SY-TOOL-001: unregistered tool returns a structured error listing available tools', async () => {
    const provider = scripted([
      msg('a1', [{ type: 'tool_use', id: 'c1', name: 'nope', input: {} }]),
      msg('a2', [{ type: 'text', text: 'recovered' }]),
    ]);
    const agent = createAgent({ provider, model: 'm', tools: [echoTool], runtime: fakeRuntime() });
    const summary = await agent.runOnce('go');
    expect(summary.endReason).toBe('completed');
    const tr = agent.history.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
    expect(JSON.stringify(tr)).toContain('not registered');
    expect(JSON.stringify(tr)).toContain('echo');
  });

  it('SY-TOOL-002: zod failure feeds the model actionable info', async () => {
    const provider = scripted([
      msg('a1', [{ type: 'tool_use', id: 'c1', name: 'echo', input: { wrong: true } }]),
      msg('a2', [{ type: 'text', text: 'fixed' }]),
    ]);
    const agent = createAgent({ provider, model: 'm', tools: [echoTool], runtime: fakeRuntime() });
    await agent.runOnce('go');
    const tr = agent.history.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
    expect(JSON.stringify(tr)).toContain('Invalid arguments');
    expect(JSON.stringify(tr)).toContain('text');
  });

  it('SY-TOOL-004: tool timeout yields an error result, loop continues', async () => {
    const provider = scripted([
      msg('a1', [{ type: 'tool_use', id: 'c1', name: 'slow', input: { ms: 5_000 } }]),
      msg('a2', [{ type: 'text', text: 'after timeout' }]),
    ]);
    const agent = createAgent({ provider, model: 'm', tools: [slowTool], runtime: fakeRuntime() });
    const summary = await agent.runOnce('go');
    expect(summary.endReason).toBe('completed');
    expect(summary.finalText).toBe('after timeout');
    const tr = agent.history.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
    expect(JSON.stringify(tr)).toContain('exceeded its 50ms timeout');
  });

  it('NFR-004: multiple agents in one process keep independent history', async () => {
    const mk = () => {
      const provider = scripted([msg('a1', [{ type: 'text', text: 'mine' }])]);
      return createAgent({ provider, model: 'm', runtime: fakeRuntime() });
    };
    const agents = Array.from({ length: 20 }, mk);
    const summaries = await Promise.all(agents.map((a) => a.runOnce('x')));
    expect(summaries.every((s) => s.finalText === 'mine')).toBe(true);
    expect(new Set(agents.map((a) => a.sessionId)).size).toBe(20);
  });

  it('routes thinking block deltas to thinking.delta, not text.delta', async () => {
    const provider: Provider = {
      id: 'thinking',
      capabilities: () => ({
        contextWindow: 100_000,
        maxOutputTokens: 4_096,
        parallelToolCalls: true,
        thinking: 'budget',
        promptCache: 'none',
        vision: false,
        structuredOutput: true,
      }),
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        const thinking = { type: 'thinking' as const, text: 'plan' };
        const text = { type: 'text' as const, text: 'answer' };
        yield { type: 'block_start', index: 0, block: thinking };
        yield { type: 'block_delta', index: 0, delta: 'pla' };
        yield { type: 'block_delta', index: 0, delta: 'n' };
        yield { type: 'block_start', index: 1, block: text };
        yield { type: 'block_delta', index: 1, delta: 'answer' };
        yield {
          type: 'message_stop',
          stopReason: 'end_turn',
          message: { id: 'a1', role: 'assistant', content: [thinking, text], meta: { createdAt: 0 } },
        };
      },
    };
    const agent = createAgent({ provider, model: 'm', runtime: fakeRuntime() });
    const events: AgentEvent[] = [];
    const stream = agent.run('go');
    for (;;) {
      const r = await stream.next();
      if (r.done) break;
      events.push(r.value);
    }
    expect(events.filter((e) => e.type === 'thinking.delta').map((e) => (e.type === 'thinking.delta' ? e.text : ''))).toEqual(['pla', 'n']);
    expect(events.filter((e) => e.type === 'text.delta').map((e) => (e.type === 'text.delta' ? e.text : ''))).toEqual(['answer']);
  });
});
