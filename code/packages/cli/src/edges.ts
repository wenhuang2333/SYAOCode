/**
 * Mounting real protocol edges on the CLI's fabric.
 *
 * `@syaocode/protocols` is imported LAZILY (dynamic `import()` inside
 * try/catch): the CLI must keep working in a build where the protocol package
 * is absent or half-finished, degrading with a sentence instead of a stack
 * trace. Everything that is not protocol-specific lives here, so the rest of
 * the CLI never touches a wire format.
 *
 * Two directions:
 *
 *   client edge (`/peer add`, `syao mcp add`) — SYAOCode calls a remote MCP
 *     server / A2A agent. The registry entry becomes a mounted adapter, so
 *     `fabric.call('mcp://<id>/tool/<name>')` reaches the peer through the
 *     ten-step pipeline.
 *
 *   server edge (`syao serve`) — a remote client calls SYAOCode. The server's
 *     executor / gateway funnels the inbound request back into
 *     `fabric.dispatcher.invoke`, so an inbound call is governed exactly like
 *     an outbound one.
 */

import type { Runtime } from '@syaocode/core';
import {
  CanonicalError,
  type Capability,
  type Fabric,
  type InvokeResult,
  type Principal,
  type ProtocolAdapter,
} from '@syaocode/rpc';
import { t } from './i18n/index.js';
import type { PeerConfig } from './peers.js';

/** Result of an attempt to mount one edge. */
export interface MountOutcome {
  ok: boolean;
  providerId: string;
  /** Capabilities the edge contributed (empty when the mount failed). */
  capabilities: number;
  /** Why the mount failed (already localized). */
  reason?: string;
  /** Set when the protocol package is not available in this build. */
  edgeUnavailable?: boolean;
  /** The mounted adapter (kept so the caller can close it). */
  adapter?: ProtocolAdapter;
}

export interface MountOptions {
  runtime: Runtime;
  fabric: Fabric;
  /** The principal the inbound/outbound call runs as. */
  principal: Principal;
  cwd: string;
  workspaceRoots: string[];
  /** Tenant that owns the edge. */
  tenantId: string;
  /** Token value for HTTP edges (never logged, never persisted). */
  token?: string;
  /**
   * Called before an inbound governed invocation so the session (and its
   * budget account) exists. Inbound requests arrive before any CLI call.
   */
  ensureSession?: () => Promise<{ id: string; budgetId: string }>;
}

/**
 * Lazily load a protocol module.
 *
 * Returns undefined when the package is missing or fails to load — the caller
 * degrades to "protocol edge not available in this build".
 */
export async function loadProtocolModule(subpath: 'mcp' | 'a2a' | 'acp' | 'shared'): Promise<Record<string, unknown> | undefined> {
  const specifier = `@syaocode/protocols/${subpath}`;
  try {
    return (await import(/* @vite-ignore */ specifier)) as unknown as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** True when the protocol package is loadable in this build. */
export async function protocolsAvailable(): Promise<boolean> {
  return (await loadProtocolModule('mcp')) !== undefined;
}

/** Split a command line into argv, honouring simple quoting. */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (started || current !== '') {
        out.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
  }
  if (started || current !== '') out.push(current);
  return out;
}

/**
 * Mount a *client* edge for a registered peer.
 *
 * `mcp` peers are stdio servers (a command line); `a2a` peers are HTTP agent
 * cards; `acp` peers are stdio clients that reverse-call into SYAOCode.
 */
export async function mountPeerEdge(peer: PeerConfig, id: string, opts: MountOptions): Promise<MountOutcome> {
  switch (peer.protocol) {
    case 'mcp':
      return mountMcpClientEdge(peer, id, opts);
    case 'a2a':
      return mountA2aClientEdge(peer, id, opts);
    case 'acp':
      return mountAcpClientEdge(peer, id, opts);
  }
}

/** MCP client edge: SYAOCode → a remote MCP server over stdio. */
export async function mountMcpClientEdge(peer: PeerConfig, id: string, opts: MountOptions): Promise<MountOutcome> {
  const mod = await loadProtocolModule('mcp');
  if (mod === undefined) {
    return { ok: false, providerId: id, capabilities: 0, reason: t('rpc.peer.edgeUnavailable'), edgeUnavailable: true };
  }
  const argv = splitCommand(peer.target);
  const command = argv[0];
  if (command === undefined) {
    return { ok: false, providerId: id, capabilities: 0, reason: t('rpc.peer.badCommand') };
  }
  // One stdio path for every host: the factory goes through Runtime.shell and
  // `createStdioChannel`, which reads the raw byte stream so Content-Length
  // framing survives. The CLI never opens a pipe itself.
  const factory = mod.createStdioMcpAdapter as ((o: Record<string, unknown>) => ProtocolAdapter) | undefined;
  if (typeof factory !== 'function') {
    return { ok: false, providerId: id, capabilities: 0, reason: t('rpc.peer.edgeUnavailable'), edgeUnavailable: true };
  }
  try {
    const adapter = factory({
      runtime: opts.runtime,
      serverId: id,
      command,
      args: argv.slice(1),
      cwd: opts.cwd,
      clientInfo: { name: 'syaocode', version: '0.3.0-dev' },
    });
    await opts.fabric.mount(adapter, { providerId: id, endpoint: `mcp://${id}` });
    const caps = await opts.fabric.discover();
    return {
      ok: true,
      providerId: id,
      capabilities: caps.filter((c) => c.provider.id === id).length,
      adapter,
    };
  } catch (e) {
    return {
      ok: false,
      providerId: id,
      capabilities: 0,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

/** A2A client edge: SYAOCode → a remote agent card over HTTP. */
export async function mountA2aClientEdge(peer: PeerConfig, id: string, opts: MountOptions): Promise<MountOutcome> {
  const mod = await loadProtocolModule('a2a');
  if (mod === undefined) {
    return { ok: false, providerId: id, capabilities: 0, reason: t('rpc.peer.edgeUnavailable'), edgeUnavailable: true };
  }
  const factory = mod.createHttpA2aAdapter as ((o: Record<string, unknown>) => ProtocolAdapter) | undefined;
  if (typeof factory !== 'function') {
    return { ok: false, providerId: id, capabilities: 0, reason: t('rpc.peer.edgeUnavailable'), edgeUnavailable: true };
  }
  try {
    const adapter = factory({
      runtime: opts.runtime,
      agentId: id,
      tenantId: opts.tenantId,
      url: peer.target,
      ...(opts.token !== undefined ? { headers: { authorization: `Bearer ${opts.token}` } } : {}),
    });
    await opts.fabric.mount(adapter, { providerId: id, endpoint: peer.target });
    const caps = await opts.fabric.discover();
    return {
      ok: true,
      providerId: id,
      capabilities: caps.filter((c) => c.provider.id === id).length,
      adapter,
    };
  } catch (e) {
    return { ok: false, providerId: id, capabilities: 0, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** ACP client edge: a stdio editor that reverse-calls into SYAOCode. */
export async function mountAcpClientEdge(peer: PeerConfig, id: string, opts: MountOptions): Promise<MountOutcome> {
  const mod = await loadProtocolModule('acp');
  if (mod === undefined) {
    return { ok: false, providerId: id, capabilities: 0, reason: t('rpc.peer.edgeUnavailable'), edgeUnavailable: true };
  }
  const factory = mod.createStdioAcpEdge as ((o: Record<string, unknown>) => unknown) | undefined;
  if (typeof factory !== 'function') {
    return { ok: false, providerId: id, capabilities: 0, reason: t('rpc.peer.edgeUnavailable'), edgeUnavailable: true };
  }
  const argv = splitCommand(peer.target);
  const command = argv[0];
  if (command === undefined) {
    return { ok: false, providerId: id, capabilities: 0, reason: t('rpc.peer.badCommand') };
  }
  try {
    const edge = factory({
      runtime: opts.runtime,
      command,
      args: argv.slice(1),
      cwd: opts.cwd,
      clientId: id,
      agentInfo: { name: 'syaocode', version: '0.3.0-dev' },
      gateway: reverseGateway(opts),
    }) as { adapter?: ProtocolAdapter } | undefined;
    if (edge?.adapter === undefined) {
      return { ok: false, providerId: id, capabilities: 0, reason: t('rpc.peer.edgeUnavailable') };
    }
    await opts.fabric.mount(edge.adapter, { providerId: id, endpoint: `acp://${id}` });
    return { ok: true, providerId: id, capabilities: 0, adapter: edge.adapter };
  } catch (e) {
    return { ok: false, providerId: id, capabilities: 0, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The reverse-call gateway: an ACP/host-initiated call that must be governed
 * exactly like an outbound one.
 */
export function reverseGateway(opts: MountOptions): {
  invoke(request: { capabilityId: string; input: unknown; taskId?: string; sessionId?: string }): Promise<{
    outcome: InvokeResult['outcome'];
    output?: unknown;
    error?: unknown;
    lossy?: string[];
  }>;
} {
  return {
    async invoke(request) {
      const result = await invokeGoverned(opts, {
        capabilityId: request.capabilityId,
        input: request.input,
        direction: 'reverse',
        ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
        ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      });
      return {
        outcome: result.outcome,
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.lossy !== undefined ? { lossy: result.lossy } : {}),
      };
    },
  };
}

/** One governed invocation over the dispatcher (the only path to a side effect). */
async function invokeGoverned(
  opts: MountOptions,
  input: {
    capabilityId: string;
    input: unknown;
    direction: 'inbound' | 'outbound' | 'reverse';
    taskId?: string;
    sessionId?: string;
  },
): Promise<InvokeResult> {
  // The budget account hangs off the session: create it before the first
  // inbound call or the reservation step fails.
  const sessionId =
    input.sessionId ?? (opts.ensureSession !== undefined ? (await opts.ensureSession()).id : undefined);
  return opts.fabric.dispatcher.invoke(
    {
      principal: opts.principal,
      capabilityId: input.capabilityId,
      input: input.input,
      protocol: 'native',
      direction: input.direction,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    },
    {
      cwd: opts.cwd,
      workspaceRoots: opts.workspaceRoots,
    },
  );
}

/**
 * The MCP *server* executor: an inbound `tools/call` becomes a governed
 * invocation through the dispatcher.
 */
export function mcpServerExecutor(opts: MountOptions): {
  execute(request: {
    capabilityId: string;
    toolName: string;
    input: unknown;
    correlationId: string;
  }): Promise<{ outcome: string; output?: unknown; error?: unknown; lossy?: string[] }>;
} {
  return {
    async execute(request) {
      try {
        const result = await invokeGoverned(opts, {
          capabilityId: request.capabilityId,
          input: request.input,
          direction: 'inbound',
        });
        return {
          outcome: result.outcome,
          ...(result.output !== undefined ? { output: result.output } : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
          ...(result.lossy !== undefined ? { lossy: result.lossy } : {}),
        };
      } catch (e) {
        throw CanonicalError.is(e) ? e : new CanonicalError({ kind: 'internal', message: e instanceof Error ? e.message : String(e) });
      }
    },
  };
}

/** Capability ids of one provider (used by the peers/tools panels). */
export async function capabilitiesOfProvider(fabric: Fabric, providerId: string): Promise<Capability[]> {
  const caps = await fabric.capabilities();
  return caps.filter((c) => c.provider.id === providerId);
}
