/**
 * `syao serve` — expose the governance fabric over a protocol edge.
 *
 * Split in two so tests never open a socket:
 *
 *   servePlan(opts)  → PURE. Validates the listen address, derives the
 *                      endpoints and refuses an unsafe bind (SY-SRV-002).
 *   runServe(plan)   → thin. Mounts a real protocol server edge and serves.
 *                      Only `main.ts` calls it.
 *
 * Default host is 127.0.0.1. A non-loopback host without a bearer token is
 * refused with SY-SRV-002 semantics (UnsafeListenAddress, BR-041) — the code
 * already exists in the error registry, so no new code is invented.
 *
 * Inbound requests are NOT executed here: the MCP/A2A/ACP server edge calls
 * `fabric.dispatcher.invoke` through the executor/gateway built in `edges.ts`,
 * so an inbound call goes through the same ten-step governance pipeline as an
 * outbound one.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import type { Fabric, Principal } from '@syaocode/rpc';
import { isLoopbackHost } from './arf.js';
import { loadProtocolModule, mcpServerExecutor } from './edges.js';
import { t } from './i18n/index.js';
import { servePanel, type ServePlan, type ServeState } from './rpc-views.js';

export type ServeProtocol = 'mcp' | 'acp' | 'a2a';
export type ServeTransport = 'stdio' | 'http';

export interface ServeOptions {
  protocol?: ServeProtocol;
  transport?: ServeTransport;
  host?: string;
  port?: number;
  /** Resolved bearer token; only its presence is ever rendered. */
  token?: string;
}

export interface ServeIo {
  out(text: string): void;
  err(text: string): void;
  /** Aborts the listener (SIGINT / tests). */
  signal?: AbortSignal;
}

/** Default ports, one per edge so two edges can run side by side. */
/**
 * Why the A2A edge refuses to run agent turns in this build (05 §10.1 C-2).
 *
 * The previous implementation answered `TASK_STATE_COMPLETED` without going
 * through the dispatcher: it did no work and still reported success. Returning
 * a fabricated completion poisons every caller that trusts the state, so the
 * edge is explicit about being unable to execute. Kept as a named constant so
 * a test can assert the refusal instead of the fake completion.
 */
export const A2A_EXECUTION_UNSUPPORTED_MESSAGE =
  'SYAOCode A2A edge accepts discovery and task bookkeeping but does not execute agent turns in this build; the task was recorded and cancelled rather than reported as completed.';

/**
 * The wire framing for one binding.
 *
 * Getting this wrong breaks every real peer, and the failure is silent to a
 * self-test that shares the mistake:
 *   - MCP stdio is `Content-Length` framed (LSP-style);
 *   - ACP stdio is newline-delimited JSON (04 C16);
 *   - HTTP carries the payload in the response BODY, so it is bare JSON.
 * The official MCP client failed with `SyntaxError: Unexpected token 'C'` when
 * HTTP reused the stdio framing.
 */
export function framingFor(protocol: ServeProtocol, transport: ServeTransport): 'content-length' | 'json-lines' {
  return transport === 'stdio' && protocol === 'mcp' ? 'content-length' : 'json-lines';
}

export const DEFAULT_PORTS: Readonly<Record<ServeProtocol, number>> = {
  mcp: 8787,
  a2a: 8788,
  acp: 8789,
};

/** HTTP path each edge is served under. */
export const EDGE_PATHS: Readonly<Record<ServeProtocol, string>> = {
  mcp: '/mcp',
  a2a: '/a2a',
  acp: '/acp',
};

/**
 * Where an A2A client looks for our self-description (A2A 1.0 / SDK
 * `AGENT_CARD_PATH`). Serving it is what makes the edge *discoverable*: a
 * compliant client resolves the card before it will talk to us at all, so
 * without this endpoint no official SDK client can reach the edge.
 */
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';

export function edgePath(protocol: ServeProtocol): string {
  return EDGE_PATHS[protocol];
}

/** The token the CLI would use, from the environment (never from a file). */
export function resolveServeToken(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env.SYAO_RPC_TOKEN;
  return raw !== undefined && raw !== '' ? raw : undefined;
}

/**
 * PURE: turn CLI flags into a validated listen plan.
 *
 * `errors` non-empty means the listener must not start; `errorCodes` carries
 * the registry code for each error (SY-SRV-002 for an unsafe bind).
 */
export function servePlan(opts: ServeOptions = {}): ServePlan {
  const protocol: ServeProtocol = opts.protocol ?? 'mcp';
  const transport: ServeTransport = opts.transport ?? 'http';
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? DEFAULT_PORTS[protocol];
  const tokenConfigured = opts.token !== undefined && opts.token !== '';

  const errors: string[] = [];
  const errorCodes: string[] = [];

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    errors.push(t('serve.badPort', { port: String(port) }));
    errorCodes.push('SY-CLI-001');
  }
  if (transport === 'http' && !isLoopbackHost(host) && !tokenConfigured) {
    errors.push(t('serve.unsafeListen', { host }));
    errorCodes.push('SY-SRV-002');
  }

  const endpoints =
    transport === 'http'
      ? [`http://${host}:${port}${edgePath(protocol)}`, `http://${host}:${port}/healthz`]
      : [`stdio://${protocol}`];

  const notes: string[] = [];
  if (transport === 'http' && isLoopbackHost(host)) notes.push(t('serve.loopbackOnly'));
  if (transport === 'http' && tokenConfigured) notes.push(t('serve.tokenRequired'));

  return {
    protocol,
    transport,
    host,
    port,
    tokenConfigured,
    endpoints,
    errors,
    errorCodes,
    edgeUnavailable: false,
    notes,
  };
}

/** True when a protocol edge module loads and exposes its server factory. */
export async function probeProtocolEdge(protocol: ServeProtocol): Promise<boolean> {
  const mod = await loadProtocolModule(protocol);
  if (mod === undefined) return false;
  const factory =
    protocol === 'mcp' ? mod.createMcpServer : protocol === 'a2a' ? mod.createA2aServer : mod.createAcpEdge;
  return typeof factory === 'function';
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function tokenMatches(expected: string, header: string | undefined): boolean {
  if (header === undefined) return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const given = Buffer.from(header.slice(prefix.length));
  const want = Buffer.from(expected);
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}

/** Everything the server edge needs from the running CLI. */
export interface ServeFabricContext {
  fabric: Fabric;
  principal: Principal;
  cwd: string;
  workspaceRoots: string[];
  tenantId: string;
  /**
   * The session every inbound call is attributed to. Creating it also creates
   * the budget account the dispatcher reserves against, so an inbound request
   * never fails with "budget account does not exist".
   */
  ensureSession(): Promise<{ id: string; budgetId: string }>;
  /**
   * Run one ACP prompt turn (audit C-3).
   *
   * Without it the ACP edge can `initialize` and open sessions but every
   * `session/prompt` fails with "this agent has no prompt handler". The host
   * supplies the runner because it owns the model configuration.
   */
  runTurn?: (request: {
    /** The ACP content blocks of this turn (flattened by the runner). */
    prompt: readonly { type: string; text?: string }[];
    sessionId: string;
    taskId: string;
    update(update: { sessionUpdate: string; [key: string]: unknown }): void;
    requestPermission(request: unknown): Promise<{ outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }>;
    signal?: AbortSignal;
  }) => Promise<{ stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' }>;
}

export interface MountedServerEdge {
  close(): Promise<void>;
  /** Feed one inbound JSON-RPC chunk and get the reply chunks. */
  handle(chunk: string): Promise<string[]>;
}

/**
 * Build the server edge for one protocol over an in-process callback channel.
 *
 * The channel is what makes HTTP serving possible without inventing a second
 * transport: the HTTP handler pushes the request body into `handle()` and
 * writes the queued reply back.
 */
export async function mountServerEdge(
  protocol: ServeProtocol,
  ctx: ServeFabricContext,
  opts: {
    serverId?: string;
    bufferStdout?: boolean;
    timeoutMs?: number;
    /** The binding in use; it decides the wire framing. */
    transport?: ServeTransport;
  } = {},
): Promise<MountedServerEdge | undefined> {
  const mod = await loadProtocolModule(protocol);
  if (mod === undefined) return undefined;
  const shared = await loadProtocolModule('shared');
  const createCallbackChannel = shared?.createCallbackChannel as
    | ((handlers: { onSend: (chunk: string) => void; framing?: string; describe?: string }) => {
        channel: unknown;
        push: (chunk: string) => void;
        end: () => void;
      })
    | undefined;
  if (typeof createCallbackChannel !== 'function') return undefined;

  const outbox: string[] = [];
  /** Ids of requests we accepted but have not answered yet. */
  const pendingIds = new Set<string>();
  const idleWaiters: (() => void)[] = [];
  // stdio mode additionally mirrors every reply onto the real stdout.
  const useStdout = opts.bufferStdout !== true;
  const { channel, push, end } = createCallbackChannel({
    describe: `${protocol}:serve`,
    // Framing is per BINDING, and getting it wrong makes every real peer fail:
    //   - MCP stdio is `Content-Length` framed (LSP-style);
    //   - ACP stdio is newline-delimited JSON (04 C16);
    //   - HTTP carries the payload in the response BODY, so it is bare JSON —
    //     writing stdio framing there is what made the official MCP client fail
    //     with `SyntaxError: Unexpected token 'C'`.
    framing: framingFor(protocol, opts.transport ?? 'stdio'),
    onSend: (chunk) => {
      outbox.push(chunk);
      if (useStdout) stdout.write(chunk);
      for (const id of messageIds(chunk)) pendingIds.delete(id);
      if (pendingIds.size === 0) for (const waiter of idleWaiters.splice(0)) waiter();
    },
  });

  const mountOpts = {
    runtime: ctx.fabric.kernel.runtime,
    fabric: ctx.fabric,
    principal: ctx.principal,
    cwd: ctx.cwd,
    workspaceRoots: ctx.workspaceRoots,
    tenantId: ctx.tenantId,
    ensureSession: ctx.ensureSession,
  };

  const serverId = opts.serverId ?? 'syaocode';
  let close: () => Promise<void> = async () => {
    end();
  };

  try {
    if (protocol === 'mcp') {
      const factory = mod.createMcpServer as (o: Record<string, unknown>) => { close(): Promise<void> };
      const caps = await ctx.fabric.capabilities();
      const tools = caps
        .filter((c) => c.kind === 'tool')
        .map((c) => ({
          name: c.displayName,
          description: c.description ?? c.displayName,
          capabilityId: c.id,
        }));
      // The server edge advertises the capabilities the kernel already knows;
      // every tools/call funnels back through the dispatcher.
      const server = factory({
        runtime: mountOpts.runtime,
        channel,
        serverId,
        serverInfo: { name: 'syaocode', version: '0.3.0-dev' },
        tools,
        executor: mcpServerExecutor(mountOpts),
      });
      close = async () => {
        await server.close();
        end();
      };
    } else if (protocol === 'a2a') {
      const factory = mod.createA2aServer as (o: Record<string, unknown>) => { close(): Promise<void> };
      const cardMod = await loadProtocolModule('a2a');
      const buildAgentCard = cardMod?.buildAgentCard as ((o: Record<string, unknown>) => unknown) | undefined;
      if (typeof buildAgentCard !== 'function') return undefined;
      const card = buildAgentCard({
        name: 'syaocode',
        description: 'SYAOCode governance fabric',
        url: `http://127.0.0.1:${DEFAULT_PORTS.a2a}/`,
        version: '0.3.0-dev',
        capabilities: {},
        skills: [],
        tenantId: ctx.tenantId,
      });
      const server = factory({
        runtime: mountOpts.runtime,
        channel,
        agentId: serverId,
        card,
        onMessage: async (input: { message?: { parts?: unknown[] } }) => {
          // The A2A edge has no task runner wired in this build. The previous
          // implementation created an ARF task and immediately answered
          // TASK_STATE_COMPLETED without going through the dispatcher — it did
          // no work and still told the caller the work was done. Auditing
          // (05 §10.1 C-2) flagged that as fabricated success, which is exactly
          // what this design must never do, so the edge now refuses honestly.
          //
          // The ARF task IS created and recorded (so the request is visible and
          // auditable), then the call fails with an explicit unsupported
          // operation instead of a fake completion.
          const active = await ctx.ensureSession();
          const task = await ctx.fabric.tasks.create({ sessionId: active.id });
          await ctx.fabric.tasks.cancel(task.id, 'a2a task execution is not implemented in this build');
          void input;
          throw {
            code: -32004, // A2A UnsupportedOperationError
            message: A2A_EXECUTION_UNSUPPORTED_MESSAGE,
            data: { kind: 'unsupported_capability', taskId: task.id, registryCode: 'SY-SRV-004' },
          };
        },
      });
      close = async () => {
        await server.close();
        end();
      };
    } else {
      const factory = mod.createAcpEdge as (o: Record<string, unknown>) => {
        server: { close(): Promise<void> };
        adapter: unknown;
      };
      const gateway = {
        invoke: async (request: { capabilityId: string; input: unknown }) => {
          const active = await ctx.ensureSession();
          const result = await ctx.fabric.dispatcher.invoke(
            {
              principal: ctx.principal,
              capabilityId: request.capabilityId,
              input: request.input,
              protocol: 'acp',
              direction: 'reverse',
              sessionId: active.id,
            },
            { cwd: ctx.cwd, workspaceRoots: ctx.workspaceRoots },
          );
          return {
            outcome: result.outcome,
            ...(result.output !== undefined ? { output: result.output } : {}),
            ...(result.error !== undefined ? { error: result.error } : {}),
            ...(result.lossy !== undefined ? { lossy: result.lossy } : {}),
          };
        },
      };
      const edge = factory({
        runtime: mountOpts.runtime,
        channel,
        clientId: serverId,
        gateway,
        agentInfo: { name: 'syaocode', version: '0.3.0-dev' },
        // ACP is the editor edge: the turn runs through the governed agent
        // path, and the editor is the approval authority.
        ...(ctx.runTurn !== undefined ? { runTurn: ctx.runTurn } : {}),
      });
      close = async () => {
        await edge.server.close();
        end();
      };
    }
  } catch {
    end();
    return undefined;
  }

  return {
    close,
    /**
     * Feed one inbound chunk and wait until every request it carried has been
     * answered. The reply path is asynchronous (policy → approval → budget →
     * dispatch → receipt), so a fixed tick is not enough: we correlate on the
     * JSON-RPC id instead.
     */
    handle: async (chunk: string): Promise<string[]> => {
      const ids = messageIds(chunk);
      for (const id of ids) pendingIds.add(id);
      push(chunk);
      if (pendingIds.size > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            const i = idleWaiters.indexOf(waiter);
            if (i >= 0) idleWaiters.splice(i, 1);
            resolve();
          }, opts.timeoutMs ?? 60_000);
          const waiter = (): void => {
            clearTimeout(timer);
            resolve();
          };
          idleWaiters.push(waiter);
        });
      } else {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      return outbox.splice(0);
    },
  };
}

/**
 * Extract the JSON-RPC ids from a chunk of wire text.
 *
 * Handles both framings (`Content-Length` headers and newline-delimited JSON)
 * because the edge may be fed by a stdio peer or by an HTTP handler. Ids are
 * returned as strings so `1` and `"1"` correlate with the reply.
 */
export function messageIds(text: string): string[] {
  const out: string[] = [];
  for (const body of decodeFrames(text)) {
    try {
      const parsed = JSON.parse(body) as { id?: unknown };
      if (parsed.id !== undefined && parsed.id !== null) out.push(String(parsed.id));
    } catch {
      /* a partial frame: the protocol layer will deal with it */
    }
  }
  return out;
}

/** Test hook: the frame decoder is pure and worth asserting directly. */
export const decodeFramesForTest = (text: string): string[] => decodeFrames(text);

/** Decode one or more JSON bodies out of a raw wire chunk. */
function decodeFrames(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  for (;;) {
    const trimmed = rest.replace(/^[\s\u0000]+/, '');
    if (trimmed.length === 0) break;
    const headerEnd = trimmed.indexOf('\r\n\r\n');
    const lfEnd = trimmed.indexOf('\n\n');
    const looksFramed = /^[A-Za-z][A-Za-z0-9-]*\s*:/.test(trimmed.split(/\r?\n/, 1)[0] ?? '');
    if (looksFramed && (headerEnd !== -1 || lfEnd !== -1)) {
      const end = headerEnd !== -1 && (lfEnd === -1 || headerEnd <= lfEnd) ? headerEnd : lfEnd;
      const skip = end === headerEnd ? 4 : 2;
      const headers = trimmed.slice(0, end);
      const match = /content-length\s*:\s*(\d+)/i.exec(headers);
      if (match === null) {
        rest = trimmed.slice(end + skip);
        continue;
      }
      const length = Number(match[1]);
      const start = end + skip;
      if (trimmed.length < start + length) break;
      out.push(trimmed.slice(start, start + length));
      rest = trimmed.slice(start + length);
      continue;
    }
    const nl = trimmed.indexOf('\n');
    if (nl === -1) {
      out.push(trimmed);
      break;
    }
    const line = trimmed.slice(0, nl).trim();
    rest = trimmed.slice(nl + 1);
    if (line.length > 0) out.push(line);
  }
  return out;
}

/**
 * Actually listen. Returns the process exit code.
 *
 * Only `main.ts` should call this; the view tests use `servePlan()`.
 */
export async function runServe(
  plan: ServePlan,
  deps: { ctx: ServeFabricContext; io: ServeIo; token?: string; serverId?: string },
): Promise<number> {
  const { io, ctx } = deps;

  if (plan.errors.length > 0) {
    io.out(`${servePanel(plan).join('\n')}\n`);
    return 2; // EXIT.USAGE — the plan never reaches the kernel
  }

  const edgeAvailable = await probeProtocolEdge(plan.protocol);
  const effective: ServePlan = edgeAvailable ? plan : { ...plan, edgeUnavailable: true };

  if (plan.transport === 'stdio') {
    if (!edgeAvailable) {
      io.out(`${servePanel(effective).join('\n')}\n`);
      return 7; // EXIT.UNAVAILABLE — no edge to serve
    }
    // stdio: the protocol messages own stdout, so the panel goes to stderr.
    io.err(`${servePanel(effective, { listening: true, endpoints: effective.endpoints }).join('\n')}\n`);
    const edge = await mountServerEdge(plan.protocol, ctx, {
      serverId: deps.serverId ?? 'syaocode',
      transport: plan.transport,
    });
    if (edge === undefined) return 7;
    // Raw stdin chunks feed the edge verbatim: the framer in the protocol
    // layer owns Content-Length parsing, so the bytes must not be line-split.
    const pump = pumpStdin(edge, io.signal);
    await pump;
    await edge.close();
    return 0;
  }

  const server = await startHttpServer(effective, deps);
  if (server === undefined) return 7;

  const state: ServeState = {
    listening: true,
    endpoints: effective.endpoints,
    startedAt: new Date().toISOString(),
    detail: edgeAvailable ? t('serve.edgeReady') : t('serve.edgeDegraded'),
  };
  io.out(`${servePanel(effective, state).join('\n')}\n`);

  await waitForShutdown(server, io.signal);
  io.out(`${t('serve.stopped')}\n`);
  return 0;
}

async function startHttpServer(
  plan: ServePlan,
  deps: { ctx: ServeFabricContext; io: ServeIo; token?: string; serverId?: string },
): Promise<Server | undefined> {
  const edge = plan.edgeUnavailable
    ? undefined
    : await mountServerEdge(plan.protocol, deps.ctx, {
        serverId: deps.serverId ?? 'syaocode',
        bufferStdout: false,
        transport: plan.transport,
      });
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void handle(req, res);
  };

  /**
   * Fold the A2A HTTP headers into the JSON-RPC params metadata.
   *
   * Only for the A2A edge, only for a single request object: a batch or a
   * notification is passed through untouched.
   */
  function bridgeA2aHeaders(protocol: ServeProtocol, req: IncomingMessage, body: string): string {
    if (protocol !== 'a2a') return body;
    const version = headerValue(req, 'a2a-version');
    const tenant = headerValue(req, 'a2a-tenant');
    if (version === undefined && tenant === undefined) return body;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      return body;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return body;
    const message = parsed as { method?: unknown; params?: unknown };
    // Notifications carry no params we can annotate; leave them alone.
    if (typeof message.method !== 'string') return body;
    const params = (message.params ?? {}) as Record<string, unknown>;
    const metadata = { ...((params.metadata ?? {}) as Record<string, unknown>) };
    if (version !== undefined && metadata['A2A-Version'] === undefined) metadata['A2A-Version'] = version;
    if (tenant !== undefined && metadata['tenantId'] === undefined) metadata['tenantId'] = tenant;
    message.params = { ...params, metadata };
    return JSON.stringify(message);
  }

  function headerValue(req: IncomingMessage, name: string): string | undefined {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' && value !== '' ? value : undefined;
  }

  /**
   * The AgentCard this edge advertises, or undefined for non-A2A protocols.
   *
   * `supportedInterfaces[].url` points at the edge path so a client that
   * resolved the card knows exactly where to send `SendMessage`.
   */
  function agentCardFor(activePlan: ServePlan): Record<string, unknown> | undefined {
    if (activePlan.protocol !== 'a2a') return undefined;
    const base = `http://${activePlan.host}:${activePlan.port}`;
    return {
      name: 'syaocode',
      description: 'SYAOCode governance fabric (experimental preview)',
      version: '0.4.0-dev',
      supportedInterfaces: [
        {
          url: `${base}${EDGE_PATHS.a2a}`,
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
        },
      ],
      capabilities: { streaming: true, pushNotifications: false, extensions: [] },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      // The edge does not execute agent turns in this build, so it advertises
      // no skills rather than promising work it will refuse (see the A2A edge
      // note in mountServerEdge).
      skills: [],
      securitySchemes: {},
      securityRequirements: [],
      metadata: { tenantId: deps.ctx.tenantId, execution: 'not-implemented' },
    };
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString('utf8');
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    if (url === '/healthz') {
      const status = await deps.ctx.fabric.status();
      json(res, 200, {
        ok: true,
        protocol: plan.protocol,
        transport: 'http',
        edge: edge === undefined ? 'unavailable' : 'ready',
        tenantId: status.tenantId,
        capabilities: status.capabilityCount,
        pendingApprovals: status.pendingApprovals,
      });
      return;
    }
    // A2A discovery. Unauthenticated by design: the card is public metadata
    // (it carries no secret), and a client needs it to learn HOW to authenticate.
    if (url === AGENT_CARD_PATH) {
      const card = agentCardFor(plan);
      if (card === undefined) {
        json(res, 404, { error: { code: 'SY-SRV-004', message: 'this edge does not serve an agent card' } });
        return;
      }
      json(res, 200, card);
      return;
    }
    if (plan.tokenConfigured && deps.token !== undefined) {
      if (!tokenMatches(deps.token, req.headers.authorization)) {
        json(res, 401, { error: { code: 'SY-SRV-001', message: t('serve.unauthorized') } });
        return;
      }
    }
    if (url.startsWith(edgePath(plan.protocol))) {
      if (edge === undefined) {
        json(res, 503, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32601, message: t('serve.edgeUnavailable'), data: { registryCode: 'SY-SRV-004' } },
        });
        return;
      }
      const body = await readBody(req);
      let replies: string[];
      try {
        // A2A 1.0 carries the protocol version in the HTTP `A2A-Version` HEADER
        // (and the tenant may ride along), while the edge reads both from the
        // request's `metadata`. Without this bridge a compliant client's header
        // is ignored, the edge falls back to 0.3, and EVERY request from a real
        // A2A SDK is rejected as an unsupported version.
        const bridged = bridgeA2aHeaders(plan.protocol, req, body);
        replies = await edge.handle(bridged.endsWith('\n') ? bridged : `${bridged}\n`);
      } catch (e) {
        json(res, 500, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
        });
        return;
      }
      if (replies.length === 0) {
        // A notification has no reply; 202 Accepted is the JSON-RPC-over-HTTP
        // convention for "handled, nothing to return".
        res.writeHead(202, { 'content-length': '0' });
        res.end();
        return;
      }
      // One HTTP response carries exactly one JSON-RPC reply: strip the
      // newline framing a channel adds and return the bare JSON object.
      const text = replies.map((reply) => reply.trim()).filter((r) => r !== '').join('');
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
      });
      res.end(text);
      return;
    }
    json(res, 404, { error: { code: 'SY-CLI-001', message: t('serve.notFound', { path: url }) } });
  }

  try {
    return await new Promise<Server>((resolve, reject) => {
      const server = createServer(handler);
      server.once('error', reject);
      server.listen(plan.port, plan.host, () => {
        server.removeListener('error', reject);
        resolve(server);
      });
    });
  } catch (e) {
    deps.io.err(`${t('serve.bindFailed', { detail: e instanceof Error ? e.message : String(e) })}\n`);
    if (edge !== undefined) await edge.close();
    return undefined;
  }
}

function waitForShutdown(server: Server, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      server.close(() => resolve());
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        done();
        return;
      }
      signal.addEventListener('abort', done, { once: true });
    }
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

/**
 * stdio server loop: every chunk from the real stdin is handed to the edge,
 * which writes its reply straight to stdout. Resolves at EOF or on a signal.
 */
function pumpStdin(edge: MountedServerEdge, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const inFlight = new Set<Promise<void>>();
    const done = (): void => {
      if (settled) return;
      settled = true;
      stdin.off('data', onData);
      // Let every accepted request finish writing its reply before we close.
      void Promise.allSettled([...inFlight]).then(() => resolve());
    };
    const onData = (chunk: Buffer | string): void => {
      const task = edge
        .handle(Buffer.from(chunk as Buffer).toString('utf8'))
        .then(() => undefined)
        .catch(() => undefined);
      inFlight.add(task);
      void task.then(() => inFlight.delete(task));
    };
    stdin.on('data', onData);
    stdin.once('end', done);
    stdin.once('close', done);
    if (signal !== undefined) {
      if (signal.aborted) {
        done();
        return;
      }
      signal.addEventListener('abort', done, { once: true });
    }
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}
