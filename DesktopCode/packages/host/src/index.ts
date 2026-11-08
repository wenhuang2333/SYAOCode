/**
 * `@liwencode/host` —— LIWENCode 桌面宿主进程。
 *
 * 这个包**只在 Node 里运行**，且**不得** import `electron`：
 * Host 必须能脱离 shell 独立启动（`liwen host` / 测试 / 未来的 `liwen web`）。
 *
 * 职责：
 *   host.ts              装配：DHP 方法实现与事件桥接
 *   dhp-server.ts        WebSocket + 令牌握手 + 方法派发 + 错误映射
 *   session-registry.ts  会话集合、事件环、投影（复用 dhp 的 fold）
 *   interaction-broker.ts 内核审批 ⇄ DHP 交互（超时 fail-closed、结算幂等）
 *   agent-factory.ts     provider/model 解析与 Agent 创建
 *   config-service.ts    分层配置 + 原子写回
 *   workspace.ts         文件树 / 读取 / 差异 + 路径围栏
 *   paths.ts             数据目录唯一入口（OI-D-07）
 *   home-migration.ts    旧数据目录（`~/.syaocode`）→ 新目录的安全迁移
 */

export { createHost, type HomeMigrationOverride, type HostOptions, type RunningHost } from './host.ts';
export {
  startDhpServer,
  DhpServerError,
  DhpProtocolError,
  HOST_VERSION,
  isLoopback,
  mapError,
  newToken,
  tokenMatches,
  type DhpHandler,
  type DhpHandlerContext,
  type DhpServerHandle,
  type DhpServerOptions,
} from './dhp-server.ts';
export {
  SessionRegistry,
  EVENT_RING_SIZE,
  toSessionEvents,
  pumpAgentEvents,
  addUsage,
  type SessionState,
} from './session-registry.ts';
export {
  InteractionBroker,
  INTERACTION_TIMEOUT_MS,
  toPendingInteraction,
  type InteractionRecord,
  type ResolveOutcome,
} from './interaction-broker.ts';
export {
  buildProvider,
  createDesktopAgent,
  hasKeyFor,
  parseModelSpec,
  providerNeedsKey,
  type CreateDesktopAgentOptions,
  type ModelSpec,
} from './agent-factory.ts';
export { ConfigService, type EffectiveConfig, type Language } from './config-service.ts';
export {
  WorkspaceService,
  WorkspaceAccessError,
  diffLines,
  type DiffHunk,
  type TreeNode,
  type WorkspaceServiceOptions,
} from './workspace.ts';
export {
  LEGACY_HOME_DIR_NAME,
  LEGACY_HOME_ENV,
  LIWENCODE_HOME_DIR_NAME,
  LIWENCODE_HOME_ENV,
  LIWENHomeError,
  MIGRATION_MARKER_FILE,
  redactHomeInPath,
  resolveHomePlan,
  resolveLIWENHome,
  sessionLogPath,
  liwenPaths,
  type HomePlan,
  type LegacyHomeSource,
  type LegacyHomeSourceKind,
  type LIWENPaths,
} from './paths.ts';
export {
  migrateLegacyHome,
  nodeMigrationFs,
  type HomeMigrationOptions,
  type HomeMigrationResult,
  type HomeMigrationWarning,
  type HomeMigrationWarningCode,
  type MigrationFs,
  type MigrationMarker,
  type MigrationStat,
} from './home-migration.ts';
export {
  MemoryCredentialProvider,
  keychainEntryFor,
  nonce,
  redactSecret,
  secretFingerprint,
} from './credentials.ts';
export type { CredentialBridge, CredentialProvider } from './credentials.ts';
export {
  IpcCredentialBridge,
  UnavailableCredentialProvider,
  processCredentialChannel,
} from './credential-bridge.ts';
export type { CredentialIpcChannel, CredentialIpcOp } from './credential-bridge.ts';
export {
  GitError,
  assertRelativePath,
  assertSafeGitArgs,
  assertSafeRemoteUrl,
  cleanEnv,
  gitAvailable,
  isGitRepository,
  redact,
  requireRepository,
  resetGitAvailability,
  runGit,
  sanitizeRemoteUrl,
  type GitFailureKind,
  type GitRunOptions,
  type GitRunResult,
} from './git-run.ts';
export { statFile, readTextPreview, type FileStat, type FileStatKind } from './file-stat.ts';
export {
  GitAuthService,
  GitAuthError,
  GIT_AUTH_FAILURE_KINDS,
  isGitAuthError,
  hostFromRemoteUrl,
  type GitAuthFailureKind,
  type GitAuthHydrateRecord,
} from './git-auth.ts';
export { GitService, type GitServiceOptions } from './git-service.ts';
export { GitWriteService, isSigningFailure, type GitAuditSink, type GitStatusReader } from './git-write.ts';
export { GitUploadService, dhpCodeForGitError, dhpKindForGitError } from './git-upload.ts';
export { McpService, McpServiceError, type McpServiceOptions } from './mcp-service.ts';
export { AgentsService, AgentsServiceError, type AgentsServiceOptions } from './agents-service.ts';
export {
  runCommand,
  CommandDeniedError,
  MAX_COMMAND_LENGTH,
  MAX_COMMAND_OUTPUT_BYTES,
  DEFAULT_COMMAND_TIMEOUT_MS,
  type CommandAuditRecord,
  type RunCommandInput,
  type RunCommandOptions,
  type RunCommandResult,
} from './run-command.ts';
export {
  CommitMessageService,
  buildCommitPrompt,
  sanitizeCommitMessage,
  fallbackCommitMessage,
  COMMIT_TYPES,
  DEFAULT_COMMIT_TIMEOUT_MS,
  DEFAULT_COMMIT_MAX_DIFF_BYTES,
  type CommitMessageInput,
  type CommitMessageResult,
  type CommitMessageServiceOptions,
  type CommitType,
  type CompletionFn,
  type CompletionRequest,
} from './commit-message.ts';
export {
  ChangesCollector,
  createChangeToolHooks,
  pathFromToolInput,
  type ChangeToolHooks,
  type ChangesSnapshot,
} from './changes.ts';
