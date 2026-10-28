import { describe, expect, it } from 'vitest';
import { ApprovalBrokerImpl, normalizeOptions } from '../src/governance/approval.js';
import type { ApprovalOption } from '../src/ir/types.js';
import { TEST_NOW, TEST_TENANT, FakeApprovalStore } from './kernel-helpers.js';

function makeBroker(over: Partial<ConstructorParameters<typeof ApprovalBrokerImpl>[0]> = {}) {
  const store = new FakeApprovalStore();
  let n = 0;
  const broker = new ApprovalBrokerImpl({
    store,
    ids: { next: (p: string) => `${p}_${(n += 1)}` },
    now: () => TEST_NOW,
    defaultTimeoutMs: 60_000,
    ...over,
  });
  return { broker, store };
}

const baseRequest = {
  tenantId: TEST_TENANT,
  taskId: 'task_1',
  subject: { kind: 'tool' as const, summary: 'Allow mcp://github/tool/create_issue?' },
  authority: 'local' as const,
  policyRevision: 'sha256:rev1',
};

describe('ApprovalBroker (02 §6)', () => {
  it('resolves allowed when the authority picks an allow option', async () => {
    const { broker } = makeBroker({
      present: (record) => {
        // The presenter observes the pending record and decides out of band.
        void broker.decide(record.id, record.revision, { optionId: 'allow_once', by: 'tester' });
      },
    });
    const outcome = await broker.request(baseRequest);
    expect(outcome.state).toBe('allowed');
    expect(outcome.optionId).toBe('allow_once');
    expect(outcome.decidedBy).toBe('tester');
  });

  it('fails closed: a timeout resolves to expired, never to allow (I9)', async () => {
    const { broker } = makeBroker({ defaultTimeoutMs: 1000 });
    const outcome = await broker.request(baseRequest);
    expect(outcome.state).toBe('expired');
    expect(outcome.reason).toContain('fail closed');
  });

  it('fails closed when the authority cancels', async () => {
    const { broker } = makeBroker();
    const pending = broker.request(baseRequest);
    // Give request() a tick to insert the record, then cancel the task.
    await new Promise((r) => setTimeout(r, 0));
    const pendingRecords = await broker.listPending({ taskId: 'task_1' });
    expect(pendingRecords).toHaveLength(1);
    await broker.cancelForTask('task_1', 'task cancelled');
    const outcome = await pending;
    expect(outcome.state).toBe('cancelled');
  });

  it('is single-winner: the second decision loses the CAS', async () => {
    const { broker } = makeBroker();
    const pending = broker.request(baseRequest);
    await new Promise((r) => setTimeout(r, 0));
    const record = (await broker.listPending({ taskId: 'task_1' }))[0]!;

    const first = await broker.decide(record.id, record.revision, { optionId: 'allow_once', by: 'client-a' });
    const second = await broker.decide(record.id, record.revision, { optionId: 'deny_once', by: 'client-b' });
    expect(first).toBe(true);
    expect(second).toBe(false);

    const outcome = await pending;
    expect(outcome.state).toBe('allowed');
    expect(outcome.decidedBy).toBe('client-a');
  });

  it('treats an unknown option id as a denial, never as an allow', async () => {
    const { broker } = makeBroker();
    const pending = broker.request(baseRequest);
    await new Promise((r) => setTimeout(r, 0));
    const record = (await broker.listPending({ taskId: 'task_1' }))[0]!;
    await broker.decide(record.id, record.revision, { optionId: 'not-a-real-option', by: 'attacker' });
    const outcome = await pending;
    expect(outcome.state).toBe('denied');
  });

  it('strips rememberable options for sensitive subjects (§6.4)', () => {
    const options: ApprovalOption[] = [
      { id: 'allow_once', label: 'once', kind: 'allow_once' },
      { id: 'allow_session', label: 'session', kind: 'allow_session' },
      { id: 'allow_always', label: 'always', kind: 'allow_always' },
      { id: 'deny_once', label: 'deny', kind: 'deny_once' },
    ];
    const normalized = normalizeOptions(options, true);
    expect(normalized.map((o) => o.kind)).toEqual(['allow_once', 'deny_once']);
    // Non-sensitive keeps everything.
    expect(normalizeOptions(options, false)).toHaveLength(4);
  });

  it('recheck auto-resolves a pending approval when policy now allows (§6.5)', async () => {
    let effect: 'allow' | 'deny' | 'ask' = 'ask';
    const { broker } = makeBroker({ recheckPolicy: async () => effect });
    const pending = broker.request(baseRequest);
    await new Promise((r) => setTimeout(r, 0));
    effect = 'allow';
    const moved = await broker.recheck('task_1');
    expect(moved).toBe(1);
    const outcome = await pending;
    expect(outcome.state).toBe('allowed');
    expect(outcome.decidedBy).toBe('policy-recheck');
  });

  it('recheck denies a pending approval when policy now denies (§6.5)', async () => {
    const { broker } = makeBroker({ recheckPolicy: async () => 'deny' as const });
    const pending = broker.request(baseRequest);
    await new Promise((r) => setTimeout(r, 0));
    await broker.recheck('task_1');
    expect((await pending).state).toBe('denied');
  });

  it('denies after the recheck round limit instead of looping forever (§6.5)', async () => {
    let presents = 0;
    const { broker } = makeBroker({
      maxRounds: 3,
      recheckPolicy: async () => 'ask' as const,
      present: () => {
        presents += 1;
      },
    });
    const pending = broker.request(baseRequest);
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 4; i += 1) await broker.recheck('task_1');
    const outcome = await pending;
    expect(outcome.state).toBe('denied');
    expect(outcome.reason).toBe('approval_loop_exceeded');
    expect(presents).toBeGreaterThan(1);
  });

  it('cancels the timeout timer as soon as a decision arrives (no lingering handle)', async () => {
    // Regression: a leaked 5-minute timer kept a one-shot CLI process alive
    // long after its approval had been answered.
    let timerCancelled = false;
    const { broker } = makeBroker({
      defaultTimeoutMs: 60_000,
      // A sleep that only resolves when aborted, so the test can observe the
      // abort rather than waiting for a real timer.
      sleep: (ms: number, signal?: AbortSignal) =>
        new Promise<void>((resolve) => {
          if (signal?.aborted === true) {
            timerCancelled = true;
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => {
            timerCancelled = true;
            resolve();
          }, { once: true });
        }),
      present: (record) => {
        void broker.decide(record.id, record.revision, { optionId: 'allow_once', by: 'tester' });
      },
    });
    const outcome = await broker.request(baseRequest);
    expect(outcome.state).toBe('allowed');
    // request() must have aborted the pending timeout before returning.
    await new Promise((r) => setTimeout(r, 0));
    expect(timerCancelled).toBe(true);
  });

  it('cancelForTask only touches pending approvals', async () => {
    const { broker } = makeBroker();
    const pending = broker.request(baseRequest);
    await new Promise((r) => setTimeout(r, 0));
    const record = (await broker.listPending({ taskId: 'task_1' }))[0]!;
    await broker.decide(record.id, record.revision, { optionId: 'allow_once', by: 'tester' });
    await pending;
    expect(await broker.cancelForTask('task_1', 'too late')).toBe(0);
  });
});
