/**
 * `@syaocode/host` —— SYAOCode 桌面宿主进程。
 *
 * 这个包**只在 Node 里运行**，且**不得** import `electron`：
 * Host 必须能脱离 shell 独立启动（`syao host` / 测试 / 未来的 `syao web`）。
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
 */

export { createHost, type HostOptions, type RunningHost } from './host.ts';
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
  SYAOCODE_HOME_ENV,
  SyaoHomeError,
  redactHomeInPath,
  resolveSyaoHome,
  sessionLogPath,
  syaoPaths,
  type SyaoPaths,
} from './paths.ts';
