/**
 * A2A 1.0.0 — task / message / artifact mapping (01 §2.2, §5.3).
 *
 * State names are the ProtoJSON enum names (`TASK_STATE_*`) taken verbatim from
 * the kernel's frozen `TASK_TO_A2A` table — never re-invented, never
 * string-rewritten (03 §5.2).
 *
 * G3 (A2A does not expose tool-level calls) means an A2A invocation is opaque:
 * the mapping records `visibility: 'opaque'` and the artifacts, nothing more.
 */

import {
  TASK_TO_A2A,
  type ArtifactRef,
  type CanonicalErrorShape,
  type TaskInputBlock,
  type TaskState,
  type Visibility,
} from '@syaocode/rpc';

// ── wire shapes ───────────────────────────────────────────────────────────

export interface A2aFilePart {
  name?: string;
  mimeType?: string;
  bytes?: string;
  uri?: string;
}

export interface A2aPart {
  text?: string;
  file?: A2aFilePart;
  data?: unknown;
  metadata?: Record<string, unknown>;
}

export type A2aRole = 'user' | 'agent';

export interface A2aMessage {
  messageId: string;
  role: A2aRole;
  parts: A2aPart[];
  contextId?: string;
  taskId?: string;
  referenceTaskIds?: string[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
  kind?: 'message';
}

export interface A2aArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2aPart[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
}

export interface A2aTaskStatus {
  /** `TASK_STATE_*` ProtoJSON enum name. */
  state: string;
  message?: A2aMessage;
  timestamp?: string;
}

export interface A2aTask {
  id: string;
  contextId: string;
  status: A2aTaskStatus;
  artifacts?: A2aArtifact[];
  history?: A2aMessage[];
  metadata?: Record<string, unknown>;
  kind?: 'task';
}

export interface A2aTaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: A2aTaskStatus;
  final: boolean;
  metadata?: Record<string, unknown>;
  kind: 'status-update';
}

export interface A2aTaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: A2aArtifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
  kind: 'artifact-update';
}

export type A2aStreamEvent = A2aTask | A2aMessage | A2aTaskStatusUpdateEvent | A2aTaskArtifactUpdateEvent;

// ── state mapping ─────────────────────────────────────────────────────────

/** Canonical → A2A (`TASK_TO_A2A`, frozen in rpc/src/ir/states.ts). */
export function taskStateToA2a(state: TaskState): string {
  return TASK_TO_A2A[state];
}

/**
 * A2A → canonical. `TASK_STATE_FAILED` is ambiguous: ARF `expired` degrades to
 * FAILED(reason=timeout), so the caller may disambiguate with a reason.
 */
export function a2aStateToTaskState(state: string, reason?: string): TaskState | undefined {
  switch (state) {
    case 'TASK_STATE_SUBMITTED':
      return 'submitted';
    case 'TASK_STATE_WORKING':
      return 'working';
    case 'TASK_STATE_INPUT_REQUIRED':
      return 'input_required';
    case 'TASK_STATE_AUTH_REQUIRED':
      return 'auth_required';
    case 'TASK_STATE_COMPLETED':
      return 'completed';
    case 'TASK_STATE_FAILED':
      return reason !== undefined && /timeout|expired/i.test(reason) ? 'expired' : 'failed';
    case 'TASK_STATE_CANCELED':
      return 'cancelled';
    case 'TASK_STATE_REJECTED':
      return 'rejected';
    default:
      return undefined;
  }
}

/** True when the A2A state is terminal (no further transition is legal). */
export function isA2aTerminal(state: string): boolean {
  return state === 'TASK_STATE_COMPLETED' || state === 'TASK_STATE_FAILED' || state === 'TASK_STATE_CANCELED' || state === 'TASK_STATE_REJECTED';
}

/** ARF task → A2A wire task. */
export function taskToA2a(task: {
  id: string;
  state: TaskState;
  artifacts: readonly ArtifactRef[];
  createdAt: string;
  updatedAt: string;
  terminalReason?: string;
  contextId?: string;
}): A2aTask {
  return {
    id: task.id,
    contextId: task.contextId ?? task.id,
    kind: 'task',
    status: {
      state: taskStateToA2a(task.state),
      timestamp: task.updatedAt,
      ...(task.terminalReason !== undefined
        ? { message: { messageId: `${task.id}:status`, role: 'agent' as const, parts: [{ text: task.terminalReason }] } }
        : {}),
    },
    artifacts: task.artifacts.map(artifactRefToA2a),
  };
}

// ── artifacts ─────────────────────────────────────────────────────────────

export function artifactRefToA2a(ref: ArtifactRef): A2aArtifact {
  const part: A2aPart =
    ref.ref !== undefined
      ? { file: { ...(ref.mediaType !== undefined ? { mimeType: ref.mediaType } : {}), uri: ref.ref } }
      : { data: { hash: ref.hash } };
  return {
    artifactId: ref.id,
    parts: [part],
    ...(ref.mediaType !== undefined ? { metadata: { mediaType: ref.mediaType } } : {}),
  };
}

export function a2aArtifactToRef(artifact: A2aArtifact): ArtifactRef {
  const first = artifact.parts[0];
  const ref: ArtifactRef = { id: artifact.artifactId, hash: artifact.artifactId };
  const mediaType = first?.file?.mimeType;
  if (mediaType !== undefined) ref.mediaType = mediaType;
  const uri = first?.file?.uri;
  if (uri !== undefined) ref.ref = uri;
  return ref;
}

export function a2aArtifactsToRefs(artifacts: readonly A2aArtifact[] | undefined): ArtifactRef[] {
  return (artifacts ?? []).map(a2aArtifactToRef);
}

// ── messages ──────────────────────────────────────────────────────────────

/** Flatten the text of a message (used for `Task.input` and receipts). */
export function messageText(message: A2aMessage): string {
  return message.parts
    .map((part) => (typeof part.text === 'string' ? part.text : part.file?.uri !== undefined ? `file:${part.file.uri}` : part.data !== undefined ? JSON.stringify(part.data) : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}

/** A2A message → canonical task input blocks. */
export function messageToInputBlocks(message: A2aMessage): TaskInputBlock[] {
  const blocks: TaskInputBlock[] = [];
  for (const part of message.parts) {
    if (typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.file !== undefined) {
      const ref = part.file.uri ?? part.file.name ?? 'inline';
      blocks.push({ type: 'data', mediaType: part.file.mimeType ?? 'application/octet-stream', ref });
      continue;
    }
    if (part.data !== undefined) blocks.push({ type: 'data', mediaType: 'application/json', ref: JSON.stringify(part.data) });
  }
  return blocks;
}

/** Canonical input blocks → an A2A message (outbound direction). */
export function inputBlocksToMessage(blocks: readonly TaskInputBlock[], messageId: string, role: A2aRole = 'user'): A2aMessage {
  const parts: A2aPart[] = blocks.map((block) => {
    switch (block.type) {
      case 'text':
        return { text: block.text };
      case 'data':
        return { file: { mimeType: block.mediaType, uri: block.ref } };
      case 'protocol':
        return { data: block.native, metadata: { protocol: block.protocol } };
    }
  });
  return { messageId, role, parts, kind: 'message' };
}

/** Free-form invocation input → an A2A message (adapter convenience). */
export function inputToMessage(input: unknown, messageId: string): A2aMessage {
  if (typeof input === 'string') return { messageId, role: 'user', parts: [{ text: input }], kind: 'message' };
  if (input !== null && typeof input === 'object' && Array.isArray((input as { parts?: unknown }).parts)) {
    return { messageId, role: 'user', parts: (input as { parts: A2aPart[] }).parts, kind: 'message' };
  }
  return { messageId, role: 'user', parts: [{ data: input }], kind: 'message' };
}

// ── lossy markers ─────────────────────────────────────────────────────────

/** Semantic gaps of the A2A edge (01 §6, G3/G4/G7). */
export const A2A_LOSSY = {
  /** Remote tool calls are invisible: one opaque invocation per task (G3). */
  opaqueRemoteTask: 'a2a-remote-task-opaque',
  /** No standard approval options; extension metadata or message text only (G4). */
  noApprovalOptions: 'a2a-no-approval-options',
  /** `contextId` is a weak session (01 §2.4). */
  weakSession: 'a2a-weak-session',
  /** The AgentCard is self-description, not an authorization credential (G7). */
  untrustedCard: 'a2a-agent-card-untrusted',
  /** ARF `expired` degrades to TASK_STATE_FAILED. */
  expiredAsFailed: 'a2a-expired-maps-to-failed',
  /** Push notification configs are not implemented in v1. */
  pushUnsupported: 'a2a-push-notifications-unsupported',
} as const;

/** Visibility of an A2A invocation's evidence (01 §4.8.2). */
export const A2A_VISIBILITY: Visibility = 'opaque';

/** Canonical error shape for a remote A2A failure. */
export type A2aErrorShape = CanonicalErrorShape;
