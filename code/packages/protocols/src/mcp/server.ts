/**
 * MCP server — expose SYAOCode as a modern (2026-07-28) MCP capability endpoint.
 *
 * Server-side rules from 01 §2.1 that this file enforces:
 *   - **never initiate a request**: a need for input is expressed by returning
 *     `resultType: "input_required"` with an opaque `requestState` (MRTR);
 *   - the retry MUST echo `requestState` **verbatim**; a missing, unknown, or
 *     already-consumed state fails closed with `-32021`;
 *   - every tool invocation goes through the injected {@link McpToolExecutor}
 *     (the governance dispatcher). The server itself never executes a tool and
 *     never inspects a `Tool` object (03 §7.3 boundary rule);
 *   - `ToolAnnotations` are re-published as untrusted hints only.
 */

import type { Logger, Runtime } from '@syaocode/core';
import { mcpCapabilityId, mcpToolName, type CanonicalErrorShape, type InvokeResultPayload } from '@syaocode/rpc';
import { AdapterBase, mergeLossy, type DuplexChannel } from '../shared/index.js';
import { NO_RESPONSE, JsonRpcConnection, type JsonRpcId, type JsonRpcHandlerResult } from '../shared/jsonrpc.js';
import { MCP_ERROR_CODES, mcpError } from './errors.js';
import { checkMcpHttpHeaders, type McpHttpHeaderCheck } from './http.js';
import {
  MCP_LOSSY,
  MCP_PROTOCOL_VERSION,
  buildMcpMeta,
  mcpPromptCapability,
  mcpResourceCapability,
  mcpToolCapability,
  readMcpMetaVersion,
  type McpInputRequest,
  type McpPromptDescriptor,
  type McpResourceDescriptor,
  type McpToolAnnotations,
  type McpToolDescriptor,
  type McpToolResult,
} from './mapping.js';

export const MCP_SERVER_METHODS = ['server/discover', 'tools/list', 'tools/call', 'initialize'] as const;

/** A tool the server publishes. `capabilityId` is registry-assigned. */
export interface McpServerTool extends McpToolDescriptor {
  capabilityId?: string;
}

export interface McpServerResource extends McpResourceDescriptor {
  capabilityId?: string;
}

export interface McpServerPrompt extends McpPromptDescriptor {
  capabilityId?: string;
}

/** The server needs more input before it can complete the call (MRTR). */
export interface McpInputRequiredSignal {
  kind: 'input_required';
  inputRequests: McpInputRequest[];
}

/** Builder for the MRTR signal returned by a tool executor. */
export function requiresInput(inputRequests: McpInputRequest[]): McpInputRequiredSignal {
  return { kind: 'input_required', inputRequests };
}

export function isInputRequiredSignal(value: unknown): value is McpInputRequiredSignal {
  return value !== null && typeof value === 'object' && (value as { kind?: unknown }).kind === 'input_required';
}

/**
 * The governance entry point for server-side calls. The host implements this
 * over `Dispatcher.invoke`; the server only forwards, it never authorizes.
 */
export interface McpToolExecutor {
  execute(request: {
    capabilityId: string;
    toolName: string;
    input: unknown;
    requestState?: string;
    inputResponses?: Record<string, unknown>;
    correlationId: string;
  }): Promise<InvokeResultPayload | McpInputRequiredSignal>;
}

export interface McpServerOptions {
  runtime: Runtime;
  channel: DuplexChannel;
  /** Registry-assigned server id (never the peer's self-description). */
  serverId: string;
  serverInfo?: { name: string; version: string };
  tools?: McpServerTool[];
  resources?: McpServerResource[];
  prompts?: McpServerPrompt[];
  executor: McpToolExecutor;
  /** Advertised protocol versions (defaults to [2026-07-28]). */
  supportedVersions?: string[];
  /** Discovery cache hints (01 §2.1). */
  ttlMs?: number;
  cacheScope?: string;
  /** Serve the legacy `initialize` handshake for old clients. */
  allowLegacyClients?: boolean;
  /** Extra declared capabilities (resources/prompts/elicitation/tasks…). */
  capabilities?: Record<string, unknown>;
  logger?: Logger;
}

interface PendingInput {
  toolName: string;
  input: unknown;
  inputRequests: McpInputRequest[];
  consumed: boolean;
}

export class McpServer extends AdapterBase {
  private readonly connection: JsonRpcConnection;
  private readonly options: McpServerOptions;
  private readonly pending = new Map<string, PendingInput>();
  private readonly tools: Map<string, McpServerTool>;

  constructor(options: McpServerOptions) {
    super('mcp', MCP_PROTOCOL_VERSION, options.runtime, options.logger);
    this.options = options;
    this.tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
    this.connection = new JsonRpcConnection({
      channel: options.channel,
      framing: 'auto',
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      handlers: {
        request: (method, params, ctx) => this.handleRequest(method, params, ctx.id),
        notification: (method, params) => this.handleNotification(method, params),
      },
    });
    this.connection.start();
  }

  get serverId(): string {
    return this.options.serverId;
  }

  /** Wire method table (pinned by `shared/drift.ts`). */
  static readonly methods: readonly string[] = MCP_SERVER_METHODS;

  override async close(): Promise<void> {
    await this.connection.close('server-close');
    await super.close();
  }

  // ── request routing ─────────────────────────────────────────────────────

  private async handleRequest(method: string, params: unknown, id: JsonRpcId): Promise<JsonRpcHandlerResult> {
    void id;
    const meta = (params as { _meta?: unknown } | null)?._meta;
    const version = readMcpMetaVersion(meta);
    if (version !== undefined && !this.supportedVersions().includes(version)) {
      throw { code: MCP_ERROR_CODES.versionNegotiationFailed, message: `unsupported protocolVersion ${version}`, data: { supported: this.supportedVersions() } };
    }
    switch (method) {
      case 'server/discover':
        return this.discoverResult();
      case 'tools/list':
        return {
          resultType: 'complete',
          ...this.cacheHint(),
          tools: [...this.tools.values()].map((tool) => this.publishedTool(tool)),
        };
      case 'tools/call':
        return this.callTool(params, id);
      case 'resources/list':
        return { resultType: 'complete', ...this.cacheHint(), resources: this.options.resources ?? [] };
      case 'resources/read':
        return this.readResource(params);
      case 'prompts/list':
        return { resultType: 'complete', ...this.cacheHint(), prompts: this.options.prompts ?? [] };
      case 'prompts/get':
        return this.getPrompt(params);
      case 'tasks/get':
      case 'tasks/update':
        throw { code: MCP_ERROR_CODES.invalidRequest, message: `the tasks extension is not enabled on this server (${method})` };
      case 'tasks/cancel':
        throw { code: MCP_ERROR_CODES.invalidRequest, message: 'the tasks extension is not enabled on this server' };
      case 'initialize':
        if (this.options.allowLegacyClients !== true) {
          throw { code: MCP_ERROR_CODES.methodNotFound, message: 'initialize was removed in MCP 2026-07-28' };
        }
        return this.legacyInitializeResult();
      default:
        throw { code: MCP_ERROR_CODES.methodNotFound, message: `method not found: ${method}` };
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'notifications/cancelled') {
      const requestId = (params as { requestId?: unknown } | null)?.requestId;
      this.logger?.log('debug', 'mcp cancel received', { requestId: String(requestId) });
    }
  }

  private supportedVersions(): string[] {
    return this.options.supportedVersions ?? [MCP_PROTOCOL_VERSION];
  }

  /**
   * Cache hints (MCP 2026-07-28). Every list result must carry them: a modern
   * client validates the fields and refuses a result without `ttlMs`.
   */
  private cacheHint(): { ttlMs: number; cacheScope: string } {
    return {
      ttlMs: this.options.ttlMs ?? 300_000,
      cacheScope: this.options.cacheScope ?? 'private',
    };
  }

  private discoverResult(): Record<string, unknown> {
    const capabilities: Record<string, unknown> = {
      tools: { listChanged: false },
      ...(this.options.resources !== undefined ? { resources: { listChanged: false } } : {}),
      ...(this.options.prompts !== undefined ? { prompts: { listChanged: false } } : {}),
      ...(this.options.capabilities ?? {}),
    };
    return {
      supportedVersions: this.supportedVersions(),
      capabilities,
      ttlMs: this.options.ttlMs ?? 300_000,
      cacheScope: this.options.cacheScope ?? 'private',
      serverInfo: this.options.serverInfo ?? { name: 'syaocode', version: '0.3.0-dev' },
    };
  }

  private legacyInitializeResult(): Record<string, unknown> {
    return {
      protocolVersion: this.supportedVersions()[0] ?? MCP_PROTOCOL_VERSION,
      capabilities: this.discoverResult()['capabilities'],
      serverInfo: this.options.serverInfo ?? { name: 'syaocode', version: '0.3.0-dev' },
    };
  }

  private publishedTool(tool: McpServerTool): McpToolDescriptor {
    return {
      name: tool.name,
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      // MCP 2026-07-28 requires an inputSchema on every published tool, so a
      // tool that declares none gets the permissive object schema rather than
      // being published without the field (which a modern client rejects).
      inputSchema: tool.inputSchema ?? { type: 'object' },
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    };
  }

  // ── tools/call (MRTR) ───────────────────────────────────────────────────

  private async callTool(params: unknown, id: JsonRpcId): Promise<JsonRpcHandlerResult> {
    void id;
    const record = (params ?? {}) as Record<string, unknown>;
    const name = record.name;
    if (typeof name !== 'string') throw { code: MCP_ERROR_CODES.invalidParams, message: 'tools/call requires a string name' };
    const tool = this.tools.get(name);
    if (tool === undefined) throw { code: MCP_ERROR_CODES.invalidParams, message: `unknown tool: ${name}` };
    const requestState = typeof record.requestState === 'string' ? record.requestState : undefined;
    const inputResponses = isRecord(record.inputResponses) ? record.inputResponses : undefined;

    let retryState: string | undefined;
    if (requestState !== undefined) {
      retryState = this.consumeRequestState(requestState, name);
    }

    const result = await this.options.executor.execute({
      capabilityId: tool.capabilityId ?? mcpCapabilityId(this.options.serverId, 'tool', name),
      toolName: name,
      input: record.arguments ?? {},
      correlationId: this.runtime.ids.next('mcp'),
      ...(retryState !== undefined ? { requestState: retryState } : {}),
      ...(inputResponses !== undefined ? { inputResponses } : {}),
    });

    if (isInputRequiredSignal(result)) {
      const issued = this.issueRequestState(name, record.arguments ?? {}, result.inputRequests);
      const payload: McpToolResult = {
        resultType: 'input_required',
        requestState: issued,
        inputRequests: result.inputRequests,
      };
      return payload;
    }
    return this.toToolResult(result);
  }

  private toToolResult(payload: InvokeResultPayload): McpToolResult {
    switch (payload.outcome) {
      case 'succeeded': {
        const output = payload.output;
        const content = contentBlocksOf(output);
        const result: McpToolResult = {
          resultType: 'complete',
          content,
          ...(output !== undefined ? { structuredContent: output } : {}),
        };
        return result;
      }
      case 'failed':
      case 'cancelled':
      case 'timed_out':
      case 'indeterminate':
        return {
          resultType: 'complete',
          isError: true,
          content: [{ type: 'text', text: errorText(payload.error, payload.outcome) }],
          ...(payload.error !== undefined ? { structuredContent: { error: payload.error } } : {}),
        };
      default:
        return { resultType: 'complete', isError: true, content: [{ type: 'text', text: `unexpected outcome` }] };
    }
  }

  // ── requestState custody (fail closed, -32021) ──────────────────────────

  /** Mint an opaque state token bound to the pending call. */
  private issueRequestState(toolName: string, input: unknown, inputRequests: McpInputRequest[]): string {
    const token = this.runtime.ids.next('mrtr');
    this.pending.set(token, { toolName, input, inputRequests, consumed: false });
    return token;
  }

  /** Validate a retry's echoed token: known, matching, unused. Throws -32021. */
  private consumeRequestState(token: string, toolName: string): string {
    const record = this.pending.get(token);
    if (record === undefined) {
      throw { code: MCP_ERROR_CODES.requestStateInvalid, message: 'requestState was not issued by this server', data: { tool: toolName } };
    }
    if (record.toolName !== toolName) {
      throw { code: MCP_ERROR_CODES.requestStateInvalid, message: 'requestState belongs to a different tool', data: { tool: toolName } };
    }
    if (record.consumed) {
      throw { code: MCP_ERROR_CODES.requestStateInvalid, message: 'requestState was already consumed', data: { tool: toolName } };
    }
    record.consumed = true;
    return token;
  }

  /**
   * Validate the mandatory Streamable-HTTP headers of an inbound request.
   *
   * A host that serves this server over HTTP MUST call this before handing the
   * body to the connection: a mismatch is HTTP 400 + JSON-RPC -32020
   * (HeaderMismatch, 04 M13/M18) and never reaches a tool handler.
   */
  checkHttpRequest(headers: Record<string, string>, body: string): McpHttpHeaderCheck {
    return checkMcpHttpHeaders(headers, body, { protocolVersion: this.supportedVersions()[0] ?? MCP_PROTOCOL_VERSION });
  }

  /** Number of outstanding MRTR states (test/diagnostic hook). */
  get pendingInputCount(): number {
    let count = 0;
    for (const record of this.pending.values()) if (!record.consumed) count += 1;
    return count;
  }

  // ── resources / prompts ─────────────────────────────────────────────────

  private async readResource(params: unknown): Promise<Record<string, unknown>> {
    const uri = (params as { uri?: unknown } | null)?.uri;
    if (typeof uri !== 'string') throw { code: MCP_ERROR_CODES.invalidParams, message: 'resources/read requires a uri' };
    const resource = (this.options.resources ?? []).find((entry) => entry.uri === uri);
    if (resource === undefined) throw { code: MCP_ERROR_CODES.invalidParams, message: `unknown resource: ${uri}` };
    const payload = await this.options.executor.execute({
      capabilityId: resource.capabilityId ?? mcpCapabilityId(this.options.serverId, 'resource', uri),
      toolName: uri,
      input: { uri },
      correlationId: this.runtime.ids.next('mcp'),
    });
    if (isInputRequiredSignal(payload)) {
      throw { code: MCP_ERROR_CODES.inputRequired, message: 'resource read requires input', data: { inputRequests: payload.inputRequests } };
    }
    const contents = typeof payload.output === 'string' ? [{ uri, text: payload.output }] : [{ uri, json: payload.output }];
    return { resultType: 'complete', contents };
  }

  private async getPrompt(params: unknown): Promise<Record<string, unknown>> {
    const name = (params as { name?: unknown } | null)?.name;
    if (typeof name !== 'string') throw { code: MCP_ERROR_CODES.invalidParams, message: 'prompts/get requires a name' };
    const prompt = (this.options.prompts ?? []).find((entry) => entry.name === name);
    if (prompt === undefined) throw { code: MCP_ERROR_CODES.invalidParams, message: `unknown prompt: ${name}` };
    const payload = await this.options.executor.execute({
      capabilityId: prompt.capabilityId ?? mcpCapabilityId(this.options.serverId, 'prompt', name),
      toolName: name,
      input: (params as { arguments?: unknown } | null)?.arguments ?? {},
      correlationId: this.runtime.ids.next('mcp'),
    });
    if (isInputRequiredSignal(payload)) {
      throw { code: MCP_ERROR_CODES.inputRequired, message: 'prompt requires input', data: { inputRequests: payload.inputRequests } };
    }
    return { resultType: 'complete', messages: [{ role: 'user', content: { type: 'text', text: typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '') } }] };
  }

  // ── adapter surface ─────────────────────────────────────────────────────

  capabilities(): import('@syaocode/rpc').AdapterCapabilities {
    const supports = this.options.capabilities ?? {};
    return {
      protocol: 'mcp',
      version: MCP_PROTOCOL_VERSION,
      supports: {
        session: false,
        task: 'tasks' in supports,
        streaming: false,
        push: false,
        approvalOptions: true,
        artifacts: true,
        reverseCalls: false,
        cancellation: true,
      },
      lossy: mergeLossy([MCP_LOSSY.noSession, MCP_LOSSY.untrustedAnnotations]),
    };
  }

  /** A server-side edge cannot discover remote capabilities. */
  async discover(): Promise<never[]> {
    return [];
  }

  /** A server-side edge is invoked *by* the peer; the dispatcher calls tools. */
  async invoke(): Promise<InvokeResultPayload> {
    return { outcome: 'failed', error: unsupportedShape('McpServer does not invoke peers; use McpClient') };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function contentBlocksOf(output: unknown): { type: string; text?: string; [key: string]: unknown }[] {
  if (typeof output === 'string') return [{ type: 'text', text: output }];
  if (Array.isArray(output)) {
    const blocks = output.filter((entry): entry is { type: string } => isRecord(entry) && typeof entry.type === 'string');
    if (blocks.length === output.length) return blocks;
  }
  return [{ type: 'text', text: JSON.stringify(output ?? null) }];
}

function errorText(error: CanonicalErrorShape | undefined, outcome: string): string {
  if (error === undefined) return `invocation ${outcome}`;
  return `${error.kind}: ${error.message}`;
}

function unsupportedShape(message: string): CanonicalErrorShape {
  return { kind: 'unsupported_capability', message, retryable: false };
}

/** Convenience: build an MCP server tool from a canonical tool descriptor. */
export function defineMcpTool(serverId: string, tool: McpServerTool): McpServerTool & { capabilityId: string } {
  return { ...tool, capabilityId: tool.capabilityId ?? mcpCapabilityId(serverId, 'tool', tool.name) };
}

/** Convenience: canonical model-facing name for a server tool (DD-8). */
export function mcpServerToolName(serverId: string, toolName: string): string {
  return mcpToolName(serverId, toolName);
}

export { mcpError };
export type { McpToolAnnotations };

/** Re-exported for hosts that build the discover payload themselves. */
export const mcpMetaBuilder = buildMcpMeta;
