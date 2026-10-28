/**
 * Event projection — fold the canonical event log into a `Task` (01 §4.4).
 *
 * The projection is the ONLY way task state is derived: stores never mutate a
 * task row directly from a protocol message, they append an event and replay.
 * Illegal state transitions throw (`assertTaskTransition`) so a bug fails loudly
 * instead of silently corrupting the projection.
 *
 * Recognised payloads (tolerant on purpose — adapters and the dispatcher both
 * write events):
 *   task.created          payload = Task | { task: Task }
 *   task.state_changed    payload = { state } | { to } | TaskState
 *   task.completed        payload = { reason? }
 *   task.failed           payload = { reason?, error? }
 *   task.cancelled        payload = { reason? }
 *   artifact.created/updated  payload = ArtifactRef | { artifact: ArtifactRef } | Artifact
 *
 * Any other event type only advances the watermark (`lastSeq`, `updatedAt`).
 */

import { TASK_STATES, assertTaskTransition } from '../ir/states.js';
import type { ArtifactRef, CanonicalEvent, Task, TaskInputBlock, TaskState } from '../ir/types.js';

// ── shared helpers ────────────────────────────────────────────────────────

/** Structural copy so callers cannot mutate stored rows. */
export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => deepClone(item)) as unknown as T;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = deepClone(item);
  return out as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ── folding ───────────────────────────────────────────────────────────────

/**
 * Fold a full (or partial) event stream into a task; `undefined` before create.
 *
 * `seed` lets a host project onto the authoritative task row (the TaskStore is
 * the source of truth; the event log is the change log). When a seed is given
 * the `task.created` event only validates and advances the watermark.
 */
export function projectTask(events: readonly CanonicalEvent[], seed?: Task): Task | undefined {
  let task = seed !== undefined ? deepClone(seed) : undefined;
  for (const event of events) task = applyEvent(task, event);
  return task;
}

/** Apply one event to the running projection. */
export function applyEvent(task: Task | undefined, event: CanonicalEvent): Task | undefined {
  switch (event.type) {
    case 'task.created': {
      const created = readCreatedTask(event);
      return task === undefined ? created : mergeCreated(task, created, event);
    }
    case 'task.state_changed':
    case 'task.completed':
    case 'task.failed':
    case 'task.cancelled':
      return transitionTask(task, event, stateOf(event));
    case 'artifact.created':
    case 'artifact.updated':
      return upsertArtifact(task, event);
    default:
      if (task === undefined) return undefined;
      return { ...task, lastSeq: event.seq, updatedAt: event.ts };
  }
}

/**
 * Fold a `task.created` event onto the authoritative row. The event usually
 * carries only a subset (the dispatcher emits `{ state }`), so the row wins for
 * everything the event does not state.
 */
function mergeCreated(seed: Task, created: Task, event: CanonicalEvent): Task {
  if (seed.id !== event.taskId) {
    throw new Error(`projection: event ${event.eventId} targets ${event.taskId} but the projection holds ${seed.id}`);
  }
  if (seed.state !== created.state) assertTaskTransition(seed.state, created.state);
  return {
    ...seed,
    state: created.state,
    sessionId: created.sessionId !== '' ? created.sessionId : seed.sessionId,
    tenantId: created.tenantId !== '' ? created.tenantId : seed.tenantId,
    input: created.input.length > 0 ? created.input : seed.input,
    artifacts: created.artifacts.length > 0 ? created.artifacts : seed.artifacts,
    lastSeq: event.seq,
    updatedAt: created.updatedAt,
  };
}

function transitionTask(task: Task | undefined, event: CanonicalEvent, to: TaskState): Task {
  if (task === undefined) {
    throw new Error(`projection: ${event.type} for task ${event.taskId} arrived before task.created`);
  }
  if (task.id !== event.taskId) {
    throw new Error(`projection: event ${event.eventId} targets ${event.taskId} but the projection holds ${task.id}`);
  }
  // Re-emitting the current state is an idempotent no-op (replay safety);
  // anything else must be a legal edge or the bug is loud.
  if (task.state !== to) assertTaskTransition(task.state, to);
  const next: Task = { ...task, state: to, lastSeq: event.seq, updatedAt: event.ts };
  const reason = reasonOf(event.payload);
  if (reason !== undefined) next.terminalReason = reason;
  return next;
}

function upsertArtifact(task: Task | undefined, event: CanonicalEvent): Task {
  if (task === undefined) {
    throw new Error(`projection: ${event.type} for task ${event.taskId} arrived before task.created`);
  }
  if (task.id !== event.taskId) {
    throw new Error(`projection: event ${event.eventId} targets ${event.taskId} but the projection holds ${task.id}`);
  }
  const ref = readArtifactRef(event);
  const artifacts = task.artifacts.filter((item) => item.id !== ref.id);
  artifacts.push(ref);
  return { ...task, artifacts, lastSeq: event.seq, updatedAt: event.ts };
}

// ── payload readers ───────────────────────────────────────────────────────

function stateOf(event: CanonicalEvent): TaskState {
  if (event.type === 'task.completed') return 'completed';
  if (event.type === 'task.failed') return 'failed';
  if (event.type === 'task.cancelled') return 'cancelled';
  const payload = event.payload;
  const raw = typeof payload === 'string'
    ? payload
    : isRecord(payload) && typeof payload['state'] === 'string'
      ? (payload['state'] as string)
      : isRecord(payload) && typeof payload['to'] === 'string'
        ? (payload['to'] as string)
        : undefined;
  if (raw === undefined || !(TASK_STATES as readonly string[]).includes(raw)) {
    throw new Error(`projection: ${event.type} for task ${event.taskId} carries no valid state`);
  }
  return raw as TaskState;
}

function reasonOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const reason = payload['reason'] ?? payload['terminalReason'];
  return typeof reason === 'string' ? reason : undefined;
}

/**
 * Read a `task.created` payload. The authoritative task row lives in the
 * TaskStore; the event may carry the whole task or only the fields the emitter
 * knows (the dispatcher emits `{ state }`), so missing fields are filled from
 * the event and safe defaults.
 */
function readCreatedTask(event: CanonicalEvent): Task {
  const payload = event.payload;
  const raw = isRecord(payload) && isRecord(payload['task']) ? payload['task'] : payload;
  if (!isRecord(raw)) throw new Error(`projection: task.created for ${event.taskId} has a non-object payload`);
  const id = typeof raw['id'] === 'string' ? raw['id'] : event.taskId;
  if (id !== event.taskId) {
    throw new Error(`projection: task.created payload id ${id} does not match event task ${event.taskId}`);
  }
  const sessionId = typeof raw['sessionId'] === 'string' ? raw['sessionId'] : '';
  const tenantId = typeof raw['tenantId'] === 'string' ? raw['tenantId'] : '';
  const rawState = raw['state'];
  const state = typeof rawState === 'string' && (TASK_STATES as readonly string[]).includes(rawState)
    ? (rawState as TaskState)
    : 'submitted';
  const input = Array.isArray(raw['input']) ? (raw['input'] as TaskInputBlock[]) : [];
  const artifacts = Array.isArray(raw['artifacts']) ? (raw['artifacts'] as ArtifactRef[]) : [];
  const createdAt = typeof raw['createdAt'] === 'string' ? raw['createdAt'] : event.ts;
  const updatedAt = typeof raw['updatedAt'] === 'string' ? raw['updatedAt'] : event.ts;
  return {
    id,
    sessionId,
    tenantId,
    state,
    input,
    artifacts,
    createdAt,
    updatedAt,
    lastSeq: event.seq,
    ...(typeof raw['parentTaskId'] === 'string' ? { parentTaskId: raw['parentTaskId'] } : {}),
    ...(typeof raw['terminalReason'] === 'string' ? { terminalReason: raw['terminalReason'] } : {}),
    ...(raw['cancelRequested'] === true ? { cancelRequested: true } : {}),
  };
}

function readArtifactRef(event: CanonicalEvent): ArtifactRef {
  const payload = event.payload;
  const raw = isRecord(payload) && isRecord(payload['artifact']) ? payload['artifact'] : payload;
  if (!isRecord(raw)) throw new Error(`projection: ${event.type} for ${event.taskId} has a non-object payload`);
  const { id, hash } = raw;
  if (typeof id !== 'string' || typeof hash !== 'string') {
    throw new Error(`projection: ${event.type} for ${event.taskId} needs { id, hash }`);
  }
  const ref: ArtifactRef = { id, hash };
  if (typeof raw['mediaType'] === 'string') ref.mediaType = raw['mediaType'];
  if (typeof raw['ref'] === 'string') ref.ref = raw['ref'];
  if (typeof raw['bytes'] === 'number') ref.bytes = raw['bytes'];
  return ref;
}
