import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createAgent,
  MemoryReceiptStore,
  textContent,
  type AgentEvent,
  type Message,
  type ModelStreamEvent,
  type Provider,
  type Tool,
} from '../src';
import { fakeRuntime } from './helpers';

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
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield {
        type: 'message_stop',
        stopReason: message.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        message,
      };
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

async function collect(stream: AsyncGenerator<AgentEvent, unknown>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for (;;) {
    const r = await stream.next();
    if (r.done) break;
    events.push(r.value);
  }
  return events;
}

describe('event contract v2', () => {
  it('yields lifecycle events, stamps seq/runId/turnId, and correlates tool causes', async () => {
    const provider = scripted([
      msg('a1', [{ type: 'tool_use', id: 'c1', name: 'echo', input: { text: 'hi' } }]),
      msg('a2', [{ type: 'text', text: 'done' }]),
    ]);
    const agent = createAgent({
      provider,
      model: 'm',
      tools: [echo],
      permissionMode: 'strict',
      permissionHandler: async () => ({ decision: 'allow' }),
      runtime: fakeRuntime(),
      receipts: new MemoryReceiptStore(),
    });
    const events = await collect(agent.run('go'));

    expect(events[0]?.type).toBe('session.start');
    expect(events.at(-1)?.type).toBe('session.end');
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(new Set(events.map((e) => e.runId)).size).toBe(1);
    expect(events.filter((e) => e.type === 'turn.start' || e.type === 'turn.end').every((e) => e.turnId !== undefined)).toBe(true);

    const request = events.find((e) => e.type === 'permission.request');
    const result = events.find((e) => e.type === 'permission.result');
    expect(request).toBeDefined();
    expect(result).toBeDefined();
    if (request?.type === 'permission.request' && result?.type === 'permission.result') {
      expect(request.id).toBe(result.id);
      expect(request.request.callId).toBe('c1');
    }

    const start = events.find((e) => e.type === 'tool.start');
    expect(start?.causationId).toBe('c1');
    const receipt = events.find((e) => e.type === 'tool.receipt');
    expect(receipt).toBeDefined();
    if (receipt?.type === 'tool.receipt') {
      expect(receipt.receipt.callId).toBe('c1');
      expect(receipt.receipt.outputRef).toMatch(/^mem:\/\//);
    }
  });

  it('turns counts completed turns (one turn is 1, not 0)', async () => {
    const provider = scripted([msg('a1', [{ type: 'text', text: 'one' }])]);
    const agent = createAgent({ provider, model: 'm', runtime: fakeRuntime() });
    const summary = await agent.runOnce('go');
    expect(summary.turns).toBe(1);
    expect(summary.endReason).toBe('completed');
    expect(summary.verdict).toBe('not_run');
  });

  it('hard token budget stops even when no pricing exists', async () => {
    const provider = scripted([
      msg('a1', [{ type: 'tool_use', id: 'c1', name: 'echo', input: { text: 'x' } }]),
      msg('a2', [{ type: 'text', text: 'unreachable' }]),
    ]);
    const agent = createAgent({
      provider,
      model: 'm',
      tools: [echo],
      runtime: fakeRuntime(),
      limits: { maxTotalTokens: 5 },
    });
    const summary = await agent.runOnce('go');
    expect(summary.endReason).toBe('budget_exhausted');
    expect(summary.finalText).toBe('');
  });
});
