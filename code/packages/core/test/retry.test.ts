import { describe, expect, it } from 'vitest';
import { SyaoError, userText, withRetry, type Message, type ModelStreamEvent, type Provider } from '../src';
import { fakeRuntime } from './helpers';

/** 重试可见性：withRetry 在每次退避前回调 onRetry（UI 用它显示网络拥塞/失效）。 */

function flakyProvider(failures: number, code = 'SY-PRV-003'): Provider & { calls: number } {
  let calls = 0;
  return {
    id: 'flaky',
    get calls() {
      return calls;
    },
    capabilities: () => ({
      contextWindow: 1000,
      maxOutputTokens: 100,
      parallelToolCalls: false,
      thinking: 'none',
      promptCache: 'none',
      vision: false,
      structuredOutput: true,
    }),
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      calls += 1;
      if (calls <= failures) throw new SyaoError({ code });
      const message: Message = {
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        meta: { createdAt: 0 },
      };
      yield { type: 'message_stop', stopReason: 'end_turn', message };
    },
  };
}

async function drain(gen: AsyncIterable<ModelStreamEvent>): Promise<void> {
  for await (const _ of gen) {
    void _;
  }
}

describe('withRetry replay safety (report L2)', () => {
  it('does not replay a stream that already emitted text deltas', async () => {
    let calls = 0;
    const provider: Provider = {
      id: 'partial',
      capabilities: () => ({
        contextWindow: 1000,
        maxOutputTokens: 100,
        parallelToolCalls: false,
        thinking: 'none',
        promptCache: 'none',
        vision: false,
        structuredOutput: true,
      }),
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        calls += 1;
        yield { type: 'block_start', index: 0, block: { type: 'text', text: '' } };
        yield { type: 'block_delta', index: 0, delta: 'partial answer' };
        throw new SyaoError({ code: 'SY-PRV-009' });
      },
    };
    const wrapped = withRetry(provider, fakeRuntime(), { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1 });
    await expect(
      drain(wrapped.stream({ model: 'm', messages: [userText('hi', 'u1')] }, { signal: new AbortController().signal })),
    ).rejects.toSatisfy((e) => SyaoError.is(e) && e.code === 'SY-PRV-009');
    expect(calls).toBe(1);
  });
});

describe('withRetry onRetry hook', () => {
  it('每次即将重试都回调（attempt 从 1 递增、带错误码与退避时长）', async () => {
    const provider = flakyProvider(2);
    const seen: { attempt: number; code: string; delayMs: number }[] = [];
    const wrapped = withRetry(provider, fakeRuntime(), {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 20,
      onRetry: (info) => seen.push(info),
    });
    await drain(wrapped.stream({ model: 'm', messages: [userText('hi', 'u1')] }, { signal: new AbortController().signal }));
    expect(provider.calls).toBe(3);
    expect(seen.map((s) => s.attempt)).toEqual([1, 2]);
    expect(seen.every((s) => s.code === 'SY-PRV-003')).toBe(true);
    expect(seen.every((s) => s.delayMs >= 0)).toBe(true);
  });

  it('不可重试错误不触发回调（401）', async () => {
    const provider = flakyProvider(1, 'SY-PRV-001');
    const seen: unknown[] = [];
    const wrapped = withRetry(provider, fakeRuntime(), {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
      onRetry: (info) => seen.push(info),
    });
    await expect(
      drain(wrapped.stream({ model: 'm', messages: [userText('hi', 'u1')] }, { signal: new AbortController().signal })),
    ).rejects.toSatisfy((e) => SyaoError.is(e) && e.code === 'SY-PRV-001');
    expect(provider.calls).toBe(1);
    expect(seen).toHaveLength(0);
  });
});
