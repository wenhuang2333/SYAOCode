/**
 * MCP 客户端服务（FR-N-001）。
 *
 * 职责边界（`27` §4.1 / §5.1 / §6 / §12）：
 *  - 只做**客户端**：把受信 MCP 服务（stdio 命令或 HTTP 端点）的工具映射成内核
 *    `Tool`，由 `agent-factory` 注册进 `ToolRegistry`。
 *  - **不实现 MCP 服务端**（FR-N-002 明确不做）。
 *  - 传输只有两种：stdio（`command` + `args`）与 http（`url`）。
 *
 * 安全姿态（硬约束，不可放宽）：
 *  - **未受信不启动**：只有 `trusted === true` 的服务才会被拉起；未受信服务既不
 *    执行工具，也不出现在 `toolDefinitions()` 里（`-32029` mcp_not_trusted）。
 *  - **env 只允许变量名**：`/^[A-Za-z_][A-Za-z0-9_]*$/`。值从 Host 启动环境
 *    （`McpServiceOptions.env`）取，**不落盘、不回显、不进状态**；本服务对外只
 *    暴露 `envNames` 这一概念（状态持久化由 host.ts 负责）。
 *  - **不过 shell**：stdio 走 `Runtime.shell.spawn(command, args)`（参数是数组，
 *    `shell: false`）；命令里出现 shell 元字符一律拒绝。
 *  - **工具结果是不可信内容**：`trust: 'untrusted'`；调用失败返回 `isError`
 *    输出而不是抛未处理异常——第三方 MCP 服务崩了，Host 不能跟着崩。
 *
 * 崩溃可观测（TC-N-021）：stdio 通道 `onClose` → 状态置 `error` 并触发
 * `onChanged`；`restart()` 能重新拉起。
 */

import { z } from 'zod';
import type { Runtime, Tool, ToolContext, ToolOutput, ToolResultContent } from '@syaocode/core';
import { nodeRuntime } from '@syaocode/node';
import {
  MCP_PROTOCOL_VERSION,
  McpClient,
  createHttpChannel,
  createStdioChannel,
} from '@syaocode/protocols';
import type { DuplexChannel, McpToolDescriptor, McpToolResult } from '@syaocode/protocols';
import { buildMcpHttpHeaders } from '@syaocode/protocols/mcp';
import type { McpContentBlock } from '@syaocode/protocols/mcp';
import type {
  McpAddParams,
  McpAddResult,
  McpServerInfo,
  McpServerStatus,
  McpToolSummary,
  McpToolsResult,
} from '@syaocode/dhp';

/** MCP 服务的失败语义：与 `27` §5.2 的 `-32026…-32029` 一一对应。 */
export type McpFailureKind = 'mcp_unavailable' | 'mcp_spawn_failed' | 'mcp_tool_failed' | 'mcp_not_trusted';

/** 服务层错误：host.ts 按 `kind` 映射成 DHP 错误码，**不**在业务层手写数字码。 */
export class McpServiceError extends Error {
  readonly kind: McpFailureKind;

  constructor(kind: McpFailureKind, message: string) {
    super(message);
    this.name = 'McpServiceError';
    this.kind = kind;
  }
}

export interface McpServiceOptions {
  /** 注入的内核运行时；缺省用 `@syaocode/node` 的 `nodeRuntime()`。 */
  runtime?: Runtime;
  /** Host 启动环境：`envNames` 的值**只**从这里取（缺省 `process.env`）。 */
  env?: Record<string, string | undefined>;
  /** 状态变化回调（`mcp.changed` 事件的数据源）。 */
  onChanged?: (serverId: string, status: McpServerStatus) => void;
}

/** 环境变量名：只允许 POSIX 标识符，杜绝 `NAME=VALUE` 形式的"值"混进来。 */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** shell 元字符：stdio 命令一旦带这些字符就拒绝（即使当前 spawn 不过 shell）。 */
const SHELL_METACHARACTERS = /[;|&$`><\n\r]/;

/**
 * 传给 stdio 子进程的**基础**环境变量白名单。
 *
 * 只给"让普通可执行文件能跑起来"的最小集合；其余变量必须由用户显式写成
 * `envNames` 才会传入——这正是"env 只允许变量名"的意义：不把 Host 的全部
 * 环境（含密钥）无差别暴露给第三方 MCP 进程。
 *
 * 注：内核 `Runtime.shell` 的 `env` 语义是"在进程环境之上追加"，因此子进程
 * 实际仍能继承 Host 的环境；本白名单保证的是**显式声明**这一层的行为可预期。
 */
const BASE_ENV_NAMES: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
  'NODE_PATH',
];

const CONNECT_TIMEOUT_MS = 15_000;
const TOOL_TIMEOUT_MS = 60_000;

interface ServerEntry {
  readonly id: string;
  readonly name: string;
  readonly transport: 'stdio' | 'http';
  readonly command: string | null;
  readonly args: readonly string[];
  readonly url: string | null;
  readonly envNames: readonly string[];
  readonly trusted: boolean;
  readonly createdAt: number;
  status: McpServerStatus;
  toolCount: number;
  lossy: readonly string[];
  detail: string | null;
  updatedAt: number;
  client: McpClient | undefined;
  channel: DuplexChannel | undefined;
  tools: readonly McpToolDescriptor[];
  /** 主动关闭中：此时通道关闭是预期行为，不置 `error`。 */
  closing: boolean;
}

export class McpService {
  private readonly runtime: Runtime;
  private readonly env: Record<string, string | undefined>;
  private readonly onChanged: ((serverId: string, status: McpServerStatus) => void) | undefined;
  private readonly servers = new Map<string, ServerEntry>();

  constructor(opts: McpServiceOptions) {
    this.runtime = opts.runtime ?? nodeRuntime();
    this.env = opts.env ?? process.env;
    this.onChanged = opts.onChanged;
  }

  // ── 查询 ──────────────────────────────────────────────────────────────

  /** 服务列表（不含任何环境变量值、不含任何凭据）。 */
  list(): McpServerInfo[] {
    return [...this.servers.values()].map((entry) => toInfo(entry));
  }

  /** 供界面/诊断用的工具摘要；未受信或未就绪时按语义报错。 */
  async tools(serverId: string): Promise<McpToolsResult> {
    const entry = this.require(serverId);
    if (!entry.trusted) {
      throw new McpServiceError('mcp_not_trusted', `MCP 服务 ${serverId} 未受信，拒绝列出或执行工具`);
    }
    if (entry.status !== 'ready' || entry.client === undefined) {
      // 惰性重连：界面点开工具清单时给一次恢复机会。
      await this.start(entry);
      if (entry.status !== 'ready' || entry.client === undefined) {
        throw new McpServiceError('mcp_spawn_failed', entry.detail ?? `MCP 服务 ${serverId} 未就绪`);
      }
    }
    return { serverId, tools: entry.tools.map((tool) => toSummary(tool)) };
  }

  /**
   * 供 `agent-factory` 注册工具：返回内核 `Tool` 定义（MCP 工具进 `ToolRegistry`）。
   *
   * 只有**受信且 ready** 的服务的工具会出现在这里；名称统一加
   * `mcp__<serverId>__<tool>` 前缀，保证跨服务唯一且字符合法。
   */
  toolDefinitions(): Tool[] {
    const out: Tool[] = [];
    const used = new Set<string>();
    for (const entry of this.servers.values()) {
      if (!entry.trusted || entry.status !== 'ready' || entry.client === undefined) continue;
      for (const descriptor of entry.tools) {
        const name = uniqueToolName(toolName(entry.id, descriptor.name), used);
        out.push(this.makeTool(entry, descriptor, name));
      }
    }
    return out;
  }

  // ── 增删与生命周期 ────────────────────────────────────────────────────

  /**
   * 添加 MCP 服务。
   *
   * 未受信服务也会登记（状态 `stopped`），但**不会启动**；受信服务会立即探测
   * 一次：成功 → `ready` + 工具数，失败 → `error` + 一句不含敏感信息的 `detail`
   * （`add` 本身不抛错，让界面能看到失败状态并重试）。
   */
  async add(params: McpAddParams): Promise<McpAddResult> {
    const hasCommand = typeof params.command === 'string' && params.command.trim() !== '';
    const hasUrl = typeof params.url === 'string' && params.url.trim() !== '';
    if (!hasCommand && !hasUrl) {
      throw new McpServiceError('mcp_spawn_failed', 'MCP 服务必须提供 command（stdio）或 url（http）之一');
    }
    if (hasCommand && hasUrl) {
      throw new McpServiceError('mcp_spawn_failed', 'MCP 服务不能同时提供 command 与 url，请只选一种传输');
    }

    const envNames = validateEnvNames(params.envNames);
    const transport: 'stdio' | 'http' = hasCommand ? 'stdio' : 'http';
    const command = hasCommand ? validateCommand(params.command ?? '') : null;
    const args = hasCommand ? validateArgs(params.args) : [];
    const url = hasCommand ? null : validateUrl(params.url ?? '');
    const name = (params.name ?? '').trim() !== '' ? (params.name ?? '').trim() : defaultName(transport, command, url);
    const id = this.nextId(name);
    const now = Date.now();

    const entry: ServerEntry = {
      id,
      name,
      transport,
      command,
      args,
      url,
      envNames,
      trusted: params.trusted === true,
      createdAt: now,
      status: 'idle',
      toolCount: 0,
      lossy: [],
      detail: null,
      updatedAt: now,
      client: undefined,
      channel: undefined,
      tools: [],
      closing: false,
    };
    this.servers.set(id, entry);

    if (!entry.trusted) {
      entry.status = 'stopped';
      entry.detail = '未受信：不会启动，也不会执行任何工具';
      this.notify(entry);
      return { server: toInfo(entry) };
    }

    await this.start(entry);
    return { server: toInfo(entry) };
  }

  /** 移除服务：关闭连接/进程并从列表消失（工具也随之从 `toolDefinitions()` 消失）。 */
  async remove(serverId: string): Promise<{ removed: true }> {
    const entry = this.require(serverId);
    await this.teardown(entry);
    this.servers.delete(serverId);
    this.notify({ ...entry, status: 'stopped' });
    return { removed: true };
  }

  /** 重启服务：先关旧连接/进程，再重新拉起；失败时返回 `error` 状态而不是抛错。 */
  async restart(serverId: string): Promise<McpServerInfo> {
    const entry = this.require(serverId);
    if (!entry.trusted) {
      throw new McpServiceError('mcp_not_trusted', `MCP 服务 ${serverId} 未受信，拒绝启动`);
    }
    await this.teardown(entry);
    await this.start(entry);
    return toInfo(entry);
  }

  /** 关闭全部连接与子进程（Host 关停时调用）。 */
  async close(): Promise<void> {
    for (const entry of this.servers.values()) {
      await this.teardown(entry);
      entry.status = 'stopped';
      entry.updatedAt = Date.now();
    }
  }

  // ── 内部：连接 ────────────────────────────────────────────────────────

  private async start(entry: ServerEntry): Promise<void> {
    entry.status = 'starting';
    entry.detail = null;
    entry.updatedAt = Date.now();
    this.notify(entry);

    try {
      const channel = this.buildChannel(entry);
      const client = new McpClient({
        runtime: this.runtime,
        channel,
        serverId: entry.id,
        transport: entry.transport,
        requestTimeoutMs: CONNECT_TIMEOUT_MS,
      });
      entry.client = client;
      entry.channel = channel;
      entry.closing = false;
      // 进程崩溃 / 连接断开必须可观测（TC-N-021），且不能把 Host 拖崩。
      channel.onClose(() => {
        this.handleChannelClosed(entry);
      });

      await client.connect();
      const tools = await client.listTools();
      entry.tools = tools;
      entry.toolCount = tools.length;
      entry.lossy = client.lossy;
      entry.status = 'ready';
      entry.detail = null;
    } catch (error) {
      entry.status = 'error';
      entry.toolCount = 0;
      entry.tools = [];
      entry.lossy = [];
      entry.detail = describeFailure(error);
      await this.teardown(entry);
    }

    entry.updatedAt = Date.now();
    this.notify(entry);
  }

  /** 建立传输通道；env 校验失败等前置问题在这里抛 `McpServiceError`。 */
  private buildChannel(entry: ServerEntry): DuplexChannel {
    if (entry.transport === 'stdio') {
      const command = entry.command;
      if (command === null) {
        throw new McpServiceError('mcp_spawn_failed', 'stdio 传输缺少 command');
      }
      const { channel } = createStdioChannel(this.runtime, command, [...entry.args], {
        env: this.buildEnv(entry),
      });
      return channel;
    }
    const url = entry.url;
    if (url === null) {
      throw new McpServiceError('mcp_spawn_failed', 'http 传输缺少 url');
    }
    return createHttpChannel(this.runtime, url, {
      headersFor: (body) => buildMcpHttpHeaders(body, { protocolVersion: MCP_PROTOCOL_VERSION }),
      label: `mcp-http:${url}`,
    });
  }

  /**
   * 组装子进程环境。
   *
   * 只有 `envNames` 里声明的变量会**按名字**从 Host 启动环境取值；某个名字在
   * Host 环境里不存在 → 启动失败（变量名本身不是秘密，可以写进 detail）。
   */
  private buildEnv(entry: ServerEntry): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of BASE_ENV_NAMES) {
      const value = this.env[name];
      if (typeof value === 'string') out[name] = value;
    }
    for (const name of entry.envNames) {
      const value = this.env[name];
      if (value === undefined) {
        throw new McpServiceError('mcp_spawn_failed', `环境变量 ${name} 未在 Host 启动环境中设置`);
      }
      out[name] = value;
    }
    return out;
  }

  /** 通道被关闭：主动关闭 → 忽略；被动断开 → 置 error 并通知界面。 */
  private handleChannelClosed(entry: ServerEntry): void {
    if (entry.closing) return;
    entry.status = 'error';
    entry.toolCount = 0;
    entry.tools = [];
    entry.detail = 'MCP 服务连接已断开（进程退出或连接中断），可尝试重启';
    entry.updatedAt = Date.now();
    // 关闭连接以立即结算挂起的请求，避免调用方等满超时。
    const client = entry.client;
    entry.client = undefined;
    entry.channel = undefined;
    if (client !== undefined) void client.close().catch(() => undefined);
    this.notify(entry);
  }

  /** 关闭客户端与通道；`closing` 置位保证 onClose 不会把状态误置为 error。 */
  private async teardown(entry: ServerEntry): Promise<void> {
    entry.closing = true;
    const client = entry.client;
    const channel = entry.channel;
    entry.client = undefined;
    entry.channel = undefined;
    entry.tools = [];
    entry.toolCount = 0;
    if (client !== undefined) {
      try {
        await client.close();
      } catch {
        /* 关闭一个已经坏掉的连接不是错误 */
      }
    }
    if (channel !== undefined) {
      try {
        await channel.close('service-close');
      } catch {
        /* 同上 */
      }
    }
  }

  // ── 内部：工具映射 ────────────────────────────────────────────────────

  private makeTool(entry: ServerEntry, descriptor: McpToolDescriptor, name: string): Tool {
    const client = entry.client;
    const readOnly = descriptor.annotations?.readOnlyHint === true;
    const toolName = descriptor.name;
    const description = descriptor.description ?? descriptor.title ?? `MCP 工具 ${toolName}`;
    const execute = async (input: unknown, ctx: ToolContext): Promise<ToolOutput> => {
      if (client === undefined) {
        return errorOutput('MCP 服务已断开，工具不可用；请先重启该服务');
      }
      if (!entry.trusted) {
        return errorOutput('MCP 服务未受信，拒绝执行工具');
      }
      try {
        const outcome = await client.callTool(toolName, input ?? {}, { signal: ctx.signal });
        return toToolOutput(outcome.result);
      } catch (error) {
        return errorOutput(`MCP 工具调用失败：${describeFailure(error)}`);
      }
    };
    return {
      name,
      description,
      // 不伪造具体 schema：MCP 的 inputSchema 是 JSON Schema，不是 zod；这里只声明
      // "任意对象"，真正的参数校验交给对端服务。
      inputSchema: z.record(z.unknown()),
      risk: readOnly ? 'read' : 'write',
      readOnly,
      concurrencySafe: readOnly,
      timeoutMs: TOOL_TIMEOUT_MS,
      trust: 'untrusted',
      execute,
    };
  }

  // ── 内部：杂项 ────────────────────────────────────────────────────────

  private require(serverId: string): ServerEntry {
    const entry = this.servers.get(serverId);
    if (entry === undefined) {
      throw new McpServiceError('mcp_unavailable', `MCP 服务 ${serverId} 不存在`);
    }
    return entry;
  }

  private nextId(seed: string): string {
    const base = slugify(seed);
    let id = base;
    let n = 2;
    while (this.servers.has(id)) {
      id = `${base}-${n}`;
      n += 1;
    }
    return id;
  }

  private notify(entry: ServerEntry): void {
    this.onChanged?.(entry.id, entry.status);
  }
}

// ── 校验 ────────────────────────────────────────────────────────────────

function validateCommand(raw: string): string {
  const command = raw.trim();
  if (command === '') {
    throw new McpServiceError('mcp_spawn_failed', 'stdio 的 command 不能为空');
  }
  if (command.includes('\0')) {
    throw new McpServiceError('mcp_spawn_failed', 'stdio 的 command 不能包含 NUL 字符');
  }
  if (SHELL_METACHARACTERS.test(command)) {
    throw new McpServiceError('mcp_spawn_failed', 'stdio 的 command 不允许包含 shell 元字符（; | & $ ` > <）');
  }
  return command;
}

function validateArgs(raw: readonly string[] | undefined): string[] {
  const args = raw ?? [];
  return args.map((arg, index) => {
    if (typeof arg !== 'string') {
      throw new McpServiceError('mcp_spawn_failed', `stdio 的 args[${index}] 必须是字符串`);
    }
    if (arg.includes('\0')) {
      throw new McpServiceError('mcp_spawn_failed', `stdio 的 args[${index}] 不能包含 NUL 字符`);
    }
    return arg;
  });
}

function validateEnvNames(raw: readonly string[] | undefined): string[] {
  const names = raw ?? [];
  const seen = new Set<string>();
  for (const name of names) {
    if (typeof name !== 'string' || !ENV_NAME_PATTERN.test(name)) {
      throw new McpServiceError(
        'mcp_spawn_failed',
        `envNames 只允许环境变量名（/^[A-Za-z_][A-Za-z0-9_]*$/），收到 ${JSON.stringify(name)}`,
      );
    }
    if (seen.has(name)) continue;
    seen.add(name);
  }
  return [...seen];
}

function validateUrl(raw: string): string {
  const value = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new McpServiceError('mcp_spawn_failed', 'http 的 url 不是合法 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new McpServiceError('mcp_spawn_failed', 'http 的 url 只允许 http/https 协议');
  }
  return value;
}

// ── 展示 ────────────────────────────────────────────────────────────────

function toInfo(entry: ServerEntry): McpServerInfo {
  return {
    id: entry.id,
    name: entry.name,
    transport: entry.transport,
    status: entry.status,
    toolCount: entry.toolCount,
    lossy: [...entry.lossy],
    trusted: entry.trusted,
    detail: entry.detail,
    command: entry.command,
    url: entry.url,
    updatedAt: entry.updatedAt,
  };
}

function toSummary(tool: McpToolDescriptor): McpToolSummary {
  return {
    name: tool.name,
    description: tool.description ?? tool.title ?? '',
    inputSchemaSummary: summarizeSchema(tool.inputSchema),
    readOnly: tool.annotations?.readOnlyHint === true,
  };
}

/** schema 摘要：只给属性名 + 类型，**不**把完整 JSON Schema 推给渲染层。 */
function summarizeSchema(schema: unknown): string {
  if (schema === null || typeof schema !== 'object') return '无参数';
  const record = schema as { properties?: unknown; required?: unknown; type?: unknown };
  const properties = record.properties;
  if (properties === null || typeof properties !== 'object') {
    return typeof record.type === 'string' ? record.type : '无参数';
  }
  const required = Array.isArray(record.required) ? (record.required as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  const entries = Object.entries(properties as Record<string, unknown>).map(([key, value]) => {
    const type = value !== null && typeof value === 'object' ? (value as { type?: unknown }).type : undefined;
    return `${key}${required.includes(key) ? '' : '?'}:${typeof type === 'string' ? type : 'any'}`;
  });
  if (entries.length === 0) return '无参数';
  const text = `{${entries.join(', ')}}`;
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

// ── 工具名与结果映射 ────────────────────────────────────────────────────

/** `provider` 风格的安全标识符（已保证字符集合法、长度有限）。 */
function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return slug === '' ? 'mcp' : slug.slice(0, 40);
}

/**
 * 内核工具名：`mcp__<serverId>__<tool>`。
 *
 * 只保留 `[A-Za-z0-9_-]`，并限制总长 64（模型侧 function name 的常见上限）。
 */
function toolName(serverId: string, rawToolName: string): string {
  const prefix = `mcp__${slugify(serverId)}__`;
  const cleaned = rawToolName.replace(/[^A-Za-z0-9_-]/g, '_');
  const room = Math.max(1, 64 - prefix.length);
  const body = cleaned === '' ? 'tool' : cleaned.slice(0, room);
  return `${prefix}${body}`;
}

function uniqueToolName(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let n = 2;
  for (;;) {
    const suffix = `_${n}`;
    const next = `${candidate.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    if (!used.has(next)) {
      used.add(next);
      return next;
    }
    n += 1;
  }
}

function toToolOutput(result: McpToolResult): ToolOutput {
  const content: ToolResultContent[] = [];
  for (const block of result.content ?? []) {
    content.push(mapContentBlock(block));
  }
  if (content.length === 0 && result.structuredContent !== undefined) {
    content.push({ type: 'text', text: safeJson(result.structuredContent) });
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: '（MCP 工具没有返回内容）' });
  }
  const output: ToolOutput = { content, meta: { trust: 'untrusted' } };
  if (result.isError === true) output.isError = true;
  return output;
}

function mapContentBlock(block: McpContentBlock): ToolResultContent {
  if (block.type === 'text') {
    return { type: 'text', text: typeof block.text === 'string' ? block.text : safeJson(block) };
  }
  if (block.type === 'image') {
    if (typeof block.data === 'string' && typeof block.mimeType === 'string') {
      return { type: 'image', source: { type: 'base64', mediaType: block.mimeType, data: block.data } };
    }
    if (typeof block.uri === 'string') {
      return { type: 'image', source: { type: 'url', url: block.uri } };
    }
    return { type: 'text', text: '[image]' };
  }
  return { type: 'text', text: safeJson(block) };
}

function errorOutput(text: string): ToolOutput {
  return { isError: true, content: [{ type: 'text', text }] };
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
  } catch {
    return String(value);
  }
}

/**
 * 失败原因：一句给用户看的话，**已脱敏**。
 *
 * 红线 1：任何环境变量值、令牌、URL 内嵌凭据都不得出现在 `detail` 里。
 */
function describeFailure(error: unknown): string {
  if (error instanceof McpServiceError) return redactDetail(error.message);
  if (error instanceof Error) return redactDetail(error.message);
  return redactDetail(String(error));
}

function redactDetail(value: string): string {
  return value
    .replace(/([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/\bBearer\s+\S+/gi, 'Bearer ***')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+)(:[^/@\s]*)?@/gi, '$1$2:***@')
    .slice(0, 240);
}

function defaultName(transport: 'stdio' | 'http', command: string | null, url: string | null): string {
  if (transport === 'stdio' && command !== null) {
    const base = command.split(/[\\/]/).pop() ?? command;
    return base === '' ? 'mcp-stdio' : base;
  }
  if (url !== null) {
    try {
      return new URL(url).host;
    } catch {
      return 'mcp-http';
    }
  }
  return 'mcp';
}
