/**
 * ACP v1 — content block and session/update mapping (01 §2.3, §5.5).
 *
 * ACP `ContentBlock`s are close to core's but not identical; this module is the
 * only place that translates between them so no ACP type leaks into the kernel
 * (03 §3.4 hard constraint 3).
 */

import type { TaskInputBlock, TaskState } from '@syaocode/rpc';

// ── content blocks ────────────────────────────────────────────────────────

export interface AcpTextBlock {
  type: 'text';
  text: string;
}

export interface AcpImageBlock {
  type: 'image';
  mimeType?: string;
  data?: string;
  uri?: string;
}

export interface AcpResourceLinkBlock {
  type: 'resource_link';
  uri: string;
  name?: string;
  mimeType?: string;
}

export interface AcpEmbeddedResourceBlock {
  type: 'resource';
  uri?: string;
  mimeType?: string;
  text?: string;
}

export type AcpContentBlock = AcpTextBlock | AcpImageBlock | AcpResourceLinkBlock | AcpEmbeddedResourceBlock | { type: string; [key: string]: unknown };

export function textBlock(text: string): AcpTextBlock {
  return { type: 'text', text };
}

/** ACP blocks → canonical task input blocks. */
export function contentToInputBlocks(blocks: readonly AcpContentBlock[]): TaskInputBlock[] {
  const out: TaskInputBlock[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text': {
        const text = (block as AcpTextBlock).text;
        if (typeof text === 'string') out.push({ type: 'text', text });
        break;
      }
      case 'image': {
        const image = block as AcpImageBlock;
        out.push({ type: 'data', mediaType: image.mimeType ?? 'image/png', ref: image.uri ?? image.data ?? 'inline-image' });
        break;
      }
      case 'resource_link': {
        const link = block as AcpResourceLinkBlock;
        out.push({ type: 'data', mediaType: link.mimeType ?? 'application/octet-stream', ref: link.uri });
        break;
      }
      case 'resource': {
        const resource = block as AcpEmbeddedResourceBlock;
        if (typeof resource.text === 'string') {
          out.push({ type: 'text', text: resource.text });
        } else {
          out.push({ type: 'data', mediaType: resource.mimeType ?? 'application/octet-stream', ref: resource.uri ?? 'embedded-resource' });
        }
        break;
      }
      default:
        out.push({ type: 'protocol', protocol: 'acp', native: block });
    }
  }
  return out;
}

/** Canonical input blocks → ACP blocks (outbound / replay direction). */
export function inputBlocksToContent(blocks: readonly TaskInputBlock[]): AcpContentBlock[] {
  return blocks.map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'data':
        return { type: 'resource_link', uri: block.ref, mimeType: block.mediaType };
      case 'protocol':
        return block.native as AcpContentBlock;
    }
  });
}

/** Serialize a prompt back to plain text (evidence / CLI rendering). */
export function contentText(blocks: readonly AcpContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'text') return (block as AcpTextBlock).text;
      if (block.type === 'resource_link') return `resource:${(block as AcpResourceLinkBlock).uri}`;
      if (block.type === 'resource') return (block as AcpEmbeddedResourceBlock).text ?? `resource:${(block as AcpEmbeddedResourceBlock).uri ?? ''}`;
      return '';
    })
    .filter((text) => text.length > 0)
    .join('\n');
}

// ── session/update variants (01 §5.5, pinned) ─────────────────────────────

/** The 15 `sessionUpdate` variants this edge implements (01 §5.5). */
export const ACP_SESSION_UPDATE_VARIANTS: readonly string[] = [
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
  'notice',
  'compaction_update',
  'compaction_summary_chunk',
];

export type AcpSessionUpdateKind = (typeof ACP_SESSION_UPDATE_VARIANTS)[number];

export interface AcpSessionNotification {
  sessionId: string;
  update: { sessionUpdate: AcpSessionUpdateKind; [key: string]: unknown };
}

/** Canonical event → ACP `session/update` variant (01 §5.5). */
export function eventToSessionUpdate(type: string, payload: unknown): { sessionUpdate: AcpSessionUpdateKind; [key: string]: unknown } | undefined {
  switch (type) {
    case 'invocation.output_delta':
      return { sessionUpdate: 'agent_message_chunk', content: textBlock(String((payload as { text?: unknown })?.text ?? '')) };
    case 'invocation.started':
      return { sessionUpdate: 'tool_call', ...(payload as Record<string, unknown>) };
    case 'invocation.completed':
      return { sessionUpdate: 'tool_call_update', status: 'completed', ...(payload as Record<string, unknown>) };
    case 'invocation.failed':
      return { sessionUpdate: 'tool_call_update', status: 'failed', ...(payload as Record<string, unknown>) };
    case 'task.plan':
      return { sessionUpdate: 'plan', ...(payload as Record<string, unknown>) };
    case 'capability.discovered':
      return { sessionUpdate: 'available_commands_update', ...(payload as Record<string, unknown>) };
    case 'session.mode_changed':
      return { sessionUpdate: 'current_mode_update', ...(payload as Record<string, unknown>) };
    case 'session.config_changed':
      return { sessionUpdate: 'config_option_update', ...(payload as Record<string, unknown>) };
    case 'session.metadata_changed':
      return { sessionUpdate: 'session_info_update', ...(payload as Record<string, unknown>) };
    case 'budget.settled':
    case 'budget.reserved':
      return { sessionUpdate: 'usage_update', ...(payload as Record<string, unknown>) };
    case 'notice':
      return { sessionUpdate: 'notice', ...(payload as Record<string, unknown>) };
    default:
      return undefined;
  }
}

// ── stop reasons (01 §2.3) ────────────────────────────────────────────────

export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

/** ARF terminal task state → ACP `stopReason` (uses the frozen `TASK_TO_ACP_STOP`). */
export function stopReasonFor(state: TaskState): AcpStopReason | undefined {
  return TASK_STOP[state];
}

/** Local copy kept in sync with rpc's `TASK_TO_ACP_STOP` by the drift suite. */
const TASK_STOP: Record<TaskState, AcpStopReason | undefined> = {
  submitted: undefined,
  working: undefined,
  input_required: undefined,
  auth_required: undefined,
  completed: 'end_turn',
  failed: 'refusal',
  cancelled: 'cancelled',
  rejected: 'refusal',
  expired: 'max_turn_requests',
};

// ── lossy markers ─────────────────────────────────────────────────────────

/** Semantic gaps of the ACP edge (01 §6, G5/G6). */
export const ACP_LOSSY = {
  /** ACP has no task state machine: a prompt turn is the task (G5). */
  noTaskState: 'acp-no-task-state',
  /** ACP has no artifacts: diffs/content/terminal are the artifacts (G5). */
  noArtifacts: 'acp-no-artifacts',
  /** ACP has no `denied` outcome: rejection is `selected` + `reject_*`. */
  noDeniedOutcome: 'acp-no-denied-outcome',
  /** fs/terminal are client-owned: a missing client capability fails closed (G6). */
  clientOwnedFs: 'acp-fs-client-owned',
  /** The client did not declare a capability, so the edge is unavailable (G6). */
  clientCapabilityMissing: 'acp-client-capability-missing',
  /** Session history replay only exists on `session/load`. */
  replayOnLoadOnly: 'acp-replay-on-load-only',
} as const;
