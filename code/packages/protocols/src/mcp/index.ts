/**
 * `@syaocode/protocols/mcp` — the MCP 2026-07-28 edge.
 *
 * Two halves:
 *   - {@link createMcpAdapter} / {@link McpAdapter}: SYAOCode as an MCP *client*
 *     (discover + `tools/call` + MRTR), governed by the ARF dispatcher;
 *   - {@link createMcpServer} / {@link McpServer}: SYAOCode as an MCP *server*
 *     (modern era, `resultType`, MRTR, legacy `initialize` fallback).
 *
 * Both halves talk to the governance kernel through injected callbacks
 * ({@link McpToolExecutor}, `AdapterContext.approval`) and never touch a `Tool`
 * directly (03 §7.3 boundary rule).
 */

export {
  MCP_LOSSY,
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_CLIENT_INFO,
  MCP_META_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  buildMcpMeta,
  declaredRiskFromAnnotations,
  mcpKindOf,
  mcpPromptCapability,
  mcpResourceCapability,
  mcpToolCapability,
  readMcpMetaVersion,
} from './mapping.js';
export type {
  McpClientInfo,
  McpContentBlock,
  McpDiscoverResult,
  McpInputRequest,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpResultType,
  McpTaskState,
  McpToolAnnotations,
  McpToolDescriptor,
  McpToolResult,
} from './mapping.js';

export {
  MCP_ERROR_CODES,
  MCP_INPUT_REQUIRED,
  MCP_PROTOCOL,
  MCP_REQUEST_STATE_INVALID,
  MCP_VERSION_NEGOTIATION_FAILED,
  mcpError,
  mcpErrorShape,
  mcpRequestStateInvalid,
  mcpToolError,
  mcpUnsupported,
  mcpVersionMismatch,
} from './errors.js';

export { MrtrCustodian, buildInputResponses, optionsFromInputRequest, subjectFromInputRequest } from './mrtr.js';
export type { MrtrRetry, MrtrState } from './mrtr.js';

export {
  MCP_METHODS,
  MCP_NOTIFICATIONS,
  McpAdapter,
  McpClient,
  capabilityName,
  inputResponsesFromOutcome,
  planForInputRequests,
  stableKey,
} from './client.js';
export type { McpAdapterOptions, McpCallOptions, McpCallOutcome, McpClientOptions, McpEra, MrtrApprovalPlan } from './client.js';

export {
  MCP_SERVER_METHODS,
  McpServer,
  defineMcpTool,
  isInputRequiredSignal,
  mcpMetaBuilder,
  mcpServerToolName,
  requiresInput,
} from './server.js';
export type {
  McpInputRequiredSignal,
  McpServerOptions,
  McpServerPrompt,
  McpServerResource,
  McpServerTool,
  McpToolExecutor,
} from './server.js';

export { createHttpChannel, createLoopbackPair, createStdioChannel } from '../shared/transport.js';
export type { DuplexChannel, StdioChannelOptions } from '../shared/transport.js';

import type { Logger, Runtime } from '@syaocode/core';
import type { DuplexChannel } from '../shared/transport.js';
import { createHttpChannel, createStdioChannel } from '../shared/transport.js';
import { McpAdapter, type McpAdapterOptions } from './client.js';
import { McpServer, type McpServerOptions } from './server.js';

/** Create the MCP client edge as a `ProtocolAdapter`. */
export function createMcpAdapter(options: McpAdapterOptions): McpAdapter {
  return new McpAdapter(options);
}

/** Alias used by the CLI and the docs (03 §3.3 spells it `mcpAdapter()`). */
export const mcpAdapter = createMcpAdapter;

/** Create the MCP server edge (expose SYAOCode's capabilities to hosts). */
export function createMcpServer(options: McpServerOptions): McpServer {
  return new McpServer(options);
}

export interface McpStdioEdgeOptions {
  runtime: Runtime;
  serverId: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  logger?: Logger;
  clientInfo?: { name: string; version: string };
  clientCapabilities?: Record<string, unknown>;
  requestTimeoutMs?: number;
  allowLegacyFallback?: boolean;
}

/**
 * Convenience factory: spawn a stdio MCP server through `Runtime.shell` and
 * wrap it as a governed adapter. The CLI's `syao mcp` command uses this.
 */
export function createStdioMcpAdapter(options: McpStdioEdgeOptions): McpAdapter {
  const spawnOptions: { cwd?: string; env?: Record<string, string> } = {};
  if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
  if (options.env !== undefined) spawnOptions.env = options.env;
  const { channel } = createStdioChannel(options.runtime, options.command, options.args ?? [], {
    ...spawnOptions,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  return new McpAdapter({
    runtime: options.runtime,
    channel,
    serverId: options.serverId,
    ...(options.clientInfo !== undefined ? { clientInfo: options.clientInfo } : {}),
    ...(options.clientCapabilities !== undefined ? { clientCapabilities: options.clientCapabilities } : {}),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(options.allowLegacyFallback !== undefined ? { allowLegacyFallback: options.allowLegacyFallback } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}

export interface McpHttpEdgeOptions {
  runtime: Runtime;
  serverId: string;
  url: string;
  headers?: Record<string, string>;
  logger?: Logger;
  requestTimeoutMs?: number;
  clientInfo?: { name: string; version: string };
  clientCapabilities?: Record<string, unknown>;
}

/** Convenience factory: a Streamable-HTTP MCP edge (01 §2.1 transport rule). */
export function createHttpMcpAdapter(options: McpHttpEdgeOptions): McpAdapter {
  const channel: DuplexChannel = createHttpChannel(options.runtime, options.url, {
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    label: `mcp-http:${options.url}`,
  });
  return new McpAdapter({
    runtime: options.runtime,
    channel,
    serverId: options.serverId,
    ...(options.clientInfo !== undefined ? { clientInfo: options.clientInfo } : {}),
    ...(options.clientCapabilities !== undefined ? { clientCapabilities: options.clientCapabilities } : {}),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}
