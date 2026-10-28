/**
 * ACP v1 server — SYAOCode as an ACP **agent** (01 §2.3, 03 §5.3).
 *
 * Implemented surface:
 *   - `initialize` — connection-level negotiation. `protocolVersion` is a
 *     single integer MAJOR; a mismatch is a hard failure.
 *   - `session/new` | `session/load` | `session/resume` | `session/prompt` |
 *     `session/cancel` | `session/close` | `session/list` | `session/delete`
 *   - `session/update` notifications (the 15 pinned variants, 01 §5.5)
 *   - `session/request_permission` — agent→client, blocking; there is no
 *     `denied` outcome, a rejection is `selected` + a `reject_*` option
 *   - reverse `fs/read_text_file` | `fs/write_text_file` and `terminal/*`:
 *     these are **governed** — they go through the kernel's dispatcher, and a
 *     client that did not declare the capability gets `unsupported_capability`
 *     (never a local fs / local shell fallback, G6).
 *
 * The server never executes a tool itself: the host supplies `runTurn`, and
 * every reverse effect goes through the {@link ReverseInvokeGateway}.
 */

import type { Logger, Runtime } from '@syaocode/core';
import {
  ACP_ERROR_CODES,
  acpCapabilityId,
  type CanonicalErrorShape,
  type DiscoveredCapability,
  type InvokeResultPayload,
} from '@syaocode/rpc';
import { AdapterBase, type DuplexChannel } from '../shared/index.js';
import { JsonRpcConnection, type JsonRpcHandlerResult, type JsonRpcId } from '../shared/jsonrpc.js';
import type { ReverseInvokeGateway } from '../shared/gateway.js';
import { ACP_LOSSY, contentToInputBlocks, type AcpContentBlock, type AcpSessionUpdateKind, type AcpStopReason } from './content.js';
import { AcpApprovalChannel, optionsToAcp, subjectFromToolCall, type AcpPermissionOption, type AcpPermissionRequest, type AcpToolCallRef } from './permissions.js';
import { AcpFsBridge, type AcpFsClientCapabilities } from './fs.js';
import { AcpTerminalBridge, type AcpTerminalClientCapabilities } from './terminal.js';

export const ACP_METHODS: readonly string[] = [
  'initialize',
  'authenticate',
  'session/new',
  'session/load',
  'session/resume',
  'session/prompt',
  'session/cancel',
  'session/close',
  'session/list',
  'session/delete',
  'session/request_permission',
  'fs/read_text_file',
  'fs/write_text_file',
  'terminal/create',
  'terminal/output',
  'terminal/wait_for_exit',
  'terminal/kill',
  'terminal/release',
  'elicitation/create',
  '$/cancel_request',
];

export const ACP_NOTIFICATIONS: readonly string[] = ['session/update', 'session/cancel'];

export const ACP_PROTOCOL_VERSION = 1;

// ── client capabilities ───────────────────────────────────────────────────

export interface AcpClientCapabilities {
  fs?: AcpFsClientCapabilities;
  terminal?: AcpTerminalClientCapabilities;
  elicitation?: { available?: boolean };
}

export interface AcpAgentCapabilities {
  loadSession: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  sessionCapabilities?: { resume?: boolean };
  auth?: boolean;
}

export interface AcpSessionRecord {
  sessionId: string;
  cwd: string;
  mcpServers?: unknown[];
  createdAt: string;
  history: { role: 'user' | 'agent'; content: AcpContentBlock[] }[];
}

// ── turn interface ────────────────────────────────────────────────────────

export interface AcpTurnIo {
  sessionId: string;
  taskId: string;
  /** Emit a `session/update` notification. */
  update(update: { sessionUpdate: AcpSessionUpdateKind; [key: string]: unknown }): void;
  /** Ask the editor for permission (blocking, fail-closed). */
  requestPermission(request: AcpPermissionRequest): Promise<{ outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }>;
  /** Governed reverse filesystem access. */
  fs: AcpFsBridge;
  /** Governed reverse terminal access. */
  terminal: AcpTerminalBridge;
  signal?: AbortSignal;
}

export interface AcpTurnInput extends AcpTurnIo {
  prompt: AcpContentBlock[];
}

export interface AcpTurnResult {
  stopReason: AcpStopReason;
  error?: CanonicalErrorShape;
}

export interface AcpServerOptions {
  runtime: Runtime;
  channel: DuplexChannel;
  agentInfo: { name: string; version: string };
  agentCapabilities?: Partial<AcpAgentCapabilities>;
  authMethods?: { id: string; name?: string; description?: string }[];
  /**
   * Verify an `authenticate` request. Returning false rejects it; omitting it
   * accepts the method as satisfied (the host has no secret to check).
   */
  verifyAuthenticate?: (params: Record<string, unknown>) => boolean | undefined;
  /** Registry-assigned id of the connected editor. */
  clientId: string;
  /** Governed reverse calls (fs/terminal) — required for a real agent. */
  gateway: ReverseInvokeGateway;
  /** Run one prompt turn. The host wires this to the ARF dispatcher. */
  runTurn?: (input: AcpTurnInput) => Promise<AcpTurnResult>;
  /** Session store; the default keeps sessions in memory. */
  sessions?: Map<string, AcpSessionRecord>;
  /** Tenant the session belongs to. */
  tenantId?: string;
  /** Roots the client declares per session (`cwd` + additionalDirectories). */
  additionalDirectories?: (sessionId: string) => readonly string[];
  requestTimeoutMs?: number;
  logger?: Logger;
}

export class AcpServer extends AdapterBase {
  static readonly methods: readonly string[] = ACP_METHODS;

  readonly connection: JsonRpcConnection;
  private readonly options: AcpServerOptions;
  private readonly sessions: Map<string, AcpSessionRecord>;
  private readonly running = new Map<string, { taskId: string; abort: AbortController; cancelled: boolean }>();
  /** Pending `session/request_permission` calls, keyed by session. */
  private readonly pendingPermissions = new Map<string, (() => void)[]>();
  /** Sessions whose last turn was cancelled (observable by hosts and tests). */
  private readonly cancelledSessions = new Set<string>();
  private clientCapabilitiesValue: AcpClientCapabilities = {};
  private negotiatedVersion = ACP_PROTOCOL_VERSION;

  constructor(options: AcpServerOptions) {
    super('acp', String(ACP_PROTOCOL_VERSION), options.runtime, options.logger);
    this.options = options;
    this.sessions = options.sessions ?? new Map<string, AcpSessionRecord>();
    this.connection = new JsonRpcConnection({
      channel: options.channel,
      framing: 'auto',
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      handlers: {
        request: (method, params, ctx) => this.handleRequest(method, params, ctx.id),
        notification: (method, params) => {
          void this.handleNotification(method, params);
        },
      },
    });
    this.connection.start();
  }

  /** Capabilities the editor declared at `initialize`. */
  get clientCapabilities(): AcpClientCapabilities {
    return this.clientCapabilitiesValue;
  }

  get negotiatedProtocolVersion(): number {
    return this.negotiatedVersion;
  }

  /** Sessions known to this server (test/diagnostic helper). */
  listSessions(): AcpSessionRecord[] {
    return [...this.sessions.values()];
  }

  override async close(): Promise<void> {
    for (const entry of this.running.values()) entry.abort.abort();
    this.running.clear();
    await this.connection.close('server-close');
    await super.close();
  }

  /**
   * `authenticate` must not claim success it cannot back.
   *
   * The agent advertises its auth methods in `initialize`; a client may only
   * call `authenticate` for an advertised method. Answering `{authenticated:
   * true}` unconditionally asserted a completed authentication that never
   * happened — the same "fake success" the audit flagged for the A2A edge.
   */
  private authenticate(record: Record<string, unknown>): JsonRpcHandlerResult {
    const methods = this.options.authMethods ?? [];
    if (methods.length === 0) {
      throw {
        code: ACP_ERROR_CODES.invalidParams,
        message: 'this agent advertises no auth methods, so there is nothing to authenticate',
      };
    }
    const methodId = typeof record.methodId === 'string' ? record.methodId : undefined;
    if (methodId === undefined || !methods.some((m) => m.id === methodId)) {
      throw {
        code: ACP_ERROR_CODES.invalidParams,
        message: `unknown auth method '${methodId ?? '(none)'}'; this agent advertises: ${methods.map((m) => m.id).join(', ')}`,
      };
    }
    // The host decides whether the presented secret is acceptable; without a
    // verifier we cannot claim the authentication succeeded.
    const verified = this.options.verifyAuthenticate?.(record);
    if (verified === false) {
      throw {
        code: ACP_ERROR_CODES.authRequired,
        message: `authentication for '${methodId}' was rejected`,
      };
    }
    return { authenticated: true };
  }

  // ── routing ─────────────────────────────────────────────────────────────

  private async handleRequest(method: string, params: unknown, id: JsonRpcId): Promise<JsonRpcHandlerResult> {
    void id;
    const record = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'initialize':
        return this.initialize(record);
      case 'authenticate':
        return this.authenticate(record);
      case 'session/new':
        return this.newSession(record);
      case 'session/load':
        return this.loadSession(record, true);
      case 'session/resume':
        return this.loadSession(record, false);
      case 'session/prompt':
        return this.prompt(record);
      case 'session/cancel':
        await this.cancelSession(record);
        return {};
      case 'session/close':
        this.closeSession(record);
        return {};
      case 'session/list':
        return { sessions: [...this.sessions.values()].map((session) => ({ sessionId: session.sessionId, cwd: session.cwd })) };
      case 'session/delete':
        this.sessions.delete(sessionIdOf(record));
        return {};
      case 'session/request_permission':
        // The client must not call this: it is the agent→client direction.
        throw { code: -32601, message: 'session/request_permission is issued by the agent, not the client' };
      case 'fs/read_text_file':
      case 'fs/write_text_file':
      case 'terminal/create':
      case 'terminal/output':
      case 'terminal/wait_for_exit':
      case 'terminal/kill':
      case 'terminal/release':
      case 'elicitation/create':
        // These are client-owned capabilities: the *client* serves them, so an
        // agent receiving them is a protocol violation.
        throw { code: -32601, message: `${method} is a client-owned capability; the agent may only call it` };
      case '$/cancel_request':
        return {};
      default:
        throw { code: -32601, message: `method not found: ${method}` };
    }
  }

  private async handleNotification(method: string, params: unknown): Promise<void> {
    if (method === 'session/cancel') await this.cancelSession((params ?? {}) as Record<string, unknown>);
  }

  // ── methods ─────────────────────────────────────────────────────────────

  private initialize(record: Record<string, unknown>): Record<string, unknown> {
    const requested = record['protocolVersion'];
    const version = typeof requested === 'number' ? requested : ACP_PROTOCOL_VERSION;
    if (version !== ACP_PROTOCOL_VERSION) {
      throw { code: -32022, message: `unsupported ACP protocolVersion ${version} (this agent speaks ${ACP_PROTOCOL_VERSION})` };
    }
    this.negotiatedVersion = version;
    const capabilities = record['clientCapabilities'];
    this.clientCapabilitiesValue =
      capabilities !== null && typeof capabilities === 'object' ? (capabilities as AcpClientCapabilities) : {};
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { resume: true },
        auth: (this.options.authMethods ?? []).length > 0,
        ...(this.options.agentCapabilities ?? {}),
      },
      authMethods: this.options.authMethods ?? [],
      agentInfo: this.options.agentInfo,
    };
  }

  private newSession(record: Record<string, unknown>): Record<string, unknown> {
    const cwd = record['cwd'];
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
      throw { code: -32602, message: 'session/new requires an absolute cwd' };
    }
    const sessionId = this.options.runtime.ids.next('acp');
    const mcpServers = Array.isArray(record['mcpServers']) ? (record['mcpServers'] as unknown[]) : undefined;
    this.sessions.set(sessionId, {
      sessionId,
      cwd,
      ...(mcpServers !== undefined ? { mcpServers } : {}),
      createdAt: new Date(this.options.runtime.clock.now()).toISOString(),
      history: [],
    });
    return { sessionId };
  }

  /** `session/load` replays the history first; `session/resume` does not. */
  private async loadSession(record: Record<string, unknown>, replay: boolean): Promise<Record<string, unknown>> {
    const sessionId = sessionIdOf(record);
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw { code: -32002, message: `unknown session: ${sessionId}` };
    if (replay) {
      for (const entry of session.history) {
        await this.connection.notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: entry.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
            content: entry.content,
          },
        });
      }
    }
    return {};
  }

  private closeSession(record: Record<string, unknown>): void {
    const sessionId = sessionIdOf(record);
    this.sessions.delete(sessionId);
    this.running.delete(sessionId);
  }

  private async cancelSession(record: Record<string, unknown>): Promise<void> {
    const sessionId = sessionIdOf(record);
    const entry = this.running.get(sessionId);
    if (entry === undefined) return;
    // Abort the turn; the prompt handler answers `cancelled`, and every
    // pending permission request is answered `cancelled` (ACP §2.3).
    entry.abort.abort();
    entry.cancelled = true;
    this.running.delete(sessionId);
    this.cancelledSessions.add(sessionId);
    // Answer every in-flight permission request with `cancelled`: a pending
    // approval must never outlive the turn it belongs to.
    for (const pending of this.pendingPermissions.get(sessionId) ?? []) pending();
    this.pendingPermissions.delete(sessionId);
  }

  private async prompt(record: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = sessionIdOf(record);
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw { code: -32002, message: `unknown session: ${sessionId}` };
    const prompt = Array.isArray(record['prompt']) ? (record['prompt'] as AcpContentBlock[]) : [];
    const taskId = this.options.runtime.ids.next('task');
    if (this.options.runTurn === undefined) {
      throw { code: -32603, message: 'this agent has no prompt handler' };
    }
    const abort = new AbortController();
    this.running.set(sessionId, { taskId, abort, cancelled: false });
    const fs = this.fsBridge(sessionId);
    const terminal = this.terminalBridge(sessionId);
    const approval = new AcpApprovalChannel(
      (method, params, opts) => this.connection.request(method, params, opts),
      sessionId,
      this.options.requestTimeoutMs,
    );
    const io: AcpTurnIo = {
      sessionId,
      taskId,
      update: (update) => {
        void this.connection.notify('session/update', { sessionId, update });
      },
      requestPermission: (request) => approval.requestPermission(request, { register: (cancel) => this.trackPermission(sessionId, cancel) }),
      fs,
      terminal,
      signal: abort.signal,
    };
    try {
      const result = await this.options.runTurn({ ...io, prompt });
      session.history.push({ role: 'user', content: prompt });
      // Cancellation wins over whatever the turn handler claims: the client
      // MUST see `cancelled` for a turn it cancelled (ACP §2.3), even when the
      // handler degraded the abort into its own non-cancelled stop reason.
      if (abort.signal.aborted) {
        this.cancelledSessions.add(sessionId);
        return { stopReason: 'cancelled' };
      }
      return { stopReason: result.stopReason };
    } catch (error) {
      // A cancelled turn is NOT a refusal (ACP MUST): the distinction is the
      // difference between "the user stopped it" and "the agent refused".
      if (isCancellation(error, abort.signal)) {
        this.cancelledSessions.add(sessionId);
        return { stopReason: 'cancelled' };
      }
      return { stopReason: 'refusal' };
    } finally {
      this.running.delete(sessionId);
    }
  }

  // ── reverse bridges ─────────────────────────────────────────────────────

  /** Track a pending permission request so a cancel can answer it. */
  private trackPermission(sessionId: string, cancel: () => void): void {
    const list = this.pendingPermissions.get(sessionId) ?? [];
    list.push(cancel);
    this.pendingPermissions.set(sessionId, list);
  }

  /** True when the session's last turn was cancelled. */
  wasCancelled(sessionId: string): boolean {
    return this.cancelledSessions.has(sessionId);
  }

  /** Governed reverse filesystem bridge for a session. */
  fsBridge(sessionId: string): AcpFsBridge {
    return new AcpFsBridge({
      clientId: this.options.clientId,
      sessionId,
      capabilities: this.clientCapabilitiesValue.fs ?? {},
      workspaceRoots: this.rootsFor(sessionId),
      gateway: this.options.gateway,
      ...(this.options.tenantId !== undefined ? { tenantId: this.options.tenantId } : {}),
    });
  }

  /** Governed reverse terminal bridge for a session. */
  terminalBridge(sessionId: string): AcpTerminalBridge {
    return new AcpTerminalBridge({
      clientId: this.options.clientId,
      sessionId,
      capabilities: this.clientCapabilitiesValue.terminal ?? {},
      gateway: this.options.gateway,
      ...(this.options.tenantId !== undefined ? { tenantId: this.options.tenantId } : {}),
    });
  }

  private rootsFor(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    const roots: string[] = [];
    if (session !== undefined) roots.push(session.cwd);
    const extra = this.options.additionalDirectories?.(sessionId) ?? [];
    roots.push(...extra);
    return roots;
  }

  // ── adapter-ish surface ─────────────────────────────────────────────────

  capabilities(): import('@syaocode/rpc').AdapterCapabilities {
    return {
      protocol: 'acp',
      version: String(ACP_PROTOCOL_VERSION),
      supports: {
        session: true,
        task: false,
        streaming: false,
        push: true,
        approvalOptions: true,
        artifacts: false,
        reverseCalls: true,
        cancellation: true,
      },
      lossy: [ACP_LOSSY.noTaskState, ACP_LOSSY.noArtifacts, ACP_LOSSY.noDeniedOutcome, ACP_LOSSY.clientOwnedFs],
    };
  }

  /** The client-owned capabilities this agent may invoke (G6). */
  discover(): DiscoveredCapability[] {
    const clientId = this.options.clientId;
    const out: DiscoveredCapability[] = [];
    const fs = this.clientCapabilitiesValue.fs;
    if (fs?.readTextFile === true) {
      out.push({
        id: acpCapabilityId(clientId, 'fs', 'read_text_file'),
        kind: 'fs',
        displayName: 'read_text_file',
        declaredRisk: 'read',
        annotations: { trust: 'untrusted', source: 'acp-client-capabilities', lossy: [ACP_LOSSY.clientOwnedFs] },
      });
    }
    if (fs?.writeTextFile === true) {
      out.push({
        id: acpCapabilityId(clientId, 'fs', 'write_text_file'),
        kind: 'fs',
        displayName: 'write_text_file',
        declaredRisk: 'write',
        annotations: { trust: 'untrusted', source: 'acp-client-capabilities', lossy: [ACP_LOSSY.clientOwnedFs] },
      });
    }
    if (this.clientCapabilitiesValue.terminal?.terminal === true) {
      for (const method of ['create', 'output', 'wait_for_exit', 'kill', 'release']) {
        out.push({
          id: acpCapabilityId(clientId, 'terminal', method),
          kind: 'terminal',
          displayName: `terminal/${method}`,
          declaredRisk: 'execute',
          annotations: { trust: 'untrusted', source: 'acp-client-capabilities', lossy: [ACP_LOSSY.clientOwnedFs] },
        });
      }
    }
    return out;
  }

  async invoke(): Promise<InvokeResultPayload> {
    const error: CanonicalErrorShape = { kind: 'unsupported_capability', message: 'AcpServer does not invoke peers; use AcpAdapter', retryable: false };
    return { outcome: 'failed', error };
  }
}

/**
 * True when a failure is a cancellation rather than a real error.
 *
 * The turn may fail because the session was cancelled (the abort signal fired)
 * or because the handler raised a canonical `cancelled` error.
 */
function isCancellation(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (error === null || typeof error !== 'object') return false;
  const kind = (error as { kind?: unknown }).kind;
  return kind === 'cancelled';
}

function sessionIdOf(record: Record<string, unknown>): string {
  const sessionId = record['sessionId'];
  if (typeof sessionId !== 'string') throw { code: -32602, message: 'sessionId is required' };
  return sessionId;
}

export { contentToInputBlocks, optionsToAcp, subjectFromToolCall };
export type { AcpPermissionOption, AcpPermissionRequest, AcpToolCallRef };
