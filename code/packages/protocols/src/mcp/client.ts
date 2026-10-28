/**
 * MCP client — the outbound half of the MCP edge.
 *
 * Implements the 2026-07-28 modern era (no handshake, per-request `_meta`,
 * `server/discover`, MRTR) with a legacy `initialize` fallback that is recorded
 * as `lossy: ['mcp-legacy']` (01 §2.1 / G9).
 *
 * Every call is bounded by the caller's deadline; a timeout after the request
 * was written is reported as `indeterminate` and never retried (I10 / ADR-R6).
 */

import type { Logger, Runtime } from '@syaocode/core';
import {
  CanonicalError,
  type ApprovalOption,
  type ApprovalOutcome,
  type ApprovalSubject,
  type CanonicalErrorShape,
  type DiscoveredCapability,
} from '@syaocode/rpc';
import {
  AdapterBase,
  appendEdgeEvent,
  mergeLossy,
  remainingMs,
  timeoutOutcome,
  wireError,
  type DuplexChannel,
} from '../shared/index.js';
import { JsonRpcConnection, JsonRpcRemoteError, JsonRpcTimeoutError } from '../shared/jsonrpc.js';
import { MCP_ERROR_CODES, mcpError, mcpUnsupported, mcpVersionMismatch } from './errors.js';
import {
  MCP_LOSSY,
  MCP_PROTOCOL_VERSION,
  buildMcpMeta,
  mcpPromptCapability,
  mcpResourceCapability,
  mcpToolCapability,
  type McpClientInfo,
  type McpDiscoverResult,
  type McpPromptDescriptor,
  type McpResourceDescriptor,
  type McpTaskState,
  type McpToolDescriptor,
  type McpToolResult,
} from './mapping.js';
import { MrtrCustodian, buildInputResponses, optionsFromInputRequest, subjectFromInputRequest, type MrtrRetry } from './mrtr.js';

// ── method table (pinned by shared/drift.ts) ──────────────────────────────

export const MCP_METHODS = [
  'server/discover',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
  'tasks/get',
  'tasks/update',
  'tasks/cancel',
  'initialize',
] as const;

export const MCP_NOTIFICATIONS = [
  'notifications/cancelled',
  'notifications/progress',
  'notifications/tasks',
  'notifications/initialized',
] as const;

export type McpEra = 'modern' | 'legacy';

export interface McpClientOptions {
  runtime: Runtime;
  /** Injected duplex transport (stdio, HTTP or an in-process loopback). */
  channel: DuplexChannel;
  /** Registry-assigned id; the peer's self-description never overrides it. */
  serverId: string;
  clientInfo?: McpClientInfo;
  clientCapabilities?: Record<string, unknown>;
  /** Pinned protocol version; `auto` negotiates against `supportedVersions`. */
  protocolVersion?: string;
  /** Allow the legacy `initialize` handshake when `server/discover` is absent. */
  allowLegacyFallback?: boolean;
  requestTimeoutMs?: number;
  logger?: Logger;
  /**
   * The transport binding. `http` adds the mandatory Streamable-HTTP headers
   * (04 M13) and declares OAuth 2.1 / RFC 9728 PRM as unsupported (04 M20).
   */
  transport?: 'stdio' | 'http';
  /**
   * How to answer an OAuth-protected peer. We do not implement OAuth 2.1 /
   * PRM, so the only supported policy is `deny` (fail closed).
   */
  oauthPolicy?: 'deny';
}

export interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** MRTR: verbatim token from a previous `input_required` result. */
  requestState?: string;
  /** MRTR: answers to the elicitation requests. */
  inputResponses?: Record<string, unknown>;
}

/** The result of a `tools/call`, normalized but not yet mapped to the IR. */
export interface McpCallOutcome {
  result: McpToolResult;
  /** Raw `content` / `structuredContent` as published by the peer. */
  output: unknown;
}

export class McpClient {
  readonly connection: JsonRpcConnection;
  private readonly runtime: Runtime;
  private readonly logger: Logger | undefined;
  private readonly allowLegacy: boolean;
  private readonly pinnedVersion: string;
  private readonly custodian = new MrtrCustodian();
  private discoverResult: McpDiscoverResult | undefined;
  private eraValue: McpEra = 'modern';
  private connected = false;

  constructor(private readonly options: McpClientOptions) {
    this.runtime = options.runtime;
    this.logger = options.logger;
    this.allowLegacy = options.allowLegacyFallback ?? true;
    this.pinnedVersion = options.protocolVersion ?? MCP_PROTOCOL_VERSION;
    this.connection = new JsonRpcConnection({
      channel: options.channel,
      framing: 'auto',
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    });
    this.connection.start();
  }

  get era(): McpEra {
    return this.eraValue;
  }

  get discovery(): McpDiscoverResult | undefined {
    return this.discoverResult;
  }

  get serverId(): string {
    return this.options.serverId;
  }

  /** Lossy markers observed so far (legacy fallback, missing task extension…). */
  get lossy(): string[] {
    const out: string[] = [];
    if (this.eraValue === 'legacy') out.push(MCP_LOSSY.legacy);
    // OAuth 2.1 + RFC 9728 PRM is not implemented: an HTTP peer that demands
    // it is refused, never half-authenticated (04 M20).
    if (this.options.transport === 'http') out.push(MCP_LOSSY.oauthUnsupported);
    return out;
  }

  private meta(extra?: Record<string, unknown>): Record<string, unknown> {
    const base = buildMcpMeta({
      protocolVersion: this.pinnedVersion,
      clientCapabilities: this.options.clientCapabilities ?? {},
      clientInfo: this.options.clientInfo ?? { name: 'syaocode', version: '0.3.0-dev' },
    });
    return extra === undefined ? base : { ...base, ...extra };
  }

  /** Modern handshake: `server/discover`, else legacy `initialize`. */
  async connect(): Promise<void> {
    if (this.connected) return;
    try {
      const result = (await this.connection.request(
        'server/discover',
        { _meta: this.meta() },
        this.requestOptions(),
      )) as McpDiscoverResult;
      this.discoverResult = result;
      this.eraValue = 'modern';
      const supported = Array.isArray(result.supportedVersions) ? result.supportedVersions : [];
      if (supported.length > 0 && !supported.includes(this.pinnedVersion)) {
        throw mcpVersionMismatch(supported, this.pinnedVersion);
      }
    } catch (error) {
      if (!(error instanceof JsonRpcRemoteError) || error.code !== MCP_ERROR_CODES.methodNotFound || !this.allowLegacy) {
        throw wireError('mcp', error);
      }
      await this.legacyInitialize();
    }
    this.connected = true;
  }

  private async legacyInitialize(): Promise<void> {
    const result = (await this.connection.request(
      'initialize',
      {
        protocolVersion: this.pinnedVersion,
        capabilities: this.options.clientCapabilities ?? {},
        clientInfo: this.options.clientInfo ?? { name: 'syaocode', version: '0.3.0-dev' },
      },
      this.requestOptions(),
    )) as { protocolVersion?: string; serverInfo?: { name: string; version: string }; capabilities?: Record<string, unknown> };
    this.eraValue = 'legacy';
    this.discoverResult = {
      supportedVersions: typeof result.protocolVersion === 'string' ? [result.protocolVersion] : [this.pinnedVersion],
      capabilities: result.capabilities ?? {},
      ttlMs: 0,
      cacheScope: 'private',
      ...(result.serverInfo !== undefined ? { serverInfo: result.serverInfo } : {}),
    };
    await this.connection.notify('notifications/initialized', {});
    this.logger?.log('info', 'mcp legacy fallback negotiated', { serverId: this.options.serverId });
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const out: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = (await this.connection.request(
        'tools/list',
        { _meta: this.meta(), ...(cursor !== undefined ? { cursor } : {}) },
        this.requestOptions(),
      )) as { tools?: McpToolDescriptor[]; nextCursor?: string };
      for (const tool of result.tools ?? []) out.push(tool);
      if (result.nextCursor === undefined || result.nextCursor.length === 0) break;
      cursor = result.nextCursor;
    }
    return out;
  }

  async listResources(): Promise<McpResourceDescriptor[]> {
    const result = (await this.connection.request('resources/list', { _meta: this.meta() }, this.requestOptions())) as {
      resources?: McpResourceDescriptor[];
    };
    return result.resources ?? [];
  }

  async listPrompts(): Promise<McpPromptDescriptor[]> {
    const result = (await this.connection.request('prompts/list', { _meta: this.meta() }, this.requestOptions())) as {
      prompts?: McpPromptDescriptor[];
    };
    return result.prompts ?? [];
  }

  /** Discovery for the registry: tools + resources + prompts. */
  async discover(): Promise<DiscoveredCapability[]> {
    await this.connect();
    const serverId = this.options.serverId;
    const out: DiscoveredCapability[] = [];
    for (const tool of await this.listTools()) out.push(mcpToolCapability(serverId, tool));
    try {
      for (const resource of await this.listResources()) out.push(mcpResourceCapability(serverId, resource));
    } catch (error) {
      this.logger?.log('debug', 'resources/list unsupported', { serverId, error: String(error) });
    }
    try {
      for (const prompt of await this.listPrompts()) out.push(mcpPromptCapability(serverId, prompt));
    } catch (error) {
      this.logger?.log('debug', 'prompts/list unsupported', { serverId, error: String(error) });
    }
    return out;
  }

  async readResource(uri: string, opts?: McpCallOptions): Promise<unknown> {
    return this.connection.request('resources/read', { uri, _meta: this.meta() }, this.requestOptions(opts));
  }

  async getPrompt(name: string, args: Record<string, unknown> | undefined, opts?: McpCallOptions): Promise<unknown> {
    return this.connection.request(
      'prompts/get',
      { name, ...(args !== undefined ? { arguments: args } : {}), _meta: this.meta() },
      this.requestOptions(opts),
    );
  }

  /**
   * `tools/call`. Returns the raw result; MRTR rounds are driven by the caller
   * (the adapter) so the approval bridge stays in one place.
   */
  async callTool(name: string, args: unknown, opts?: McpCallOptions): Promise<McpCallOutcome> {
    const params: Record<string, unknown> = {
      name,
      ...(args !== undefined ? { arguments: args } : {}),
      _meta: this.meta(),
      ...(opts?.requestState !== undefined ? { requestState: opts.requestState } : {}),
      ...(opts?.inputResponses !== undefined ? { inputResponses: opts.inputResponses } : {}),
    };
    const result = (await this.connection.request('tools/call', params, this.requestOptions(opts))) as McpToolResult;
    const resultType = result.resultType ?? 'complete';
    if (resultType === 'input_required' && typeof result.requestState === 'string') {
      // Track the issued token so a tampered echo can be rejected (fail closed).
      this.custodian.track(result.requestState, this.fingerprint(name, args));
    }
    return {
      result,
      output: result.structuredContent !== undefined ? result.structuredContent : (result.content ?? []),
    };
  }

  /** Verify + build an MRTR retry payload (verbatim state, single use). */
  retryPayload(name: string, args: unknown, state: string, inputResponses: Record<string, unknown>): MrtrRetry {
    const fingerprint = this.fingerprint(name, args);
    const verified = this.custodian.verify(fingerprint, state);
    return {
      method: 'tools/call',
      params: { name, ...(args !== undefined ? { arguments: args } : {}) },
      inputResponses,
      requestState: verified,
    };
  }

  fingerprint(name: string, args: unknown): string {
    return `${name}:${stableKey(args)}`;
  }

  // ── tasks extension (io.modelcontextprotocol/tasks) ─────────────────────

  async getTask(taskId: string): Promise<McpTaskState> {
    return (await this.connection.request('tasks/get', { taskId, _meta: this.meta() }, this.requestOptions())) as McpTaskState;
  }

  async updateTask(taskId: string, input: unknown): Promise<McpTaskState> {
    return (await this.connection.request('tasks/update', { taskId, input, _meta: this.meta() }, this.requestOptions())) as McpTaskState;
  }

  async cancelTask(taskId: string, reason?: string): Promise<McpTaskState> {
    return (await this.connection.request(
      'tasks/cancel',
      { taskId, ...(reason !== undefined ? { reason } : {}), _meta: this.meta() },
      this.requestOptions(),
    )) as McpTaskState;
  }

  /** stdio cancel semantics: `notifications/cancelled` (01 §5.2). */
  async cancelRequest(requestId: string | number, reason?: string): Promise<void> {
    await this.connection.notify('notifications/cancelled', {
      requestId,
      ...(reason !== undefined ? { reason } : {}),
      _meta: this.meta(),
    });
  }

  async close(): Promise<void> {
    await this.connection.close('client-close');
  }

  private requestOptions(opts?: McpCallOptions): { timeoutMs?: number; signal?: AbortSignal } {
    const out: { timeoutMs?: number; signal?: AbortSignal } = {};
    if (opts?.timeoutMs !== undefined) out.timeoutMs = opts.timeoutMs;
    else if (this.options.requestTimeoutMs !== undefined) out.timeoutMs = this.options.requestTimeoutMs;
    if (opts?.signal !== undefined) out.signal = opts.signal;
    return out;
  }
}

/** Deterministic key for MRTR fingerprints (no crypto needed, stable order). */
export function stableKey(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`).join(',')}}`;
  }
  return String(value);
}

// ── MRTR approval bridge ──────────────────────────────────────────────────

export interface MrtrApprovalPlan {
  subject: ApprovalSubject;
  options: ApprovalOption[];
  /** optionId → the answer value to send back for that option. */
  valueByOption: Map<string, unknown>;
}

/** Build the approval plan for a set of elicitation requests. */
export function planForInputRequests(requests: readonly { id?: string; method?: string; message?: string; schema?: unknown }[], toolName: string): MrtrApprovalPlan {
  const valueByOption = new Map<string, unknown>();
  const options: ApprovalOption[] = [];
  for (const [index, request] of requests.entries()) {
    const requestOptions = optionsFromInputRequest(request);
    for (const [optionIndex, option] of requestOptions.entries()) {
      const value = optionValue(request, optionIndex);
      valueByOption.set(option.id, value);
      options.push({ ...option, id: requestOptions.length > 1 ? `${option.id}__${index}` : option.id });
      if (requestOptions.length > 1) valueByOption.set(`${option.id}__${index}`, value);
    }
  }
  const subject = subjectFromInputRequest(requests[0] ?? {}, toolName);
  if (options.length === 0) {
    options.push({ id: 'allow_once', label: 'Allow once', kind: 'allow_once' }, { id: 'deny_once', label: 'Deny', kind: 'deny_once' });
    valueByOption.set('allow_once', true);
    valueByOption.set('deny_once', false);
  }
  return { subject, options, valueByOption };
}

function optionValue(request: { schema?: unknown }, index: number): unknown {
  const schema = request.schema as { enum?: unknown[]; oneOf?: { const?: unknown }[] } | undefined;
  if (schema !== undefined && Array.isArray(schema.enum)) return schema.enum[index];
  if (schema !== undefined && Array.isArray(schema.oneOf)) return schema.oneOf[index]?.const;
  return index === 0 ? true : false;
}

/** Turn an approval outcome into the `inputResponses` payload for a retry. */
export function inputResponsesFromOutcome(
  plan: MrtrApprovalPlan,
  requests: readonly { id?: string; method?: string }[],
  outcome: ApprovalOutcome,
): Record<string, unknown> {
  const value = outcome.optionId !== undefined ? plan.valueByOption.get(outcome.optionId) : undefined;
  const answers: Record<string, unknown> = {};
  for (const request of requests) {
    const key = request.id ?? request.method;
    if (key === undefined) continue;
    if (value !== undefined) answers[key] = value;
  }
  return buildInputResponses(requests, answers);
}

// ── ProtocolAdapter ───────────────────────────────────────────────────────

export interface McpAdapterOptions extends McpClientOptions {
  /** Extra lossy markers the host wants surfaced (e.g. auth-less HTTP). */
  lossy?: string[];
}

/**
 * The MCP edge as a `ProtocolAdapter`.
 *
 * `invoke()` drives the MRTR loop: when the peer asks for input, the adapter
 * asks the kernel's approval broker and only retries after an `allowed`
 * decision, echoing `requestState` verbatim. A denied/expired/cancelled
 * approval ends the invocation as `denied` and the peer is not retried.
 */
export class McpAdapter extends AdapterBase {
  readonly client: McpClient;
  private readonly extraLossy: string[];
  private readonly transport: 'stdio' | 'http';

  constructor(options: McpAdapterOptions) {
    super('mcp', MCP_PROTOCOL_VERSION, options.runtime, options.logger);
    this.client = new McpClient(options);
    this.extraLossy = options.lossy ?? [];
    this.transport = options.transport ?? 'stdio';
  }

  capabilities(): import('@syaocode/rpc').AdapterCapabilities {
    return {
      protocol: 'mcp',
      version: MCP_PROTOCOL_VERSION,
      supports: {
        session: false,
        task: true,
        streaming: false,
        push: false,
        approvalOptions: true,
        artifacts: true,
        reverseCalls: false,
        cancellation: true,
      },
      lossy: mergeLossy(
        [
          MCP_LOSSY.noSession,
          MCP_LOSSY.noServerInitiatedRequest,
          MCP_LOSSY.optionalTaskExtension,
          MCP_LOSSY.untrustedAnnotations,
        ],
        this.client.lossy,
        this.extraLossy,
      ),
    };
  }

  async discover(ctx: import('@syaocode/rpc').AdapterContext): Promise<DiscoveredCapability[]> {
    void ctx;
    return this.client.discover();
  }

  async invoke(req: import('@syaocode/rpc').AuthorizedInvocation, ctx: import('@syaocode/rpc').AdapterContext): Promise<import('@syaocode/rpc').InvokeResultPayload> {
    const kind = req.capability.kind;
    const name = capabilityName(req.capability.id);
    if (name === undefined) {
      return { outcome: 'failed', error: mcpUnsupported(`malformed MCP capability id: ${req.capability.id}`).toShape() };
    }
    const timeoutMs = remainingMs(ctx.runtime, ctx);
    const callOptions: McpCallOptions = {};
    if (timeoutMs !== undefined) callOptions.timeoutMs = timeoutMs;
    if (ctx.signal !== undefined) callOptions.signal = ctx.signal;

    try {
      if (kind === 'tool') return await this.invokeTool(name, req, ctx, callOptions);
      if (kind === 'resource') {
        const output = await this.client.readResource(name, callOptions);
        return { outcome: 'succeeded', output, lossy: this.adapterLossy() };
      }
      if (kind === 'prompt') {
        const output = await this.client.getPrompt(name, asRecord(req.input), callOptions);
        return { outcome: 'succeeded', output, lossy: this.adapterLossy() };
      }
      return { outcome: 'failed', error: mcpUnsupported(`MCP cannot invoke capability kind ${kind}`).toShape() };
    } catch (error) {
      return this.failurePayload(error);
    }
  }

  private async invokeTool(
    toolName: string,
    req: import('@syaocode/rpc').AuthorizedInvocation,
    ctx: import('@syaocode/rpc').AdapterContext,
    callOptions: McpCallOptions,
  ): Promise<import('@syaocode/rpc').InvokeResultPayload> {
    let outcome = await this.client.callTool(toolName, req.input, callOptions);
    let rounds = 0;
    while ((outcome.result.resultType ?? 'complete') === 'input_required') {
      rounds += 1;
      if (rounds > 3) {
        return { outcome: 'failed', error: mcpUnsupported('MRTR exceeded the maximum number of rounds').toShape(), lossy: this.adapterLossy() };
      }
      const requests = outcome.result.inputRequests ?? [];
      const plan = planForInputRequests(requests, toolName);
      const decision = await ctx.approval.request({
        tenantId: req.tenantId,
        taskId: req.taskId,
        invocationId: req.invocationId,
        subject: plan.subject,
        options: plan.options,
        authority: 'delegated',
        policyRevision: 'mcp-mrtr',
      });
      if (decision.state !== 'allowed') {
        // `InvokeResultPayload.outcome` has no `denied`; denial is a failure
        // whose CanonicalError kind is `denied` (01 §5 / G10).
        return {
          outcome: 'failed',
          error: CanonicalError.denied(`MRTR input request was ${decision.state}`, 'SY-MCP-004').toShape(),
          lossy: this.adapterLossy(),
        };
      }
      const requestState = outcome.result.requestState;
      if (requestState === undefined) {
        return { outcome: 'failed', error: mcpUnsupported('peer returned input_required without requestState').toShape() };
      }
      const retry = this.client.retryPayload(toolName, req.input, requestState, inputResponsesFromOutcome(plan, requests, decision));
      // Edge-level fact the kernel cannot know: an MRTR round-trip happened.
      // `append` is best effort and the log stamps seq/eventId/ts.
      await appendEdgeEvent(ctx, {
        type: 'notice',
        invocation: req,
        protocol: 'mcp',
        causationId: 'tools/call',
        payload: {
          mcp: 'mrtr-round-trip',
          tool: toolName,
          round: rounds,
          optionId: decision.optionId ?? null,
          requestStateEchoed: retry.requestState.length > 0,
        },
      });
      outcome = await this.client.callTool(toolName, req.input, { ...callOptions, requestState: retry.requestState, inputResponses: retry.inputResponses });
    }

    if ((outcome.result.resultType ?? 'complete') === 'task') {
      return {
        outcome: 'succeeded',
        output: { taskId: outcome.result.taskId, resultType: 'task' },
        lossy: mergeLossy(this.adapterLossy(), ['mcp-task-not-awaited']),
      };
    }
    if (outcome.result.isError === true) {
      return { outcome: 'failed', error: mcpError({ code: MCP_ERROR_CODES.internalError, message: 'tool reported isError', data: outcome.result }).toShape(), lossy: this.adapterLossy() };
    }
    return { outcome: 'succeeded', output: outcome.output, lossy: this.adapterLossy() };
  }

  async cancel(taskId: string, reason: string, ctx: import('@syaocode/rpc').AdapterContext): Promise<void> {
    void ctx;
    try {
      await this.client.cancelTask(taskId, reason);
    } catch (error) {
      // A peer without the Tasks extension can still be told about the cancel.
      this.logger?.log('debug', 'tasks/cancel failed; falling back to notifications/cancelled', { taskId, error: String(error) });
      await this.client.cancelRequest(taskId, reason);
    }
  }

  override async close(): Promise<void> {
    await this.client.close();
    await super.close();
  }

  private failurePayload(error: unknown): import('@syaocode/rpc').InvokeResultPayload {
    // An OAuth-protected HTTP peer: we do not implement OAuth 2.1 / PRM, so we
    // fail closed with an honest error instead of pretending to be authorized.
    if (this.transport === 'http') {
      const status = httpStatusOf(error);
      if (status === 401 || status === 403) {
        return {
          outcome: 'failed',
          error: new CanonicalError({
            kind: 'unauthenticated',
            message: `the MCP peer requires OAuth 2.1 / RFC 9728 PRM, which this edge does not implement (HTTP ${status})`,
            protocol: 'mcp',
            retryable: false,
            details: { status, lossy: [MCP_LOSSY.oauthUnsupported] },
          }).toShape(),
          lossy: mergeLossy(this.adapterLossy(), [MCP_LOSSY.oauthUnsupported]),
        };
      }
    }
    if (error instanceof JsonRpcTimeoutError) {
      const canonical = wireError('mcp', error);
      return {
        outcome: timeoutOutcome(error.sent),
        error: canonical.toShape(),
        lossy: mergeLossy(this.adapterLossy(), ['mcp-no-auto-retry']),
      };
    }
    const canonical = wireError('mcp', error);
    const shape: CanonicalErrorShape = canonical.toShape();
    const outcome: import('@syaocode/rpc').InvokeResultPayload['outcome'] = canonical.kind === 'cancelled' ? 'cancelled' : 'failed';
    return { outcome, error: shape, lossy: this.adapterLossy() };
  }

  private adapterLossy(): string[] {
    return mergeLossy(this.client.lossy, this.extraLossy);
  }
}

/**
 * The HTTP status carried by a transport error, when there is one.
 *
 * `createHttpChannel` reports it on `protocolError`; a caller-supplied error
 * may put it in `details`. Both are checked so the OAuth fail-closed path can
 * never be missed because of where the status was recorded.
 */
function httpStatusOf(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const record = error as { details?: unknown; protocolError?: unknown };
  for (const source of [record.protocolError, record.details]) {
    if (source === null || typeof source !== 'object') continue;
    const status = (source as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/** `mcp://<server>/tool/<name>` → `<name>` (undefined for malformed ids). */
export function capabilityName(capabilityId: string): string | undefined {
  const match = /^(?:mcp|a2a|acp):\/\/[^/]+\/[^/]+\/(.+)$/.exec(capabilityId);
  return match?.[1];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
