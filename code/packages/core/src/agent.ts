import type { Runtime } from './runtime/index.js';
import {
  AGENT_EVENT_SCHEMA_VERSION,
  EventBus,
  type AgentEvent,
  type AgentEventBody,
  type EndReason,
  type EventSink,
  type PermissionMode,
} from './events.js';
import type { Provider, ToolDefinition } from './provider.js';
import { DEFAULT_RETRY_POLICY, withRetry, type RetryPolicy } from './provider.js';
import { ToolRegistry, type Tool, type ToolGovernor } from './tool.js';
import {
  PermissionEngine,
  classifyCommand,
  type PermissionHandler,
  type PermissionRule,
  type PermissionRuleStore,
} from './permissions.js';
import { executeToolCall } from './pipeline.js';
import type { ContextConfig } from './context.js';
import { assembleSystemPrompt, estimateMessagesTokens } from './context.js';
import type { SessionStore } from './session/index.js';
import type { ContentBlock, Message, ToolCall, ToolResultBlock, Usage } from './types.js';
import { toolCallsOf } from './types.js';
import { SyaoError } from './errors/syao-error.js';
import { RedactingLogger, RedactingSessionStore, type Redactor } from './redact.js';
import {
  type ReceiptStore,
  type ToolReceipt,
  type VerificationReport,
} from './evidence.js';
import { lintClaims, verdictOf, type ClaimCheck, type Verdict } from './claims.js';
import { discoverVerification, runVerification, type DiscoveredCommand, type VerificationOptions } from './verify.js';

/**
 * createAgent + run loop (DD-2). The loop owns nothing global: every state
 * lives on the instance, so ≥20 agents can coexist in one process (NFR-004).
 */

export interface Limits {
  maxTurns: number;
  maxBudgetUsd: number | undefined;
  /** Price-independent hard stop: input + output + cache tokens (report L8/L3). */
  maxTotalTokens: number | undefined;
  /** Price-independent wall-clock stop; `timeoutMs` is kept as an alias. */
  maxWallClockMs: number | undefined;
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
  /** Required: the kernel never constructs a host runtime (report E1). */
  runtime: Runtime;
  retryPolicy?: Partial<RetryPolicy>;
  /** Redacts secrets before tool results reach history/events and before session writes. */
  redactor?: Redactor;
  /** Content-addressed receipts for tool outputs (Evidence MVP). */
  receipts?: ReceiptStore;
  /** Automatic verification after a completed run (report v0.2.5). */
  verification?: VerificationOptions;
  /**
   * Out-of-band event channel (report C3). Sinks receive every event
   * synchronously at production time, so an approval request is visible to
   * subscribers *before* the permission handler is awaited (report C1).
   * The agent never closes a sink; call `flush()`/`close()` from the host.
   */
  eventSink?: EventSink;
  /** Persisted `remember:'project'` approvals, reloaded per run (report C5). */
  permissionRuleStore?: PermissionRuleStore;
  /**
   * Host-supplied execution authority (ARF kernel).
   *
   * When set, every tool call is authorized and executed by the governor
   * instead of the local permission gate + `tool.execute`. The agent keeps
   * emitting `tool.start` / `tool.result` / `tool.receipt` and keeps building
   * the same `ToolResultBlock`s, so the UI and the loop are unaffected.
   */
  governor?: ToolGovernor;
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
  permissionDenied: boolean;
  finalText: string;
  verdict: Verdict;
  claims: ClaimCheck[];
  toolReceipts: ToolReceipt[];
  verification?: VerificationReport;
  /** Set when verification was intentionally skipped (untrusted or dangerous command). */
  verificationNote?: string;
}

const DEFAULT_LIMITS: Limits = {
  maxTurns: 100,
  maxBudgetUsd: undefined,
  maxTotalTokens: undefined,
  maxWallClockMs: undefined,
  timeoutMs: undefined,
};

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
  const baseRuntime: Runtime = config.runtime;
  const runtime: Runtime =
    config.redactor !== undefined
      ? { ...baseRuntime, logger: new RedactingLogger(baseRuntime.logger, config.redactor) }
      : baseRuntime;
  const session: SessionStore | undefined =
    config.session !== undefined && config.redactor !== undefined
      ? new RedactingSessionStore(config.session, config.redactor)
      : config.session;
  const cwd = config.cwd ?? process.cwd();
  const registry = new ToolRegistry();
  for (const tool of config.tools ?? []) registry.register(tool);

  const limits: Limits = { ...DEFAULT_LIMITS, ...config.limits };
  const sessionId = runtime.ids.next('ses');
  const history: Message[] = [];
  const bus = new EventBus();
  const sinks: EventSink[] = config.eventSink !== undefined ? [config.eventSink] : [];

  /** Set for the duration of one run(); approval callbacks use it to stamp envelopes. */
  let activeRun:
    | {
        emit: (body: AgentEventBody, meta?: { causationId?: string; turnId?: string }, callId?: string) => void;
        /** Approval path (C1): never buffered, delivered before the handler is awaited. */
        emitImmediate: (body: AgentEventBody, meta?: { causationId?: string; turnId?: string }) => void;
        notePermission: (decision: 'allow' | 'deny') => void;
      }
    | undefined;

  const extraRoots = (config.extraDirs ?? []).map((d) => (d.startsWith('/') ? d : `${cwd}/${d}`));
  const engine = new PermissionEngine({
    mode: config.permissionMode ?? 'default',
    rules: config.rules ?? [],
    workspaceRoots: [cwd, ...extraRoots],
    runtime,
    ...(config.permissionHandler !== undefined ? { onRequest: config.permissionHandler } : {}),
    ...(config.permissionRuleStore !== undefined ? { ruleStore: config.permissionRuleStore } : {}),
    onRequestStart: (req) => {
      // C1: an approval prompt must reach subscribers *before* the handler is
      // awaited — otherwise a multi-client host cannot answer it at all.
      activeRun?.emitImmediate(
        { type: 'permission.request', id: req.id, request: req },
        { causationId: req.id },
      );
    },
    onResult: (id, decision, by) => {
      activeRun?.emitImmediate(
        { type: 'permission.result', id, decision, by },
        { causationId: id },
      );
      activeRun?.notePermission(decision);
    },
  });

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

    const runId = runtime.ids.next('run');
    let seq = 0;
    let currentTurnId: string | undefined;
    let permissionDenied = false;
    /** Session the envelopes belong to; updated by the resume branch. */
    let envelopeSessionId = sessionId;
    const pendingByCall = new Map<string, AgentEvent[]>();
    /**
     * Approval events bypass the per-call batch buffer (report C1): they are
     * queued here and surfaced by the generator's drain loop the moment they
     * are produced, so `permission.request` is observable *before* the
     * permission handler is awaited.
     */
    const immediateQueue: AgentEvent[] = [];
    let immediateWake: (() => void) | undefined;
    const queueImmediate = (event: AgentEvent): void => {
      immediateQueue.push(event);
      const wake = immediateWake;
      immediateWake = undefined;
      wake?.();
    };

    /** Fan out one produced event to the bus and to every sink (report C3). */
    const publish = (event: AgentEvent): void => {
      bus.emit(event);
      for (const sink of sinks) {
        try {
          const r = sink.emit(event);
          if (r instanceof Promise) void r.catch(() => undefined);
        } catch {
          /* a broken sink must never fail a run */
        }
      }
    };
    const buffer = (callId: string, event: AgentEvent): void => {
      const list = pendingByCall.get(callId) ?? [];
      list.push(event);
      pendingByCall.set(callId, list);
      publish(event);
    };
    const stamp = (
      body: AgentEventBody,
      meta: { causationId?: string; turnId?: string } = {},
    ): AgentEvent => {
      seq += 1;
      const turnId = meta.turnId ?? currentTurnId;
      return {
        ...body,
        seq,
        runId,
        schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
        ts: runtime.clock.now(),
        sessionId: envelopeSessionId,
        ...(turnId !== undefined ? { turnId } : {}),
        ...(meta.causationId !== undefined ? { causationId: meta.causationId } : {}),
      } as AgentEvent;
    };
    const out = (body: AgentEventBody, meta: { causationId?: string; turnId?: string } = {}): AgentEvent => {
      const event = stamp(body, meta);
      publish(event);
      return event;
    };
    activeRun = {
      emit: (body, meta = {}, callId) => {
        const event = stamp(body, meta);
        if (callId !== undefined) buffer(callId, event);
        else publish(event);
      },
      emitImmediate: (body, meta = {}) => {
        const event = stamp(body, meta);
        // Subscribers see it now (before the handler is awaited) …
        publish(event);
        // … and the run generator yields it as soon as it regains control.
        queueImmediate(event);
      },
      notePermission: (decision) => {
        if (decision === 'deny') permissionDenied = true;
      },
    };

    /**
     * Await a batch while yielding the approval events that arrive during it.
     *
     * The tool calls run concurrently, so the permission handler is awaited
     * inside `Promise.all`. Without this drain the `permission.request` event
     * would only reach the consumer after the whole batch settled — which is
     * exactly the defect report C1 describes: a multi-client host cannot
     * answer a prompt it has not seen yet.
     */
    async function* drainBatch<R>(running: Promise<R[]>): AsyncGenerator<AgentEvent, R[]> {
      let done = false;
      let result: R[] = [];
      const settled = running.then(
        (r) => {
          result = r;
          done = true;
          immediateWake?.();
        },
        (e) => {
          done = true;
          immediateWake?.();
          throw e;
        },
      );
      void settled.catch(() => undefined);
      for (;;) {
        while (immediateQueue.length > 0) {
          const next = immediateQueue.shift();
          if (next !== undefined) yield next;
        }
        if (done) break;
        // Wait for either the next approval event or the batch completion.
        await new Promise<void>((resolve) => {
          immediateWake = () => resolve();
        });
      }
      while (immediateQueue.length > 0) {
        const next = immediateQueue.shift();
        if (next !== undefined) yield next;
      }
      return result;
    }

    // ── resume ──
    let resumedSessionId = sessionId;
    if (opts.sessionId !== undefined && session !== undefined) {
      const entries = await session.load(opts.sessionId);
      for (const e of entries) {
        if (e.type === 'message') {
          const m = e.data as Message;
          history.push(m);
        }
      }
      resumedSessionId = opts.sessionId;
      envelopeSessionId = resumedSessionId;
    }

    // ── seed input ──
    const seedMessages: Message[] =
      typeof input === 'string'
        ? [{ id: runtime.ids.next('msg'), role: 'user', content: [{ type: 'text', text: input }], meta: { createdAt: runtime.clock.now() } }]
        : input;
    history.push(...seedMessages);
    await session?.append(resumedSessionId, seedMessages.map(messageEntry(resumedSessionId, runtime)));

    const startedAt = runtime.clock.now();
    const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
    let costUsd = 0;
    const budgetWarned = new Set<'cost' | 'tokens' | 'turns'>();
    let turns = 0;
    let endReason: EndReason = 'completed';
    let finalText = '';
    const runReceipts: ToolReceipt[] = [];
    let verificationCommands: DiscoveredCommand[] | undefined;
    let verificationNote: string | undefined;
    let verificationBlocked = false;
    let baselineResults: VerificationReport['baseline'];

    yield out({ type: 'session.start', sessionId: resumedSessionId, permissionMode: engine.mode });

    if (config.verification?.enabled === true) {
      const discovered =
        config.verification.commands !== undefined
          ? config.verification.commands.map((command) => ({ command, source: 'config' as const, scope: 'full' as const }))
          : await discoverVerification(runtime, cwd);
      // Repository-controlled discovery is not executable until a human pins
      // it with `syao verify init` (source=config) or the embedder opts in.
      const eligible = discovered.filter(
        (c) => c.source === 'config' || config.verification?.allowDiscovered === true,
      );
      const dangerous = eligible.filter((c) => classifyCommand(c.command) === 'dangerous');
      verificationCommands = eligible.filter((c) => classifyCommand(c.command) !== 'dangerous');
      verificationBlocked = dangerous.length > 0;
      if (dangerous.length > 0) {
        verificationNote = `verification refused dangerous command(s): ${dangerous.map((c) => c.command).join('; ')}`;
      } else if (verificationCommands.length === 0 && discovered.length > 0) {
        verificationNote = 'verification not run: repository-discovered commands are untrusted; run `syao verify init` to confirm them once';
      }
      if (config.verification.baseline === true && verificationCommands.length > 0) {
        baselineResults = [];
        for (let i = 0; i < verificationCommands.length; i += 1) {
          const cmd = verificationCommands[i]!;
          yield out({ type: 'verification.start', command: cmd.command, index: i, total: verificationCommands.length }, { turnId: 'baseline' });
          const [result] = await runVerification(runtime, cwd, [cmd], config.receipts, {
            ...(config.verification.timeoutMs !== undefined ? { timeoutMs: config.verification.timeoutMs } : {}),
            ...(config.redactor !== undefined ? { redactor: config.redactor } : {}),
            signal,
          });
          if (result !== undefined) {
            baselineResults.push(result);
            yield out({ type: 'verification.result', result }, { turnId: 'baseline' });
          }
        }
      }
    }

    // repeated-failure tracking (BR-011)
    const failureStreaks = new Map<string, number>();
    const failKey = (c: ToolCall) => `${c.name}::${stableStringify(c.input)}`;

    try {
      loop: for (;;) {
        // ── limit checks (BR-010) ──
        if (turns >= effectiveLimits.maxTurns) {
          endReason = 'max_turns';
          yield out({ type: 'error', error: err('SY-LOOP-001', `maxTurns (${effectiveLimits.maxTurns}) reached`), fatal: false });
          break loop;
        }
        const wallClockLimit = effectiveLimits.maxWallClockMs ?? effectiveLimits.timeoutMs;
        if (wallClockLimit !== undefined && runtime.clock.now() - startedAt > wallClockLimit) {
          endReason = 'timeout';
          yield out({ type: 'error', error: err('SY-LOOP-005', 'run timeout exceeded'), fatal: false });
          break loop;
        }
        const usedTokens = totalTokensOf(totalUsage);
        if (effectiveLimits.maxBudgetUsd !== undefined && costUsd >= effectiveLimits.maxBudgetUsd) {
          endReason = 'budget_exhausted';
          yield out({ type: 'error', error: err('SY-LOOP-002', `cost budget $${effectiveLimits.maxBudgetUsd} exhausted`), fatal: false });
          break loop;
        }
        if (effectiveLimits.maxTotalTokens !== undefined && usedTokens >= effectiveLimits.maxTotalTokens) {
          endReason = 'budget_exhausted';
          yield out({
            type: 'error',
            error: err('SY-LOOP-002', `token budget ${effectiveLimits.maxTotalTokens} exhausted (${usedTokens} used)`),
            fatal: false,
          });
          break loop;
        }

        turns += 1;
        currentTurnId = `turn_${turns}`;
        yield out({ type: 'turn.start', turn: turns });

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
                yield out({ type: 'thinking.delta', text: ev.delta });
              } else {
                yield out({ type: 'text.delta', text: ev.delta });
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
                yield out({ type: 'usage', usage: ev.usage, costUsd: cost });
              } else {
                yield out({ type: 'usage', usage: ev.usage });
              }
              // ── budget 80% warnings (BR-010) ──
              if (
                effectiveLimits.maxBudgetUsd !== undefined &&
                !budgetWarned.has('cost') &&
                costUsd / effectiveLimits.maxBudgetUsd >= 0.8
              ) {
                budgetWarned.add('cost');
                yield out({ type: 'budget.warning', kind: 'cost', ratio: costUsd / effectiveLimits.maxBudgetUsd });
              }
              if (
                effectiveLimits.maxTotalTokens !== undefined &&
                !budgetWarned.has('tokens') &&
                totalTokensOf(totalUsage) / effectiveLimits.maxTotalTokens >= 0.8
              ) {
                budgetWarned.add('tokens');
                yield out({
                  type: 'budget.warning',
                  kind: 'tokens',
                  ratio: totalTokensOf(totalUsage) / effectiveLimits.maxTotalTokens,
                });
              }
            }
          }
        } catch (e) {
          const le = SyaoError.is(e) ? e : SyaoError.wrap(e);
          if (signal.aborted) {
            endReason = 'aborted';
            yield out({ type: 'error', error: err('SY-LOOP-003', 'run aborted by user'), fatal: false });
            break loop;
          }
          endReason = le.fatal ? 'fatal_error' : 'aborted';
          yield out({ type: 'error', error: le.toJSON(), fatal: true });
          break loop;
        }

        if (assistant === undefined) {
          endReason = 'fatal_error';
          yield out({ type: 'error', error: err('SY-PRV-008', 'provider stream ended without a message'), fatal: true });
          break loop;
        }

        history.push(assistant);
        await session?.append(resumedSessionId, [messageEntry(resumedSessionId, runtime)(assistant)]);
        yield out(
          { type: 'message.complete', message: assistant, stopReason: assistantStopReason },
          { causationId: assistant.id },
        );

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
          yield out({ type: 'tool.proposed', call }, { causationId: call.id });
        }

        // ── execute calls in batches (BR-008 / BR-009) ──
        // Tool events fire from inside executeToolCall, so they are buffered
        // per call and yielded in call order after each batch. Approval events
        // are NOT buffered (report C1): they are yielded the moment they are
        // produced, i.e. before the permission handler is awaited.
        const results: ToolResultBlock[] = [];
        const batches = planBatches(calls, registry);
        for (const batch of batches) {
          if (signal.aborted) break;
          let executed: ToolResultBlock[] = [];
          const drained = drainBatch(
            Promise.all(
              batch.map((call) =>
                executeToolCall(call, registry, engine, runtime, {
                  cwd,
                  signal,
                  ...(config.redactor !== undefined ? { redactor: config.redactor } : {}),
                  ...(config.receipts !== undefined ? { receipts: config.receipts } : {}),
                  ...(config.governor !== undefined ? { governor: config.governor } : {}),
                  events: {
                    onToolStart: (callId, name, input) => {
                      config.onToolStart?.({ callId, name, input });
                      buffer(callId, stamp({ type: 'tool.start', callId, name, input }, { causationId: callId }));
                    },
                    onToolProgress: (callId, note) =>
                      buffer(callId, stamp({ type: 'tool.progress', callId, note }, { causationId: callId })),
                    onToolResult: (callId, name, content, isError, durationMs) =>
                      buffer(
                        callId,
                        stamp(
                          { type: 'tool.result', callId, name, content, isError, durationMs },
                          { causationId: callId },
                        ),
                      ),
                    onToolReceipt: (receipt) => {
                      runReceipts.push(receipt);
                      buffer(
                        receipt.callId,
                        stamp({ type: 'tool.receipt', receipt }, { causationId: receipt.callId }),
                      );
                    },
                  },
                }),
              ),
            ),
          );
          let step = await drained.next();
          while (!step.done) {
            yield step.value;
            step = await drained.next();
          }
          executed = step.value ?? [];
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
              yield out({ type: 'error', error: err('SY-LOOP-004', `tool '${call.name}' failed 5 consecutive times`), fatal: false });
              const resultMessage = resultMessageOf(results, runtime, resumedSessionId);
              history.push(resultMessage);
              await session?.append(resumedSessionId, [messageEntry(resumedSessionId, runtime)(resultMessage)]);
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
        await session?.append(resumedSessionId, [messageEntry(resumedSessionId, runtime)(resultMessage)]);

        yield out({ type: 'turn.end', turn: turns });
        currentTurnId = undefined;
      }
    } finally {
      activeRun = undefined;
    }

    let claims: ClaimCheck[] = lintClaims(finalText, runReceipts, undefined);
    let verdict: Verdict = 'not_run';
    let verificationReport: VerificationReport | undefined;
    if (config.verification?.enabled === true && verificationCommands !== undefined) {
      if (verificationCommands.length === 0) {
        // Discovery found nothing to run: report "not run" rather than a
        // misleading pass or a hard failure.
        claims = lintClaims(finalText, runReceipts, undefined);
      } else {
        const results = [];
        for (let i = 0; i < verificationCommands.length; i += 1) {
          const cmd = verificationCommands[i]!;
          yield out({ type: 'verification.start', command: cmd.command, index: i, total: verificationCommands.length });
          const [result] = await runVerification(runtime, cwd, [cmd], config.receipts, {
            ...(config.verification.timeoutMs !== undefined ? { timeoutMs: config.verification.timeoutMs } : {}),
            ...(config.redactor !== undefined ? { redactor: config.redactor } : {}),
            signal,
          });
          if (result !== undefined) {
            results.push(result);
            yield out({ type: 'verification.result', result });
          }
        }
        verificationReport = {
          commands: verificationCommands.length,
          results,
          ...(baselineResults !== undefined ? { baseline: baselineResults } : {}),
        };
        claims = lintClaims(finalText, runReceipts, verificationReport);
        verdict = verdictOf(verificationReport, claims);
        if (verificationBlocked && verdict === 'verified') {
          verdict = 'unverified';
          verificationNote ??= 'verification incomplete: a dangerous command was refused';
        }
        if (endReason === 'completed') {
          if (verdict === 'failed') endReason = 'verification_failed';
          else if (verdict === 'unverified') endReason = 'unverified';
        }
      }
    }

    const endEvent = out({ type: 'session.end', reason: endReason });
    bus.end();
    yield endEvent;

    return {
      sessionId: resumedSessionId,
      endReason,
      turns,
      totalUsage,
      ...(costUsd > 0 || pricing !== undefined ? { costUsd } : {}),
      permissionDenied,
      finalText,
      verdict,
      claims,
      toolReceipts: runReceipts,
      ...(verificationReport !== undefined ? { verification: verificationReport } : {}),
      ...(verificationNote !== undefined ? { verificationNote } : {}),
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

function costOf(usage: Usage, pricing: { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number } | undefined): number | undefined {  // 网关直接上报的费用最准确（含路由/折扣），优先于本地价目表
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

export function totalTokensOf(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
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
