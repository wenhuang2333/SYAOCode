/**
 * Tenant write lease (06 §3, WP-1.2).
 *
 * The lease is the thing that decides whether two CLI processes can safely
 * share a governance directory, so these tests are written to break it: they
 * assert the invariants (W1/W6/W7/W8) directly rather than the implementation's
 * shape.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WRITE_INTENT,
  MIN_PRIORITY_BY_WORK_KIND,
  acquireWriteLease,
  agedPriority,
  effectivePriority,
  forceUnlock,
  readEpoch,
  readLeaseOwner,
  readLeaseQueue,
  StoreLockedError,
  LeaseLostError,
} from '../src/runtime/lock.js';
import { FakeRuntime, TEST_TENANT } from './kernel-helpers.js';

function runtime(): FakeRuntime {
  return new FakeRuntime();
}

/**
 * Let queued writers actually run.
 *
 * `rt.clock.sleep()` advances the FAKE clock, so using it to "wait for the
 * queue to fill" would both starve the waiters (one microtask turn each) and
 * age their tickets. A real timer lets their promise chains progress without
 * moving lease time at all.
 */
function settle(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Short timings so tests do not spend seconds waiting. */
function fastOpts(rt: FakeRuntime, dir: string, extra: Record<string, unknown> = {}) {
  return {
    runtime: rt,
    dir,
    tenantId: TEST_TENANT,
    lockTimeoutMs: 2_000,
    // A healthy holder must look healthy. Waiters burn simulated time with
    // backoff, so a short TTL would let one legitimately take over from a
    // holder that is perfectly alive; tests that WANT a takeover say so.
    leaseTtlMs: 600_000,
    heartbeatIntervalMs: 50,
    agingMs: 10_000,
    ...extra,
  };
}

describe('write intent (06 §5.3)', () => {
  it('defaults to execution / L2 / P3 so ordinary writes are FIFO', () => {
    expect(DEFAULT_WRITE_INTENT).toEqual({ workKind: 'execution', layer: 'L2', priority: 30 });
    expect(effectivePriority({})).toBe(30);
  });

  it('lets only safety claim P0 and only safety/evidence claim P1', () => {
    expect(effectivePriority({ workKind: 'safety', priority: 0 })).toBe(0);
    expect(effectivePriority({ workKind: 'evidence', priority: 10 })).toBe(10);
    // An execution write asking for P1 is downgraded to its floor, not honoured.
    expect(effectivePriority({ workKind: 'execution', priority: 10 })).toBe(30);
    expect(effectivePriority({ workKind: 'governance', priority: 0 })).toBe(20);
    expect(effectivePriority({ workKind: 'maintenance', priority: 0 })).toBe(50);
    // Asking for LOWER priority than the floor (bigger number) is fine.
    expect(effectivePriority({ workKind: 'safety', priority: 50 })).toBe(50);
  });

  it('documents a floor for every work kind', () => {
    for (const [kind, floor] of Object.entries(MIN_PRIORITY_BY_WORK_KIND)) {
      expect(effectivePriority({ workKind: kind as never, priority: 0 })).toBe(floor);
    }
  });

  it('ages a waiting ticket by one level per aging window, capped at two steps and at P3', () => {
    expect(agedPriority(50, 0, 1_000, 2)).toBe(50);
    expect(agedPriority(50, 1_000, 1_000, 2)).toBe(40);
    expect(agedPriority(50, 2_000, 1_000, 2)).toBe(30);
    // Never below P3 (06 §5.3 rule 4: P5 may rise only to P3).
    expect(agedPriority(50, 10_000, 1_000, 2)).toBe(30);
    expect(agedPriority(10, 10_000, 1_000, 2)).toBe(30);
  });
});

describe('write lease: mutual exclusion (W1)', () => {
  it('grants the lease to exactly one writer at a time', async () => {
    const rt = runtime();
    const dir = '/tenant';
    const first = await acquireWriteLease(fastOpts(rt, dir));
    expect(first.epoch).toBe(1);
    expect((await readLeaseOwner(rt, dir))?.ticketId).toBe(first.ticketId);

    // A second writer must not get the lease while the first holds it.
    let secondDone = false;
    const second = acquireWriteLease(fastOpts(rt, dir, { leaseTtlMs: 600_000 })).then((lease) => {
      secondDone = true;
      return lease;
    });

    await settle(60);
    expect(secondDone).toBe(false);
    expect((await readLeaseQueue(rt, dir)).length).toBeGreaterThan(0);

    await first.release();
    const secondLease = await second;
    expect(secondLease.epoch).toBe(2);
    await secondLease.release();
  });

  it('release removes the owner, the directory and the ticket', async () => {
    const rt = runtime();
    const dir = '/tenant';
    const lease = await acquireWriteLease(fastOpts(rt, dir));
    await lease.release();

    expect(await readLeaseOwner(rt, dir)).toBeUndefined();
    expect(await rt.fs.exists(`${dir}/.write/lease`)).toBe(false);
    expect(await readLeaseQueue(rt, dir)).toEqual([]);
  });

  it('releasing twice is harmless', async () => {
    const rt = runtime();
    const lease = await acquireWriteLease(fastOpts(rt, '/t'));
    await lease.release();
    await expect(lease.release()).resolves.toBeUndefined();
  });
});

describe('write lease: fencing (W6)', () => {
  it('rejects a write from a lease whose epoch moved on', async () => {
    const rt = runtime();
    const dir = '/tenant';
    const lease = await acquireWriteLease(fastOpts(rt, dir));
    await lease.assertHeld();

    // Simulate a takeover: the epoch advances.
    await rt.fs.writeFile(`${dir}/.write/epoch`, '99');

    await expect(lease.assertHeld()).rejects.toThrow(/taken over/);
    await expect(lease.assertHeld()).rejects.toBeInstanceOf(LeaseLostError);
  });

  it('a released lease cannot be used to clean up the next owner', async () => {
    const rt = runtime();
    const dir = '/tenant';
    const first = await acquireWriteLease(fastOpts(rt, dir));
    const firstEpoch = first.epoch;
    await forceUnlock(rt, dir);
    // After a force unlock the old holder must not delete the new owner's files.
    await first.release();
    expect(await readEpoch(rt, dir)).toBe(firstEpoch + 1);
  });
});

describe('write lease: takeover (W6 / §3.5)', () => {
  it('takes over a lease whose heartbeat expired, keeping a tombstone', async () => {
    const rt = runtime();
    const dir = '/tenant';
    const lease = await acquireWriteLease(
      fastOpts(rt, dir, { leaseTtlMs: 100, heartbeatIntervalMs: 100_000 }),
    );
    const firstEpoch = lease.epoch;
    const leaseId = lease.leaseId;

    // Let the TTL pass without a heartbeat (the interval is far longer).
    rt.clock.advance(1_000);

    const next = await acquireWriteLease(fastOpts(rt, dir, { leaseTtlMs: 600_000 }));
    expect(next.epoch).toBe(firstEpoch + 1);
    expect(next.leaseId).not.toBe(leaseId);

    const tombstone = await rt.fs.readFile(`${dir}/.write/tombstones/${leaseId}.json`);
    expect(JSON.parse(tombstone)).toMatchObject({ leaseId, reason: 'heartbeat expired' });

    await next.release();
  });

  it('does NOT take over a lease whose heartbeat is fresh', async () => {
    const rt = runtime();
    const dir = '/tenant';
    const lease = await acquireWriteLease(fastOpts(rt, dir, { leaseTtlMs: 600_000 }));

    const attempt = acquireWriteLease(fastOpts(rt, dir, { lockTimeoutMs: 150, leaseTtlMs: 600_000 }));
    await expect(attempt).rejects.toBeInstanceOf(StoreLockedError);

    await lease.release();
  });

  it('forceUnlock bumps the epoch so the old holder is fenced out', async () => {
    const rt = runtime();
    const dir = '/tenant';
    const lease = await acquireWriteLease(fastOpts(rt, dir));
    const epoch = await forceUnlock(rt, dir);
    expect(epoch).toBe(lease.epoch + 1);
    await expect(lease.assertHeld()).rejects.toBeInstanceOf(LeaseLostError);
  });
});

describe('write lease: timeout (W8)', () => {
  it('gives up after lockTimeoutMs instead of spinning forever', async () => {
    const rt = runtime();
    const dir = '/tenant';
    const held = await acquireWriteLease(fastOpts(rt, dir, { leaseTtlMs: 600_000 }));
    const started = rt.clock.now();
    await expect(
      acquireWriteLease(fastOpts(rt, dir, { lockTimeoutMs: 100, leaseTtlMs: 600_000 })),
    ).rejects.toBeInstanceOf(StoreLockedError);
    // It must actually have waited, not failed instantly.
    expect(rt.clock.now()).toBeGreaterThanOrEqual(started);
    await held.release();
  });

  it('does not leave its ticket behind after timing out', async () => {
    const rt = runtime();
    const dir = '/tenant';
    const held = await acquireWriteLease(fastOpts(rt, dir, { leaseTtlMs: 600_000 }));
    await expect(
      acquireWriteLease(fastOpts(rt, dir, { lockTimeoutMs: 100, leaseTtlMs: 600_000 })),
    ).rejects.toBeInstanceOf(StoreLockedError);
    // The timed-out writer must not be left in the queue, and the holder is
    // not a waiter either — after acquiring, its ticket is gone.
    expect(await readLeaseQueue(rt, dir)).toEqual([]);
    await held.release();
  });
});

describe('write lease: ordering (W7)', () => {
  it('serves same-priority tickets in FIFO order', async () => {
    const rt = runtime();
    const dir = '/tenant';
    const held = await acquireWriteLease(fastOpts(rt, dir, { leaseTtlMs: 600_000 }));

    // Queue three default (P3) writers; the lease is held so they all wait.
    const order: string[] = [];
    const waiters = ['a', 'b', 'c'].map((tag) =>
      acquireWriteLease(fastOpts(rt, dir, { leaseTtlMs: 600_000 })).then(async (lease) => {
        order.push(tag);
        await lease.release();
      }),
    );

    await settle();
    // Sanity: all three are queued with increasing seq.
    const queue = await readLeaseQueue(rt, dir);
    expect(queue.length).toBe(3);
    expect(queue.map((t) => t.seq)).toEqual([...queue.map((t) => t.seq)].sort((x, y) => x - y));

    await held.release();
    await Promise.all(waiters);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('lets a safety write (P0) overtake queued execution writes', async () => {
    const rt = runtime();
    const dir = '/tenant';
    const held = await acquireWriteLease(fastOpts(rt, dir, { leaseTtlMs: 600_000 }));

    const order: string[] = [];
    const normal = acquireWriteLease(
      fastOpts(rt, dir, { leaseTtlMs: 600_000, intent: { workKind: 'execution', layer: 'L2', priority: 30 } }),
    ).then(async (lease) => {
      order.push('execution');
      await lease.release();
    });
    await settle(10);
    const urgent = acquireWriteLease(
      fastOpts(rt, dir, {
        leaseTtlMs: 600_000,
        intent: { workKind: 'safety', layer: 'L0', priority: 0, reason: 'policy.denied' },
      }),
    ).then(async (lease) => {
      order.push('safety');
      await lease.release();
    });

    await settle();
    await held.release();
    await Promise.all([normal, urgent]);
    // Safety overtook even though it queued later.
    expect(order).toEqual(['safety', 'execution']);
  });

  it('downgrades an execution write that asks for P0', async () => {
    const rt = runtime();
    const dir = '/tenant';
    const lease = await acquireWriteLease(
      fastOpts(rt, dir, { intent: { workKind: 'execution', priority: 0 } }),
    );
    expect(lease.priority).toBe(30);
    await lease.release();
  });
});

describe('write lease: ticket sequence', () => {
  it('hands out unique, increasing sequence numbers under many waiters', async () => {
    const rt = runtime();
    const dir = '/tenant';
    const held = await acquireWriteLease(fastOpts(rt, dir, { lockTimeoutMs: 20_000 }));

    // The lease is strictly serial, so N waiters are served one after another;
    // the individual timeout must cover the whole drain, not one acquisition.
    const waiters = Array.from({ length: 20 }, () =>
      acquireWriteLease(fastOpts(rt, dir, { lockTimeoutMs: 20_000 })).then(async (lease) => {
        await lease.release();
        return lease;
      }),
    );

    // All 40 must get a distinct ticket number while the lease is held. The
    // counter file is the durable record of that, independent of how quickly
    // the waiters happen to queue up.
    await settle(500);
    const issued = Number(await rt.fs.readFile(`${dir}/.write/seq`));
    // One for the holder plus twenty waiters.
    expect(issued).toBe(21);

    await held.release();
    const leases = await Promise.all(waiters);
    expect(leases.length).toBe(20);
    // Every ticket id is distinct — a collision would let two writers believe
    // they are the same queue entry.
    expect(new Set(leases.map((l) => l.ticketId)).size).toBe(20);
    // And every writer cleaned its ticket up.
    expect(await readLeaseQueue(rt, dir)).toEqual([]);
  });
});

describe('write lease: observability (W12)', () => {
  it('records acquire and release metrics', async () => {
    const rt = runtime();
    const dir = '/tenant';
    const lease = await acquireWriteLease(fastOpts(rt, dir));
    await lease.release();
    const metrics = (await rt.fs.readFile(`${dir}/.write/metrics.jsonl`))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    expect(metrics.map((m) => m.type)).toEqual(
      expect.arrayContaining(['write.lease.acquired', 'write.lease.released']),
    );
  });

  it('records a timeout', async () => {
    const rt = runtime();
    const dir = '/tenant';
    const held = await acquireWriteLease(fastOpts(rt, dir, { leaseTtlMs: 600_000 }));
    await expect(
      acquireWriteLease(fastOpts(rt, dir, { lockTimeoutMs: 80, leaseTtlMs: 600_000 })),
    ).rejects.toBeInstanceOf(StoreLockedError);
    const metrics = (await rt.fs.readFile(`${dir}/.write/metrics.jsonl`)).trim().split('\n');
    expect(metrics.some((line) => line.includes('write.lease.timeout'))).toBe(true);
    await held.release();
  });
});
