/**
 * Tenant-directory write lease (06 §3, WP-1.2).
 *
 * Why this exists: five of the eight file stores are "read everything → change
 * → rewrite everything". Two CLI processes doing that at the same time lose
 * updates, overwrite each other's budget reservations, and fork the audit
 * chain. The audit calls that "silent corruption": no error, no red test,
 * just wrong data.
 *
 * The lease is deliberately coarse — one writer per tenant directory — because
 * a single invocation writes 4–6 files that must agree with each other. A
 * per-file lock would need an ordering, would deadlock, and could not keep
 * the receipt chain and the audit chain consistent.
 *
 * Four mechanisms, each with one job (06 §15):
 *   - the lease directory → mutual exclusion (W1);
 *   - re-reading inside the lease → no stale overwrite (W2);
 *   - the epoch → a taken-over writer cannot clobber the new owner (W6);
 *   - FIFO by default → predictable order (W7).
 *
 * Layout under the tenant directory:
 *
 *   .write/epoch                 monotonic fencing token
 *   .write/seq                   ticket counter (FIFO order)
 *   .write/lease/owner.json      the current holder's metadata
 *   .write/queue/<ticket>.json   waiting tickets
 *   .write/tombstones/<id>.json  evidence of taken-over leases
 *   .write/metrics.jsonl         wait/hold/takeover observations (W12)
 */

import { SyaoError } from '@syaocode/core';
import type { IdGenerator, Runtime } from '@syaocode/core';

/** What kind of work a write is (06 §5.1). */
export type WorkKind = 'safety' | 'evidence' | 'governance' | 'execution' | 'telemetry' | 'maintenance';

/** The coding layer a write belongs to (06 §5.1). */
export type Layer = 'L0' | 'L1' | 'L2' | 'L3';

/** P0..P5, as numeric weights (06 §5.3). */
export type Priority = 0 | 10 | 20 | 30 | 40 | 50;

export interface WriteIntent {
  workKind?: WorkKind;
  layer?: Layer;
  priority?: Priority;
  /** Required when claiming a priority above the default — it lands in the audit. */
  reason?: string;
}

/**
 * The default intent: ordinary execution work at P3.
 *
 * Everything that does not declare an intent lands here, and because every
 * default write shares one priority, the queue is strictly FIFO (W7).
 */
export const DEFAULT_WRITE_INTENT: Required<Omit<WriteIntent, 'reason'>> = {
  workKind: 'execution',
  layer: 'L2',
  priority: 30,
};

/** The lowest priority each work kind may claim (06 §5.3 rule 1). */
export const MIN_PRIORITY_BY_WORK_KIND: Readonly<Record<WorkKind, Priority>> = {
  safety: 0,
  evidence: 10,
  governance: 20,
  execution: 30,
  telemetry: 40,
  maintenance: 50,
};

export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
export const DEFAULT_LEASE_TTL_MS = 5_000;
export const DEFAULT_AGING_MS = 2_000;
export const DEFAULT_MAX_AGING_STEPS = 2;

export interface LeaseOptions {
  runtime: Runtime;
  /** The tenant directory this lease guards. */
  dir: string;
  tenantId: string;
  intent?: WriteIntent;
  /** How long to wait for the lease before giving up (W8). */
  lockTimeoutMs?: number;
  /** How long a holder may go without a heartbeat before it can be taken over. */
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  /** Waiting longer than this ages the ticket up one level (anti-starvation). */
  agingMs?: number;
  maxAgingSteps?: number;
  ids?: IdGenerator;
}

export interface LeaseOwner {
  leaseId: string;
  epoch: number;
  ticketId: string;
  tenantId: string;
  pid: number | undefined;
  host: string;
  acquiredAt: string;
  heartbeatAt: string;
  ttlMs: number;
  intent: string;
  workKind: WorkKind;
  layer: Layer;
  priority: Priority;
  reason?: string;
}

export interface WriteLease {
  readonly epoch: number;
  readonly ticketId: string;
  readonly leaseId: string;
  readonly tenantId: string;
  /** Wall-clock ms when the lease was taken. */
  readonly acquiredAt: number;
  /** The intent this lease was taken for. */
  readonly workKind: WorkKind;
  readonly priority: Priority;
  /**
   * Prove we are still the writer (W6).
   *
   * MUST be called immediately before each durable write: the epoch file is
   * the only thing that distinguishes the current holder from a writer that
   * was paused (SIGSTOP) long enough to be taken over.
   */
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

/** Raised when the wait exceeded the timeout — the write was NOT applied (W8). */
export class StoreLockedError extends SyaoError {
  constructor(init: { message: string; waitedMs: number; ticketId: string }) {
    super({ code: 'SY-SRV-005', message: init.message, details: { waitedMs: init.waitedMs, ticketId: init.ticketId } });
  }
}

/** Raised when the epoch moved on: this writer was taken over (W6). */
export class LeaseLostError extends SyaoError {
  constructor(init: { message: string; expected: number; actual: number }) {
    super({ code: 'SY-SRV-007', message: init.message, details: { expected: init.expected, actual: init.actual } });
  }
}

// ── paths ──────────────────────────────────────────────────────────────────

function writeDir(dir: string): string {
  return `${dir}/.write`;
}
function leaseDir(dir: string): string {
  return `${writeDir(dir)}/lease`;
}
function ownerPath(dir: string): string {
  return `${leaseDir(dir)}/owner.json`;
}
function epochPath(dir: string): string {
  return `${writeDir(dir)}/epoch`;
}
function seqPath(dir: string): string {
  return `${writeDir(dir)}/seq`;
}
function seqLockPath(dir: string): string {
  return `${writeDir(dir)}/seq.lock`;
}
function queueDir(dir: string): string {
  return `${writeDir(dir)}/queue`;
}
function tombstoneDir(dir: string): string {
  return `${writeDir(dir)}/tombstones`;
}
function metricsPath(dir: string): string {
  return `${writeDir(dir)}/metrics.jsonl`;
}

// ── helpers ────────────────────────────────────────────────────────────────

async function exists(runtime: Runtime, path: string): Promise<boolean> {
  return runtime.fs.exists(path);
}

async function readJson<T>(runtime: Runtime, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await runtime.fs.readFile(path)) as T;
  } catch {
    return undefined;
  }
}

/** Write a file atomically (tmp → rename), so a reader never sees a half file. */
async function writeJsonAtomic(runtime: Runtime, path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`;
  await runtime.fs.writeFile(tmp, `${JSON.stringify(value)}\n`);
  await runtime.fs.rename(tmp, path);
}

function isEexist(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /EEXIST|already exists/i.test(message);
}

function isEnoent(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /ENOENT|no such file/i.test(message);
}

/** Deterministic jitter so a thundering herd does not retry in lockstep. */
function backoffMs(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return 20 + (h % 30);
}

/**
 * Per-process ticket counter.
 *
 * A ticket id must be unique across every writer, and deriving it from the
 * clock is not enough: two writers that enqueue in the same tick would share
 * an id, overwrite each other's ticket file, and then both believe they are
 * the same queue entry. `pid` + a process-local counter is unique by
 * construction; a caller that supplies an IdGenerator gets that instead.
 */
let ticketCounter = 0;

function nextTicketId(ids: IdGenerator | undefined): string {
  if (ids !== undefined) return ids.next('tkt');
  ticketCounter += 1;
  return `tkt_${process.pid.toString(36)}_${ticketCounter.toString(36)}`;
}

function nowIso(runtime: Runtime): string {
  return new Date(runtime.clock.now()).toISOString();
}

/** Monotonic milliseconds, falling back to the wall clock when unavailable. */
function mono(runtime: Runtime): number {
  return runtime.clock.monotonicNow?.() ?? runtime.clock.now();
}

/**
 * Clamp a requested priority to what its work kind may claim.
 *
 * Only `safety` may claim P0 and only `safety`/`evidence` may claim P1
 * (06 §5.3 rule 1). A caller asking for more than its work kind allows is
 * downgraded, not rejected — the write still happens, at the highest priority
 * it is entitled to.
 */
export function effectivePriority(intent: WriteIntent): Priority {
  const workKind = intent.workKind ?? DEFAULT_WRITE_INTENT.workKind;
  const requested = intent.priority ?? DEFAULT_WRITE_INTENT.priority;
  const floor = MIN_PRIORITY_BY_WORK_KIND[workKind];
  return (requested < floor ? floor : requested) as Priority;
}

/** Aging promotes a waiting ticket by one level, at most `maxSteps` times. */
export function agedPriority(base: Priority, waitedMs: number, agingMs: number, maxAgingSteps: number): Priority {
  if (agingMs <= 0 || waitedMs < agingMs) return base;
  const steps = Math.min(maxAgingSteps, Math.floor(waitedMs / agingMs));
  // Aging may lift a ticket at most two levels, and never above the floor its
  // work kind is entitled to (06 §5.3 rule 4).
  const floor = MIN_PRIORITY_BY_WORK_KIND.execution;
  const promoted = (base - 10 * steps) as Priority;
  const capped = promoted < floor ? (floor as Priority) : promoted;
  return capped;
}

interface Ticket {
  ticketId: string;
  tenantId: string;
  pid: number | undefined;
  host: string;
  seq: number;
  priority: Priority;
  workKind: WorkKind;
  layer: Layer;
  intent: string;
  reason?: string;
  enqueuedAt: string;
  expiresAt: string;
  /** Monotonic enqueue time — aging must not be fooled by a clock step. */
  enqueuedMono: number;
}

async function appendMetric(runtime: Runtime, dir: string, entry: Record<string, unknown>): Promise<void> {
  try {
    await runtime.fs.mkdir(queueDir(dir), { recursive: true });
    await runtime.fs.appendFile(metricsPath(dir), `${JSON.stringify(entry)}\n`);
  } catch {
    // Metrics must never break a write.
  }
}

/**
 * Take the next ticket sequence number.
 *
 * `seq` is the FIFO basis, so it must be unique and monotonic ACROSS
 * processes. A short-lived `mkdir` lock protects the read-modify-write; it is
 * held for well under a millisecond and never covers business writes.
 */
async function nextTicketSeq(runtime: Runtime, dir: string): Promise<number> {
  const lock = seqLockPath(dir);
  const deadline = mono(runtime) + 2_000;
  for (;;) {
    try {
      await runtime.fs.mkdir(lock);
      break;
    } catch (e) {
      if (!isEexist(e)) throw e;
      if (mono(runtime) > deadline) {
        // A stuck sequence lock must not deadlock every writer forever.
        throw new StoreLockedError({
          message: `could not take the ticket sequence lock at ${lock}`,
          waitedMs: 2_000,
          ticketId: 'unknown',
        });
      }
      await runtime.clock.sleep(5);
    }
  }
  try {
    const current = Number((await runtime.fs.readFile(seqPath(dir)).catch(() => '0')) || '0') || 0;
    const next = current + 1;
    await runtime.fs.writeFile(seqPath(dir), String(next));
    return next;
  } finally {
    await runtime.fs.rmdir(lock).catch(() => undefined);
  }
}

/** Bump and return the fencing epoch. */
async function bumpEpoch(runtime: Runtime, dir: string): Promise<number> {
  const current = Number((await runtime.fs.readFile(epochPath(dir)).catch(() => '0')) || '0') || 0;
  const next = current + 1;
  await runtime.fs.writeFile(epochPath(dir), String(next));
  return next;
}

async function currentEpoch(runtime: Runtime, dir: string): Promise<number> {
  const raw = await runtime.fs.readFile(epochPath(dir)).catch(() => '0');
  const value = Number(raw || '0');
  return Number.isFinite(value) ? value : 0;
}

/** Read the live tickets, dropping expired and unreadable ones. */
async function readTickets(runtime: Runtime, dir: string, nowMs: number): Promise<Ticket[]> {
  const out: Ticket[] = [];
  let names: string[] = [];
  try {
    names = (await runtime.fs.readdir(queueDir(dir))).map((e) => e.name);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = `${queueDir(dir)}/${name}`;
    const ticket = await readJson<Ticket>(runtime, path);
    if (ticket === undefined) {
      // An unreadable ticket cannot be honoured; drop it rather than block.
      await runtime.fs.unlink(path).catch(() => undefined);
      continue;
    }
    // An expired ticket is ignored for ordering but NOT deleted: it belongs
    // to another process, which may be slow rather than dead. Deleting it
    // would silently steal a live writer's place in the queue.
    if (Date.parse(ticket.expiresAt) <= nowMs) continue;
    out.push(ticket);
  }
  return out;
}

function compareTickets(a: Ticket, b: Ticket, agingMs: number, maxSteps: number, nowMono: number): number {
  const pa = agedPriority(a.priority, nowMono - a.enqueuedMono, agingMs, maxSteps);
  const pb = agedPriority(b.priority, nowMono - b.enqueuedMono, agingMs, maxSteps);
  if (pa !== pb) return pa - pb;
  return a.seq - b.seq;
}

/**
 * Acquire the tenant write lease.
 *
 * The queue is FIFO by default: every undeclared write shares P3, so tickets
 * are served strictly in `seq` order (W7). A caller that declares a higher
 * priority may overtake, but only within the bounds its work kind allows.
 */
export async function acquireWriteLease(opts: LeaseOptions): Promise<WriteLease> {
  const runtime = opts.runtime;
  const dir = opts.dir;
  const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? Math.max(1, Math.floor(leaseTtlMs / 3));
  const agingMs = opts.agingMs ?? DEFAULT_AGING_MS;
  const maxAgingSteps = opts.maxAgingSteps ?? DEFAULT_MAX_AGING_STEPS;
  const intent = opts.intent ?? {};
  const workKind = intent.workKind ?? DEFAULT_WRITE_INTENT.workKind;
  const layer = intent.layer ?? DEFAULT_WRITE_INTENT.layer;
  const priority = effectivePriority(intent);

  await runtime.fs.mkdir(queueDir(dir), { recursive: true });
  await runtime.fs.mkdir(tombstoneDir(dir), { recursive: true });

  const ticketId = nextTicketId(opts.ids);
  const seq = await nextTicketSeq(runtime, dir);
  const enqueuedMono = mono(runtime);
  const ticket: Ticket = {
    ticketId,
    tenantId: opts.tenantId,
    pid: process.pid,
    host: runtime.env.get('HOSTNAME') ?? 'localhost',
    seq,
    priority,
    workKind,
    layer,
    intent: intent.reason ?? `${workKind}/${layer}`,
    ...(intent.reason !== undefined ? { reason: intent.reason } : {}),
    enqueuedAt: nowIso(runtime),
    expiresAt: new Date(runtime.clock.now() + lockTimeoutMs).toISOString(),
    enqueuedMono,
  };
  await writeJsonAtomic(runtime, `${queueDir(dir)}/${ticketId}.json`, ticket);

  const deadline = mono(runtime) + lockTimeoutMs;
  const ticketPath = `${queueDir(dir)}/${ticketId}.json`;
  for (;;) {
    // Refresh our ticket FIRST, on every pass.
    //
    // A waiter that loses the race for the lease directory must keep its
    // place in the queue; if the refresh only happened on the happy path, a
    // long wait would age the ticket out, the queue would drop it, and the
    // writer could never win — a livelock disguised as a timeout.
    await writeJsonAtomic(runtime, ticketPath, {
      ...ticket,
      expiresAt: new Date(runtime.clock.now() + lockTimeoutMs).toISOString(),
    });

    const nowMs = runtime.clock.now();
    const nowMono = mono(runtime);
    if (nowMono > deadline) {
      await runtime.fs.unlink(ticketPath).catch(() => undefined);
      await appendMetric(runtime, dir, { type: 'write.lease.timeout', ticketId, waitedMs: nowMono - enqueuedMono });
      throw new StoreLockedError({
        message: `timed out after ${lockTimeoutMs}ms waiting for the write lease on ${dir}`,
        waitedMs: nowMono - enqueuedMono,
        ticketId,
      });
    }
    const tickets = await readTickets(runtime, dir, nowMs);
    const mine = tickets.find((t) => t.ticketId === ticketId);
    if (mine === undefined) {
      // Our ticket was pruned (a stale writer may have cleaned it). Put it
      // back so the queue keeps reflecting the real waiters.
      await writeJsonAtomic(runtime, ticketPath, {
        ...ticket,
        expiresAt: new Date(runtime.clock.now() + lockTimeoutMs).toISOString(),
      });
    }
    const head = [...tickets].sort((a, b) => compareTickets(a, b, agingMs, maxAgingSteps, nowMono))[0];

    if (head?.ticketId === ticketId) {
      try {
        // `mkdir` is the atomic test: exactly one process can win it.
        await runtime.fs.mkdir(leaseDir(dir));
      } catch (e) {
        if (!isEexist(e)) throw e;
        const owner = await readJson<LeaseOwner>(runtime, ownerPath(dir));
        const expired =
          owner === undefined ||
          runtime.clock.now() - Date.parse(owner.heartbeatAt) > owner.ttlMs;
        if (expired) {
          await takeOverLease(runtime, dir, owner, ticket, leaseTtlMs);
          continue;
        }
        await runtime.clock.sleep(backoffMs(ticketId));
        continue;
      }

      // We won the directory. Before claiming it, confirm we are still the
      // best ticket: a waiter that read the queue just before a higher-priority
      // ticket appeared would otherwise slip ahead of it. This check-then-yield
      // is what makes the declared order real rather than advisory.
      const rivals = (await readTickets(runtime, dir, runtime.clock.now())).filter(
        (t) => t.ticketId !== ticketId,
      );
      const rival = rivals.sort((a, b) => compareTickets(a, b, agingMs, maxAgingSteps, nowMono))[0];
      if (rival !== undefined && compareTickets(rival, ticket, agingMs, maxAgingSteps, nowMono) < 0) {
        await runtime.fs.rmdir(leaseDir(dir)).catch(() => undefined);
        await runtime.clock.sleep(backoffMs(ticketId));
        continue;
      }

      // We own the lease directory: take the epoch and publish ourselves.
      const epoch = await bumpEpoch(runtime, dir);
      const owner: LeaseOwner = {
        leaseId: opts.ids?.next('lease') ?? `lease_${epoch}`,
        epoch,
        ticketId,
        tenantId: opts.tenantId,
        pid: process.pid,
        host: runtime.env.get('HOSTNAME') ?? 'localhost',
        acquiredAt: nowIso(runtime),
        heartbeatAt: nowIso(runtime),
        ttlMs: leaseTtlMs,
        intent: ticket.intent,
        workKind,
        layer,
        priority,
        ...(ticket.reason !== undefined ? { reason: ticket.reason } : {}),
      };
      await writeJsonAtomic(runtime, ownerPath(dir), owner);
      await runtime.fs.unlink(`${queueDir(dir)}/${ticketId}.json`).catch(() => undefined);

      const startedAt = mono(runtime);
      await appendMetric(runtime, dir, {
        type: 'write.lease.acquired',
        ticketId,
        epoch,
        waitMs: startedAt - enqueuedMono,
        priority,
        workKind,
      });

      return makeLease(runtime, dir, owner, ticket, {
        lockTimeoutMs,
        leaseTtlMs,
        heartbeatIntervalMs,
        agingMs,
        maxAgingSteps,
        enqueuedMono,
      });

    }

    await runtime.clock.sleep(backoffMs(ticketId));
  }
}


/**
 * Remove a lease directory even when it still holds files.
 *
 * A holder killed mid-heartbeat leaves `owner.json.tmp.<pid>` behind, and a
 * plain `rmdir` then refuses with ENOTEMPTY. Swallowing that would leave the
 * lease directory in place forever and every later writer would time out.
 */
async function clearLeaseDir(runtime: Runtime, dir: string): Promise<void> {
  try {
    for (const entry of await runtime.fs.readdir(leaseDir(dir))) {
      await runtime.fs.unlink(`${leaseDir(dir)}/${entry.name}`).catch(() => undefined);
    }
  } catch {
    // No directory: nothing to clean.
  }
  await runtime.fs.rmdir(leaseDir(dir)).catch(() => undefined);
}

/**
 * Take over an expired lease.
 *
 * The old lease is preserved as a tombstone (evidence of who held it and for
 * how long) instead of being deleted, and the epoch moves on so the old holder
 * — which may simply have been paused — can no longer write.
 */
async function takeOverLease(
  runtime: Runtime,
  dir: string,
  previous: LeaseOwner | undefined,
  next: Ticket,
  leaseTtlMs: number,
): Promise<void> {
  const staleId = previous?.leaseId ?? 'unknown';
  await runtime.fs.mkdir(tombstoneDir(dir), { recursive: true });
  await writeJsonAtomic(runtime, `${tombstoneDir(dir)}/${staleId}.json`, {
    leaseId: staleId,
    epoch: previous?.epoch ?? 0,
    ticketId: previous?.ticketId ?? 'unknown',
    pid: previous?.pid,
    host: previous?.host,
    acquiredAt: previous?.acquiredAt,
    heartbeatAt: previous?.heartbeatAt,
    takenOverAt: nowIso(runtime),
    takenOverBy: next.ticketId,
    reason: 'heartbeat expired',
  });
  await clearLeaseDir(runtime, dir);
  await appendMetric(runtime, dir, {
    type: 'write.lease.taken_over',
    oldLeaseId: staleId,
    oldPid: previous?.pid,
    ticketId: next.ticketId,
    ttlMs: leaseTtlMs,
  });
}

interface LeaseInternals {
  lockTimeoutMs: number;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  agingMs: number;
  maxAgingSteps: number;
  enqueuedMono: number;
}

function makeLease(
  runtime: Runtime,
  dir: string,
  owner: LeaseOwner,
  ticket: Ticket,
  internals: LeaseInternals,
): WriteLease {
  let released = false;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;

  const stopHeartbeat = (): void => {
    if (heartbeat !== undefined) {
      clearTimeout(heartbeat);
      heartbeat = undefined;
    }
  };

  const beat = (): void => {
    if (released) return;
    void (async () => {
      try {
        const current = await readJson<LeaseOwner>(runtime, ownerPath(dir));
        if (current === undefined || current.leaseId !== owner.leaseId) return;
        await writeJsonAtomic(runtime, ownerPath(dir), { ...current, heartbeatAt: nowIso(runtime) });
      } catch {
        // A failed heartbeat means the lease may expire; the takeover path
        // handles that. Do not crash the writer here.
      }
      if (!released) {
        heartbeat = setTimeout(beat, internals.heartbeatIntervalMs);
        heartbeat.unref?.();
      }
    })();
  };
  heartbeat = setTimeout(beat, internals.heartbeatIntervalMs);
  heartbeat.unref?.();

  return {
    epoch: owner.epoch,
    ticketId: owner.ticketId,
    leaseId: owner.leaseId,
    tenantId: owner.tenantId,
    acquiredAt: Date.parse(owner.acquiredAt),
    workKind: owner.workKind,
    priority: owner.priority,
    async assertHeld(): Promise<void> {
      const actual = await currentEpoch(runtime, dir);
      if (actual !== owner.epoch) {
        throw new LeaseLostError({
          message: `write lease for ${dir} was taken over (epoch ${owner.epoch} → ${actual}); this write must be abandoned and re-run`,
          expected: owner.epoch,
          actual,
        });
      }
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      stopHeartbeat();
      // Only clean up OUR lease: if we were taken over, the current owner's
      // directory must not be touched (06 §3.8).
      if ((await currentEpoch(runtime, dir)) === owner.epoch) {
        await runtime.fs.unlink(ownerPath(dir)).catch(() => undefined);
        await runtime.fs.rmdir(leaseDir(dir)).catch(() => undefined);
      }
      await runtime.fs.unlink(`${queueDir(dir)}/${owner.ticketId}.json`).catch(() => undefined);
      await appendMetric(runtime, dir, {
        type: 'write.lease.released',
        ticketId: owner.ticketId,
        epoch: owner.epoch,
        holdMs: mono(runtime) - internals.enqueuedMono,
      });
    },
  };
}

/** Read the current lease holder, if any. */
export async function readLeaseOwner(runtime: Runtime, dir: string): Promise<LeaseOwner | undefined> {
  return readJson<LeaseOwner>(runtime, ownerPath(dir));
}

/** The live queue, oldest first. */
export async function readLeaseQueue(runtime: Runtime, dir: string): Promise<Ticket[]> {
  const tickets = await readTickets(runtime, dir, runtime.clock.now());
  return tickets.sort((a, b) => a.seq - b.seq);
}

/** The current fencing epoch. */
export async function readEpoch(runtime: Runtime, dir: string): Promise<number> {
  return currentEpoch(runtime, dir);
}

/**
 * Take over a lease whose holder is known to be gone (operator command).
 *
 * Bumps the epoch, so the old holder is fenced out even if it comes back.
 */
export async function forceUnlock(runtime: Runtime, dir: string): Promise<number> {
  const owner = await readLeaseOwner(runtime, dir);
  await runtime.fs.mkdir(tombstoneDir(dir), { recursive: true });
  await writeJsonAtomic(runtime, `${tombstoneDir(dir)}/${owner?.leaseId ?? 'unknown'}.json`, {
    leaseId: owner?.leaseId ?? 'unknown',
    epoch: owner?.epoch ?? 0,
    pid: owner?.pid,
    host: owner?.host,
    acquiredAt: owner?.acquiredAt,
    heartbeatAt: owner?.heartbeatAt,
    takenOverAt: nowIso(runtime),
    takenOverBy: 'force-unlock',
    reason: 'operator forced unlock',
  });
  await clearLeaseDir(runtime, dir);
  const epoch = await bumpEpoch(runtime, dir);
  await appendMetric(runtime, dir, { type: 'write.lease.force_unlock', epoch });
  return epoch;
}

/** True when `path` is inside the tenant's write-lease area. */
export function isLeasePath(path: string): boolean {
  return path.includes('/.write/');
}

export { isEnoent };
