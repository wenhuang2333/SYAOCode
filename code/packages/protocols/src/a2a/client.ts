/**
 * A2A 1.0.0 client — PascalCase JSON-RPC methods over the injected channel.
 *
 * Every read is tenant-scoped: the caller's tenant travels in `metadata` and
 * the server MUST filter by it (01 §2.2 "List/Get/Cancel/Subscribe 都必须按
 * 调用者可见范围过滤"). The client also pins `A2A-Version` on every request so
 * an unsupported peer answers `VersionNotSupportedError` (-32022).
 */

import type { Logger, Runtime } from '@syaocode/core';
import { CanonicalError, type AdapterCapabilities, type DiscoveredCapability, type InvokeResultPayload } from '@syaocode/rpc';
import {
  AdapterBase,
  mergeLossy,
  remainingMs,
  timeoutOutcome,
  wireError,
  type DuplexChannel,
} from '../shared/index.js';
import { JsonRpcConnection, JsonRpcRemoteError, JsonRpcTimeoutError, isFinalStreamResult, isJsonRpcResponse, type JsonRpcId } from '../shared/jsonrpc.js';
import { A2A_LOSSY, A2A_VISIBILITY, inputToMessage, isA2aTerminal, a2aStateToTaskState, type A2aArtifact, type A2aMessage, type A2aStreamEvent, type A2aTask, type A2aTaskStatusUpdateEvent } from './artifacts.js';
import { a2aUnsupportedOperation, a2aVersionNotSupported } from './errors.js';
import { agentCardCapabilities, parseAgentCard, type A2aAgentCard } from './card.js';

export const A2A_METHODS = [
  'SendMessage',
  'SendStreamingMessage',
  'GetTask',
  'ListTasks',
  'CancelTask',
  'SubscribeToTask',
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
  'GetExtendedAgentCard',
] as const;

export const A2A_VERSION = '1.0';

export interface A2aClientOptions {
  runtime: Runtime;
  channel: DuplexChannel;
  /** Registry-assigned agent id (never the card's self-description). */
  agentId: string;
  /** Tenant the caller acts in; attached to every request. */
  tenantId: string;
  /** Pinned `A2A-Version` (Major.Minor). */
  version?: string;
  requestTimeoutMs?: number;
  logger?: Logger;
}

export interface A2aCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface A2aSendResult {
  task?: A2aTask;
  message?: A2aMessage;
}

export interface A2aListResult {
  tasks: A2aTask[];
  nextPageToken?: string;
}

export class A2aClient {
  readonly connection: JsonRpcConnection;
  private readonly options: A2aClientOptions;
  private card: A2aAgentCard | undefined;

  constructor(options: A2aClientOptions) {
    this.options = options;
    this.connection = new JsonRpcConnection({
      channel: options.channel,
      framing: 'auto',
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    });
    this.connection.start();
  }

  get agentId(): string {
    return this.options.agentId;
  }

  get version(): string {
    return this.options.version ?? A2A_VERSION;
  }

  /** Metadata attached to every request (tenant + protocol version pin). */
  private metadata(extra?: Record<string, unknown>): Record<string, unknown> {
    return { tenantId: this.options.tenantId, 'A2A-Version': this.version, ...(extra ?? {}) };
  }

  async getExtendedAgentCard(opts?: A2aCallOptions): Promise<A2aAgentCard> {
    const raw = await this.connection.request('GetExtendedAgentCard', { metadata: this.metadata() }, this.requestOptions(opts));
    this.card = parseAgentCard(raw);
    return this.card;
  }

  async sendMessage(input: { message: A2aMessage; configuration?: Record<string, unknown>; metadata?: Record<string, unknown> }, opts?: A2aCallOptions): Promise<A2aSendResult> {
    const raw = (await this.connection.request(
      'SendMessage',
      {
        message: input.message,
        ...(input.configuration !== undefined ? { configuration: input.configuration } : {}),
        metadata: this.metadata(input.metadata),
      },
      this.requestOptions(opts),
    )) as A2aTask | A2aMessage;
    return normalizeSendResult(raw);
  }

  /** Streaming variant; yields status/artifact update events. */
  async *sendStreamingMessage(input: { message: A2aMessage; metadata?: Record<string, unknown> }, opts?: A2aCallOptions): AsyncIterable<A2aStreamEvent> {
    yield* this.stream('SendStreamingMessage', { message: input.message, metadata: this.metadata(input.metadata) }, opts);
  }

  async getTask(id: string, historyLength?: number, opts?: A2aCallOptions): Promise<A2aTask> {
    return (await this.connection.request(
      'GetTask',
      { id, ...(historyLength !== undefined ? { historyLength } : {}), metadata: this.metadata() },
      this.requestOptions(opts),
    )) as A2aTask;
  }

  async listTasks(query?: { contextId?: string; pageSize?: number; pageToken?: string }, opts?: A2aCallOptions): Promise<A2aListResult> {
    const raw = (await this.connection.request(
      'ListTasks',
      {
        ...(query?.contextId !== undefined ? { contextId: query.contextId } : {}),
        ...(query?.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
        ...(query?.pageToken !== undefined ? { pageToken: query.pageToken } : {}),
        metadata: this.metadata(),
      },
      this.requestOptions(opts),
    )) as { tasks?: A2aTask[]; nextPageToken?: string };
    return {
      tasks: raw.tasks ?? [],
      ...(raw.nextPageToken !== undefined ? { nextPageToken: raw.nextPageToken } : {}),
    };
  }

  async cancelTask(id: string, reason?: string, opts?: A2aCallOptions): Promise<A2aTask> {
    return (await this.connection.request(
      'CancelTask',
      { id, ...(reason !== undefined ? { reason } : {}), metadata: this.metadata() },
      this.requestOptions(opts),
    )) as A2aTask;
  }

  /** Subscribe to a task's updates; the first event is the current snapshot. */
  async *subscribeToTask(id: string, opts?: A2aCallOptions): AsyncIterable<A2aStreamEvent> {
    yield* this.stream('SubscribeToTask', { id, metadata: this.metadata() }, opts);
  }

  async createTaskPushNotificationConfig(): Promise<never> {
    throw a2aUnsupportedOperation('push notification configs are not implemented');
  }

  /** `A2A-Version` gate used by the server side of the edge. */
  assertSupportedVersion(supported: string): void {
    if (this.version.split('.')[0] !== supported.split('.')[0]) throw a2aVersionNotSupported(this.version, supported);
  }

  async close(): Promise<void> {
    await this.connection.close('client-close');
  }

  private requestOptions(opts?: A2aCallOptions): { timeoutMs?: number; signal?: AbortSignal; onId?: (id: JsonRpcId) => void } {
    const out: { timeoutMs?: number; signal?: AbortSignal; onId?: (id: JsonRpcId) => void } = {};
    if (opts?.timeoutMs !== undefined) out.timeoutMs = opts.timeoutMs;
    else if (this.options.requestTimeoutMs !== undefined) out.timeoutMs = this.options.requestTimeoutMs;
    if (opts?.signal !== undefined) out.signal = opts.signal;
    return out;
  }

  /**
   * One streaming request over the spec's `text/event-stream` binding.
   *
   * `SendStreamingMessage` / `SubscribeToTask` answer with a stream of events;
   * each SSE frame carries a complete JSON-RPC response with the request id and
   * a `Task` / `Message` / `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent`
   * as its `result`. The stream ends at a `final` status event or when the peer
   * closes the connection.
   */
  private async *stream(method: string, params: Record<string, unknown>, opts?: A2aCallOptions): AsyncIterable<A2aStreamEvent> {
    for await (const frame of this.connection.requestStream(method, params, this.requestOptions(opts))) {
      if (!isJsonRpcResponse(frame)) continue;
      if ('error' in frame) throw new JsonRpcRemoteError(frame.error);
      const event = frame.result as A2aStreamEvent | undefined;
      if (event === undefined) continue;
      yield event;
      if (isFinalStreamResult(event)) return;
      const state = (event as A2aTaskStatusUpdateEvent).status?.state;
      if (state !== undefined && isA2aTerminal(state)) return;
      const task = event as A2aTask;
      if (typeof task.id === 'string' && task.status !== undefined && isA2aTerminal(task.status.state)) return;
    }
  }
}

function normalizeSendResult(raw: A2aTask | A2aMessage): A2aSendResult {
  if (raw !== null && typeof raw === 'object' && typeof (raw as A2aTask).status === 'object') return { task: raw as A2aTask };
  return { message: raw as A2aMessage };
}

// ── ProtocolAdapter ───────────────────────────────────────────────────────

export interface A2aAdapterOptions extends A2aClientOptions {
  /** Extra lossy markers the host wants surfaced. */
  lossy?: string[];
  /** Max poll attempts while waiting for a remote task to reach a terminal state. */
  maxPolls?: number;
  pollIntervalMs?: number;
}

/**
 * The A2A edge as a `ProtocolAdapter`.
 *
 * One remote A2A task maps onto one *opaque* ARF invocation (G3): the adapter
 * sends a message, waits for a terminal `TASK_STATE_*`, and returns the task's
 * artifacts. `input_required` / `auth_required` are surfaced through the
 * kernel's approval broker before a continuation message is sent.
 */
export class A2aAdapter extends AdapterBase {
  readonly client: A2aClient;
  private readonly extraLossy: string[];
  private readonly maxPolls: number;
  private readonly pollIntervalMs: number;

  constructor(options: A2aAdapterOptions) {
    super('a2a', options.version ?? A2A_VERSION, options.runtime, options.logger);
    this.client = new A2aClient(options);
    this.extraLossy = options.lossy ?? [];
    this.maxPolls = options.maxPolls ?? 50;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
  }

  capabilities(): AdapterCapabilities {
    return {
      protocol: 'a2a',
      version: this.version,
      supports: {
        session: true,
        task: true,
        streaming: true,
        push: false,
        approvalOptions: false,
        artifacts: true,
        reverseCalls: false,
        cancellation: true,
      },
      lossy: mergeLossy(
        [A2A_LOSSY.opaqueRemoteTask, A2A_LOSSY.noApprovalOptions, A2A_LOSSY.weakSession, A2A_LOSSY.untrustedCard, A2A_LOSSY.expiredAsFailed],
        this.extraLossy,
      ),
    };
  }

  async discover(ctx: import('@syaocode/rpc').AdapterContext): Promise<DiscoveredCapability[]> {
    void ctx;
    const card = await this.client.getExtendedAgentCard();
    return agentCardCapabilities(card, this.client.agentId);
  }

  async invoke(req: import('@syaocode/rpc').AuthorizedInvocation, ctx: import('@syaocode/rpc').AdapterContext): Promise<InvokeResultPayload> {
    const messageId = req.idempotencyKey ?? ctx.runtime.ids.next('msg');
    const message = inputToMessage(req.input, messageId);
    const timeoutMs = remainingMs(ctx.runtime, ctx);
    const callOptions: A2aCallOptions = {};
    if (timeoutMs !== undefined) callOptions.timeoutMs = timeoutMs;
    if (ctx.signal !== undefined) callOptions.signal = ctx.signal;

    try {
      const sent = await this.client.sendMessage({ message }, callOptions);
      if (sent.message !== undefined) {
        return { outcome: 'succeeded', output: { message: sent.message }, lossy: this.adapterLossy() };
      }
      let task = sent.task;
      if (task === undefined) return { outcome: 'failed', error: a2aUnsupportedOperation('SendMessage returned neither Task nor Message').toShape() };
      task = await this.awaitTerminal(task, req, ctx, callOptions);
      return this.payloadFromTask(task);
    } catch (error) {
      return this.failurePayload(error);
    }
  }

  /** Poll `GetTask` until terminal / approval-resolved / deadline. */
  private async awaitTerminal(
    initial: A2aTask,
    req: import('@syaocode/rpc').AuthorizedInvocation,
    ctx: import('@syaocode/rpc').AdapterContext,
    callOptions: A2aCallOptions,
  ): Promise<A2aTask> {
    let task = initial;
    for (let poll = 0; poll < this.maxPolls; poll += 1) {
      if (isA2aTerminal(task.status.state)) return task;
      if (task.status.state === 'TASK_STATE_INPUT_REQUIRED' || task.status.state === 'TASK_STATE_AUTH_REQUIRED') {
        const decision = await ctx.approval.request({
          tenantId: req.tenantId,
          taskId: req.taskId,
          invocationId: req.invocationId,
          subject: {
            kind: 'tool',
            summary: `Remote A2A agent ${this.client.agentId} requires ${task.status.state === 'TASK_STATE_AUTH_REQUIRED' ? 'authorization' : 'input'}`,
            ...(task.status.message !== undefined
              ? { detail: task.status.message.parts.map((part) => part.text ?? '').join(' '), detailTrust: 'untrusted' as const }
              : {}),
          },
          authority: 'delegated',
          policyRevision: 'a2a-remote',
        });
        if (decision.state !== 'allowed') {
          return { ...task, status: { ...task.status, state: 'TASK_STATE_REJECTED' } };
        }
        const continuation = await this.client.sendMessage(
          {
            message: {
              messageId: ctx.runtime.ids.next('msg'),
              role: 'user',
              parts: [{ text: 'approved' }],
              taskId: task.id,
              ...(task.contextId !== undefined ? { contextId: task.contextId } : {}),
            },
          },
          callOptions,
        );
        if (continuation.task !== undefined) task = continuation.task;
      }
      const left = remainingMs(ctx.runtime, ctx);
      if (left !== undefined && left <= 0) return task;
      await ctx.runtime.clock.sleep(Math.min(this.pollIntervalMs, left ?? this.pollIntervalMs), ctx.signal);
      task = await this.client.getTask(task.id, undefined, callOptions);
    }
    return task;
  }

  private payloadFromTask(task: A2aTask): InvokeResultPayload {
    const state = a2aStateToTaskState(task.status.state, task.status.message?.parts.map((part) => part.text ?? '').join(' '));
    const artifacts = (task.artifacts ?? []).map((artifact: A2aArtifact) => ({
      id: artifact.artifactId,
      hash: artifact.artifactId,
      ...(artifact.parts[0]?.file?.mimeType !== undefined ? { mediaType: artifact.parts[0].file.mimeType } : {}),
      ...(artifact.parts[0]?.file?.uri !== undefined ? { ref: artifact.parts[0].file.uri } : {}),
    }));
    const output = {
      taskId: task.id,
      contextId: task.contextId,
      state: task.status.state,
      artifacts: task.artifacts ?? [],
      ...(task.status.message !== undefined ? { message: task.status.message } : {}),
    };
    const lossy = mergeLossy(this.adapterLossy(), A2A_VISIBILITY === 'opaque' ? ['a2a-evidence-opaque'] : []);
    switch (state) {
      case 'completed':
        return { outcome: 'succeeded', output, lossy, ...(artifacts.length > 0 ? { artifacts } : {}) };
      case 'cancelled':
        return { outcome: 'cancelled', output, lossy, error: { kind: 'cancelled', message: 'remote A2A task was cancelled', retryable: false } };
      case 'expired':
        return {
          outcome: 'timed_out',
          output,
          lossy: mergeLossy(lossy, [A2A_LOSSY.expiredAsFailed]),
          error: { kind: 'timed_out', message: 'remote A2A task expired', retryable: false },
        };
      case 'rejected':
        return { outcome: 'failed', output, lossy, error: { kind: 'denied', message: 'remote A2A task was rejected', retryable: false } };
      case 'failed':
        return { outcome: 'failed', output, lossy, error: { kind: 'remote_error', message: 'remote A2A task failed', retryable: false } };
      default:
        // Still non-terminal when the deadline ran out: the remote task exists,
        // so the outcome is genuinely unknown rather than a clean timeout.
        return {
          outcome: 'indeterminate',
          output,
          lossy,
          error: { kind: 'indeterminate', message: `remote A2A task is still ${task.status.state}`, retryable: false },
        };
    }
  }

  async cancel(taskId: string, reason: string, ctx: import('@syaocode/rpc').AdapterContext): Promise<void> {
    void ctx;
    await this.client.cancelTask(taskId, reason);
  }

  override async close(): Promise<void> {
    await this.client.close();
    await super.close();
  }

  private failurePayload(error: unknown): InvokeResultPayload {
    if (error instanceof JsonRpcTimeoutError) {
      const canonical = wireError('a2a', error);
      return {
        outcome: timeoutOutcome(error.sent),
        error: canonical.toShape(),
        lossy: mergeLossy(this.adapterLossy(), ['a2a-no-auto-retry']),
      };
    }
    const canonical = wireError('a2a', error);
    const outcome: InvokeResultPayload['outcome'] = canonical.kind === 'cancelled' ? 'cancelled' : 'failed';
    return { outcome, error: canonical.toShape(), lossy: this.adapterLossy() };
  }

  private adapterLossy(): string[] {
    // Every A2A invocation is opaque: the remote agent's internal steps are
    // invisible to us (G3), so the marker travels with every result.
    return mergeLossy([A2A_LOSSY.opaqueRemoteTask], this.extraLossy);
  }
}

/** Guard used by hosts that keep a card locally instead of fetching it. */
export function discoverFromCard(card: A2aAgentCard, agentId: string): DiscoveredCapability[] {
  return agentCardCapabilities(card, agentId);
}

export { CanonicalError };
