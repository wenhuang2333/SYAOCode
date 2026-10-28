import { describe, expect, it } from 'vitest';
import { FakeApprovalChannel, allowAllApprovals, denyAllApprovals } from '../src/approval-channel';
import { defineAdapterContract, localAdapterFixture } from '../src/adapter-contract';

describe('FakeApprovalChannel', () => {
  it('records requests and answers from the queue in order', async () => {
    const channel = new FakeApprovalChannel();
    channel.enqueue({ decision: 'allow', remember: 'once' }, { decision: 'deny', message: 'nope' });
    const req = { id: 'perm_1', tool: 'bash', risk: 'exec', subject: { command: 'ls' }, reason: 'exec' } as const;
    expect(await channel.handler(req)).toEqual({ decision: 'allow', remember: 'once' });
    expect(await channel.handler({ ...req, id: 'perm_2' })).toEqual({ decision: 'deny', message: 'nope' });
    expect(channel.count).toBe(2);
    expect(channel.last?.id).toBe('perm_2');
  });

  it('falls back to the default answer and stays pending without one', async () => {
    const allowing = allowAllApprovals();
    expect(await allowing.handler({ id: 'p', tool: 'read', risk: 'read', subject: {}, reason: '' })).toEqual({
      decision: 'allow',
      remember: 'once',
    });
    expect(denyAllApprovals().requests).toHaveLength(0);

    const silent = new FakeApprovalChannel();
    let settled = false;
    void silent.handler({ id: 'p', tool: 'read', risk: 'read', subject: {}, reason: '' }).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
  });

  it('honours a dedicated sensitive answer', async () => {
    const channel = new FakeApprovalChannel({
      defaultAnswer: { decision: 'allow', remember: 'session' },
      sensitiveAnswer: { decision: 'allow', remember: 'once' },
    });
    const sensitive = await channel.handler({
      id: 'p1',
      tool: 'read',
      risk: 'read',
      subject: { path: '.env' },
      reason: '',
      sensitive: true,
    });
    expect(sensitive).toEqual({ decision: 'allow', remember: 'once' });
  });
});

describe('defineAdapterContract', () => {
  // A tiny in-memory adapter used to prove the harness itself behaves.
  interface FakeAdapter {
    calls: number;
    denied: boolean;
    cache: Map<string, unknown>;
  }

  const fixture = localAdapterFixture<FakeAdapter>({
    createAdapter: () => ({ calls: 0, denied: false, cache: new Map() }),
    invoke: async (adapter, req) => {
      if (adapter.denied) return { state: 'denied', errorCode: 'SY-PERM-002', receiptId: 'rcpt_denied' };
      if (req.idempotencyKey !== undefined && adapter.cache.has(req.idempotencyKey)) {
        return { state: 'succeeded', output: adapter.cache.get(req.idempotencyKey), receiptId: 'rcpt_1', replayed: true };
      }
      adapter.calls += 1;
      adapter.cache.set(req.idempotencyKey ?? 'anon', req.input);
      return { state: 'succeeded', output: req.input, receiptId: 'rcpt_1' };
    },
  });

  defineAdapterContract<FakeAdapter>('fake in-memory adapter', fixture);
});
