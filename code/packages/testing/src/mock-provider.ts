import type {
  Capabilities,
  ContentBlock,
  Message,
  ModelRequest,
  ModelStreamEvent,
  Provider,
  Usage,
} from '@syaocode/core';
import { ProviderError, toolCallsOf } from '@syaocode/core';

/**
 * Scripted MockProvider (FR-142 / NFR-20): deterministic, no network.
 * Each `stream()` call pops the next scripted assistant message and replays
 * it as normalized stream events. Records every request for assertions.
 */

export interface MockProviderOptions {
  script: (Message | ((req: ModelRequest, turn: number) => Message))[];
  capabilities?: Partial<Capabilities>;
  usage?: Partial<Usage>;
}

export class MockProvider implements Provider {
  readonly id = 'mock';
  readonly requests: ModelRequest[] = [];
  private turn = 0;

  constructor(private opts: MockProviderOptions) {}

  capabilities(): Capabilities {
    return {
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      parallelToolCalls: true,
      thinking: 'none',
      promptCache: 'none',
      vision: false,
      structuredOutput: true,
      ...this.opts.capabilities,
    };
  }

  reset(script?: MockProviderOptions['script']): void {
    this.turn = 0;
    this.requests.length = 0;
    if (script !== undefined) this.opts.script = script;
  }

  async *stream(req: ModelRequest, _opts?: { signal: AbortSignal }): AsyncGenerator<ModelStreamEvent> {
    this.requests.push(req);
    const turn = this.turn;
    this.turn += 1;
    const step = this.opts.script[turn];
    if (step === undefined) {
      // Script exhaustion behaves like an interrupted provider stream so the
      // shared contract suite's transport-error case also passes here.
      throw new ProviderError({ code: 'SY-PRV-007', message: `MockProvider: script exhausted at turn ${turn}` });
    }
    const message = typeof step === 'function' ? step(req, turn) : step;
    const blocks = message.content;

    yield { type: 'message_start', messageId: message.id };
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i]!;
      yield { type: 'block_start', index: i, block };
      if (block.type === 'text' || block.type === 'thinking') {
        // stream in two halves for delta-shaped events
        const mid = Math.ceil(block.text.length / 2);
        if (mid > 0) yield { type: 'block_delta', index: i, delta: block.text.slice(0, mid) };
        if (block.text.length - mid > 0) yield { type: 'block_delta', index: i, delta: block.text.slice(mid) };
      }
      yield { type: 'block_stop', index: i };
    }
    const usage: Usage = {
      inputTokens: this.opts.usage?.inputTokens ?? 100,
      outputTokens: this.opts.usage?.outputTokens ?? 50,
      ...(this.opts.usage?.cacheReadTokens !== undefined ? { cacheReadTokens: this.opts.usage.cacheReadTokens } : {}),
      ...(this.opts.usage?.cacheWriteTokens !== undefined ? { cacheWriteTokens: this.opts.usage.cacheWriteTokens } : {}),
    };
    yield { type: 'usage', usage };
    const hasToolUse = blocks.some((b) => b.type === 'tool_use');
    yield {
      type: 'message_stop',
      stopReason: hasToolUse ? 'tool_use' : 'end_turn',
      message: { ...message, meta: { createdAt: Date.now() } },
    };
  }
}

/** Convenience: assistant message with tool_use blocks. */
export function mockToolUse(id: string, calls: { id: string; name: string; input: unknown }[]): Message {
  const blocks: ContentBlock[] = calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input }));
  return { id, role: 'assistant', content: blocks, meta: { createdAt: 0 } };
}

export function mockText(id: string, text: string): Message {
  return { id, role: 'assistant', content: [{ type: 'text', text }], meta: { createdAt: 0 } };
}

export { toolCallsOf };
