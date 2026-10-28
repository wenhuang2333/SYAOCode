/**
 * A2A 1.0.0 server — expose SYAOCode as an A2A agent.
 *
 * Enforced here:
 *   - PascalCase JSON-RPC method names, exactly as pinned (01 §2.2);
 *   - `A2A-Version` gate → `VersionNotSupportedError` (-32022);
 *   - **tenant filtering on every read**: `GetTask` / `ListTasks` /
 *     `CancelTask` / `SubscribeToTask` can only see the caller's tenant, and a
 *     cross-tenant probe answers `TaskNotFoundError` (-32001) so task existence
 *     never leaks;
 *   - cursor pagination, newest-updated first;
 *   - `SendMessage` is idempotent on `messageId` (server-side dedupe);
 *   - push notification configs answer `PushNotificationNotSupportedError`.
 */

import type { Logger, Runtime } from '@syaocode/core';
import { type CanonicalErrorShape, type DiscoveredCapability, type InvokeResultPayload } from '@syaocode/rpc';
import { AdapterBase, type DuplexChannel } from '../shared/index.js';
import { NO_RESPONSE, JsonRpcConnection, type JsonRpcHandlerResult, type JsonRpcId } from '../shared/jsonrpc.js';
import { a2aPushUnsupported, a2aTaskNotFound, a2aUnsupportedOperation, a2aVersionNotSupported } from './errors.js';
import { isA2aTerminal, type A2aMessage, type A2aTask, type A2aTaskStatusUpdateEvent } from './artifacts.js';
import { agentCardCapabilities, type A2aAgentCard } from './card.js';

export const A2A_SERVER_METHODS: readonly string[] = [
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
];

export interface A2aCallerContext {
  tenantId: string;
  principalId?: string;
  /** `Major.Minor` from `A2A-Version` (empty ⇒ treated as 0.3 per spec). */
  version: string;
}

export interface A2aSendInput {
  message: A2aMessage;
  configuration?: Record<string, unknown>;
  caller: A2aCallerContext;
}

export interface A2aTaskStore {
  put(tenantId: string, task: A2aTask): Promise<void> | void;
  get(tenantId: string, id: string): Promise<A2aTask | undefined> | A2aTask | undefined;
  list(tenantId: string, filter: { contextId?: string; limit: number; cursor?: string }): Promise<{ tasks: A2aTask[]; nextPageToken?: string }> | { tasks: A2aTask[]; nextPageToken?: string };
  /** `messageId` → task id, for idempotent `SendMessage`. */
  findByMessageId(tenantId: string, messageId: string): Promise<string | undefined> | string | undefined;
  remember(tenantId: string, messageId: string, taskId: string): Promise<void> | void;
}

interface StoredTask {
  task: A2aTask;
  updatedAt: string;
}

/** In-memory, tenant-scoped task store (the host may swap in a durable one). */
export class MemoryA2aTaskStore implements A2aTaskStore {
  private readonly tasks = new Map<string, Map<string, StoredTask>>();
  private readonly messageIndex = new Map<string, Map<string, string>>();

  put(tenantId: string, task: A2aTask): void {
    const bucket = this.bucket(this.tasks, tenantId);
    bucket.set(task.id, { task, updatedAt: task.status.timestamp ?? new Date(0).toISOString() });
  }

  get(tenantId: string, id: string): A2aTask | undefined {
    return this.tasks.get(tenantId)?.get(id)?.task;
  }

  list(tenantId: string, filter: { contextId?: string; limit: number; cursor?: string }): { tasks: A2aTask[]; nextPageToken?: string } {
    const bucket = this.tasks.get(tenantId);
    if (bucket === undefined) return { tasks: [] };
    const all = [...bucket.values()]
      .filter((entry) => filter.contextId === undefined || entry.task.contextId === filter.contextId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.task.id < b.task.id ? -1 : 1));
    const start = filter.cursor === undefined ? 0 : Math.max(0, all.findIndex((entry) => entry.task.id === filter.cursor) + 1);
    const page = all.slice(start, start + filter.limit);
    const last = page[page.length - 1];
    const hasMore = start + filter.limit < all.length;
    return {
      tasks: page.map((entry) => entry.task),
      ...(hasMore && last !== undefined ? { nextPageToken: last.task.id } : {}),
    };
  }

  findByMessageId(tenantId: string, messageId: string): string | undefined {
    return this.messageIndex.get(tenantId)?.get(messageId);
  }

  remember(tenantId: string, messageId: string, taskId: string): void {
    this.bucket(this.messageIndex, tenantId).set(messageId, taskId);
  }

  private bucket<T>(map: Map<string, Map<string, T>>, tenantId: string): Map<string, T> {
    const existing = map.get(tenantId);
    if (existing !== undefined) return existing;
    const created = new Map<string, T>();
    map.set(tenantId, created);
    return created;
  }
}

export interface A2aServerOptions {
  runtime: Runtime;
  channel: DuplexChannel;
  agentId: string;
  card: A2aAgentCard;
  /** Create or continue an ARF task; the host wires this to the dispatcher. */
  onMessage?: (input: A2aSendInput) => Promise<A2aTask | A2aMessage>;
  store?: A2aTaskStore;
  /** Host-owned authentication; the default reads `metadata.tenantId`. */
  resolveCaller?: (params: unknown) => A2aCallerContext | undefined;
  supportedVersions?: string[];
  /** Poll interval used to project task updates onto subscribers. */
  pollIntervalMs?: number;
  maxPolls?: number;
  logger?: Logger;
}

export class A2aServer extends AdapterBase {
  static readonly methods: readonly string[] = A2A_SERVER_METHODS;

  private readonly connection: JsonRpcConnection;
  private readonly options: A2aServerOptions;
  private readonly store: A2aTaskStore;
  private readonly subscribers = new Map<string, Set<(task: A2aTask) => void>>();

  constructor(options: A2aServerOptions) {
    super('a2a', options.card.supportedInterfaces[0]?.protocolVersion ?? '1.0', options.runtime, options.logger);
    this.options = options;
    this.store = options.store ?? new MemoryA2aTaskStore();
    this.connection = new JsonRpcConnection({
      channel: options.channel,
      framing: 'auto',
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      handlers: {
        request: (method, params, ctx) => this.handleRequest(method, params, ctx.id),
      },
    });
    this.connection.start();
  }

  get agentId(): string {
    return this.options.agentId;
  }

  /** Publish a task update to local subscribers (used by hosts/tests). */
  async publish(task: A2aTask, tenantId: string): Promise<void> {
    await this.store.put(tenantId, task);
    for (const sink of this.subscribers.get(task.id) ?? []) sink(task);
  }

  override async close(): Promise<void> {
    await this.connection.close('server-close');
    await super.close();
  }

  // ── routing ─────────────────────────────────────────────────────────────

  private async handleRequest(method: string, params: unknown, id: JsonRpcId): Promise<JsonRpcHandlerResult> {
    const record = (params ?? {}) as Record<string, unknown>;
    if (method === 'GetExtendedAgentCard') return this.options.card as unknown as Record<string, unknown>;

    const caller = this.caller(params);
    if (caller === undefined) {
      throw { code: -32602, message: 'a2a: missing caller context (metadata.tenantId)' };
    }
    this.assertVersion(caller.version);

    switch (method) {
      case 'SendMessage':
        return (await this.sendMessage(record, caller)) as unknown as Record<string, unknown>;
      case 'SendStreamingMessage':
        return this.handleStream(id, record, caller, true);
      case 'GetTask':
        return (await this.getTask(record, caller)) as unknown as Record<string, unknown>;
      case 'ListTasks':
        return (await this.listTasks(record, caller)) as unknown as Record<string, unknown>;
      case 'CancelTask':
        return (await this.cancelTask(record, caller)) as unknown as Record<string, unknown>;
      case 'SubscribeToTask':
        return this.handleStream(id, record, caller, false);
      case 'CreateTaskPushNotificationConfig':
      case 'GetTaskPushNotificationConfig':
      case 'ListTaskPushNotificationConfigs':
      case 'DeleteTaskPushNotificationConfig':
        throw a2aPushUnsupported().toShape();
      default:
        throw { code: -32601, message: `method not found: ${method}` };
    }
  }

  private caller(params: unknown): A2aCallerContext | undefined {
    if (this.options.resolveCaller !== undefined) return this.options.resolveCaller(params);
    const metadata = (params as { metadata?: unknown } | null)?.metadata;
    if (metadata === null || typeof metadata !== 'object') return undefined;
    const tenantId = (metadata as { tenantId?: unknown }).tenantId;
    if (typeof tenantId !== 'string' || tenantId.length === 0) return undefined;
    const version = (metadata as { 'A2A-Version'?: unknown })['A2A-Version'];
    return { tenantId, version: typeof version === 'string' ? version : '0.3' };
  }

  private assertVersion(version: string): void {
    const supported = this.options.supportedVersions ?? ['1.0'];
    const major = version.split('.')[0] ?? '';
    if (major.length === 0) return; // spec: empty ⇒ 0.3 compatibility mode
    if (!supported.some((entry) => entry.split('.')[0] === major)) {
      throw a2aVersionNotSupported(version, supported.join(', ')).toShape();
    }
  }

  // ── methods ─────────────────────────────────────────────────────────────

  private async sendMessage(record: Record<string, unknown>, caller: A2aCallerContext): Promise<A2aTask | A2aMessage> {
    const message = record['message'] as A2aMessage | undefined;
    if (message === undefined || typeof message.messageId !== 'string') {
      throw { code: -32602, message: 'SendMessage requires message.messageId' };
    }
    // Idempotency: the same messageId never creates a second task.
    const existing = await this.store.findByMessageId(caller.tenantId, message.messageId);
    if (existing !== undefined) {
      const task = await this.store.get(caller.tenantId, existing);
      if (task !== undefined) return task;
    }
    if (this.options.onMessage === undefined) throw a2aUnsupportedOperation('this agent has no message handler').toShape();
    const result = await this.options.onMessage({
      message,
      ...(record['configuration'] !== undefined ? { configuration: record['configuration'] as Record<string, unknown> } : {}),
      caller,
    });
    if (isTask(result)) {
      await this.store.put(caller.tenantId, result);
      await this.store.remember(caller.tenantId, message.messageId, result.id);
      return result;
    }
    return result;
  }

  private async getTask(record: Record<string, unknown>, caller: A2aCallerContext): Promise<A2aTask> {
    const id = record['id'];
    if (typeof id !== 'string') throw { code: -32602, message: 'GetTask requires id' };
    const task = await this.store.get(caller.tenantId, id);
    if (task === undefined) throw a2aTaskNotFound(id, caller.tenantId).toShape();
    return task;
  }

  private async listTasks(record: Record<string, unknown>, caller: A2aCallerContext): Promise<{ tasks: A2aTask[]; nextPageToken?: string }> {
    const pageSize = typeof record['pageSize'] === 'number' && record['pageSize'] > 0 ? Math.min(record['pageSize'], 200) : 50;
    const filter: { contextId?: string; limit: number; cursor?: string } = { limit: pageSize };
    if (typeof record['contextId'] === 'string') filter.contextId = record['contextId'];
    if (typeof record['pageToken'] === 'string') filter.cursor = record['pageToken'];
    return this.store.list(caller.tenantId, filter);
  }

  private async cancelTask(record: Record<string, unknown>, caller: A2aCallerContext): Promise<A2aTask> {
    const id = record['id'];
    if (typeof id !== 'string') throw { code: -32602, message: 'CancelTask requires id' };
    const task = await this.store.get(caller.tenantId, id);
    if (task === undefined) throw a2aTaskNotFound(id, caller.tenantId).toShape();
    if (isA2aTerminal(task.status.state)) return task; // idempotent
    const reason = typeof record['reason'] === 'string' ? record['reason'] : 'cancelled by caller';
    const cancelled: A2aTask = {
      ...task,
      status: {
        state: 'TASK_STATE_CANCELED',
        timestamp: new Date(this.runtime.clock.now()).toISOString(),
        message: { messageId: `${task.id}:cancel`, role: 'agent', parts: [{ text: reason }] },
      },
    };
    await this.publish(cancelled, caller.tenantId);
    return cancelled;
  }

  /** Streaming methods: snapshot first, then updates, then the final response. */
  private async handleStream(id: JsonRpcId, record: Record<string, unknown>, caller: A2aCallerContext, isSend: boolean): Promise<JsonRpcHandlerResult> {
    let task: A2aTask | undefined;
    if (isSend) {
      const result = await this.sendMessage(record, caller);
      if (!isTask(result)) {
        await this.connection.respond(id, result);
        return NO_RESPONSE;
      }
      task = result;
    } else {
      task = await this.getTask(record, caller);
    }
    // The first event MUST be the current task snapshot (01 §5.3).
    await this.connection.notifyStream(id, task);
    const interval = this.options.pollIntervalMs ?? 50;
    const maxPolls = this.options.maxPolls ?? 200;
    for (let poll = 0; poll < maxPolls && !isA2aTerminal(task.status.state); poll += 1) {
      await this.runtime.clock.sleep(interval);
      const refreshed = await this.store.get(caller.tenantId, task.id);
      if (refreshed === undefined) break;
      task = refreshed;
      const event: A2aTaskStatusUpdateEvent = {
        taskId: task.id,
        contextId: task.contextId,
        status: task.status,
        final: isA2aTerminal(task.status.state),
        kind: 'status-update',
      };
      await this.connection.notifyStream(id, event);
    }
    await this.connection.respond(id, task);
    return NO_RESPONSE;
  }

  // ── adapter-ish surface (the server is not a client adapter) ────────────

  capabilities(): import('@syaocode/rpc').AdapterCapabilities {
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
      lossy: ['a2a-no-approval-options', 'a2a-push-notifications-unsupported'],
    };
  }

  /** The card's skills, as this agent would be discovered by a caller. */
  discover(): DiscoveredCapability[] {
    return agentCardCapabilities(this.options.card, this.options.agentId);
  }

  async invoke(): Promise<InvokeResultPayload> {
    const error: CanonicalErrorShape = { kind: 'unsupported_capability', message: 'A2aServer does not invoke peers; use A2aClient', retryable: false };
    return { outcome: 'failed', error };
  }
}

function isTask(value: A2aTask | A2aMessage): value is A2aTask {
  return typeof (value as A2aTask).status === 'object' && (value as A2aTask).status !== null;
}
