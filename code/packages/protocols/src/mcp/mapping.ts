/**
 * MCP 2026-07-28 — wire types and the MCP ↔ Canonical IR mapping.
 *
 * Modern era (01 §2.1):
 *   - no `initialize` handshake, no `Mcp-Session-Id`, no `ping`;
 *   - every request carries a `_meta` envelope with the protocol version,
 *     the client capabilities and the client info;
 *   - the server MUST implement `server/discover`;
 *   - the server MUST NOT initiate requests — it asks for input by returning
 *     `resultType: "input_required"` (MRTR, SEP-2322);
 *   - tool results carry `content` and may carry `structuredContent`;
 *   - `ToolAnnotations` are untrusted hints and never widen permissions (G8).
 */

import { mcpCapabilityId, mcpToolName, type CapabilityKind, type DiscoveredCapability, type Risk } from '@syaocode/rpc';

// ── wire shapes ───────────────────────────────────────────────────────────

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

export interface McpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: McpToolAnnotations;
}

export interface McpResourceDescriptor {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptDescriptor {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface McpContentBlock {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
  uri?: string;
  [key: string]: unknown;
}

/** An elicitation request carried by an `input_required` result. */
export interface McpInputRequest {
  id?: string;
  method?: string;
  message?: string;
  schema?: unknown;
  [key: string]: unknown;
}

export type McpResultType = 'complete' | 'input_required' | 'task';

export interface McpToolResult {
  /** Missing means `complete` (older servers). */
  resultType?: McpResultType;
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  /** MRTR: opaque token that MUST be echoed verbatim on the retry. */
  requestState?: string;
  inputRequests?: McpInputRequest[];
  taskId?: string;
}

export interface McpDiscoverResult {
  supportedVersions: string[];
  capabilities: Record<string, unknown>;
  ttlMs: number;
  cacheScope: string;
  serverInfo?: { name: string; version: string };
  instructions?: string;
}

export interface McpTaskState {
  taskId: string;
  status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
  statusMessage?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
}

// ── `_meta` envelope ──────────────────────────────────────────────────────

/** `resultType` values this edge implements (pinned by drift.test.ts). */
export const MCP_RESULT_TYPES: readonly string[] = ['complete', 'input_required', 'task'];

/** MCP Tasks-extension states this edge implements (01 §2.1). */
export const MCP_TASK_STATES: readonly string[] = ['working', 'input_required', 'completed', 'failed', 'cancelled'];

export const MCP_META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const MCP_META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const MCP_META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';

export const MCP_PROTOCOL_VERSION = '2026-07-28';

/** The three `_meta` envelope keys every modern request carries. */
export const MCP_META_KEYS: readonly string[] = [
  'io.modelcontextprotocol/protocolVersion',
  'io.modelcontextprotocol/clientCapabilities',
  'io.modelcontextprotocol/clientInfo',
];

export interface McpClientInfo {
  name: string;
  version: string;
}

/** Build the per-request `_meta` envelope (01 §2.1). */
export function buildMcpMeta(options: {
  protocolVersion?: string;
  clientCapabilities?: Record<string, unknown>;
  clientInfo: McpClientInfo;
}): Record<string, unknown> {
  return {
    [MCP_META_PROTOCOL_VERSION]: options.protocolVersion ?? MCP_PROTOCOL_VERSION,
    [MCP_META_CLIENT_CAPABILITIES]: options.clientCapabilities ?? {},
    [MCP_META_CLIENT_INFO]: options.clientInfo,
  };
}

/** Read the protocol version out of a `_meta` envelope, if present. */
export function readMcpMetaVersion(meta: unknown): string | undefined {
  if (meta === null || typeof meta !== 'object') return undefined;
  const value = (meta as Record<string, unknown>)[MCP_META_PROTOCOL_VERSION];
  return typeof value === 'string' ? value : undefined;
}

// ── capabilities ──────────────────────────────────────────────────────────

/**
 * Advisory risk derived from the peer's `ToolAnnotations`.
 *
 * G8: annotations are untrusted, so this is *advisory only* — the registry and
 * the policy engine decide the effective risk. `annotations.trust` records
 * that the value came from the peer.
 */
export function declaredRiskFromAnnotations(annotations: McpToolAnnotations | undefined): Risk | undefined {
  if (annotations === undefined) return undefined;
  if (annotations.readOnlyHint === true) return 'read';
  if (annotations.destructiveHint === true) return 'write';
  return undefined;
}

export function mcpToolCapability(serverId: string, tool: McpToolDescriptor): DiscoveredCapability {
  const annotations: Record<string, unknown> = {
    ...(tool.annotations ?? {}),
    trust: 'untrusted',
    mcpToolName: mcpToolName(serverId, tool.name),
  };
  const declaredRisk = declaredRiskFromAnnotations(tool.annotations);
  return {
    id: mcpCapabilityId(serverId, 'tool', tool.name),
    kind: 'tool',
    displayName: tool.title ?? tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputJsonSchema: tool.inputSchema } : {}),
    ...(tool.outputSchema !== undefined ? { outputJsonSchema: tool.outputSchema } : {}),
    ...(declaredRisk !== undefined ? { declaredRisk } : {}),
    annotations,
  };
}

export function mcpResourceCapability(serverId: string, resource: McpResourceDescriptor): DiscoveredCapability {
  const displayName = resource.title ?? resource.name ?? resource.uri;
  return {
    id: mcpCapabilityId(serverId, 'resource', resource.uri),
    kind: 'resource',
    displayName,
    ...(resource.description !== undefined ? { description: resource.description } : {}),
    ...(resource.mimeType !== undefined ? { annotations: { mimeType: resource.mimeType, trust: 'untrusted' } } : {}),
  };
}

export function mcpPromptCapability(serverId: string, prompt: McpPromptDescriptor): DiscoveredCapability {
  return {
    id: mcpCapabilityId(serverId, 'prompt', prompt.name),
    kind: 'prompt',
    displayName: prompt.title ?? prompt.name,
    ...(prompt.description !== undefined ? { description: prompt.description } : {}),
    ...(prompt.arguments !== undefined ? { annotations: { arguments: prompt.arguments, trust: 'untrusted' } } : {}),
  };
}

/** Map a canonical capability kind onto the MCP discovery namespace. */
export function mcpKindOf(kind: CapabilityKind): 'tool' | 'resource' | 'prompt' | undefined {
  switch (kind) {
    case 'tool':
      return 'tool';
    case 'resource':
      return 'resource';
    case 'prompt':
      return 'prompt';
    default:
      return undefined;
  }
}

// ── lossy markers ─────────────────────────────────────────────────────────

/** Semantic gaps the MCP edge cannot express (01 §6, G1/G2/G8). */
export const MCP_LOSSY = {
  /** No protocol-level session: the kernel owns Session/Task (G1). */
  noSession: 'mcp-no-session',
  /** The server cannot initiate requests, so approval is MRTR-shaped (G1). */
  noServerInitiatedRequest: 'mcp-no-server-initiated-request',
  /** Task lifecycle is an optional extension, not core (G2). */
  optionalTaskExtension: 'mcp-task-extension-optional',
  /** Tool annotations are untrusted hints and never widen permissions (G8). */
  untrustedAnnotations: 'mcp-annotations-untrusted',
  /** Legacy `initialize` fallback was used. */
  legacy: 'mcp-legacy',
  /** The host cannot answer an MRTR elicitation → fail closed. */
  mrtrUnsupported: 'mcp-mrtr-unsupported',
  /**
   * OAuth 2.1 + RFC 9728 PRM is not implemented (04 M20). HTTP peers that
   * advertise a protected-resource challenge are refused rather than
   * half-authenticated.
   */
  oauthUnsupported: 'mcp-oauth-prm-unsupported',
} as const;
