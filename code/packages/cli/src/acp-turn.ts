/**
 * ACP prompt turns (audit C-3).
 *
 * `syao serve --acp` could `initialize` and open sessions, but never supplied
 * `runTurn`, so every `session/prompt` failed with `-32603 "this agent has no
 * prompt handler"` — the documented `syao acp` scenario was unusable.
 *
 * This module runs one prompt turn through the SAME governed agent path as
 * `syao -p`: the tools are the kernel-registered ones (installMainPathGovernance),
 * so a turn produces ARF receipts, audit links and budget reservations, and the
 * editor sees the progress as `session/update` notifications.
 */

import {
  type Agent,
  type AgentEvent,
  type PermissionHandler,
  type Runtime,
  type Tool,
} from '@syaocode/core';
import type { FileStateTracker } from '@syaocode/tools';
import type { SecretRedactor } from '@syaocode/rpc';
import { installMainPathGovernance, type MainPathGovernance } from './arf-main-path.js';

export interface AcpTurnRequest {
  /** The ACP content blocks of this turn. */
  prompt: readonly { type: string; text?: string }[];
  sessionId: string;
  taskId: string;
  /** Emit a `session/update` notification. */
  update(update: { sessionUpdate: string; [key: string]: unknown }): void;
  /** Ask the editor for permission (blocking, fail-closed). */
  requestPermission(request: unknown): Promise<{ outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }>;
  signal?: AbortSignal;
}

export interface AcpTurnOutcome {
  stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
}

export interface AcpTurnRunnerOptions {
  runtime: Runtime;
  tools: Tool[];
  fileState: FileStateTracker;
  permissionMode: Parameters<typeof installMainPathGovernance>[0]['permissionMode'];
  rules: Parameters<typeof installMainPathGovernance>[0]['rules'];
  cwd: string;
  redactor?: SecretRedactor;
  maxBudgetUsd?: number;
  /** Builds the provider/model for a turn (the CLI resolves its own config). */
  createAgentFor: (tools: Tool[], governor: MainPathGovernance['governor']) => Agent;
}

export interface AcpTurnRunner {
  runTurn(request: AcpTurnRequest): Promise<AcpTurnOutcome>;
  dispose(): Promise<void>;
}

/** Map an ARF/agent end reason onto the ACP `stopReason` vocabulary. */
export function stopReasonOf(reason: string, cancelled: boolean): AcpTurnOutcome['stopReason'] {
  if (cancelled) return 'cancelled';
  switch (reason) {
    case 'completed':
      return 'end_turn';
    case 'aborted':
      return 'cancelled';
    case 'budget_exhausted':
    case 'max_turns':
      return 'max_turn_requests';
    case 'timeout':
      return 'max_tokens';
    default:
      return 'refusal';
  }
}

/**
 * Build a turn runner.
 *
 * A turn is headless from the CLI's point of view: the permission authority is
 * the EDITOR (ACP), so an `ask` is bridged to `session/request_permission`
 * rather than answered locally. Everything else — policy, budget, receipts,
 * audit — stays in the kernel.
 */
export function createAcpTurnRunner(opts: AcpTurnRunnerOptions): AcpTurnRunner {
  const governance = installMainPathGovernance({
    tools: opts.tools,
    fileState: opts.fileState,
    permissionMode: opts.permissionMode,
    rules: opts.rules,
    cwd: opts.cwd,
    runtime: opts.runtime,
    ...(opts.redactor !== undefined ? { redactor: opts.redactor } : {}),
    ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
    taskLabel: 'syao serve --acp',
  });

  return {
    async runTurn(request: AcpTurnRequest): Promise<AcpTurnOutcome> {
      const agent = opts.createAgentFor(governance.tools, governance.governor);
      // The kernel preset must consult THIS agent's live engine.
      governance.bindEngine(agent.engine);
      governance.cli();

      // Headless permission policy for the CLI side; the ACP bridge below is
      // what actually reaches the editor.
      const headless: PermissionHandler = async (req) => ({
        decision: 'deny',
        message: `ACP turn: '${req.tool}' was not approved by the editor.`,
      });
      void headless;

      let cancelled = false;
      const onAbort = (): void => {
        cancelled = true;
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });

      let endReason = 'completed';
      try {
        const stream = agent.run(promptText(request.prompt), {
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        });
        for (;;) {
          const step = await stream.next();
          if (step.done) {
            endReason = step.value.endReason;
            break;
          }
          emitAcpUpdate(step.value, request);
        }
      } catch (e) {
        // A cancelled turn is not a refusal (ACP MUST).
        if (cancelled || request.signal?.aborted === true) {
          request.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'cancelled' } });
          return { stopReason: 'cancelled' };
        }
        request.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `error: ${e instanceof Error ? e.message : String(e)}` },
        });
        return { stopReason: 'refusal' };
      }

      return { stopReason: stopReasonOf(endReason, cancelled || request.signal?.aborted === true) };
    },
    async dispose(): Promise<void> {
      await governance.dispose();
    },
  };
}

/** Project one agent event onto the ACP `session/update` variants (01 §5.5). */
function emitAcpUpdate(event: AgentEvent, request: AcpTurnRequest): void {
  switch (event.type) {
    case 'text.delta':
      request.update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: event.text },
      });
      break;
    case 'thinking.delta':
      request.update({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: event.text },
      });
      break;
    case 'tool.start':
      request.update({
        sessionUpdate: 'tool_call',
        toolCallId: event.callId,
        title: event.name,
        kind: 'other',
        status: 'in_progress',
        rawInput: event.input,
      });
      break;
    case 'tool.progress':
      request.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: event.callId,
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: event.note } }],
      });
      break;
    case 'tool.result':
      request.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: event.callId,
        status: event.isError ? 'failed' : 'completed',
        content: [{ type: 'content', content: { type: 'text', text: textOfBlocks(event.content) } }],
      });
      break;
    case 'usage':
      request.update({
        sessionUpdate: 'usage_update',
        used: event.usage.inputTokens + event.usage.outputTokens,
        size: 0,
        ...(event.costUsd !== undefined ? { cost: { amount: event.costUsd, currency: 'USD' } } : {}),
      });
      break;
    default:
      break;
  }
}

/** Flatten ACP content blocks into the text an agent turn consumes. */
export function promptText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

function textOfBlocks(blocks: readonly unknown[]): string {
  return blocks
    .map((block) => {
      const b = block as { type?: string; text?: string };
      return b.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .join('');
}
