/**
 * `@syaocode/protocols/shared` — transport, JSON-RPC and drift utilities.
 *
 * Subpath export: importers of `@syaocode/protocols/mcp` do not pull the A2A or
 * ACP code in (03 §3.3).
 */

export {
  JSONRPC_ERROR_CODES,
  JsonRpcAbortedError,
  JsonRpcConnection,
  JsonRpcProtocolError,
  JsonRpcRemoteError,
  JsonRpcTimeoutError,
  MessageFramer,
  decodeMessage,
  decodeMessages,
  encodeMessage,
  frameContentLength,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  toJsonRpcErrorObject,
} from './jsonrpc.js';
export type {
  Framing,
  JsonRpcErrorObject,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcPeerHandlers,
  JsonRpcRequest,
  JsonRpcRequestContext,
  JsonRpcResponse,
  JsonRpcSuccess,
} from './jsonrpc.js';

export {
  MAX_FRAME_CHARS,
  createCallbackChannel,
  createHttpChannel,
  createLoopbackPair,
  createSseChannel,
  createStdioChannel,
  stdinOf,
} from './transport.js';
export type {
  DuplexChannel,
  HttpChannelOptions,
  LoopbackPair,
  SseChannelOptions,
  StdinWriter,
  StdioChannel,
  StdioChannelOptions,
} from './transport.js';

export {
  AdapterBase,
  UNSUPPORTED_CAPABILITY,
  appendEdgeEvent,
  deadlineExceeded,
  errorShape,
  mergeLossy,
  nowIso,
  remainingMs,
  timeoutOutcome,
  wireError,
} from './adapter-kit.js';
export type { EdgeEventInput } from './adapter-kit.js';

export type { ReverseInvokeGateway, ReverseInvokeRequest } from './gateway.js';

export {
  A2A_INVENTORY,
  A2A_TASK_STATES,
  ACP_INVENTORY,
  ACP_STOP_REASONS,
  ACP_UPDATE_VARIANTS,
  MCP_INVENTORY,
  MCP_META_KEYS,
  MCP_RESULT_TYPES,
  PINNED_INVENTORIES,
  assertNoDrift,
  compareErrorCodes,
  compareFields,
  compareMethods,
  compareNotifications,
} from './drift.js';
export type { Drift, DriftKind, MethodSpec, ProtocolInventory } from './drift.js';
