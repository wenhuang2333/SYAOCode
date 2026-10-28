/**
 * MCP Streamable HTTP binding: the mandatory request headers (04 M13).
 *
 * > Streamable HTTP must carry `MCP-Protocol-Version`, `Mcp-Method` and
 * > `Mcp-Name`; `x-mcp-header` parameters become `Mcp-Param-*`; a mismatch
 * > answers HTTP 400 with JSON-RPC `-32020` (HeaderMismatch).
 *
 * The headers are derived from the JSON-RPC body, so the client and the
 * server can never disagree about which method (and which tool) a request
 * carries: the server recomputes them and compares.
 */

import { MCP_ERROR_CODES } from '@syaocode/rpc';
import { MCP_PROTOCOL_VERSION } from './mapping.js';

export const MCP_HEADER_PROTOCOL_VERSION = 'MCP-Protocol-Version';
export const MCP_HEADER_METHOD = 'Mcp-Method';
export const MCP_HEADER_NAME = 'Mcp-Name';
export const MCP_HEADER_PARAM_PREFIX = 'Mcp-Param-';

/** HTTP 400 + JSON-RPC HeaderMismatch (-32020), per 04 M13/M18. */
export const MCP_HEADER_MISMATCH_STATUS = 400;
export const MCP_HEADER_MISMATCH_CODE = MCP_ERROR_CODES.headerMismatch;

/** The method/tool a JSON-RPC body carries (for the mandatory headers). */
export interface McpHttpRequestInfo {
  method: string;
  /** `tools/call` → the tool name; `prompts/get` → the prompt name. */
  name?: string;
}

/** Extract the method (and tool/prompt name) from a JSON-RPC body. */
export function parseMcpHttpRequestInfo(body: string): McpHttpRequestInfo | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const record = parsed as { method?: unknown; params?: unknown };
  if (typeof record.method !== 'string') return undefined;
  const info: McpHttpRequestInfo = { method: record.method };
  const params = record.params;
  if (params !== null && typeof params === 'object') {
    const name = (params as { name?: unknown }).name;
    if (typeof name === 'string') info.name = name;
  }
  return info;
}

/**
 * Build the mandatory headers for one JSON-RPC body.
 *
 * `x-mcp-header` style parameters are carried as `Mcp-Param-<name>`.
 */
export function buildMcpHttpHeaders(
  body: string,
  opts?: { protocolVersion?: string; params?: Record<string, string> },
): Record<string, string> {
  const info = parseMcpHttpRequestInfo(body);
  const headers: Record<string, string> = {
    [MCP_HEADER_PROTOCOL_VERSION]: opts?.protocolVersion ?? MCP_PROTOCOL_VERSION,
    [MCP_HEADER_METHOD]: info?.method ?? 'unknown',
  };
  if (info?.name !== undefined) headers[MCP_HEADER_NAME] = info.name;
  for (const [key, value] of Object.entries(opts?.params ?? {})) {
    headers[`${MCP_HEADER_PARAM_PREFIX}${key}`] = value;
  }
  return headers;
}

export interface McpHttpHeaderCheck {
  ok: boolean;
  /** HTTP status to answer with (400 on a mismatch). */
  status?: number;
  /** JSON-RPC error code (-32020 HeaderMismatch). */
  code?: number;
  message?: string;
  /** The offending header/value pairs, for the audit trail. */
  details?: Record<string, unknown>;
}

/**
 * Validate the mandatory headers of an incoming HTTP request.
 *
 * A mismatch is a **400** with the JSON-RPC `HeaderMismatch` code (-32020):
 * the request never reaches a tool handler.
 */
export function checkMcpHttpHeaders(
  headers: Record<string, string>,
  body: string,
  opts?: { protocolVersion?: string; requireName?: boolean },
): McpHttpHeaderCheck {
  const info = parseMcpHttpRequestInfo(body);
  if (info === undefined) {
    return {
      ok: false,
      status: MCP_HEADER_MISMATCH_STATUS,
      code: MCP_HEADER_MISMATCH_CODE,
      message: 'MCP HTTP request body is not a JSON-RPC request',
      details: { body },
    };
  }

  const expectedVersion = opts?.protocolVersion ?? MCP_PROTOCOL_VERSION;
  const version = headers[MCP_HEADER_PROTOCOL_VERSION] ?? headers[MCP_HEADER_PROTOCOL_VERSION.toLowerCase()];
  if (version !== expectedVersion) {
    return {
      ok: false,
      status: MCP_HEADER_MISMATCH_STATUS,
      code: MCP_HEADER_MISMATCH_CODE,
      message: `${MCP_HEADER_PROTOCOL_VERSION} mismatch: expected ${expectedVersion}, got ${version ?? 'none'}`,
      details: { header: MCP_HEADER_PROTOCOL_VERSION, expected: expectedVersion, received: version ?? null },
    };
  }

  const method = headers[MCP_HEADER_METHOD] ?? headers[MCP_HEADER_METHOD.toLowerCase()];
  if (method !== info.method) {
    return {
      ok: false,
      status: MCP_HEADER_MISMATCH_STATUS,
      code: MCP_HEADER_MISMATCH_CODE,
      message: `${MCP_HEADER_METHOD} mismatch: body says ${info.method}, header says ${method ?? 'none'}`,
      details: { header: MCP_HEADER_METHOD, expected: info.method, received: method ?? null },
    };
  }

  const name = headers[MCP_HEADER_NAME] ?? headers[MCP_HEADER_NAME.toLowerCase()];
  const requiresName = opts?.requireName ?? info.name !== undefined;
  if (requiresName && name !== info.name) {
    return {
      ok: false,
      status: MCP_HEADER_MISMATCH_STATUS,
      code: MCP_HEADER_MISMATCH_CODE,
      message: `${MCP_HEADER_NAME} mismatch: body says ${info.name ?? 'none'}, header says ${name ?? 'none'}`,
      details: { header: MCP_HEADER_NAME, expected: info.name ?? null, received: name ?? null },
    };
  }

  return { ok: true };
}
