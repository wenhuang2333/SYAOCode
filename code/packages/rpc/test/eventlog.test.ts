/**
 * Event log + projection tests: gap-free seq, replay, snapshot, subscribe.
 */

import { describe, expect, it } from 'vitest';
import { buildTestStores, fixedClock, makeEvent, makeTask, T0 } from './helpers.js';
import { MemoryEventLog } from '../src/runtime/eventlog.js';
import { projectTask } from '../src/runtime/projection.js';
import { deterministicIds } from '../src/ir/ids.js';
import type { CanonicalEvent } from '../src/ir/types.js';

function newLog(now: () => string = () => T0): MemoryEventLog {
  return new MemoryEventLog({ ids: deterministicIds(), now });
}

describe('MemoryEventLog', () => {
  it('assigns a gap-free sequence starting at 1, per task', async () => {
    const log = newLog();
    const a1 = await log.append(makeEvent({ taskId: 'task_1', type: 'notice' }));
    const a2 = await log.append(makeEvent({ taskId: 'task_1', type: 'notice' }));
    const b1 = await log.append(makeEvent({ taskId: 'task_2', type: 'notice' }));
    expect([a1.seq, a2.seq, b1.seq]).toEqual([1, 2, 1]);
    expect(a1.eventId).not.toBe(a2.eventId);
    expect(a1.ts).toBe(T0);
  });

  it('keeps the sequence gap-free under concurrent appends', async () => {
    const log = newLog();
    await Promise.all(Array.from({ length: 25 }, () => log.append(makeEvent({ taskId: 'task_1' }))));
    const events = await log.list('task_1');
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 25 }, (_v, i) => i + 1));
  });

  it('stamps a caller-supplied ts and keeps it', async () => {
    const log = newLog();
    const stamped = await log.append(makeEvent({ taskId: 'task_1', ts: '2020-05-05T05:05:05.000Z' }));
    expect(stamped.ts).toBe('2020-05-05T05:05:05.000Z');
  });

  it('replays only events after afterSeq', async () => {
    const log = newLog();
    for (let i = 0; i < 4; i += 1) await log.append(makeEvent({ taskId: 'task_1' }));
    expect((await log.list('task_1')).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect((await log.list('task_1', 2)).map((e) => e.seq)).toEqual([3, 4]);
    expect(await log.list('task_1', 4)).toEqual([]);
    expect(await log.list('task_other')).toEqual([]);
  });

  it('returns copies so stored events stay immutable', async () => {
    const log = newLog();
    await log.append(makeEvent({ taskId: 'task_1' }));
    const [event] = await log.list('task_1');
    event!.payload = { tampered: true };
    const [again] = await log.list('task_1');
    expect(again?.payload).toEqual({});
  });

  it('snapshots the projected task and the last seq', async () => {
    const log = newLog();
    const task = makeTask();
    await log.append(makeEvent({ taskId: 'task_1', type: 'task.created', payload: task }));
    await log.append(makeEvent({ taskId: 'task_1', type: 'task.state_changed', payload: { state: 'working' } }));
    const snapshot = await log.snapshot('task_1');
    expect(snapshot.lastSeq).toBe(2);
    expect(snapshot.task?.state).toBe('working');
    expect(snapshot.task?.lastSeq).toBe(2);
    expect(snapshot.task?.input).toEqual(task.input);
  });

  it('returns only the watermark for an unknown task', async () => {
    const log = newLog();
    expect(await log.snapshot('task_none')).toEqual({ lastSeq: 0 });
  });

  it('subscribes to the tail of a stream', async () => {
    const log = newLog();
    await log.append(makeEvent({ taskId: 'task_1' }));
    const seen: number[] = [];
    const stream = (async () => {
      for await (const event of log.subscribe('task_1', 0)) {
        seen.push(event.seq);
        if (seen.length === 3) break;
      }
    })();
    await log.append(makeEvent({ taskId: 'task_1' }));
    await log.append(makeEvent({ taskId: 'task_1' }));
    await stream;
    expect(seen).toEqual([1, 2, 3]);
  });

  it('delivers events appended between replay and wait (no missed wakeup)', async () => {
    const log = newLog();
    const seen: number[] = [];
    const stream = (async () => {
      for await (const event of log.subscribe('task_1', 0)) {
        seen.push(event.seq);
        if (seen.length === 2) break;
      }
    })();
    // Let the generator register its waiter, then append in a later turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await log.append(makeEvent({ taskId: 'task_1' }));
    await log.append(makeEvent({ taskId: 'task_1' }));
    await stream;
    expect(seen).toEqual([1, 2]);
  });
});

describe('projectTask', () => {
  const created = (task = makeTask()): CanonicalEvent => ({
    schemaVersion: 1,
    eventId: 'evt_1',
    seq: 1,
    taskId: task.id,
    correlationId: 'cor_1',
    ts: T0,
    principalId: 'prn_alice',
    protocol: 'mcp',
    type: 'task.created',
    payload: task,
  });

  const stateEvent = (seq: number, state: string): CanonicalEvent => ({
    schemaVersion: 1,
    eventId: `evt_${seq}`,
    seq,
    taskId: 'task_1',
    correlationId: 'cor_1',
    ts: T0,
    principalId: 'prn_alice',
    protocol: 'mcp',
    type: 'task.state_changed',
    payload: { state },
  });

  it('folds created → working → completed', () => {
    const task = projectTask([created(), stateEvent(2, 'working'), { ...stateEvent(3, 'completed'), type: 'task.completed', payload: { reason: 'done' } }]);
    expect(task?.state).toBe('completed');
    expect(task?.terminalReason).toBe('done');
    expect(task?.lastSeq).toBe(3);
  });

  it('accepts { task } payloads and a bare state string', () => {
    const task = projectTask([
      { ...created(), payload: { task: makeTask() } },
      { ...stateEvent(2, ''), payload: 'working' },
    ]);
    expect(task?.state).toBe('working');
  });

  it('tolerates the dispatcher shape (task.created carrying only a state)', () => {
    const task = projectTask([{ ...created(), payload: { state: 'working' } }]);
    expect(task?.id).toBe('task_1');
    expect(task?.state).toBe('working');
    expect(task?.lastSeq).toBe(1);
  });

  it('projects onto an authoritative seed row', () => {
    const seed = makeTask({ sessionId: 'ses_seed', tenantId: 'ten_seed', state: 'submitted' });
    const task = projectTask(
      [
        { ...created(), payload: { state: 'working' } },
        stateEvent(2, 'working'),
      ],
      seed,
    );
    expect(task?.sessionId).toBe('ses_seed');
    expect(task?.tenantId).toBe('ten_seed');
    expect(task?.state).toBe('working');
    expect(task?.lastSeq).toBe(2);
  });

  it('throws on an illegal transition', () => {
    expect(() => projectTask([created(), stateEvent(2, 'completed')])).toThrow(/illegal task transition submitted → completed/);
  });

  it('throws when a transition arrives before task.created', () => {
    expect(() => projectTask([stateEvent(1, 'working')])).toThrow(/before task.created/);
  });

  it('is idempotent for a re-emitted current state', () => {
    const task = projectTask([created(), stateEvent(2, 'working'), stateEvent(3, 'working')]);
    expect(task?.state).toBe('working');
    expect(task?.lastSeq).toBe(3);
  });

  it('treats a terminal state as terminal', () => {
    expect(() => projectTask([created(), stateEvent(2, 'rejected'), stateEvent(3, 'working')])).toThrow(/illegal task transition rejected → working/);
  });

  it('upserts artifacts by id', () => {
    const task = projectTask([
      created(),
      {
        ...stateEvent(2, 'working'),
        type: 'artifact.created',
        payload: { id: 'art_1', hash: 'h1', mediaType: 'text/plain' },
      },
      {
        ...stateEvent(3, 'working'),
        type: 'artifact.updated',
        payload: { artifact: { id: 'art_1', hash: 'h2' } },
      },
    ]);
    expect(task?.artifacts).toEqual([{ id: 'art_1', hash: 'h2' }]);
  });

  it('advances the watermark for unrelated events', () => {
    const task = projectTask([
      created(),
      { ...stateEvent(2, 'working'), type: 'notice', payload: { text: 'hi' }, ts: '2026-01-01T00:05:00.000Z' },
    ]);
    expect(task?.state).toBe('submitted');
    expect(task?.lastSeq).toBe(2);
    expect(task?.updatedAt).toBe('2026-01-01T00:05:00.000Z');
  });
});

describe('event log + stores integration', () => {
  it('snapshot matches what the dispatcher would persist', async () => {
    const clock = fixedClock();
    const { events } = buildTestStores({ now: clock.now });
    await events.append(makeEvent({ type: 'task.created', payload: makeTask() }));
    clock.advance(60_000);
    await events.append(makeEvent({ type: 'task.state_changed', payload: { state: 'working' } }));
    const snapshot = await events.snapshot('task_1');
    expect(snapshot.task?.state).toBe('working');
    expect(snapshot.task?.updatedAt).toBe(clock.now());
  });
});
