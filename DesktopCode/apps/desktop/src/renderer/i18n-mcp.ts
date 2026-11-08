/**
 * MCP 服务页文案目录（`27` FR-N-001）。
 *
 * 与 `i18n.ts` / `i18n-views.ts` / `i18n-agents.ts` 同一套纪律：中英键集对等、
 * 无空串、未知键 `⟦path⟧`、`{name}` 插值缺参保留原样。单独成文件是因为这三个页面
 * 是最后一批并行抽取的，合进已有大文件只会让合并本身变成风险。
 *
 * 一条额外纪律（安全性，不是排版）：`trust.untrustedNotice` 是本页最重要的承诺——
 * 未受信服务**不会启动、不会把工具暴露给模型**。这句只能照着 Host 的实际行为写，
 * 不允许被"弱化"成"建议谨慎"之类的话。`test/i18n-mcp.test.ts` 会盯着它。
 */

import type { Lang } from './i18n';

export interface McpMessages {
  /** 服务状态（Host 的 `McpServerStatus`）。 */
  readonly status: {
    readonly idle: string;
    readonly starting: string;
    readonly ready: string;
    readonly error: string;
    readonly stopped: string;
    /** 未知状态（不假装是 idle）。 */
    readonly unknown: string;
  };
  /** 传输方式。 */
  readonly transport: {
    readonly stdio: string;
    readonly http: string;
    readonly unknown: string;
  };
  /** 受信 / 未受信。 */
  readonly trust: {
    readonly trusted: string;
    readonly untrusted: string;
    /** 未受信时的明确承诺：不启用、不暴露工具。 */
    readonly untrustedNotice: string;
    /** 添加表单里的受信勾选框。 */
    readonly toggle: string;
  };
  /** 服务卡片上的明细。 */
  readonly detail: {
    readonly toolCount: string;
    readonly toolCountUnknown: string;
    readonly lossyNone: string;
    readonly lossy: string;
    readonly envNames: string;
    readonly envNamesNone: string;
    readonly toolReadOnly: string;
    readonly toolWritable: string;
    /** `aria-label` 里的括号包裹形式（中文全角 / 英文半角）。 */
    readonly toolKindReadOnly: string;
    readonly toolKindWritable: string;
    readonly toolLabel: string;
    readonly emptyTools: string;
    /** 列表项之间的分隔符（中文顿号 / 英文逗号）。 */
    readonly listSeparator: string;
  };
  /** 页面骨架与列表。 */
  readonly page: {
    readonly eyebrow: string;
    readonly title: string;
    readonly subtitle: string;
    readonly hostBadge: string;
    readonly configuredTitle: string;
    readonly loading: string;
    readonly empty: string;
    readonly expandTools: string;
    readonly collapseTools: string;
    readonly restart: string;
    readonly remove: string;
  };
  /** 添加表单。 */
  readonly form: {
    readonly title: string;
    readonly nameLabel: string;
    readonly transportLabel: string;
    readonly stdioOption: string;
    readonly httpOption: string;
    readonly commandLabel: string;
    readonly commandPlaceholder: string;
    readonly argsLabel: string;
    readonly argsPlaceholder: string;
    readonly urlLabel: string;
    readonly urlPlaceholder: string;
    readonly envLabel: string;
    readonly envPlaceholder: string;
    readonly envNote: string;
    readonly addButton: string;
    readonly addNote: string;
    readonly submitted: string;
    readonly addFailed: string;
    readonly toolsFailed: string;
  };
  /** 表单校验错误。 */
  readonly error: {
    readonly nameTooLong: string;
    readonly envValueNotAllowed: string;
    readonly envInvalid: string;
    readonly commandRequired: string;
    readonly stdioNoUrl: string;
    readonly urlRequired: string;
    readonly urlScheme: string;
    readonly urlCredentials: string;
    readonly urlInvalid: string;
    readonly httpNoCommand: string;
  };
  /** 页脚的能力说明。 */
  readonly capabilityNote: string;
}

const zh: McpMessages = {
  status: {
    idle: '空闲',
    starting: '启动中',
    ready: '就绪',
    error: '不可用',
    stopped: '已停止',
    unknown: '未知状态',
  },
  transport: {
    stdio: 'stdio（本机进程）',
    http: 'http（远端端点）',
    unknown: '未知传输',
  },
  trust: {
    trusted: '受信',
    untrusted: '未受信',
    untrustedNotice: '未受信：该服务不会被启用，也不会把工具暴露给模型。',
    toggle: '我信任该服务（受信后其工具才可能被模型调用）',
  },
  detail: {
    toolCount: '{count} 个工具',
    toolCountUnknown: '工具数未知（服务不可用）',
    lossyNone: '无已知能力损失',
    lossy: '能力损失：{items}',
    envNames: '环境变量名：{items}',
    envNamesNone: '未声明环境变量',
    toolReadOnly: '只读',
    toolWritable: '可能写入',
    toolKindReadOnly: '（只读）',
    toolKindWritable: '（可能写入）',
    toolLabel: '{name}{kind}：{description}',
    emptyTools: '此服务没有可用工具（或尚未就绪）。',
    listSeparator: '、',
  },
  page: {
    eyebrow: 'LOCAL CAPABILITIES',
    title: 'MCP 服务',
    subtitle: '受信服务的工具会进入模型可见定义；未受信服务不会启用。',
    hostBadge: '本机 Host',
    configuredTitle: '已配置服务',
    loading: '正在读取 MCP 服务…',
    empty: '尚未添加任何 MCP 服务。',
    expandTools: '查看工具',
    collapseTools: '收起工具',
    restart: '重启',
    remove: '移除',
  },
  form: {
    title: '添加 MCP 服务',
    nameLabel: '服务名称（可选）',
    transportLabel: '传输方式',
    stdioOption: 'stdio（启动本机进程）',
    httpOption: 'http（连接远端端点）',
    commandLabel: '命令',
    commandPlaceholder: '例如 npx',
    argsLabel: '参数（空白分隔）',
    argsPlaceholder: '例如 -y @modelcontextprotocol/server-filesystem /tmp',
    urlLabel: 'http 端点',
    urlPlaceholder: 'https://example.com/mcp',
    envLabel: '环境变量名（只填名字，值来自 Host 启动环境）',
    envPlaceholder: '例如 GITHUB_TOKEN, HOME',
    envNote: '界面不读取、不回显、不落盘任何密钥值。',
    addButton: '添加服务',
    addNote: '添加会启动本机进程或连接远端端点，因此需要你明确确认；Host 仍是权限控制点。',
    submitted: '已提交添加请求；受信服务会由 Host 启动并校验。',
    addFailed: '添加失败：{message}',
    toolsFailed: '读取工具列表失败：{message}',
  },
  error: {
    nameTooLong: '服务名称不超过 64 个字符。',
    envValueNotAllowed: '只填写环境变量名，不要填写值（例如 GITHUB_TOKEN，而不是 GITHUB_TOKEN=xxx）。',
    envInvalid: '环境变量名不合法：{name}',
    commandRequired: '请填写要启动的命令。',
    stdioNoUrl: 'stdio 传输不需要端点。',
    urlRequired: '请填写 http 端点。',
    urlScheme: '端点必须是 https://；仅本机回环地址允许 http://。',
    urlCredentials: '端点不能包含内嵌凭据。',
    urlInvalid: '端点不是合法 URL。',
    httpNoCommand: 'http 传输不需要命令。',
  },
  capabilityNote: '技能执行器尚未接入：这里不会把磁盘里的说明文档伪装成已生效技能。',
};

const en: McpMessages = {
  status: {
    idle: 'Idle',
    starting: 'Starting',
    ready: 'Ready',
    error: 'Unavailable',
    stopped: 'Stopped',
    unknown: 'Unknown status',
  },
  transport: {
    stdio: 'stdio (local process)',
    http: 'http (remote endpoint)',
    unknown: 'Unknown transport',
  },
  trust: {
    trusted: 'Trusted',
    untrusted: 'Not trusted',
    untrustedNotice: 'Not trusted: this service is never started and its tools are never exposed to the model.',
    toggle: 'I trust this service (only trusted services can expose tools the model may call)',
  },
  detail: {
    toolCount: '{count} tools',
    toolCountUnknown: 'Tool count unknown (service unavailable)',
    lossyNone: 'No known capability loss',
    lossy: 'Capability loss: {items}',
    envNames: 'Environment variable names: {items}',
    envNamesNone: 'No environment variables declared',
    toolReadOnly: 'read-only',
    toolWritable: 'may write',
    toolKindReadOnly: ' (read-only)',
    toolKindWritable: ' (may write)',
    toolLabel: '{name} ({kind}): {description}',
    emptyTools: 'This service has no usable tools (or is not ready yet).',
    listSeparator: ', ',
  },
  page: {
    eyebrow: 'LOCAL CAPABILITIES',
    title: 'MCP servers',
    subtitle: 'Tools of trusted services become part of the model-visible definitions; untrusted services are never started.',
    hostBadge: 'Local Host',
    configuredTitle: 'Configured services',
    loading: 'Reading MCP servers…',
    empty: 'No MCP servers have been added yet.',
    expandTools: 'Show tools',
    collapseTools: 'Hide tools',
    restart: 'Restart',
    remove: 'Remove',
  },
  form: {
    title: 'Add an MCP server',
    nameLabel: 'Service name (optional)',
    transportLabel: 'Transport',
    stdioOption: 'stdio (start a local process)',
    httpOption: 'http (connect to a remote endpoint)',
    commandLabel: 'Command',
    commandPlaceholder: 'for example npx',
    argsLabel: 'Arguments (whitespace separated)',
    argsPlaceholder: 'for example -y @modelcontextprotocol/server-filesystem /tmp',
    urlLabel: 'http endpoint',
    urlPlaceholder: 'https://example.com/mcp',
    envLabel: 'Environment variable names (names only; values come from the Host launch environment)',
    envPlaceholder: 'for example GITHUB_TOKEN, HOME',
    envNote: 'This page never reads, echoes or stores any secret value.',
    addButton: 'Add service',
    addNote: 'Adding starts a local process or connects to a remote endpoint, so it needs your explicit confirmation; the Host remains the permission control point.',
    submitted: 'Add request submitted; trusted services are started and verified by the Host.',
    addFailed: 'Add failed: {message}',
    toolsFailed: 'Could not read the tool list: {message}',
  },
  error: {
    nameTooLong: 'The service name must be at most 64 characters.',
    envValueNotAllowed: 'Enter environment variable names only, never values (for example GITHUB_TOKEN, not GITHUB_TOKEN=xxx).',
    envInvalid: 'Invalid environment variable name: {name}',
    commandRequired: 'Enter the command to start.',
    stdioNoUrl: 'The stdio transport does not use an endpoint.',
    urlRequired: 'Enter the http endpoint.',
    urlScheme: 'The endpoint must use https://; only loopback addresses may use http://.',
    urlCredentials: 'The endpoint must not contain embedded credentials.',
    urlInvalid: 'The endpoint is not a valid URL.',
    httpNoCommand: 'The http transport does not use a command.',
  },
  capabilityNote: 'The skill executor is not wired up yet, so this page never presents Markdown notes on disk as active skills.',
};

/** 取 MCP 服务页文案目录。 */
export function mcpMessages(lang: Lang): McpMessages {
  return lang === 'zh' ? zh : en;
}

/** 与 `i18n.ts` 的 `t()` 同语义：`a.b.c` 取值 + `{name}` 插值，未知键 `⟦path⟧`。 */
export function tm(lang: Lang, path: string, vars: Readonly<Record<string, string | number>> = {}): string {
  const found = path.split('.').reduce<unknown>(
    (node, key) => (node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
    { mcp: mcpMessages(lang) } as unknown,
  );
  if (typeof found !== 'string') return `⟦${path}⟧`;
  return found.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}
