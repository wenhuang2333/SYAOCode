/**
 * `@syaocode/protocols/acp` — the ACP v1 edge.
 *
 * One channel, two faces (01 §2.3 "ACP 是双向协议"):
 *   - {@link AcpServer} — the *agent* face: `initialize`, `session/*`,
 *     `session/update`, `session/request_permission`;
 *   - {@link AcpAdapter} — the *client face* the kernel dispatches to when it
 *     invokes a client-owned capability (`fs/read_text_file`,
 *     `fs/write_text_file`, `terminal/*`).
 *
 * Both faces share one {@link JsonRpcConnection} in production (a single stdio
 * channel with the editor); the reverse bridges in `fs.ts` / `terminal.ts` are
 * the only way an agent turn can touch the client, and they always go through
 * the kernel's `ReverseInvokeGateway` first (G6).
 */

export {
  ACP_LOSSY,
  contentText,
  contentToInputBlocks,
  eventToSessionUpdate,
  inputBlocksToContent,
  stopReasonFor,
  textBlock,
} from './content.js';
export type {
  AcpContentBlock,
  AcpEmbeddedResourceBlock,
  AcpImageBlock,
  AcpResourceLinkBlock,
  AcpSessionNotification,
  AcpSessionUpdateKind,
  AcpStopReason,
  AcpTextBlock,
} from './content.js';

export {
  AcpApprovalChannel,
  acpKindOfApproval,
  acpOutcomeFromApproval,
  approvalFromAcpOutcome,
  approvalKindOfAcp,
  isRejectKind,
  normalizeOutcome,
  optionsFromAcp,
  optionsToAcp,
  subjectFromToolCall,
} from './permissions.js';
export type {
  AcpPermissionOption,
  AcpPermissionOptionKind,
  AcpPermissionOutcome,
  AcpPermissionRequest,
  AcpRequester,
  AcpToolCallRef,
} from './permissions.js';

export { AcpFsBridge, assertPathInsideRoots, isPathInsideRoots, normalizePath } from './fs.js';
export type { AcpFsBridgeOptions, AcpFsClientCapabilities, AcpFsReadResult } from './fs.js';

export { AcpTerminalBridge } from './terminal.js';
export type {
  AcpTerminalBridgeOptions,
  AcpTerminalClientCapabilities,
  AcpTerminalCreateRequest,
  AcpTerminalCreateResult,
  AcpTerminalExitStatus,
  AcpTerminalOutput,
} from './terminal.js';

export { ACP_METHODS, ACP_NOTIFICATIONS, ACP_PROTOCOL_VERSION, AcpServer } from './server.js';
export type {
  AcpAgentCapabilities,
  AcpClientCapabilities,
  AcpServerOptions,
  AcpSessionRecord,
  AcpTurnInput,
  AcpTurnIo,
  AcpTurnResult,
} from './server.js';

import type { Logger, Runtime } from '@syaocode/core';
import { acpCapabilityId, CanonicalError, type AdapterCapabilities, type AdapterContext, type AuthorizedInvocation, type DiscoveredCapability, type InvokeResultPayload } from '@syaocode/rpc';
import { AdapterBase, appendEdgeEvent, mergeLossy, remainingMs, timeoutOutcome, wireError } from '../shared/index.js';
import { JsonRpcAbortedError, JsonRpcConnection, JsonRpcTimeoutError, type JsonRpcId } from '../shared/jsonrpc.js';
import { ACP_LOSSY } from './content.js';
import type { AcpClientCapabilities } from './server.js';
import { AcpServer, type AcpServerOptions } from './server.js';
import { createLoopbackPair, createStdioChannel, type DuplexChannel } from '../shared/transport.js';

export interface AcpAdapterOptions {
  runtime: Runtime;
  /** Shared with the paired {@link AcpServer}: one channel, two faces. */
  connection: JsonRpcConnection;
  /** Registry-assigned id of the connected editor. */
  clientId: string;
  /** Default session for reverse calls that do not carry one. */
  sessionId?: string;
  /**
   * The session this connection owns. A reverse call naming a different
   * sessionId is rejected: one editor connection must not drive another
   * session's filesystem.
   */
  ownedSessionIds?: readonly string[];
  /**
   * Roots a reverse call may touch, per session (client-declared `cwd` +
   * `additionalDirectories`). Compared against **realpaths**, never lexical
   * prefixes.
   */
  workspaceRoots?: readonly string[] | ((sessionId: string) => readonly string[]);
  /** Client capabilities, or a getter (lets the adapter read the server's). */
  clientCapabilities: AcpClientCapabilities | (() => AcpClientCapabilities);
  requestTimeoutMs?: number;
  logger?: Logger;
  lossy?: string[];
}

interface InFlight {
  taskId: string;
  requestId: JsonRpcId;
  method: string;
  abort: AbortController;
}

/**
 * The ACP *client face* as a `ProtocolAdapter`.
 *
 * The kernel dispatches here only after the ten-step pipeline authorized the
 * invocation; this class therefore performs the wire call and nothing else. All
 * the governance lives upstream (the dispatcher) and in the reverse bridges
 * (`fs.ts` / `terminal.ts`) that the agent's turn uses.
 */
export class AcpAdapter extends AdapterBase {
  private readonly connection: JsonRpcConnection;
  private readonly options: AcpAdapterOptions;
  private readonly inFlight = new Map<string, InFlight>();

  constructor(options: AcpAdapterOptions) {
    super('acp', String(1), options.runtime, options.logger);
    this.options = options;
    this.connection = options.connection;
  }

  private caps(): AcpClientCapabilities {
    const source = this.options.clientCapabilities;
    return typeof source === 'function' ? source() : source;
  }

  capabilities(): AdapterCapabilities {
    const caps = this.caps();
    return {
      protocol: 'acp',
      version: '1',
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
      lossy: mergeLossy(
        [ACP_LOSSY.noTaskState, ACP_LOSSY.noArtifacts, ACP_LOSSY.noDeniedOutcome, ACP_LOSSY.clientOwnedFs],
        caps.fs === undefined && caps.terminal?.terminal !== true ? [ACP_LOSSY.clientCapabilityMissing] : undefined,
        this.options.lossy,
      ),
    };
  }

  /** Client-owned capabilities the kernel may invoke (G6). */
  async discover(ctx: AdapterContext): Promise<DiscoveredCapability[]> {
    void ctx;
    const caps = this.caps();
    const clientId = this.options.clientId;
    const out: DiscoveredCapability[] = [];
    if (caps.fs?.readTextFile === true) {
      out.push({
        id: acpCapabilityId(clientId, 'fs', 'read_text_file'),
        kind: 'fs',
        displayName: 'read_text_file',
        declaredRisk: 'read',
        annotations: { trust: 'untrusted', source: 'acp-client-capabilities', reversible: true },
      });
    }
    if (caps.fs?.writeTextFile === true) {
      out.push({
        id: acpCapabilityId(clientId, 'fs', 'write_text_file'),
        kind: 'fs',
        displayName: 'write_text_file',
        declaredRisk: 'write',
        annotations: { trust: 'untrusted', source: 'acp-client-capabilities', reversible: false },
      });
    }
    if (caps.terminal?.terminal === true) {
      for (const method of ['create', 'output', 'wait_for_exit', 'kill', 'release']) {
        out.push({
          id: acpCapabilityId(clientId, 'terminal', method),
          kind: 'terminal',
          displayName: `terminal/${method}`,
          declaredRisk: 'execute',
          annotations: { trust: 'untrusted', source: 'acp-client-capabilities', reversible: method === 'output' },
        });
      }
    }
    return out;
  }

  async invoke(req: AuthorizedInvocation, ctx: AdapterContext): Promise<InvokeResultPayload> {
    const parsed = parseAcpCapabilityId(req.capability.id);
    if (parsed === undefined) {
      return {
        outcome: 'failed',
        error: { kind: 'invalid_request', message: `malformed ACP capability id: ${req.capability.id}`, retryable: false },
        lossy: this.adapterLossy(),
      };
    }
    const caps = this.caps();
    // Capability gate first: a client that did not declare the capability gets
    // `unsupported_capability` — NEVER a local fs / local shell fallback (G6).
    const supported = this.isSupported(parsed.kind, parsed.name, caps);
    if (!supported) {
      await appendEdgeEvent(ctx, {
        type: 'capability.unavailable',
        invocation: req,
        protocol: 'acp',
        payload: { acp: 'client-capability-missing', capabilityId: req.capability.id, kind: parsed.kind, name: parsed.name },
      });
      return {
        outcome: 'failed',
        error: {
          kind: 'unsupported_capability',
          message: `the ACP client did not declare ${parsed.kind}/${parsed.name}`,
          retryable: false,
        },
        lossy: mergeLossy(this.adapterLossy(), [ACP_LOSSY.clientCapabilityMissing]),
      };
    }

    const input = (req.input ?? {}) as Record<string, unknown>;
    const sessionId = typeof input['sessionId'] === 'string' ? input['sessionId'] : this.options.sessionId;
    if (sessionId === undefined) {
      return {
        outcome: 'failed',
        error: { kind: 'invalid_request', message: 'ACP reverse call requires a sessionId', retryable: false },
        lossy: this.adapterLossy(),
      };
    }

    // ── P-H7: the fence lives on the path the dispatcher actually calls ────
    // Session ownership first: a request may only act on a session this
    // connection owns. Then the realpath fence for fs/terminal capabilities.
    const ownership = this.checkSessionOwnership(sessionId);
    if (ownership !== undefined) return ownership;
    const fence = await this.checkFence(parsed.kind, parsed.name, sessionId, input, ctx);
    if (fence !== undefined) return fence;

    const method = `${parsed.kind}/${parsed.name}`;
    const params = { sessionId, ...withoutKeys(input, ['sessionId']) };
    const timeoutMs = remainingMs(ctx.runtime, ctx);
    const abort = new AbortController();
    if (ctx.signal !== undefined) {
      if (ctx.signal.aborted) abort.abort();
      else ctx.signal.addEventListener('abort', () => abort.abort(), { once: true });
    }
    let requestId: JsonRpcId = '';
    const track = (id: JsonRpcId): void => {
      requestId = id;
      this.inFlight.set(requestIdString(id), { taskId: req.taskId, requestId: id, method, abort });
    };

    try {
      const raw = await this.connection.request(method, params, {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        signal: abort.signal,
        onId: track,
      });
      return this.success(raw);
    } catch (error) {
      return this.failure(error);
    } finally {
      if (requestId !== '') this.inFlight.delete(requestIdString(requestId));
    }
  }

  /** Cancel propagation: `$/cancel_request` to the editor (ACP §methods). */
  async cancel(taskId: string, reason: string, ctx: AdapterContext): Promise<void> {
    void ctx;
    const targets = [...this.inFlight.values()].filter((entry) => entry.taskId === taskId);
    for (const entry of targets) {
      try {
        await this.connection.notify('$/cancel_request', { requestId: entry.requestId, reason, method: entry.method });
      } catch {
        /* the peer may already be gone; the abort below still settles us */
      }
      entry.abort.abort();
    }
  }

  /** In-flight reverse calls, for diagnostics and determinability checks. */
  pendingCalls(): { requestId: JsonRpcId; method: string; taskId: string }[] {
    return [...this.inFlight.values()].map((entry) => ({ requestId: entry.requestId, method: entry.method, taskId: entry.taskId }));
  }

  /**
   * The reverse call must name a session this connection owns.
   *
   * Without this, any capability id naming `acp://<client>/fs/...` could be
   * dispatched against another editor's session (I11).
   */
  private checkSessionOwnership(sessionId: string): InvokeResultPayload | undefined {
    const owned = this.options.ownedSessionIds;
    const configured = this.options.sessionId;
    if (owned === undefined && configured === undefined) return undefined;
    const allowed = owned ?? (configured !== undefined ? [configured] : []);
    if (allowed.includes(sessionId)) return undefined;
    return {
      outcome: 'failed',
      error: {
        kind: 'denied',
        message: `ACP reverse call names session ${sessionId}, which this connection does not own`,
        retryable: false,
        details: { sessionId, owned: this.options.ownedSessionIds ?? (this.options.sessionId !== undefined ? [this.options.sessionId] : []) },
      },
      lossy: mergeLossy(this.adapterLossy(), [ACP_LOSSY.sessionNotOwned]),
    };
  }

  /**
   * Realpath fence for `direction: 'reverse'` fs/terminal capabilities.
   *
   * `Runtime.fs.realpath` resolves symlinks and `..`, so a lexical prefix test
   * (`/repo-evil`.startsWith(`/repo`)) cannot be used to escape the roots. A
   * path that does not exist yet (a file about to be written) is fenced by its
   * parent directory, which must exist and be inside a root.
   */
  private async checkFence(
    kind: string,
    name: string,
    sessionId: string,
    input: Record<string, unknown>,
    ctx: AdapterContext,
  ): Promise<InvokeResultPayload | undefined> {
    const roots = this.rootsFor(sessionId);
    if (roots.length === 0) return undefined; // no declared roots: nothing to fence against
    const candidate = fenceCandidate(kind, name, input);
    if (candidate === undefined) return undefined;

    const resolved = await resolveForFence(ctx.runtime, candidate);
    const rootPaths = await Promise.all(roots.map(async (root) => safeRealpath(ctx.runtime, root)));
    if (resolved !== undefined && rootPaths.some((root) => root !== undefined && isWithin(resolved, root))) return undefined;

    return {
      outcome: 'failed',
      error: {
        kind: 'denied',
        message: `ACP reverse ${kind}/${name} rejected: ${candidate} is outside the session workspace roots`,
        retryable: false,
        details: { path: candidate, resolved, roots: [...roots] },
      },
      lossy: mergeLossy(this.adapterLossy(), [ACP_LOSSY.fenceDenied]),
    };
  }

  private rootsFor(sessionId: string): readonly string[] {
    const source = this.options.workspaceRoots;
    if (source === undefined) return [];
    return typeof source === 'function' ? source(sessionId) : source;
  }

  private isSupported(kind: string, name: string, caps: AcpClientCapabilities): boolean {
    if (kind === 'fs') {
      if (name === 'read_text_file') return caps.fs?.readTextFile === true;
      if (name === 'write_text_file') return caps.fs?.writeTextFile === true;
      return false;
    }
    if (kind === 'terminal') return caps.terminal?.terminal === true;
    return false;
  }

  private success(raw: unknown): InvokeResultPayload {
    const output = raw === undefined || raw === null ? {} : raw;
    return { outcome: 'succeeded', output, lossy: this.adapterLossy() };
  }

  private failure(error: unknown): InvokeResultPayload {
    if (error instanceof JsonRpcTimeoutError) {
      return { outcome: timeoutOutcome(error.sent), error: wireError('acp', error).toShape(), lossy: mergeLossy(this.adapterLossy(), ['acp-no-auto-retry']) };
    }
    if (error instanceof JsonRpcAbortedError) {
      return { outcome: 'cancelled', error: new CanonicalError({ kind: 'cancelled', message: error.message, protocol: 'acp', retryable: false }).toShape(), lossy: this.adapterLossy() };
    }
    const canonical = wireError('acp', error);
    const outcome: InvokeResultPayload['outcome'] = canonical.kind === 'cancelled' ? 'cancelled' : 'failed';
    return { outcome, error: canonical.toShape(), lossy: this.adapterLossy() };
  }

  private adapterLossy(): string[] {
    return mergeLossy([ACP_LOSSY.noTaskState, ACP_LOSSY.clientOwnedFs], this.options.lossy);
  }
}

/** The path a reverse capability will touch, when it has one. */
function fenceCandidate(kind: string, name: string, input: Record<string, unknown>): string | undefined {
  if (kind === 'fs') {
    const path = input['path'];
    return typeof path === 'string' && path.length > 0 ? path : undefined;
  }
  if (kind === 'terminal') {
    // `terminal/create` carries a cwd; the other terminal methods act on a
    // terminalId already created inside the fence.
    const cwd = input['cwd'];
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
  }
  return undefined;
}

/** `realpath` that never throws (an unresolvable path is simply not allowed). */
async function safeRealpath(runtime: Runtime, path: string): Promise<string | undefined> {
  try {
    return normalizeSlashes(await runtime.fs.realpath(path));
  } catch {
    return undefined;
  }
}

/**
 * Resolve a path for fencing.
 *
 * An existing path resolves directly; a path that does not exist yet (a file
 * about to be written) is resolved through its parent directory, which must
 * itself exist. Anything that cannot be resolved returns `undefined` and is
 * therefore denied.
 */
async function resolveForFence(runtime: Runtime, path: string): Promise<string | undefined> {
  const direct = await safeRealpath(runtime, path);
  if (direct !== undefined) return direct;
  const parent = dirnameOf(path);
  if (parent === undefined) return undefined;
  const resolvedParent = await safeRealpath(runtime, parent);
  if (resolvedParent === undefined) return undefined;
  const base = basenameOf(path);
  return base === undefined ? resolvedParent : normalizeSlashes(`${resolvedParent}/${base}`);
}

function normalizeSlashes(path: string): string {
  return path.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

function dirnameOf(path: string): string | undefined {
  const normalized = normalizeSlashes(path);
  const index = normalized.lastIndexOf('/');
  if (index < 0) return undefined;
  return index === 0 ? '/' : normalized.slice(0, index);
}

function basenameOf(path: string): string | undefined {
  const normalized = normalizeSlashes(path);
  const index = normalized.lastIndexOf('/');
  const base = index < 0 ? normalized : normalized.slice(index + 1);
  return base.length === 0 ? undefined : base;
}

/** True when `target` is `root` or lives below it (both already resolved). */
function isWithin(target: string, root: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** Parse `acp://<client>/<kind>/<name>`; undefined for malformed ids. */
export function parseAcpCapabilityId(capabilityId: string): { clientId: string; kind: string; name: string } | undefined {
  const match = /^acp:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(capabilityId);
  if (match === null) return undefined;
  const [, clientId, kind, name] = match;
  if (clientId === undefined || kind === undefined || name === undefined) return undefined;
  return { clientId, kind, name };
}

function withoutKeys(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (keys.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

function requestIdString(id: JsonRpcId): string {
  return typeof id === 'number' ? String(id) : id;
}

/** Create the ACP agent edge. */
export function createAcpServer(options: AcpServerOptions): AcpServer {
  return new AcpServer(options);
}

/** Create the ACP client face bound to an existing connection. */
export function createAcpAdapter(options: AcpAdapterOptions): AcpAdapter {
  return new AcpAdapter(options);
}

/** Alias used by the CLI and the docs. */
export const acpAdapter = createAcpAdapter;

export interface AcpEdge {
  server: AcpServer;
  adapter: AcpAdapter;
  channel: DuplexChannel;
}

/**
 * Wire both ACP faces onto one connection (production layout: a single stdio
 * channel to the editor). The client capabilities are read lazily from the
 * server, so `discover()` reflects whatever `initialize` negotiated.
 */
export function createAcpEdge(options: Omit<AcpServerOptions, 'channel'> & { channel: DuplexChannel; lossy?: string[] }): AcpEdge {
  const server = new AcpServer({ ...options, channel: options.channel });
  const adapterOptions: AcpAdapterOptions = {
    runtime: options.runtime,
    connection: server.connection,
    clientId: options.clientId,
    clientCapabilities: () => server.clientCapabilities,
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.lossy !== undefined ? { lossy: options.lossy } : {}),
  };
  const adapter = new AcpAdapter(adapterOptions);
  return { server, adapter, channel: options.channel };
}

/** Convenience: spawn an ACP peer over stdio and build both faces. */
export function createStdioAcpEdge(options: {
  runtime: Runtime;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  clientId: string;
  gateway: AcpServerOptions['gateway'];
  agentInfo: { name: string; version: string };
  runTurn?: AcpServerOptions['runTurn'];
  logger?: Logger;
}): AcpEdge {
  const spawnOptions: { cwd?: string; env?: Record<string, string> } = {};
  if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
  if (options.env !== undefined) spawnOptions.env = options.env;
  const { channel } = createStdioChannel(options.runtime, options.command, options.args ?? [], {
    ...spawnOptions,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  return createAcpEdge({
    runtime: options.runtime,
    channel,
    clientId: options.clientId,
    gateway: options.gateway,
    agentInfo: options.agentInfo,
    ...(options.runTurn !== undefined ? { runTurn: options.runTurn } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}

/** In-process pair for tests and embedded editors. */
export function createAcpLoopbackEdge(
  options: Omit<AcpServerOptions, 'channel'> & { lossy?: string[] },
): AcpEdge & { peer: DuplexChannel } {
  const pair = createLoopbackPair({ labels: ['agent', 'editor'] });
  const edge = createAcpEdge({ ...options, channel: pair.a });
  return { ...edge, peer: pair.b };
}
