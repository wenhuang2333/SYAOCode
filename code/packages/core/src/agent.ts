import type { Runtime } from './runtime/index.js';
import { nodeRuntime } from './runtime/node.js';
import { EventBus, type AgentEvent, type EndReason, type PermissionMode } from './events.js';
import type { Provider, ToolDefinition } from './provider.js';
import { DEFAULT_RETRY_POLICY, withRetry, type RetryPolicy } from './provider.js';
import { ToolRegistry, type Tool } from './tool.js';
import { PermissionEngine, type PermissionHandler, type PermissionRule } from './permissions.js';
import { executeToolCall } from './pipeline.js';
import type { ContextConfig } from './context.js';
import { assembleSystemPrompt, estimateMessagesTokens } from './context.js';
import type { SessionStore } from './session/index.js';
import type { ContentBlock, Message, ToolCall, ToolResultBlock, Usage } from './types.js';
import { toolCallsOf } from './types.js';
import { SyaoError } from './errors/syao-error.js';

/**
 * createAgent + run loop (DD-2). The loop owns nothing global: every state
 * lives on the instance, so ≥20 agents can coexist in one process (NFR-004).
 */

export interface Limits {
  maxTurns: number;
  maxBudgetUsd: number | undefined;
  timeoutMs: number | undefined;
}

export interface AgentConfig {
  provider: Provider;
  model: string;
  cwd?: string;
  tools?: Tool[];
  permissionMode?: PermissionMode;
  rules?: PermissionRule[];
  permissionHandler?: PermissionHandler;
  extraDirs?: string[];
  context?: ContextConfig;
  session?: SessionStore;
  limits?: Partial<Limits>;
  runtime?: Runtime;
  retryPolicy?: Partial<RetryPolicy>;
  /** 工具开始执行的即时回调：事件流仍按批次有序（tool.start 在批次结束后才 yield），
   *  UI 可用这个回调实时更新"正在做什么"（阶段行）。 */
  onToolStart?: (info: { callId: string; name: string; input: unknown }) => void;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Resume a previous session (history reloaded from the store). */
  sessionId?: string;
  maxTurnsOverride?: number;
}

export interface RunSummary {
  sessionId: string;
  endReason: EndReason;
  turns: number;
  totalUsage: Usage;
  costUsd?: number;
  finalText: string;
}

const DEFAULT_LIMITS: Limits = { maxTurns: 100, maxBudgetUsd: undefined, timeoutMs: undefined };

export interface Agent {
  readonly sessionId: string;
  readonly history: Message[];
  readonly registry: ToolRegistry;
  readonly engine: PermissionEngine;
  run(input: string | Message[], opts?: RunOptions): AsyncGenerator<AgentEvent, RunSummary>;
  /** FR-003 convenience: drains the stream and resolves with the summary. */
  runOnce(input: string | Message[], opts?: RunOptions): Promise<RunSummary>;
  close(): Promise<void>;
}

export function createAgent(config: AgentConfig): Agent {
  const runtime: Runtime = config.runtime ?? nodeRuntime();
  const cwd = config.cwd ?? process.cwd();
  const registry = new ToolRegistry();
  for (const tool of config.tools ?? []) registry.register(tool);

  const extraRoots = (config.extraDirs ?? []).map((d) => (d.startsWith('/') ? d : `${cwd}/${d}`));
  const requestId = runtime.ids.next('perm');
  const engine = new PermissionEngine({
    mode: config.permissionMode ?? 'default',
    rules: config.rules ?? [],
    workspaceRoots: [cwd, ...extraRoots],
    runtime,
    ...(config.permissionHandler !== undefined ? { onRequest: config.permissionHandler } : {}),
    onResult: (id, decision, by) => {
      bus.emit({ type: 'permission.result', id, decision, by });
    },
  });

  const limits: Limits = { ...DEFAULT_LIMITS, ...config.limits };
  const sessionId = runtime.ids.next('ses');
  const history: Message[] = [];
  const bus = new EventBus();

  async function* run(input: string | Message[], opts: RunOptions = {}): AsyncGenerator<AgentEvent, RunSummary> {
    const signal = opts.signal ?? new AbortController().signal;
    const effectiveLimits: Limits = {
      ...limits,
      ...(opts.maxTurnsOverride !== undefined ? { maxTurns: opts.maxTurnsOverride } : {}),
    };
    const userOnRetry = config.retryPolicy?.onRetry;
    const provider = withRetry(config.provider, runtime, {
      ...DEFAULT_RETRY_POLICY,
      ...config.retryPolicy,
      onRetry: (info) => userOnRetry?.(info),
    });
    const capabilities = provider.capabilities(config.model);
    const pricing = capabilities.pricing;

    // ── resume ──
    let resumedSessionId = sessionId;
    if (opts.sessionId !== undefined && config.session !== undefined) {
      const entries = await config.session.load(opts.sessionId);
      for (const e of entries) {
        if (e.type === 'message') {
          const m = e.data as Message;
          history.push(m);
        }
      }
      resumedSessionId = opts.sessionId;
    }

    // ── seed input ──
    const seedMessages: Message[] =
      typeof input === 'string'
        ? [{ id: runtime.ids.next('msg'), role: 'user', content: [{ type: 'text', text: input }], meta: { createdAt: runtime.clock.now() } }]
        : input;
    history.push(...seedMessages);
    await config.session?.append(resumedSessionId, seedMessages.map(messageEntry(resumedSessionId, runtime)));

    const startedAt = runtime.clock.now();
    const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
    let costUsd = 0;
    let budgetWarned = false;
    let turns = 0;
    let endReason: EndReason = 'completed';
    let finalText = '';

    bus.emit({ type: 'session.start', sessionId: resumedSessionId, permissionMode: engine.mode });

    // repeated-failure tracking (BR-011)
    const failureStreaks = new Map<string, number>();
    const failKey = (c: ToolCall) => `${c.name}::${stableStringify(c.input)}`;

    try {
      loop: for (turns = 1; ; turns += 1) {
        // ── limit checks (BR-010) ──
        if (turns > effectiveLimits.maxTurns) {
          endReason = 'max_turns';
          yield { type: 'error', error: err('SY-LOOP-001', `maxTurns (${effectiveLimits.maxTurns}) reached`), fatal: false };
          break loop;
        }
        if (effectiveLimits.timeoutMs !== undefined && runtime.clock.now() - startedAt > effectiveLimits.timeoutMs) {
          endReason = 'timeout';
          yield { type: 'error', error: err('SY-LOOP-005', 'run timeout exceeded'), fatal: false };
          break loop;
        }
        if (effectiveLimits.maxBudgetUsd !== undefined && costUsd >= effectiveLimits.maxBudgetUsd) {
          endReason = 'budget_exhausted';
          yield { type: 'error', error: err('SY-LOOP-002', `cost budget $${effectiveLimits.maxBudgetUsd} exhausted`), fatal: false };
          break loop;
        }

        bus.emit({ type: 'turn.start', turn: turns });
        yield { type: 'turn.start', turn: turns };

        // ── model call ──
        const tools: ToolDefinition[] | undefined =
          registry.list().length > 0 ? registry.definitions() : undefined;
        const request = {
          model: config.model,
          system: assembleSystemPrompt(config.context ?? {}),
          messages: history,
          ...(tools !== undefined ? { tools } : {}),
        };

        let assistant: Message | undefined;
        let assistantStopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'error' = 'end_turn';
        // Block index → kind, learned from block_start. Required to route
        // thinking deltas separately from answer text (real providers stream both).
        const blockKinds = new Map<number, string>();
        try {
          for await (const ev of provider.stream(request, { signal })) {
            if (ev.type === 'message_stop') {
              assistant = ev.message;
              assistantStopReason = ev.stopReason;
            }
            if (ev.type === 'block_start') {
              blockKinds.set(ev.index, ev.block.type);
            }
            // Forward content increments for streaming UIs (ADR-02).
            if (ev.type === 'block_delta') {
              if (blockKinds.get(ev.index) === 'thinking') {
                bus.emit({ type: 'thinking.delta', text: ev.delta });
                yield { type: 'thinking.delta', text: ev.delta };
              } else {
                bus.emit({ type: 'text.delta', text: ev.delta });
                yield { type: 'text.delta', text: ev.delta };
              }
            }
            if (ev.type === 'usage') {
              totalUsage.inputTokens += ev.usage.inputTokens;
              totalUsage.outputTokens += ev.usage.outputTokens;
              if (ev.usage.cacheReadTokens !== undefined) {
                totalUsage.cacheReadTokens = (totalUsage.cacheReadTokens ?? 0) + ev.usage.cacheReadTokens;
              }
              if (ev.usage.cacheWriteTokens !== undefined) {
                totalUsage.cacheWriteTokens = (totalUsage.cacheWriteTokens ?? 0) + ev.usage.cacheWriteTokens;
              }
              const cost = costOf(ev.usage, pricing);
              if (cost !== undefined) {
                costUsd += cost;
                bus.emit({ type: 'usage', usage: ev.usage, costUsd: cost });
                yield { type: 'usage', usage: ev.usage, costUsd: cost };
              } else {
                bus.emit({ type: 'usage', usage: ev.usage });
                yield { type: 'usage', usage: ev.usage };
              }
            }
          }
        } catch (e) {
          const le = SyaoError.is(e) ? e : SyaoError.wrap(e);
          if (signal.aborted) {
            endReason = 'aborted';
            yield { type: 'error', error: err('SY-LOOP-003', 'run aborted by user'), fatal: false };
            break loop;
          }
          endReason = le.fatal ? 'fatal_error' : 'aborted';
          yield { type: 'error', error: le.toJSON(), fatal: true };
          break loop;
        }

        if (assistant === undefined) {
          endReason = 'fatal_error';
          yield { type: 'error', error: err('SY-PRV-008', 'provider stream ended without a message'), fatal: true };
          break loop;
        }

        history.push(assistant);
        await config.session?.append(resumedSessionId, [messageEntry(resumedSessionId, runtime)(assistant)]);
        bus.emit({ type: 'message.complete', message: assistant, stopReason: assistantStopReason });
        yield { type: 'message.complete', message: assistant, stopReason: assistantStopReason };

        // ── budget 80% warning (BR-010) ──
        if (
          !budgetWarned &&
          effectiveLimits.maxBudgetUsd !== undefined &&
          costUsd / effectiveLimits.maxBudgetUsd >= 0.8
        ) {
          budgetWarned = true;
          bus.emit({ type: 'budget.warning', kind: 'cost', ratio: costUsd / effectiveLimits.maxBudgetUsd });
          yield { type: 'budget.warning', kind: 'cost', ratio: costUsd / effectiveLimits.maxBudgetUsd };
        }

        const calls = toolCallsOf(assistant);
        if (calls.length === 0) {
          finalText = assistant.content
            .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('');
          endReason = 'completed';
          break loop;
        }

        for (const call of calls) {
          bus.emit({ type: 'tool.proposed', call });
          yield { type: 'tool.proposed', call };
        }

        // ── execute calls in batches (BR-008 / BR-009) ──
        // Events fire from inside executeToolCall (callback context), so they
        // are buffered per call and yielded in call order after each batch —
        // the run() consumer sees a deterministic stream.
        const results: ToolResultBlock[] = [];
        const batches = planBatches(calls, registry);
        const pendingByCall = new Map<string, AgentEvent[]>();
        const buffer = (callId: string) => (ev: AgentEvent) => {
          const list = pendingByCall.get(callId) ?? [];
          list.push(ev);
          pendingByCall.set(callId, list);
          bus.emit(ev);
        };
        for (const batch of batches) {
          if (signal.aborted) break;
          const executed = await Promise.all(
            batch.map((call) =>
              executeToolCall(call, registry, engine, runtime, {
                cwd,
                signal,
                events: {
                  onToolStart: (callId, name, input) => {
                    config.onToolStart?.({ callId, name, input });
                    buffer(callId)({ type: 'tool.start', callId, name, input });
                  },
                  onToolProgress: (callId, note) => buffer(callId)({ type: 'tool.progress', callId, note }),
                  onToolResult: (callId, name, content, isError, durationMs) =>
                    buffer(callId)({ type: 'tool.result', callId, name, content, isError, durationMs }),
                },
              }),
            ),
          );
          results.push(...executed);
          for (const call of batch) {
            for (const ev of pendingByCall.get(call.id) ?? []) yield ev;
            pendingByCall.delete(call.id);
          }
        }

        // aborted mid-batch → backfill missing tool_use with SY-LOOP-003 (BR-009)
        for (const call of calls) {
          if (!results.some((r) => r.toolUseId === call.id)) {
            results.push({
              type: 'tool_result',
              toolUseId: call.id,
              content: [{ type: 'text', text: 'Run aborted before this call executed (SY-LOOP-003).' }],
              isError: true,
            });
          }
        }

        // repeated-failure detection (BR-011)
        let streakBroken = false;
        for (let i = 0; i < calls.length; i += 1) {
          const call = calls[i]!;
          const result = results.find((r) => r.toolUseId === call.id);
          if (result?.isError === true) {
            const key = failKey(call);
            const streak = (failureStreaks.get(key) ?? 0) + 1;
            failureStreaks.set(key, streak);
            if (streak === 3) {
              result.content = [
                ...result.content,
                { type: 'text', text: `Note: this exact call has now failed ${streak} times in a row. Change your approach instead of repeating it (BR-011).` },
              ];
            }
            if (streak >= 5) {
              endReason = 'repeated_failure';
              yield { type: 'error', error: err('SY-LOOP-004', `tool '${call.name}' failed 5 consecutive times`), fatal: false };
              const resultMessage = resultMessageOf(results, runtime, resumedSessionId);
              history.push(resultMessage);
              await config.session?.append(resumedSessionId, [messageEntry(resumedSessionId, runtime)(resultMessage)]);
              break loop;
            }
          } else {
            streakBroken = true;
          }
        }
        if (streakBroken) {
          for (const c of calls) failureStreaks.delete(failKey(c));
        }

        const resultMessage = resultMessageOf(results, runtime, resumedSessionId);
        history.push(resultMessage);
        await config.session?.append(resumedSessionId, [messageEntry(resumedSessionId, runtime)(resultMessage)]);

        bus.emit({ type: 'turn.end', turn: turns });
        yield { type: 'turn.end', turn: turns };
      }
    } finally {
      bus.emit({ type: 'session.end', reason: endReason });
      bus.end();
    }

    return {
      sessionId: resumedSessionId,
      endReason,
      turns: turns - 1 < 0 ? 0 : turns - 1,
      totalUsage,
      ...(costUsd > 0 || pricing !== undefined ? { costUsd } : {}),
      finalText,
    };
  }

  return {
    sessionId,
    history,
    registry,
    engine,
    run,
    async runOnce(input, opts = {}) {
      const it = run(input, opts);
      for (;;) {
        const r = await it.next();
        if (r.done) return r.value;
      }
    },
    async close() {
      bus.end();
    },
  };
}

function messageEntry(sessionId: string, runtime: Runtime) {
  return (m: Message) => ({
    v: 1 as const,
    id: runtime.ids.next('ent'),
    ts: runtime.clock.now(),
    sessionId,
    type: 'message' as const,
    data: m,
  });
}

function resultMessageOf(results: ToolResultBlock[], runtime: Runtime, _sessionId: string): Message {
  return {
    id: runtime.ids.next('msg'),
    role: 'user',
    content: results,
    meta: { createdAt: runtime.clock.now() },
  };
}

function err(code: string, message: string) {
  return new SyaoError({ code, message }).toJSON();
}

/** Batch plan (BR-008): consecutive read-only+concurrency-safe calls run in parallel; anything else serial. */
export function planBatches(calls: ToolCall[], registry: ToolRegistry): ToolCall[][] {
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentParallel = true;
  for (const call of calls) {
    const tool = registry.get(call.name);
    const parallel = tool !== undefined && tool.readOnly && tool.concurrencySafe;
    if (current.length === 0) {
      current = [call];
      currentParallel = parallel;
    } else if (parallel && currentParallel) {
      current.push(call);
    } else {
      batches.push(current);
      current = [call];
      currentParallel = parallel;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function costOf(usage: Usage, pricing: { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number } | undefined): number | undefined {
  // 网关直接上报的费用最准确（含路由/折扣），优先于本地价目表
  if (usage.costUsd !== undefined) return usage.costUsd;
  if (pricing === undefined) return undefined;
  let cost = 0;
  cost += (usage.inputTokens / 1e6) * pricing.inputPerMTok;
  cost += (usage.outputTokens / 1e6) * pricing.outputPerMTok;
  if (usage.cacheReadTokens !== undefined && pricing.cacheReadPerMTok !== undefined) {
    cost += (usage.cacheReadTokens / 1e6) * pricing.cacheReadPerMTok;
  }
  if (usage.cacheWriteTokens !== undefined && pricing.cacheWritePerMTok !== undefined) {
    cost += (usage.cacheWriteTokens / 1e6) * pricing.cacheWritePerMTok;
  }
  return cost;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, val]) => [k, sortKeys(val)]),
    );
  }
  return v;
}

export { estimateMessagesTokens };
