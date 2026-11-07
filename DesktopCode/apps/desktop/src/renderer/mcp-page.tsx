/**
 * MCP 服务管理页（`27` FR-N-001）。
 *
 * 纪律：
 *  - `env` **只允许填写环境变量名**：值来自 Host 启动环境，界面不读取、不回显、不落盘；
 *  - 添加服务需要用户确认命令与受影响范围；
 *  - 未受信的服务必须显式提示"不会启用"，不假装已生效；
 *  - 状态与工具数来自 Host，不本地编造。
 */

import { useState } from 'react';
import type { McpAddParams, McpServerInfo, McpServerStatus, McpToolSummary, McpTransport } from '@syaocode/dhp';

// ── 纯函数（可被测试直接断言）────────────────────────────────────────────

export const MCP_STATUS_LABELS: Readonly<Record<McpServerStatus, string>> = {
  idle: '空闲',
  starting: '启动中',
  ready: '就绪',
  error: '不可用',
  stopped: '已停止',
};

export const MCP_TRANSPORT_LABELS: Readonly<Record<McpTransport, string>> = {
  stdio: 'stdio（本机进程）',
  http: 'http（远端端点）',
};

export const MCP_UNTRUSTED_NOTICE = '未受信：该服务不会被启用，也不会把工具暴露给模型。';

export function mcpStatusLabel(status: McpServerStatus): string {
  return MCP_STATUS_LABELS[status] ?? '未知状态';
}

export function mcpTransportLabel(transport: McpTransport): string {
  return MCP_TRANSPORT_LABELS[transport] ?? '未知传输';
}

/** 工具数文案：明确"0 个工具"与"未知"的区别。 */
export function mcpToolCountText(server: McpServerInfo): string {
  if (server.status === 'error' || server.status === 'stopped') return '工具数未知（服务不可用）';
  return `${server.toolCount} 个工具`;
}

/** 能力损失（lossy）文案；没有则明确"无已知能力损失"。 */
export function mcpLossyText(server: McpServerInfo): string {
  return server.lossy.length === 0 ? '无已知能力损失' : `能力损失：${server.lossy.join('、')}`;
}

/** 环境变量名列表文案（只有名字，没有值）。 */
export function envNamesText(names: readonly string[]): string {
  return names.length === 0 ? '未声明环境变量' : `环境变量名：${names.join('、')}`;
}

/** 工具列表行的 `aria-label`。 */
export function mcpToolLabel(tool: McpToolSummary): string {
  return `${tool.name}${tool.readOnly ? '（只读）' : '（可能写入）'}：${tool.description}`;
}

export interface McpDraft {
  readonly name: string;
  readonly transport: McpTransport;
  readonly command: string;
  readonly args: string;
  readonly url: string;
  readonly envNames: string;
  readonly trusted: boolean;
}

export type McpFormErrors = Readonly<Record<string, string>>;
export type McpValidation =
  | { readonly ok: true; readonly params: McpAddParams }
  | { readonly ok: false; readonly errors: McpFormErrors };

export function createMcpDraft(): McpDraft {
  return { name: '', transport: 'stdio', command: '', args: '', url: '', envNames: '', trusted: false };
}

/** 参数按空白切分（支持用引号包裹含空格的单个参数）。 */
export function parseArgs(text: string): readonly string[] {
  const result: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of text.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    if (value !== '') result.push(value);
  }
  return result;
}

/** 环境变量名解析：逗号 / 空白分隔；**只接受变量名**，出现 `=` 一律拒绝。 */
export function parseEnvNames(text: string): readonly string[] {
  return text.split(/[\s,]+/).map((item) => item.trim()).filter((item) => item !== '');
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 添加表单校验。 */
export function validateMcpDraft(draft: McpDraft): McpValidation {
  const errors: Record<string, string> = {};
  const name = draft.name.trim();
  if (name.length > 64) errors['name'] = '服务名称不超过 64 个字符。';
  const envNames = parseEnvNames(draft.envNames);
  for (const env of envNames) {
    if (env.includes('=')) errors['envNames'] = '只填写环境变量名，不要填写值（例如 GITHUB_TOKEN，而不是 GITHUB_TOKEN=xxx）。';
    else if (!ENV_NAME_PATTERN.test(env)) errors['envNames'] = `环境变量名不合法：${env}`;
  }
  if (draft.transport === 'stdio') {
    if (draft.command.trim() === '') errors['command'] = '请填写要启动的命令。';
    if (draft.url.trim() !== '') errors['url'] = 'stdio 传输不需要端点。';
  } else {
    const url = draft.url.trim();
    if (url === '') errors['url'] = '请填写 http 端点。';
    else {
      try {
        const parsed = new URL(url);
        const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
        if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) errors['url'] = '端点必须是 https://；仅本机回环地址允许 http://。';
        if (parsed.username !== '' || parsed.password !== '') errors['url'] = '端点不能包含内嵌凭据。';
      } catch {
        errors['url'] = '端点不是合法 URL。';
      }
    }
    if (draft.command.trim() !== '') errors['command'] = 'http 传输不需要命令。';
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const params: McpAddParams = {
    ...(name === '' ? {} : { name }),
    trusted: draft.trusted,
    ...(draft.transport === 'stdio'
      ? { command: draft.command.trim(), args: parseArgs(draft.args) }
      : { url: draft.url.trim() }),
    ...(envNames.length === 0 ? {} : { envNames }),
  };
  return { ok: true, params };
}

// ── 组件 ────────────────────────────────────────────────────────────────

export interface McpPageProps {
  readonly servers: readonly McpServerInfo[];
  readonly loading: boolean;
  readonly error: string;
  readonly busy: boolean;
  readonly onAdd: (params: McpAddParams) => Promise<void>;
  readonly onRemove: (serverId: string) => Promise<void>;
  readonly onRestart: (serverId: string) => Promise<void>;
  readonly onTools: (serverId: string) => Promise<readonly McpToolSummary[]>;
}

export function McpPage({ servers, loading, error, busy, onAdd, onRemove, onRestart, onTools }: McpPageProps) {
  const [draft, setDraft] = useState<McpDraft>(createMcpDraft);
  const [errors, setErrors] = useState<McpFormErrors>({});
  const [notice, setNotice] = useState('');
  const [expanded, setExpanded] = useState('');
  const [tools, setTools] = useState<Readonly<Record<string, readonly McpToolSummary[]>>>({});

  const patch = (value: Partial<McpDraft>) => setDraft((previous) => ({ ...previous, ...value }));

  const submit = async () => {
    const validation = validateMcpDraft(draft);
    if (!validation.ok) { setErrors(validation.errors); setNotice(''); return; }
    setErrors({});
    try {
      await onAdd(validation.params);
      setNotice('已提交添加请求；受信服务会由 Host 启动并校验。');
      setDraft(createMcpDraft());
    } catch (e) {
      setNotice(`添加失败：${(e as Error).message}`);
    }
  };

  const toggleTools = async (server: McpServerInfo) => {
    if (expanded === server.id) { setExpanded(''); return; }
    setExpanded(server.id);
    if (tools[server.id]) return;
    try {
      const list = await onTools(server.id);
      setTools((previous) => ({ ...previous, [server.id]: list }));
    } catch (e) {
      setNotice(`读取工具列表失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="standard-page mcp-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">LOCAL CAPABILITIES</span>
          <h1>MCP 服务</h1>
          <p>受信服务的工具会进入模型可见定义；未受信服务不会启用。</p>
        </div>
        <span className="subtle-badge">本机 Host</span>
      </div>

      {error && <div className="inline-error" role="alert">{error}</div>}
      {notice && <p className="data-note">{notice}</p>}

      <section className="mcp-list-section">
        <h2>已配置服务 <small>{servers.length}</small></h2>
        {loading && <p className="data-note">正在读取 MCP 服务…</p>}
        {!loading && servers.length === 0 && <p className="detail-empty">尚未添加任何 MCP 服务。</p>}
        <ul className="mcp-server-list">
          {servers.map((server) => (
            <li className={`mcp-server-card ${server.trusted ? '' : 'mcp-server-untrusted'}`} key={server.id} aria-label={`${server.name}，${mcpTransportLabel(server.transport)}，${mcpStatusLabel(server.status)}`}>
              <div className="mcp-server-head">
                <strong>{server.name}</strong>
                <span className={`mcp-status mcp-status-${server.status}`}>{mcpStatusLabel(server.status)}</span>
                {server.trusted ? <span className="subtle-badge">受信</span> : <span className="subtle-badge mcp-badge-untrusted">未受信</span>}
              </div>
              <div className="mcp-server-meta">
                <span>{mcpTransportLabel(server.transport)}</span>
                <span>{mcpToolCountText(server)}</span>
                <span>{mcpLossyText(server)}</span>
              </div>
              <div className="mcp-server-target"><code>{server.transport === 'stdio' ? server.command ?? '—' : server.url ?? '—'}</code></div>
              {!server.trusted && <p className="mcp-untrusted-notice" role="note">{MCP_UNTRUSTED_NOTICE}</p>}
              {server.detail && <p className="data-note">{server.detail}</p>}
              <div className="mcp-server-actions">
                <button className="btn" disabled={busy} onClick={() => void toggleTools(server)}>{expanded === server.id ? '收起工具' : '查看工具'}</button>
                <button className="btn" disabled={busy || server.status === 'starting'} onClick={() => { void onRestart(server.id); }}>重启</button>
                <button className="btn" disabled={busy} onClick={() => { void onRemove(server.id); }}>移除</button>
              </div>
              {expanded === server.id && (
                <ul className="mcp-tool-list">
                  {(tools[server.id] ?? []).length === 0
                    ? <li className="detail-empty">此服务没有可用工具（或尚未就绪）。</li>
                    : (tools[server.id] ?? []).map((tool) => (
                      <li key={tool.name} aria-label={mcpToolLabel(tool)}>
                        <strong>{tool.name}</strong>
                        <span>{tool.readOnly ? '只读' : '可能写入'}</span>
                        <small>{tool.description}</small>
                      </li>
                    ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="mcp-add-section">
        <h2>添加 MCP 服务</h2>
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label className="mcp-field">
            <span>服务名称（可选）</span>
            <input value={draft.name} maxLength={64} disabled={busy} onChange={(event) => patch({ name: event.target.value })} />
            {errors['name'] && <small className="field-error">{errors['name']}</small>}
          </label>
          <label className="mcp-field">
            <span>传输方式</span>
            <select value={draft.transport} disabled={busy} onChange={(event) => patch({ transport: event.target.value as McpTransport })}>
              <option value="stdio">stdio（启动本机进程）</option>
              <option value="http">http（连接远端端点）</option>
            </select>
          </label>
          {draft.transport === 'stdio' ? (
            <>
              <label className="mcp-field">
                <span>命令</span>
                <input value={draft.command} placeholder="例如 npx" disabled={busy} onChange={(event) => patch({ command: event.target.value })} />
                {errors['command'] && <small className="field-error">{errors['command']}</small>}
              </label>
              <label className="mcp-field">
                <span>参数（空白分隔）</span>
                <input value={draft.args} placeholder="例如 -y @modelcontextprotocol/server-filesystem /tmp" disabled={busy} onChange={(event) => patch({ args: event.target.value })} />
              </label>
            </>
          ) : (
            <label className="mcp-field">
              <span>http 端点</span>
              <input value={draft.url} placeholder="https://example.com/mcp" disabled={busy} onChange={(event) => patch({ url: event.target.value })} />
              {errors['url'] && <small className="field-error">{errors['url']}</small>}
            </label>
          )}
          <label className="mcp-field">
            <span>环境变量名（只填名字，值来自 Host 启动环境）</span>
            <input value={draft.envNames} placeholder="例如 GITHUB_TOKEN, HOME" disabled={busy} onChange={(event) => patch({ envNames: event.target.value })} />
            {errors['envNames'] && <small className="field-error">{errors['envNames']}</small>}
            <small className="data-note">界面不读取、不回显、不落盘任何密钥值。</small>
          </label>
          <label className="mcp-trust-toggle">
            <input type="checkbox" checked={draft.trusted} disabled={busy} onChange={(event) => patch({ trusted: event.target.checked })} />
            <span>我信任该服务（受信后其工具才可能被模型调用）</span>
          </label>
          {!draft.trusted && <p className="mcp-untrusted-notice" role="note">{MCP_UNTRUSTED_NOTICE}</p>}
          <div className="mcp-form-actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>添加服务</button>
          </div>
        </form>
        <p className="data-note">添加会启动本机进程或连接远端端点，因此需要你明确确认；Host 仍是权限控制点。</p>
      </section>

      <section className="capability-note">
        <p className="data-note">技能执行器尚未接入：这里不会把磁盘里的说明文档伪装成已生效技能。</p>
      </section>
    </div>
  );
}
