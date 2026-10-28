/**
 * MCP error codes ↔ CanonicalError (01 §5.2 / G10).
 *
 * The raw JSON-RPC error object is always preserved in `protocolError`; the
 * kernel never inspects protocol-native error shapes (rpc §errors).
 */

import {
  CanonicalError,
  MCP_ERROR_CODES,
  canonicalFromJsonRpcError,
  type CanonicalErrorShape,
  type Protocol,
} from '@syaocode/rpc';

export { MCP_ERROR_CODES };

/** The client must supply input and retry with the same `requestState`. */
export const MCP_INPUT_REQUIRED = MCP_ERROR_CODES.inputRequired;

/** `requestState` was missing, stale or tampered with → fail closed. */
export const MCP_REQUEST_STATE_INVALID = MCP_ERROR_CODES.requestStateInvalid;

/** No common protocol version with the peer. */
export const MCP_VERSION_NEGOTIATION_FAILED = MCP_ERROR_CODES.versionNegotiationFailed;

/** Map an MCP JSON-RPC error object onto a CanonicalError. */
export function mcpError(error: unknown): CanonicalError {
  return canonicalFromJsonRpcError('mcp', error);
}

/** The peer answered with `isError: true` inside a successful result. */
export function mcpToolError(result: { isError?: boolean; content?: unknown[] }): CanonicalError {
  return new CanonicalError({
    kind: 'remote_error',
    message: 'MCP tool reported isError',
    protocol: 'mcp',
    retryable: false,
    protocolError: { isError: true, content: result.content ?? [] },
  });
}

/** The peer does not implement a method / capability. */
export function mcpUnsupported(message: string, protocolError?: unknown): CanonicalError {
  return new CanonicalError({
    kind: 'unsupported_capability',
    message,
    protocol: 'mcp',
    retryable: false,
    ...(protocolError !== undefined ? { protocolError } : {}),
  });
}

/** Version negotiation failed. */
export function mcpVersionMismatch(supported: readonly string[], requested: string): CanonicalError {
  return new CanonicalError({
    kind: 'version_mismatch',
    message: `no common MCP version: peer supports ${supported.join(', ') || 'none'}, requested ${requested}`,
    protocol: 'mcp',
    retryable: false,
    details: { supported: [...supported], requested },
  });
}

/** The MRTR `requestState` was missing / tampered with → fail closed (G1). */
export function mcpRequestStateInvalid(reason: string, protocolError?: unknown): CanonicalError {
  return new CanonicalError({
    kind: 'unsupported_capability',
    message: `MRTR requestState rejected: ${reason}`,
    code: 'SY-MCP-004',
    protocol: 'mcp',
    retryable: false,
    ...(protocolError !== undefined ? { protocolError } : {}),
  });
}

/** Shape a CanonicalError for a payload. */
export function mcpErrorShape(error: CanonicalError): CanonicalErrorShape {
  return error.toShape();
}

/** Protocol label used by the shared error mapper. */
export const MCP_PROTOCOL: Protocol = 'mcp';
