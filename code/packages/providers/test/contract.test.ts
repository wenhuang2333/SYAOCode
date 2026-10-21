import { afterAll } from 'vitest';
import { nodeRuntime, type Message, type Provider } from '@syaocode/core';
import { defineProviderContract } from '@syaocode/testing/contract';
import { createAnthropicProvider } from '../src/anthropic';
import { createOpenAICompatibleProvider } from '../src/openai-compatible';
import { startSseMock, type MockServer } from './helpers';

/**
 * G2: the SAME contract suite over all three providers. Here: the two real
 * adapters against a local SSE mock. (MockProvider's run lives in
 * @syaocode/testing.)
 */

const runtime = nodeRuntime();
const servers: MockServer[] = [];
// The fixture shares one mock server across the whole suite; close only at the end.
afterAll(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function openaiFrames(turns: Message[]): string[][] {
  return turns.map((m) => {
    const events: string[] = [];
    for (const block of m.content) {
      if (block.type === 'text' && block.text !== '') {
        events.push(JSON.stringify({ choices: [{ delta: { content: block.text } }] }));
      } else if (block.type === 'tool_use') {
        events.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: block.id, function: { name: block.name, arguments: JSON.stringify(block.input) } }] } }] }));
      }
    }
    events.push(JSON.stringify({ choices: [{ delta: {}, finish_reason: m.content.some((b) => b.type === 'tool_use') ? 'tool_calls' : 'stop' }] }));
    return events;
  });
}

function anthropicFrames(turns: Message[]): string[][] {
  return turns.map((m) => {
    const events: string[] = [JSON.stringify({ type: 'message_start', message: { id: m.id, usage: { input_tokens: 5 } } })];
    m.content.forEach((block, i) => {
      if (block.type === 'text') {
        events.push(JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }));
        events.push(JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } }));
      } else if (block.type === 'tool_use') {
        events.push(JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: block.id, name: block.name } }));
        events.push(JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }));
      }
      events.push(JSON.stringify({ type: 'content_block_stop', index: i }));
    });
    events.push(JSON.stringify({ type: 'message_delta', delta: { stop_reason: m.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }));
    events.push(JSON.stringify({ type: 'message_stop' }));
    return events;
  });
}

function httpFixture(
  protocol: 'openai' | 'anthropic',
  build: (turns: Message[]) => string[][],
) {
  let queue: string[][] = [];
  let server: MockServer | undefined;
  const ensureServer = async (): Promise<MockServer> => {
    if (server === undefined) {
      server = await startSseMock(async () => {
        const frames = queue.shift();
        if (frames === undefined) {
          return { status: 500, text: '{"error":"no script"}' };
        }
        return { status: 200, events: frames };
      });
      servers.push(server);
    }
    return server;
  };
  return {
    async playScript(turns: Message[]): Promise<void> {
      await ensureServer();
      queue = build(turns);
    },
    createProvider(): Provider {
      if (server === undefined) throw new Error('contract bug: playScript must run before createProvider');
      return protocol === 'openai'
        ? createOpenAICompatibleProvider({ runtime, baseUrl: server.url, apiKey: 'sk-contract' })
        : createAnthropicProvider({ runtime, apiKey: 'sk-ant-contract', baseUrl: server.url });
    },
    lastRequest: () => {
      const req = server?.requests[server.requests.length - 1];
      return req === undefined ? undefined : JSON.parse(req.body);
    },
  };
}

defineProviderContract(
  'openai-compatible (G2)',
  httpFixture('openai', openaiFrames),
);

defineProviderContract(
  'anthropic (G2)',
  httpFixture('anthropic', anthropicFrames),
);
