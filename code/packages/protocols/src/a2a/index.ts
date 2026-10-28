/**
 * `@syaocode/protocols/a2a` — the A2A 1.0.0 edge.
 *
 * Two halves:
 *   - {@link createA2aAdapter} / {@link A2aAdapter}: SYAOCode as an A2A *client*
 *     (PascalCase methods, opaque remote task mapping, cancel propagation);
 *   - {@link createA2aServer} / {@link A2aServer}: SYAOCode as an A2A *agent*
 *     (AgentCard, tenant filtering on every read, cursor pagination).
 */

export {
  A2A_LOSSY,
  A2A_VISIBILITY,
  a2aArtifactToRef,
  a2aArtifactsToRefs,
  a2aStateToTaskState,
  artifactRefToA2a,
  inputBlocksToMessage,
  inputToMessage,
  isA2aTerminal,
  messageText,
  messageToInputBlocks,
  taskStateToA2a,
  taskToA2a,
} from './artifacts.js';
export type {
  A2aArtifact,
  A2aErrorShape,
  A2aFilePart,
  A2aMessage,
  A2aPart,
  A2aRole,
  A2aStreamEvent,
  A2aTask,
  A2aTaskArtifactUpdateEvent,
  A2aTaskStatus,
  A2aTaskStatusUpdateEvent,
} from './artifacts.js';

export {
  A2A_ERROR_CODES,
  A2A_PUSH_NOT_SUPPORTED,
  A2A_TASK_NOT_CANCELABLE,
  A2A_TASK_NOT_FOUND,
  A2A_UNSUPPORTED_OPERATION,
  A2A_VERSION_NOT_SUPPORTED,
  a2aCodeFor,
  a2aError,
  a2aErrorShape,
  a2aPushUnsupported,
  a2aTaskNotCancelable,
  a2aTaskNotFound,
  a2aUnsupportedOperation,
  a2aVersionNotSupported,
  canonicalToA2aError,
} from './errors.js';

export {
  agentCardCapabilities,
  agentCardVersion,
  buildAgentCard,
  parseAgentCard,
} from './card.js';
export type {
  A2aAgentCapabilities,
  A2aAgentCard,
  A2aAgentExtension,
  A2aAgentInterface,
  A2aAgentSkill,
  A2aSecurityScheme,
  BuildAgentCardInput,
} from './card.js';

export {
  A2A_METHODS,
  A2A_VERSION,
  A2aAdapter,
  A2aClient,
  discoverFromCard,
} from './client.js';
export type { A2aAdapterOptions, A2aCallOptions, A2aClientOptions, A2aListResult, A2aSendResult } from './client.js';

export {
  A2A_SERVER_METHODS,
  A2aServer,
  MemoryA2aTaskStore,
} from './server.js';
export type { A2aCallerContext, A2aSendInput, A2aServerOptions, A2aTaskStore } from './server.js';

import type { Logger, Runtime } from '@syaocode/core';
import type { DuplexChannel } from '../shared/transport.js';
import { createHttpChannel, createSseChannel } from '../shared/transport.js';
import { A2aAdapter, type A2aAdapterOptions } from './client.js';
import { A2aServer, type A2aServerOptions } from './server.js';
import type { A2aAgentCard } from './card.js';

/** Create the A2A client edge as a `ProtocolAdapter`. */
export function createA2aAdapter(options: A2aAdapterOptions): A2aAdapter {
  return new A2aAdapter(options);
}

/** Alias used by the CLI and the docs. */
export const a2aAdapter = createA2aAdapter;

/** Create the A2A agent edge. */
export function createA2aServer(options: A2aServerOptions): A2aServer {
  return new A2aServer(options);
}

export interface A2aHttpEdgeOptions {
  runtime: Runtime;
  agentId: string;
  tenantId: string;
  /** A2A JSON-RPC endpoint, e.g. `http://127.0.0.1:8931/`. */
  url: string;
  headers?: Record<string, string>;
  version?: string;
  logger?: Logger;
  requestTimeoutMs?: number;
  lossy?: string[];
}

/**
 * Convenience factory: an HTTP-bound A2A edge. The `A2A-Version` query
 * parameter is appended so intermediaries see the pin as well (01 §2.2).
 */
export function createHttpA2aAdapter(options: A2aHttpEdgeOptions): A2aAdapter {
  const version = options.version ?? '1.0';
  const channel: DuplexChannel = createHttpChannel(options.runtime, options.url, {
    query: { 'A2A-Version': version },
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    label: `a2a-http:${options.url}`,
  });
  return new A2aAdapter({
    runtime: options.runtime,
    channel,
    agentId: options.agentId,
    tenantId: options.tenantId,
    version,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(options.lossy !== undefined ? { lossy: options.lossy } : {}),
  });
}

/** Open an SSE subscription channel for `SubscribeToTask` (A2A streaming). */
export function createA2aSubscriptionChannel(options: {
  runtime: Runtime;
  url: string;
  headers?: Record<string, string>;
  logger?: Logger;
}): DuplexChannel {
  return createSseChannel(options.runtime, options.url, {
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    label: `a2a-sse:${options.url}`,
  });
}

export type { Logger };
