/**
 * `@syaocode/protocols` — protocol edges for the ARF governance kernel.
 *
 * Subpath exports keep adapters independent:
 *   - `@syaocode/protocols/mcp`
 *   - `@syaocode/protocols/a2a`
 *   - `@syaocode/protocols/acp`
 *   - `@syaocode/protocols/shared`
 *
 * Design references: `document/Agent-RPC/01-协议基线与统一模型.md` (§2, §4.7.4,
 * §5, §6) and `03-工程实现与落地路线.md` (§3.3, §5, §7).
 *
 * Hard rules honoured by every file under `src/`:
 *   - no `node:` imports (CI purity gate);
 *   - no external protocol SDKs — the wire layers are implemented here;
 *   - no `Tool.execute` calls — adapters depend on `ProtocolAdapter` only.
 */

// ── factories (the CLI's entry points) ────────────────────────────────────
export {
  createHttpMcpAdapter,
  createMcpAdapter,
  createMcpServer,
  createStdioMcpAdapter,
  mcpAdapter,
} from './mcp/index.js';
export type { McpAdapterOptions, McpHttpEdgeOptions, McpServerOptions, McpStdioEdgeOptions, McpToolExecutor } from './mcp/index.js';

export {
  a2aAdapter,
  createA2aAdapter,
  createA2aServer,
  createHttpA2aAdapter,
} from './a2a/index.js';
export type { A2aAdapterOptions, A2aHttpEdgeOptions, A2aServerOptions } from './a2a/index.js';

export {
  acpAdapter,
  createAcpAdapter,
  createAcpEdge,
  createAcpLoopbackEdge,
  createAcpServer,
  createStdioAcpEdge,
  parseAcpCapabilityId,
} from './acp/index.js';
export type { AcpAdapterOptions, AcpEdge, AcpServerOptions as AcpEdgeServerOptions } from './acp/index.js';

// ── shared transport / codec ──────────────────────────────────────────────
export {
  JsonRpcConnection,
  MessageFramer,
  createCallbackChannel,
  createHttpChannel,
  createLoopbackPair,
  createSseChannel,
  createStdioChannel,
} from './shared/index.js';
export type { DuplexChannel, Framing, JsonRpcMessage, LoopbackPair } from './shared/index.js';

// ── drift inventory (consumed by test/drift.test.ts) ──────────────────────
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
} from './shared/index.js';
export type { Drift, ProtocolInventory } from './shared/index.js';

// ── re-exported protocol surfaces ─────────────────────────────────────────
export {
  A2A_LOSSY,
  A2A_METHODS,
  A2A_VERSION,
  A2aAdapter,
  A2aClient,
  A2aServer,
  MemoryA2aTaskStore,
  buildAgentCard,
  parseAgentCard,
  taskStateToA2a,
  a2aStateToTaskState,
} from './a2a/index.js';
export type { A2aAgentCard, A2aTask, A2aMessage, A2aArtifact, A2aCallerContext, A2aTaskStore } from './a2a/index.js';

export {
  MCP_LOSSY,
  MCP_METHODS,
  MCP_PROTOCOL_VERSION,
  McpAdapter,
  McpClient,
  McpServer,
  defineMcpTool,
  requiresInput,
} from './mcp/index.js';
export type { McpServerTool, McpToolDescriptor, McpToolResult, McpInputRequest } from './mcp/index.js';

export {
  ACP_LOSSY,
  ACP_METHODS,
  ACP_NOTIFICATIONS,
  ACP_PROTOCOL_VERSION,
  AcpAdapter,
  AcpApprovalChannel,
  AcpFsBridge,
  AcpServer,
  AcpTerminalBridge,
  acpOutcomeFromApproval,
  approvalFromAcpOutcome,
  optionsFromAcp,
  optionsToAcp,
  assertPathInsideRoots,
  isPathInsideRoots,
  contentToInputBlocks,
  inputBlocksToContent,
  stopReasonFor,
} from './acp/index.js';
export type {
  AcpClientCapabilities,
  AcpContentBlock,
  AcpPermissionOption,
  AcpPermissionOutcome,
  AcpPermissionRequest,
  AcpStopReason,
  AcpTurnInput,
  AcpTurnResult,
} from './acp/index.js';

export type { ReverseInvokeGateway, ReverseInvokeRequest } from './shared/index.js';
