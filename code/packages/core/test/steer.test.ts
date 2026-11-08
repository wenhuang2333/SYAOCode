import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createAgent,
  createSteerQueue,
  MemorySessionStore,
  STEER_DEFAULT_MAX_ITEMS,
  STEER_MAX_TEXT_LENGTH,
  textContent,
  textOf,
  type AgentEvent,
  type Message,
  type ModelRequest,
  type ModelStreamEvent,
  type Provider,
  type RunOptions,
  type Usage,
  type Tool,
} from '../src';
import { fakeRuntime } from './helpers';

/**
 * N-2 / FR-N-032 kernel steer channel.
 * Contract: doc/DesktopDoc/28-多轮steer行为契约.md (§3 内核通道, §7 验收矩阵).
 */

interface CapturedMessage {
  readonly role: string;
  readonly text: string;
  readonly steerId?: string;
}

interface CapturedRequest {
  readonly model: string;
  readonly messages: readonly CapturedMessage[];
}

interface ScriptedTurn {
  readonly message: Message;
  /** Runs mid-stream (after the first delta) — "user submits while the model is streaming". */
  readonly duringStream?: () => void;
  /** Runs just before `message_stop` — "user submits during the last output". */
  readonly beforeStop?: () => void;
  /** Overrides the reported usage (budget tests). */
  readonly usage?: Usage;
}

/** Scripted provider that captures every request's message list for assertions. */
function scriptedProvider(script: ScriptedTurn[]): Provider & { readonly requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  let turn = 0;
  return {
    id: 'scripted-steer',
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
    async *stream(req: ModelRequest, opts: { signal: AbortSignal }): AsyncGenerator<ModelStreamEvent> {
      requests.push({
        model: req.model,
        messages: req.messages.map((m) => {
          const captured: CapturedMessage = { role: m.role, text: textOf(m) };
          return m.meta?.steerId !== undefined ? { ...captured, steerId: m.meta.steerId } : captured;
        }),
      });
      const entry = script[turn];
      turn += 1;
      if (entry === undefined) throw new Error('script exhausted');
      if (opts.signal.aborted) throw new DOMException('aborted', 'AbortError');
      yield { type: 'message_start', messageId: entry.message.id };
      const first = entry.message.content[0];
      if (first !== undefined) yield { type: 'block_start', index: 0, block: first };
      yield { type: 'block_delta', index: 0, delta: 'partial output' };
      entry.duringStream?.();
      yield { type: 'usage', usage: entry.usage ?? { inputTokens: 10, outputTokens: 5 } };
      entry.beforeStop?.();
      if (opts.signal.aborted) throw new DOMException('aborted', 'AbortError');
      yield {
        type: 'message_stop',
        stopReason: entry.message.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        message: entry.message,
      };
    },
  };
}

function assistantMsg(id: string, blocks: Message['content']): Message {
  return { id, role: 'assistant', content: blocks, meta: { createdAt: 0 } };
}

/** read-only, concurrency-safe echo tool; `onExecute` simulates a user steer during a batch. */
function echoTool(onExecute?: () => void): Tool<{ text: string }> {
  return {
    name: 'echo',
    description: 'echo the text back',
    inputSchema: z.object({ text: z.string() }),
    risk: 'read',
    readOnly: true,
    concurrencySafe: true,
    async execute(input) {
      onExecute?.();
      return { content: textContent(`echo:${input.text}`) };
    },
  };
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

function steerMessages(history: readonly Message[]): Message[] {
  return history.filter((m) => m.meta?.steerId !== undefined);
}

function typesOf(events: readonly AgentEvent[]): string[] {
  return events.map((e) => e.type);
}

function notConsumedOf(events: readonly AgentEvent[]): Extract<AgentEvent, { type: 'steer.not_consumed' }>[] {
  return events.filter((e): e is Extract<AgentEvent, { type: 'steer.not_consumed' }> => e.type === 'steer.not_consumed');
}

// ── queue unit contract (§3.1) ─────────────────────────────────────────────

describe('createSteerQueue (contract §3.1)', () => {
  it('exposes the frozen constants', () => {
    expect(STEER_MAX_TEXT_LENGTH).toBe(10_000);
    expect(STEER_DEFAULT_MAX_ITEMS).toBe(32);
  });

  it('accepts in FIFO order and reports a 0-based position', () => {
    const q = createSteerQueue();
    expect(q.push({ id: 'a', text: 'one' })).toEqual({ accepted: true, id: 'a', position: 0 });
    expect(q.push({ id: 'b', text: 'two' })).toEqual({ accepted: true, id: 'b', position: 1 });
    expect(q.size).toBe(2);
    expect(q.closed).toBe(false);
    expect(q.drain().map((s) => s.id)).toEqual(['a', 'b']);
    expect(q.size).toBe(0);
  });

  it('rejects empty, too-long, duplicate, queue_full and closed without throwing', () => {
    const q = createSteerQueue({ maxItems: 2, maxTextLength: 5 });
    expect(q.push({ id: 'empty', text: '' })).toEqual({ accepted: false, id: 'empty', reason: 'empty' });
    expect(q.push({ id: 'long', text: 'x'.repeat(6) })).toEqual({ accepted: false, id: 'long', reason: 'too_long' });
    expect(q.push({ id: 'a', text: 'ok' }).accepted).toBe(true);
    expect(q.push({ id: 'a', text: 'ok' })).toEqual({ accepted: false, id: 'a', reason: 'duplicate' });
    expect(q.push({ id: 'b', text: 'ok' }).accepted).toBe(true);
    expect(q.push({ id: 'c', text: 'ok' })).toEqual({ accepted: false, id: 'c', reason: 'queue_full' });
    expect(q.close().map((s) => s.id)).toEqual(['a', 'b']);
    expect(q.closed).toBe(true);
    expect(q.push({ id: 'd', text: 'ok' })).toEqual({ accepted: false, id: 'd', reason: 'closed' });
  });

  it('never re-admits an id that was already consumed', () => {
    const q = createSteerQueue();
    q.push({ id: 'once', text: 'hi' });
    expect(q.drain()).toHaveLength(1);
    expect(q.push({ id: 'once', text: 'hi' })).toEqual({ accepted: false, id: 'once', reason: 'duplicate' });
  });
});

// ── acceptance matrix §7 ───────────────────────────────────────────────────

describe('steer consumption boundaries (contract §3.2/§3.3)', () => {
  it('#1: steer during streaming does not interrupt the stream and lands in the next request', async () => {
    const queue = createSteerQueue();
    const provider = scriptedProvider([
      {
        message: assistantMsg('a1', [{ type: 'text', text: 'first answer' }]),
        duringStream: () => {
          expect(queue.push({ id: 's1', text: 'also add tests' })).toEqual({ accepted: true, id: 's1', position: 0 });
        },
      },
      { message: assistantMsg('a2', [{ type: 'text', text: 'second answer' }]) },
    ]);
    const agent = createAgent({ provider, model: 'm', runtime: fakeRuntime() });
    const events = await collect(agent.run('go', { steer: queue }));

    // The in-flight stream was not aborted or rewritten.
    expect(events.filter((e) => e.type === 'text.delta').length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.filter((e) => e.type === 'message.complete')).toHaveLength(2);

    // The second provider request carries the steer text as a user message.
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.messages.at(-1)).toEqual({ role: 'user', text: 'also add tests', steerId: 's1' });

    const consumed = events.filter((e): e is Extract<AgentEvent, { type: 'steer.consumed' }> => e.type === 'steer.consumed');
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ steerId: 's1', text: 'also add tests', turn: 2 });
  });

  it('#2: the end-decision queue re-check — a steer in the last (tool-less) output is consumed, not dropped', async () => {
    const queue = createSteerQueue();
    const provider = scriptedProvider([
      {
        message: assistantMsg('a1', [{ type: 'text', text: 'first answer' }]),
        // The "last output" race window: submitted right before the stream stops.
        beforeStop: () => {
          queue.push({ id: 's1', text: 'one more thing' });
        },
      },
      { message: assistantMsg('a2', [{ type: 'text', text: 'second answer' }]) },
    ]);
    const agent = createAgent({ provider, model: 'm', runtime: fakeRuntime() });
    const events = await collect(agent.run('go', { steer: queue }));
    const types = typesOf(events);

    // It must be consumed, not reported as not_consumed.
    expect(notConsumedOf(events)).toHaveLength(0);
    expect(events.filter((e) => e.type === 'steer.consumed')).toHaveLength(1);

    // turn.end closes turn 1 before turn 2 starts (contract §3.2 row 4).
    expect(types.indexOf('turn.end')).toBeGreaterThan(types.indexOf('message.complete'));
    expect(types.lastIndexOf('turn.start')).toBeGreaterThan(types.indexOf('turn.end'));
    expect(types.filter((t) => t === 'turn.start')).toHaveLength(2);

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.messages.at(-1)).toEqual({ role: 'user', text: 'one more thing', steerId: 's1' });

    // history: user('go') → assistant('first answer') → user(steer) → assistant('second answer')
    expect(agent.history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(steerMessages(agent.history)).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('session.end');
  });

  it('#2b: the last answer is the post-steer one (no premature completion)', async () => {
    const queue = createSteerQueue();
    const provider = scriptedProvider([
      {
        message: assistantMsg('a1', [{ type: 'text', text: 'draft' }]),
        beforeStop: () => {
          queue.push({ id: 's1', text: 'revise it' });
        },
      },
      { message: assistantMsg('a2', [{ type: 'text', text: 'revised' }]) },
    ]);
    const agent = createAgent({ provider, model: 'm', runtime: fakeRuntime() });
    const summary = await agent.runOnce('go', { steer: queue });
    expect(summary.endReason).toBe('completed');
    expect(summary.turns).toBe(2);
    expect(summary.finalText).toBe('revised');
    expect(steerMessages(agent.history).map((m) => textOf(m))).toEqual(['revise it']);
  });

  it('#3: steer during a tool batch is injected only after every tool_result (pairing intact)', async () => {
    const queue = createSteerQueue();
    let submitted = false;
    const echo = echoTool(() => {
      if (submitted) return;
      submitted = true;
      queue.push({ id: 's1', text: 'use the second file' });
    });
    const provider = scriptedProvider([
      {
        message: assistantMsg('a1', [
          { type: 'tool_use', id: 'c1', name: 'echo', input: { text: 'one' } },
          { type: 'tool_use', id: 'c2', name: 'echo', input: { text: 'two' } },
        ]),
      },
      { message: assistantMsg('a2', [{ type: 'text', text: 'done' }]) },
    ]);
    const agent = createAgent({ provider, model: 'm', tools: [echo], runtime: fakeRuntime() });
    const events = await collect(agent.run('go', { steer: queue }));

    // Every tool_use still has exactly one tool_result, and they precede the steer message.
    expect(agent.history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user', 'assistant']);
    const resultMessage = agent.history[2]!;
    const resultBlocks = resultMessage.content.filter((b) => b.type === 'tool_result');
    expect(resultBlocks.map((b) => (b.type === 'tool_result' ? b.toolUseId : ''))).toEqual(['c1', 'c2']);
    expect(agent.history[3]!.meta?.steerId).toBe('s1');

    // The second request: tool results first, then the steer user message.
    const second = provider.requests[1]!.messages;
    const steerIndex = second.findIndex((m) => m.steerId === 's1');
    expect(steerIndex).toBeGreaterThan(second.findIndex((m) => m.text.includes('echo:one')));
    expect(steerIndex).toBe(second.length - 1);

    expect(events.filter((e) => e.type === 'steer.consumed')).toHaveLength(1);
  });

  it('#4: steer while an approval is pending does not settle the approval (and does not change its outcome)', async () => {
    const queue = createSteerQueue();
    let release!: (decision: 'allow' | 'deny') => void;
    const gate = new Promise<'allow' | 'deny'>((resolve) => {
      release = resolve;
    });
    const provider = scriptedProvider([
      {
        message: assistantMsg('a1', [{ type: 'tool_use', id: 'c1', name: 'echo', input: { text: 'hi' } }]),
      },
      { message: assistantMsg('a2', [{ type: 'text', text: 'denied, moving on' }]) },
    ]);
    const agent = createAgent({
      provider,
      model: 'm',
      tools: [echoTool()],
      permissionMode: 'strict',
      permissionHandler: async () => ({ decision: await gate }),
      runtime: fakeRuntime(),
    });

    const stream = agent.run('go', { steer: queue });
    const events: AgentEvent[] = [];
    // Drive until the approval prompt is visible, then submit a steer while it waits.
    for (;;) {
      const r = await stream.next();
      if (r.done) break;
      events.push(r.value);
      if (r.value.type === 'permission.request') {
        queue.push({ id: 's1', text: 'actually, stop after this' });
        // Still no decision: the steer must not be treated as an answer.
        expect(events.some((e) => e.type === 'permission.result')).toBe(false);
        release('deny');
      }
    }
    expect(events.find((e) => e.type === 'permission.result')).toMatchObject({ decision: 'deny' });
    expect(events.filter((e) => e.type === 'permission.result')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'steer.consumed')).toHaveLength(1);
    expect(steerMessages(agent.history)).toHaveLength(1);
  });

  it('#5: consecutive steers keep FIFO order with no overwrite or merge', async () => {
    const queue = createSteerQueue();
    const provider = scriptedProvider([
      {
        message: assistantMsg('a1', [{ type: 'text', text: 'first' }]),
        duringStream: () => {
          queue.push({ id: 's1', text: 'alpha' });
          queue.push({ id: 's2', text: 'beta' });
          queue.push({ id: 's3', text: 'gamma' });
        },
      },
      { message: assistantMsg('a2', [{ type: 'text', text: 'after all three' }]) },
    ]);
    const agent = createAgent({ provider, model: 'm', runtime: fakeRuntime() });
    await collect(agent.run('go', { steer: queue }));

    expect(steerMessages(agent.history).map((m) => m.meta?.steerId)).toEqual(['s1', 's2', 's3']);
    const second = provider.requests[1]!.messages;
    expect(second.slice(-3).map((m) => m.text)).toEqual(['alpha', 'beta', 'gamma']);
    expect(second.slice(-3).map((m) => m.steerId)).toEqual(['s1', 's2', 's3']);
    expect(queue.size).toBe(0);
  });

  it('#8: a steer queued before stop is reported not_consumed(aborted), and a later run does not replay it', async () => {
    const queue = createSteerQueue();
    const ac = new AbortController();
    const provider = scriptedProvider([
      {
        message: assistantMsg('a1', [{ type: 'tool_use', id: 'c1', name: 'echo', input: { text: 'x' } }]),
        duringStream: () => {
          queue.push({ id: 's1', text: 'never mind' });
          ac.abort();
        },
      },
      { message: assistantMsg('a2', [{ type: 'text', text: 'unreachable' }]) },
    ]);
    const agent = createAgent({ provider, model: 'm', tools: [echoTool()], runtime: fakeRuntime() });
    const events = await collect(agent.run('go', { steer: queue, signal: ac.signal }));

    const notConsumed = notConsumedOf(events);
    expect(notConsumed).toHaveLength(1);
    expect(notConsumed[0]).toMatchObject({ steerId: 's1', text: 'never mind', reason: 'aborted' });
    expect(events.some((e) => e.type === 'steer.consumed')).toBe(false);
    // Reported before session.end.
    expect(typesOf(events).lastIndexOf('steer.not_consumed')).toBeLessThan(typesOf(events).indexOf('session.end'));
    // The channel is closed: no push can sneak into a later execution.
    expect(queue.closed).toBe(true);
    expect(queue.push({ id: 's2', text: 'late' })).toEqual({ accepted: false, id: 's2', reason: 'closed' });

    // A later run with a fresh queue never replays the old steer.
    const replay = scriptedProvider([{ message: assistantMsg('b1', [{ type: 'text', text: 'clean' }]) }]);
    const agent2 = createAgent({ provider: replay, model: 'm', runtime: fakeRuntime() });
    await collect(agent2.run('again', { steer: createSteerQueue() }));
    expect(agent2.history.some((m) => textOf(m).includes('never mind'))).toBe(false);
    expect(replay.requests[0]!.messages.some((m) => m.text.includes('never mind'))).toBe(false);
  });

  it('#9a: maxTurns is not bypassed for a pending steer; reason is max_turns', async () => {
    const queue = createSteerQueue();
    const provider = scriptedProvider([
      {
        message: assistantMsg('a1', [{ type: 'tool_use', id: 'c1', name: 'echo', input: { text: '1' } }]),
      },
      {
        message: assistantMsg('a2', [{ type: 'tool_use', id: 'c2', name: 'echo', input: { text: '2' } }]),
        duringStream: () => {
          queue.push({ id: 's1', text: 'keep going' });
        },
      },
    ]);
    const agent = createAgent({
      provider,
      model: 'm',
      tools: [echoTool()],
      runtime: fakeRuntime(),
      limits: { maxTurns: 2 },
    });
    const events = await collect(agent.run('go', { steer: queue }));

    expect(events.filter((e) => e.type === 'turn.start')).toHaveLength(2);
    const notConsumed = notConsumedOf(events);
    expect(notConsumed).toHaveLength(1);
    expect(notConsumed[0]).toMatchObject({ steerId: 's1', reason: 'max_turns' });
    expect(events.find((e): e is Extract<AgentEvent, { type: 'session.end' }> => e.type === 'session.end')?.reason).toBe(
      'max_turns',
    );
  });

  it('#9b: a token budget is not bypassed for a pending steer; reason is budget_exhausted', async () => {
    const queue = createSteerQueue();
    const provider = scriptedProvider([
      {
        message: assistantMsg('a1', [{ type: 'tool_use', id: 'c1', name: 'echo', input: { text: 'x' } }]),
        duringStream: () => {
          queue.push({ id: 's1', text: 'more' });
        },
      },
      { message: assistantMsg('a2', [{ type: 'tool_use', id: 'c2', name: 'echo', input: { text: 'y' } }]) },
    ]);
    const agent = createAgent({
      provider,
      model: 'm',
      tools: [echoTool()],
      runtime: fakeRuntime(),
      limits: { maxTotalTokens: 5 },
    });
    const events = await collect(agent.run('go', { steer: queue }));
    const notConsumed = notConsumedOf(events);
    expect(notConsumed).toHaveLength(1);
    expect(notConsumed[0]).toMatchObject({ steerId: 's1', reason: 'budget_exhausted' });
    expect(events.filter((e) => e.type === 'turn.start')).toHaveLength(1);
    expect(events.find((e): e is Extract<AgentEvent, { type: 'session.end' }> => e.type === 'session.end')?.reason).toBe(
      'budget_exhausted',
    );
  });

  it('#9c: a cost budget is not bypassed for a pending steer; reason is budget_exhausted', async () => {
    const queue = createSteerQueue();
    const provider = scriptedProvider([
      {
        message: assistantMsg('a1', [{ type: 'tool_use', id: 'c1', name: 'echo', input: { text: 'x' } }]),
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 1 },
        duringStream: () => {
          queue.push({ id: 's1', text: 'one more step' });
        },
      },
      { message: assistantMsg('a2', [{ type: 'tool_use', id: 'c2', name: 'echo', input: { text: 'y' } }]) },
    ]);
    const agent = createAgent({
      provider,
      model: 'm',
      tools: [echoTool()],
      runtime: fakeRuntime(),
      limits: { maxBudgetUsd: 0.5 },
    });
    const events = await collect(agent.run('go', { steer: queue }));
    const notConsumed = notConsumedOf(events);
    expect(notConsumed).toHaveLength(1);
    expect(notConsumed[0]).toMatchObject({ steerId: 's1', reason: 'budget_exhausted' });
    expect(events.filter((e) => e.type === 'turn.start')).toHaveLength(1);
    expect(events.find((e): e is Extract<AgentEvent, { type: 'session.end' }> => e.type === 'session.end')?.reason).toBe(
      'budget_exhausted',
    );
  });

  it('#9d: a wall-clock limit is not bypassed for a pending steer; reason is timeout', async () => {
    const queue = createSteerQueue();
    let now = 1_000;
    const base = fakeRuntime();
    const runtime = { ...base, clock: { now: () => now, sleep: async () => {} } };
    const provider = scriptedProvider([
      {
        message: assistantMsg('a1', [{ type: 'tool_use', id: 'c1', name: 'echo', input: { text: 'x' } }]),
        duringStream: () => {
          queue.push({ id: 's1', text: 'slow down' });
          now = 1_000_000; // the next limit check sees a run that has run out of wall clock
        },
      },
      { message: assistantMsg('a2', [{ type: 'tool_use', id: 'c2', name: 'echo', input: { text: 'y' } }]) },
    ]);
    const agent = createAgent({
      provider,
      model: 'm',
      tools: [echoTool()],
      runtime,
      limits: { maxWallClockMs: 500 },
    });
    const events = await collect(agent.run('go', { steer: queue }));
    const notConsumed = notConsumedOf(events);
    expect(notConsumed).toHaveLength(1);
    expect(notConsumed[0]).toMatchObject({ steerId: 's1', reason: 'timeout' });
    expect(events.filter((e) => e.type === 'turn.start')).toHaveLength(1);
    expect(events.find((e): e is Extract<AgentEvent, { type: 'session.end' }> => e.type === 'session.end')?.reason).toBe(
      'timeout',
    );
  });

  it('#11: a consumed steer is persisted exactly once and survives resume/fork without replay', async () => {
    const store = new MemorySessionStore();
    const queue = createSteerQueue();
    const provider = scriptedProvider([
      {
        message: assistantMsg('a1', [{ type: 'tool_use', id: 'c1', name: 'echo', input: { text: 'x' } }]),
        duringStream: () => {
          queue.push({ id: 's1', text: 'remember this' });
        },
      },
      { message: assistantMsg('a2', [{ type: 'text', text: 'ok' }]) },
    ]);
    const agent = createAgent({ provider, model: 'm', tools: [echoTool()], runtime: fakeRuntime(), session: store });
    const summary = await agent.runOnce('go', { steer: queue });
    expect(summary.endReason).toBe('completed');

    const steerEntry = (e: { type: string; data: unknown }): boolean => {
      if (e.type !== 'message') return false;
      return (e.data as Message).meta?.steerId === 's1';
    };
    expect((await store.load(summary.sessionId)).filter(steerEntry)).toHaveLength(1);

    // Resume: the steer message is reloaded once, in the right position, and not re-injected.
    const resumeProvider = scriptedProvider([{ message: assistantMsg('b1', [{ type: 'text', text: 'resumed' }]) }]);
    const resumed = createAgent({ provider: resumeProvider, model: 'm', runtime: fakeRuntime(), session: store });
    await collect(resumed.run('continue', { sessionId: summary.sessionId, steer: createSteerQueue() }));
    expect(resumed.history.filter((m) => m.meta?.steerId === 's1')).toHaveLength(1);
    const steerPos = resumed.history.findIndex((m) => m.meta?.steerId === 's1');
    expect(resumed.history[steerPos - 1]!.role).toBe('user');
    expect(resumed.history[steerPos - 1]!.content.some((b) => b.type === 'tool_result')).toBe(true);

    // Fork: the forked log keeps the steer history exactly once.
    const forkId = await store.fork(summary.sessionId);
    expect((await store.load(forkId)).filter(steerEntry)).toHaveLength(1);
  });

  it('#14: without a steer option the loop is unchanged; an unused queue changes nothing either', async () => {
    const scenario = async (opts?: RunOptions) => {
      const provider = scriptedProvider([
        { message: assistantMsg('a1', [{ type: 'tool_use', id: 'c1', name: 'echo', input: { text: 'x' } }]) },
        { message: assistantMsg('a2', [{ type: 'text', text: 'done' }]) },
      ]);
      const agent = createAgent({ provider, model: 'm', tools: [echoTool()], runtime: fakeRuntime() });
      const events = await collect(agent.run('go', opts));
      return { events, agent, provider };
    };

    const plain = await scenario();
    const withQueue = await scenario({ steer: createSteerQueue() });

    expect(typesOf(plain.events)).toEqual(typesOf(withQueue.events));
    expect(typesOf(plain.events).some((t) => t.startsWith('steer.'))).toBe(false);
    expect(typesOf(withQueue.events).some((t) => t.startsWith('steer.'))).toBe(false);
    expect(plain.agent.history.map((m) => m.role)).toEqual(withQueue.agent.history.map((m) => m.role));
    expect(plain.agent.history.map((m) => textOf(m))).toEqual(withQueue.agent.history.map((m) => textOf(m)));
    expect(plain.provider.requests).toHaveLength(2);
    expect(withQueue.provider.requests).toHaveLength(2);
  });
});
