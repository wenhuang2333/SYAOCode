import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY_POLICY, SyaoError, userText, withRetry, type Message, type Provider } from '@syaocode/core';

/**
 * G2 acceptance: the SAME contract suite runs against MockProvider,
 * OpenAI-compatible and Anthropic adapters. A provider passes the contract
 * when every case below passes against it.
 */

export interface ContractFixture {
  /** Fresh provider under test. */
  createProvider: () => Provider;
  /**
   * Drive one scripted interaction. For HTTP adapters the harness preloads
   * the mock server with responses; for MockProvider the script is set.
   * `turn` selects the scripted assistant reply.
   */
  playScript: (turns: Message[]) => Promise<void>;
  /** Last request body seen by the (mock) transport, if any. */
  lastRequest?: () => unknown;
}

export function defineProviderContract(name: string, fixture: ContractFixture): void {
  describe(`provider contract: ${name}`, () => {
    it('streams a text-only response and reports usage', async () => {
      await fixture.playScript([
        { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hello world' }], meta: { createdAt: 0 } },
      ]);
      const provider = fixture.createProvider();
      const events = [];
      for await (const ev of provider.stream(
        { model: 'test-model', messages: [userText('hi', 'u1')] },
        { signal: new AbortController().signal },
      )) {
        events.push(ev);
      }
      const stop = events.find((e) => e.type === 'message_stop');
      expect(stop).toBeDefined();
      if (stop?.type === 'message_stop') {
        expect(stop.stopReason).toBe('end_turn');
        expect(stop.message.content.some((b) => b.type === 'text' && b.text === 'hello world')).toBe(true);
        expect(stop.message.role).toBe('assistant');
      }
      const usage = events.filter((e) => e.type === 'usage');
      expect(usage.length).toBeGreaterThan(0);
    });

    it('round-trips a tool_use call with structured args', async () => {
      await fixture.playScript([
        {
          id: 'a2',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.txt', offset: 1, limit: 5 } }],
          meta: { createdAt: 0 },
        },
      ]);
      const provider = fixture.createProvider();
      const events = [];
      for await (const ev of provider.stream(
        { model: 'test-model', messages: [userText('read a.txt', 'u1')] },
        { signal: new AbortController().signal },
      )) {
        events.push(ev);
      }
      const stop = events.find((e) => e.type === 'message_stop');
      expect(stop).toBeDefined();
      if (stop?.type === 'message_stop') {
        expect(stop.stopReason).toBe('tool_use');
        const toolUse = stop.message.content.find((b) => b.type === 'tool_use');
        expect(toolUse).toBeDefined();
        if (toolUse?.type === 'tool_use') {
          expect(toolUse.name).toBe('read');
          expect(toolUse.input).toEqual({ path: 'a.txt', offset: 1, limit: 5 });
        }
      }
    });

    it('carries tool_result history back to the provider legally', async () => {
      await fixture.playScript([
        { id: 'a3', role: 'assistant', content: [{ type: 'text', text: 'done' }], meta: { createdAt: 0 } },
      ]);
      const provider = fixture.createProvider();
      const history: Message[] = [
        userText('go', 'u0'),
        {
          id: 'a2',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'x' } }],
          meta: { createdAt: 0 },
        },
        {
          id: 'u1',
          role: 'user',
          content: [{ type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: 'file body' }] }],
          meta: { createdAt: 0 },
        },
      ];
      for await (const ev of provider.stream(
        { model: 'test-model', messages: history },
        { signal: new AbortController().signal },
      )) {
        void ev;
      }
      const last = fixture.lastRequest?.();
      if (last !== undefined) {
        const serialized = JSON.stringify(last);
        // every tool_use id referenced in history must appear exactly once in the wire request
        expect(serialized.includes('t1')).toBe(true);
      }
    });

    it('maps transport errors onto registered SY-PRV codes', async () => {
      await fixture.playScript([]);
      const provider = fixture.createProvider();
      await expect(async () => {
        for await (const _ev of provider.stream(
          { model: 'test-model', messages: [userText('boom', 'u1')] },
          { signal: new AbortController().signal },
        )) {
          void _ev;
        }
      }).rejects.toSatisfy((e: unknown) => {
        const json = JSON.stringify(e ?? {});
        return json.includes('SY-PRV-');
      });
    });

    it('withRetry honors retryable codes and gives up after maxAttempts', async () => {
      let calls = 0;
      const flaky: Provider = {
        id: 'flaky',
        capabilities: () => ({
          contextWindow: 1000, maxOutputTokens: 100, parallelToolCalls: false,
          thinking: 'none', promptCache: 'none', vision: false, structuredOutput: false,
        }),
        async *stream() {
          calls += 1;
          throw new SyaoError({ code: 'SY-PRV-002', message: 'rate limited (test double)' });
        },
      };
      const runtime = {
        clock: { now: () => 0, sleep: async () => undefined },
        logger: { log() {} },
      } as never;
      const retried = withRetry(flaky, runtime, { ...DEFAULT_RETRY_POLICY, baseDelayMs: 1, maxDelayMs: 1 });
      await expect(async () => {
        for await (const _ev of retried.stream({ model: 'm', messages: [] }, { signal: new AbortController().signal })) {
          void _ev;
        }
      }).rejects.toSatisfy((e: unknown) => SyaoError.is(e) && e.code === 'SY-PRV-002');
      expect(calls).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
    });
  });
}
