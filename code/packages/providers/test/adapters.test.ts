import { afterEach, describe, expect, it } from 'vitest';
import { SyaoError, nodeRuntime, userText } from '@syaocode/core';
import { createAnthropicProvider } from '../src/anthropic';
import { createOpenAICompatibleProvider } from '../src/openai-compatible';
import { startSseMock, type MockServer } from './helpers';

const runtime = nodeRuntime();
const servers: MockServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function drain(gen: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('openai-compatible adapter (FR-012)', () => {
  it('streams text deltas and assembles the message with usage', async () => {
    const server = await startSseMock(() => ({
      status: 200,
      events: [
        JSON.stringify({ choices: [{ delta: { content: 'hel' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.0012 } }),
      ],
    }));
    servers.push(server);
    const provider = createOpenAICompatibleProvider({ runtime, baseUrl: server.url, apiKey: 'sk-test' });
    const events = await drain(provider.stream({ model: 'gpt-test', messages: [userText('hi', 'u1')] }, { signal: new AbortController().signal }));
    const stop = events.find((e) => (e as { type: string }).type === 'message_stop') as { stopReason: string; message: { content: { type: string; text?: string }[] } };
    expect(stop.stopReason).toBe('end_turn');
    expect(stop.message.content[0]?.text).toBe('hello');
    const usage = events.find((e) => (e as { type: string }).type === 'usage') as { usage: { inputTokens: number; costUsd?: number } };
    expect(usage.usage.inputTokens).toBe(12);
    expect(usage.usage.costUsd).toBe(0.0012);
  });

  it('aggregates streamed tool_calls into tool_use blocks', async () => {
    const server = await startSseMock(() => ({
      status: 200,
      events: [
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"pa' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ],
    }));
    servers.push(server);
    const provider = createOpenAICompatibleProvider({ runtime, baseUrl: server.url, apiKey: 'sk-test' });
    const events = await drain(provider.stream({ model: 'm', messages: [userText('go', 'u1')] }, { signal: new AbortController().signal }));
    const stop = events.find((e) => (e as { type: string }).type === 'message_stop') as { stopReason: string; message: { content: { type: string; name?: string; input?: unknown }[] } };
    expect(stop.stopReason).toBe('tool_use');
    const tu = stop.message.content[0];
    expect(tu?.type).toBe('tool_use');
    expect(tu?.name).toBe('read');
    expect(tu?.input).toEqual({ path: 'a.txt' });
  });

  it('tolerates usage:null chunks and streams gateway reasoning as thinking', async () => {
    const server = await startSseMock(() => ({
      status: 200,
      events: [
        JSON.stringify({ choices: [{ delta: { reasoning: 'think ' } }] }),
        JSON.stringify({ choices: [{ delta: { reasoning: 'more' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'answer' } }] }),
        JSON.stringify({ choices: [], usage: null }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 4 } }),
      ],
    }));
    servers.push(server);
    const provider = createOpenAICompatibleProvider({ runtime, baseUrl: server.url, apiKey: 'sk-test' });
    const events = await drain(provider.stream({ model: 'm', messages: [userText('hi', 'u1')] }, { signal: new AbortController().signal }));
    const stop = events.find((e) => (e as { type: string }).type === 'message_stop') as {
      message: { content: { type: string; text?: string }[] };
    };
    expect(stop.message.content.map((b) => b.type)).toEqual(['thinking', 'text']);
    expect(stop.message.content[0]?.text).toBe('think more');
    expect(stop.message.content[1]?.text).toBe('answer');
    const starts = events.filter((e) => (e as { type: string }).type === 'block_start') as { index: number; block: { type: string } }[];
    expect(starts.map((e) => e.block.type)).toEqual(['thinking', 'text']);
  });

  it('sends history with tool_result as role=tool messages (FR-010 wire legality)', async () => {
    const server = await startSseMock(() => ({
      status: 200,
      events: [JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })],
    }));
    servers.push(server);
    const provider = createOpenAICompatibleProvider({ runtime, baseUrl: server.url, apiKey: 'sk-test' });
    await drain(
      provider.stream(
        {
          model: 'm',
          messages: [
            userText('go', 'u0'),
            { id: 'a1', role: 'assistant', content: [{ type: 'tool_use', id: 'call_9', name: 'read', input: { path: 'x' } }], meta: { createdAt: 0 } },
            { id: 'u1', role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_9', content: [{ type: 'text', text: 'body' }] }], meta: { createdAt: 0 } },
          ],
        },
        { signal: new AbortController().signal },
      ),
    );
    const body = JSON.parse(server.requests[0]!.body);
    const roles = body.messages.map((m: { role: string }): string => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool']);
    expect(body.messages[2].tool_call_id).toBe('call_9');
    expect(body.stream).toBe(true);
  });

  it('maps 401 → SY-PRV-001 (no retry), 429 → SY-PRV-002 (retryable)', async () => {
    const server = await startSseMock(() => ({ status: 401, text: '{"error":"bad key"}' }));
    servers.push(server);
    const provider = createOpenAICompatibleProvider({ runtime, baseUrl: server.url, apiKey: 'sk-bad' });
    await expect(
      drain(provider.stream({ model: 'm', messages: [userText('x', 'u1')] }, { signal: new AbortController().signal })),
    ).rejects.toSatisfy((e) => SyaoError.is(e) && e.code === 'SY-PRV-001' && e.retryable === false);

    const server429 = await startSseMock(() => ({ status: 429, text: '{"error":"slow down"}' }));
    servers.push(server429);
    const provider429 = createOpenAICompatibleProvider({ runtime, baseUrl: server429.url, apiKey: 'sk-x' });
    await expect(
      drain(provider429.stream({ model: 'm', messages: [userText('x', 'u1')] }, { signal: new AbortController().signal })),
    ).rejects.toSatisfy((e) => SyaoError.is(e) && e.code === 'SY-PRV-002' && e.retryable === true);
  });
});

describe('anthropic adapter (FR-011)', () => {
  it('streams text and thinking blocks with native semantics', async () => {
    const server = await startSseMock(() => ({
      status: 200,
      events: [
        JSON.stringify({ type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 7 } } }),
        JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'bon' } }),
        JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'jour' } }),
        JSON.stringify({ type: 'content_block_stop', index: 0 }),
        JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
        JSON.stringify({ type: 'message_stop' }),
      ],
    }));
    servers.push(server);
    const provider = createAnthropicProvider({ runtime, apiKey: 'sk-ant-test', baseUrl: `${server.url}` });
    const events = await drain(provider.stream({ model: 'claude-test', messages: [userText('hi', 'u1')] }, { signal: new AbortController().signal }));
    const stop = events.find((e) => (e as { type: string }).type === 'message_stop') as { stopReason: string; message: { content: { type: string; text?: string }[] } };
    expect(stop.stopReason).toBe('end_turn');
    expect(stop.message.content[0]?.text).toBe('bonjour');
    // auth headers on the wire
    expect(server.requests[0]!.headers['x-api-key']).toBe('sk-ant-test');
    const body = JSON.parse(server.requests[0]!.body);
    expect(body.stream).toBe(true);
  });

  it('assembles tool_use blocks from input_json_delta fragments', async () => {
    const server = await startSseMock(() => ({
      status: 200,
      events: [
        JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 5 } } }),
        JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'edit' } }),
        JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"f.t' } }),
        JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 's"}' } }),
        JSON.stringify({ type: 'content_block_stop', index: 0 }),
        JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }),
        JSON.stringify({ type: 'message_stop' }),
      ],
    }));
    servers.push(server);
    const provider = createAnthropicProvider({ runtime, apiKey: 'sk-ant-test', baseUrl: server.url });
    const events = await drain(provider.stream({ model: 'claude-test', messages: [userText('go', 'u1')] }, { signal: new AbortController().signal }));
    const stop = events.find((e) => (e as { type: string }).type === 'message_stop') as { message: { content: { type: string; input?: unknown }[] } };
    const tu = stop.message.content[0];
    expect(tu?.type).toBe('tool_use');
    expect(tu?.input).toEqual({ path: 'f.ts' });
  });

  it('sends tool_result history natively with is_error flag', async () => {
    const server = await startSseMock(() => ({
      status: 200,
      events: [JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 } } }), JSON.stringify({ type: 'message_stop' })],
    }));
    servers.push(server);
    const provider = createAnthropicProvider({ runtime, apiKey: 'k', baseUrl: server.url });
    await drain(
      provider.stream(
        {
          model: 'm',
          messages: [
            {
              id: 'u1',
              role: 'user',
              content: [{ type: 'tool_result', toolUseId: 'tu_1', content: [{ type: 'text', text: 'nope' }], isError: true }],
            },
          ],
        },
        { signal: new AbortController().signal },
      ),
    );
    const body = JSON.parse(server.requests[0]!.body);
    expect(body.messages[0].content[0].type).toBe('tool_result');
    expect(body.messages[0].content[0].is_error).toBe(true);
  });

  it('maps 5xx → SY-PRV-009 retryable', async () => {
    const server = await startSseMock(() => ({ status: 503, text: '{"error":"overloaded"}' }));
    servers.push(server);
    const provider = createAnthropicProvider({ runtime, apiKey: 'k', baseUrl: server.url });
    await expect(
      drain(provider.stream({ model: 'm', messages: [userText('x', 'u')] }, { signal: new AbortController().signal })),
    ).rejects.toSatisfy((e) => SyaoError.is(e) && e.code === 'SY-PRV-009' && e.retryable === true);
  });
});

describe('openai-compatible authStyle (/setup custom profiles)', () => {
  it('x-api-key header and query-key parameter attach the key as configured', async () => {
    const server = await startSseMock(() => ({
      status: 200,
      events: [
        JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ],
    }));
    servers.push(server);
    const signal = new AbortController().signal;
    const p1 = createOpenAICompatibleProvider({ runtime, baseUrl: server.url, apiKey: 'sk-x', authStyle: 'x-api-key' });
    await drain(p1.stream({ model: 'm', messages: [userText('hi', 'u1')] }, { signal }));
    expect(server.requests[0]?.headers['x-api-key']).toBe('sk-x');
    expect(server.requests[0]?.headers.authorization).toBeUndefined();

    const p2 = createOpenAICompatibleProvider({ runtime, baseUrl: server.url, apiKey: 'sk-q', authStyle: 'query-key' });
    await drain(p2.stream({ model: 'm', messages: [userText('hi', 'u2')] }, { signal }));
    expect(server.requests[1]?.url).toContain('/chat/completions?key=sk-q');
    expect(server.requests[1]?.headers.authorization).toBeUndefined();
  });
});
