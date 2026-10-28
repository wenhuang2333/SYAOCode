/**
 * @syaocode/core — the SYAOCode kernel.
 * Depends only on zod; no UI, no provider SDKs, no global state (NFR-012/015).
 */

// errors
export { ERROR_REGISTRY, ALL_ERROR_CODES, ERROR_DOMAINS, DOMAIN_CATEGORY, lookupError, requireError } from './errors/registry.js';
export type { ErrorCategory, ErrorDomain, ErrorCodeEntry, Recovery, Severity } from './errors/registry.js';
export { SyaoError, ProviderError, ToolError, PermissionError, FsError, ContextError, SessionError, InternalError } from './errors/syao-error.js';
export type { ErrorInit, SerializedError } from './errors/syao-error.js';
export { MESSAGES_ZH_CN } from './errors/messages-zh.js';

// types
export type { ContentBlock, ImageSource, Message, MessageMeta, Role, StopReason, ToolCall, ToolResultBlock, ToolResultContent, ToolUseBlock, Usage } from './types.js';
export { textOf, toolCallsOf, userText, assistantText } from './types.js';

// runtime
export type { Clock, DirEntry, Env, FileStat, FileSystem, Hasher, HttpClient, HttpResponse, IdGenerator, LogLevel, Logger, ProcessChunkStream, ProcessHandle, ProcessStdin, Runtime, Shell, ShellSpawnOptions } from './runtime/index.js';
export { MemoryLogger, decodeChunkStream, noopLogger } from './runtime/index.js';
export { contentHash, sha256Hex, sha256Bytes, chainHash } from './hash.js';

// events
export type { AgentEvent, AgentEventBody, EndReason, EventEnvelope, EventSink, PersistedEventType, PermissionMode, UsageEvent } from './events.js';
export {
  AGENT_EVENT_SCHEMA_VERSION,
  EventBus,
  MemoryEventSink,
  PERSISTED_EVENT_TYPES,
  isPersistableEvent,
  logEntryTypeOf,
} from './events.js';

// provider
export type { Capabilities, ModelRequest, ModelStreamEvent, Pricing, Provider, RetryPolicy, ToolDefinition } from './provider.js';
export { withRetry, DEFAULT_RETRY_POLICY, mapHttpStatus } from './provider.js';

// tool
export type { GovernedToolCall, PermissionSubject, PromptContext, Tool, ToolContext, ToolGovernor, ToolOutput, ToolProgress, ToolResultMeta, ToolRisk } from './tool.js';
export { ToolRegistry, zodToJsonSchema, textContent } from './tool.js';

// permissions
export type { EngineOutcome, EngineOptions, PermissionDecision, PermissionHandler, PermissionRequest, PermissionRule, PermissionRuleStore, PolicyVerdict, CommandClass } from './permissions.js';
export { MemoryPermissionRuleStore, PermissionEngine, classifyCommand, commandPathCandidates, globMatch } from './permissions.js';

// pipeline
export { executeToolCall, truncateOutput, TRUNCATION_MAX_CHARS, TRUNCATION_MAX_LINES } from './pipeline.js';
export type { PipelineEvents } from './pipeline.js';

// context
export type { ContextConfig } from './context.js';
export { assembleSystemPrompt, estimateTokens, estimateMessagesTokens, trimOldToolResults } from './context.js';

// config
export type { RpcConfig, SyaoConfig, LoadConfigOptions } from './config.js';
export {
  configSchema,
  loadConfig,
  permissionRuleSchema,
  resolveServerToken,
  rpcConfigSchema,
  rpcProtocolSchema,
  rulesFromConfig,
} from './config.js';

// session
export type { LogEntry, SessionFilter, SessionInfo, SessionStore } from './session/index.js';
export { MemorySessionStore, FileSessionStore, projectHashOf } from './session/index.js';

// redact
export { Redactor, RedactingLogger, RedactingSessionStore, redactToolResultContent } from './redact.js';

// evidence / verification / claims
export type { ReceiptStore, SandboxLevel, Sha256, StoredOutput, TestStats, ToolGovernanceRef, ToolReceipt, TrustLevel, VerificationReport, VerificationResult } from './evidence.js';
export { MemoryReceiptStore, defaultSha256, fencingHash, parseTestStats, receiptInputHash, stableStringify } from './evidence.js';
export type { DiscoveredCommand, VerificationOptions } from './verify.js';
export { discoverVerification, runVerification, verificationPassed } from './verify.js';
export type { ClaimCheck, ClaimKind, ClaimStatus, Verdict } from './claims.js';
export { lintClaims, verdictOf } from './claims.js';

// agent
export type { Agent, AgentConfig, Limits, RunOptions, RunSummary } from './agent.js';
export { createAgent, planBatches, totalTokensOf } from './agent.js';
