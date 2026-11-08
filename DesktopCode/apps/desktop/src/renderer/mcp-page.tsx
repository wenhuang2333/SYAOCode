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
import { tm } from './i18n-mcp';
import type { Lang } from './i18n';

// ── 纯函数（可被测试直接断言）────────────────────────────────────────────

export function mcpStatusLabels(lang: Lang = 'zh'): Readonly<Record<McpServerStatus, string>> {
  return {
    idle: tm(lang, 'mcp.status.idle'),
    starting: tm(lang, 'mcp.status.starting'),
    ready: tm(lang, 'mcp.status.ready'),
    error: tm(lang, 'mcp.status.error'),
    stopped: tm(lang, 'mcp.status.stopped'),
  };
}

/** 中文状态名（默认语言），保留给既有调用方与测试。 */
export const MCP_STATUS_LABELS: Readonly<Record<McpServerStatus, string>> = mcpStatusLabels('zh');

export function mcpTransportLabels(lang: Lang = 'zh'): Readonly<Record<McpTransport, string>> {
  return {
    stdio: tm(lang, 'mcp.transport.stdio'),
    http: tm(lang, 'mcp.transport.http'),
  };
}

/** 中文传输名（默认语言），保留给既有调用方与测试。 */
export const MCP_TRANSPORT_LABELS: Readonly<Record<McpTransport, string>> = mcpTransportLabels('zh');

/**
 * 未受信服务的承诺。
 *
 * 必须与 Host 的实际行为一致：`mcp-service.ts` 里未受信服务在 `add` 时
 * 直接置 `stopped` 且不 `start`，`toolDefinitions()` 也会跳过（`trusted` 为假）。
 * 所以"不会启用 / 不暴露工具"是**有代码依据的事实**，不是安抚话术。
 */
export function mcpUntrustedNotice(lang: Lang = 'zh'): string {
  return tm(lang, 'mcp.trust.untrustedNotice');
}

/** 中文承诺（默认语言），保留给既有调用方与测试。 */
export const MCP_UNTRUSTED_NOTICE: string = mcpUntrustedNotice('zh');

export function mcpStatusLabel(status: McpServerStatus, lang: Lang = 'zh'): string {
  return mcpStatusLabels(lang)[status] ?? tm(lang, 'mcp.status.unknown');
}

export function mcpTransportLabel(transport: McpTransport, lang: Lang = 'zh'): string {
  return mcpTransportLabels(lang)[transport] ?? tm(lang, 'mcp.transport.unknown');
}

/** 工具数文案：明确"0 个工具"与"未知"的区别。 */
export function mcpToolCountText(server: McpServerInfo, lang: Lang = 'zh'): string {
  if (server.status === 'error' || server.status === 'stopped') return tm(lang, 'mcp.detail.toolCountUnknown');
  return tm(lang, 'mcp.detail.toolCount', { count: server.toolCount });
}

/** 能力损失（lossy）文案；没有则明确"无已知能力损失"。 */
export function mcpLossyText(server: McpServerInfo, lang: Lang = 'zh'): string {
  if (server.lossy.length === 0) return tm(lang, 'mcp.detail.lossyNone');
  return tm(lang, 'mcp.detail.lossy', { items: server.lossy.join(tm(lang, 'mcp.detail.listSeparator')) });
}

/** 环境变量名列表文案（只有名字，没有值）。 */
export function envNamesText(names: readonly string[], lang: Lang = 'zh'): string {
  if (names.length === 0) return tm(lang, 'mcp.detail.envNamesNone');
  return tm(lang, 'mcp.detail.envNames', { items: names.join(tm(lang, 'mcp.detail.listSeparator')) });
}

/** 工具列表行的 `aria-label`。 */
export function mcpToolLabel(tool: McpToolSummary, lang: Lang = 'zh'): string {
  return tm(lang, 'mcp.detail.toolLabel', {
    name: tool.name,
    kind: tm(lang, tool.readOnly ? 'mcp.detail.toolKindReadOnly' : 'mcp.detail.toolKindWritable'),
    description: tool.description,
  });
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
export function validateMcpDraft(draft: McpDraft, lang: Lang = 'zh'): McpValidation {
  const errors: Record<string, string> = {};
  const name = draft.name.trim();
  if (name.length > 64) errors['name'] = tm(lang, 'mcp.error.nameTooLong');
  const envNames = parseEnvNames(draft.envNames);
  for (const env of envNames) {
    if (env.includes('=')) errors['envNames'] = tm(lang, 'mcp.error.envValueNotAllowed');
    else if (!ENV_NAME_PATTERN.test(env)) errors['envNames'] = tm(lang, 'mcp.error.envInvalid', { name: env });
  }
  if (draft.transport === 'stdio') {
    if (draft.command.trim() === '') errors['command'] = tm(lang, 'mcp.error.commandRequired');
    if (draft.url.trim() !== '') errors['url'] = tm(lang, 'mcp.error.stdioNoUrl');
  } else {
    const url = draft.url.trim();
    if (url === '') errors['url'] = tm(lang, 'mcp.error.urlRequired');
    else {
      try {
        const parsed = new URL(url);
        const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
        if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) errors['url'] = tm(lang, 'mcp.error.urlScheme');
        if (parsed.username !== '' || parsed.password !== '') errors['url'] = tm(lang, 'mcp.error.urlCredentials');
      } catch {
        errors['url'] = tm(lang, 'mcp.error.urlInvalid');
      }
    }
    if (draft.command.trim() !== '') errors['command'] = tm(lang, 'mcp.error.httpNoCommand');
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
  /** 界面语言；默认中文（与桌面端默认一致）。 */
  readonly lang?: Lang | undefined;
}

export function McpPage({ servers, loading, error, busy, onAdd, onRemove, onRestart, onTools, lang = 'zh' }: McpPageProps) {
  const [draft, setDraft] = useState<McpDraft>(createMcpDraft);
  const [errors, setErrors] = useState<McpFormErrors>({});
  const [notice, setNotice] = useState('');
  const [expanded, setExpanded] = useState('');
  const [tools, setTools] = useState<Readonly<Record<string, readonly McpToolSummary[]>>>({});

  const patch = (value: Partial<McpDraft>) => setDraft((previous) => ({ ...previous, ...value }));

  const submit = async () => {
    const validation = validateMcpDraft(draft, lang);
    if (!validation.ok) { setErrors(validation.errors); setNotice(''); return; }
    setErrors({});
    try {
      await onAdd(validation.params);
      setNotice(tm(lang, 'mcp.form.submitted'));
      setDraft(createMcpDraft());
    } catch (e) {
      setNotice(tm(lang, 'mcp.form.addFailed', { message: (e as Error).message }));
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
      setNotice(tm(lang, 'mcp.form.toolsFailed', { message: (e as Error).message }));
    }
  };

  return (
    <div className="standard-page mcp-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{tm(lang, 'mcp.page.eyebrow')}</span>
          <h1>{tm(lang, 'mcp.page.title')}</h1>
          <p>{tm(lang, 'mcp.page.subtitle')}</p>
        </div>
        <span className="subtle-badge">{tm(lang, 'mcp.page.hostBadge')}</span>
      </div>

      {error && <div className="inline-error" role="alert">{error}</div>}
      {notice && <p className="data-note">{notice}</p>}

      <section className="mcp-list-section">
        <h2>{tm(lang, 'mcp.page.configuredTitle')} <small>{servers.length}</small></h2>
        {loading && <p className="data-note">{tm(lang, 'mcp.page.loading')}</p>}
        {!loading && servers.length === 0 && <p className="detail-empty">{tm(lang, 'mcp.page.empty')}</p>}
        <ul className="mcp-server-list">
          {servers.map((server) => (
            <li className={`mcp-server-card ${server.trusted ? '' : 'mcp-server-untrusted'}`} key={server.id} aria-label={`${server.name}${tm(lang, 'mcp.detail.listSeparator')}${mcpTransportLabel(server.transport, lang)}${tm(lang, 'mcp.detail.listSeparator')}${mcpStatusLabel(server.status, lang)}`}>
              <div className="mcp-server-head">
                <strong>{server.name}</strong>
                <span className={`mcp-status mcp-status-${server.status}`}>{mcpStatusLabel(server.status, lang)}</span>
                {server.trusted
                  ? <span className="subtle-badge">{tm(lang, 'mcp.trust.trusted')}</span>
                  : <span className="subtle-badge mcp-badge-untrusted">{tm(lang, 'mcp.trust.untrusted')}</span>}
              </div>
              <div className="mcp-server-meta">
                <span>{mcpTransportLabel(server.transport, lang)}</span>
                <span>{mcpToolCountText(server, lang)}</span>
                <span>{mcpLossyText(server, lang)}</span>
              </div>
              <div className="mcp-server-target"><code>{server.transport === 'stdio' ? server.command ?? '—' : server.url ?? '—'}</code></div>
              {!server.trusted && <p className="mcp-untrusted-notice" role="note">{mcpUntrustedNotice(lang)}</p>}
              {server.detail && <p className="data-note">{server.detail}</p>}
              <div className="mcp-server-actions">
                <button className="btn" disabled={busy} onClick={() => void toggleTools(server)}>{tm(lang, expanded === server.id ? 'mcp.page.collapseTools' : 'mcp.page.expandTools')}</button>
                <button className="btn" disabled={busy || server.status === 'starting'} onClick={() => { void onRestart(server.id); }}>{tm(lang, 'mcp.page.restart')}</button>
                <button className="btn" disabled={busy} onClick={() => { void onRemove(server.id); }}>{tm(lang, 'mcp.page.remove')}</button>
              </div>
              {expanded === server.id && (
                <ul className="mcp-tool-list">
                  {(tools[server.id] ?? []).length === 0
                    ? <li className="detail-empty">{tm(lang, 'mcp.detail.emptyTools')}</li>
                    : (tools[server.id] ?? []).map((tool) => (
                      <li key={tool.name} aria-label={mcpToolLabel(tool, lang)}>
                        <strong>{tool.name}</strong>
                        <span>{tm(lang, tool.readOnly ? 'mcp.detail.toolReadOnly' : 'mcp.detail.toolWritable')}</span>
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
        <h2>{tm(lang, 'mcp.form.title')}</h2>
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label className="mcp-field">
            <span>{tm(lang, 'mcp.form.nameLabel')}</span>
            <input value={draft.name} maxLength={64} disabled={busy} onChange={(event) => patch({ name: event.target.value })} />
            {errors['name'] && <small className="field-error">{errors['name']}</small>}
          </label>
          <label className="mcp-field">
            <span>{tm(lang, 'mcp.form.transportLabel')}</span>
            <select value={draft.transport} disabled={busy} onChange={(event) => patch({ transport: event.target.value as McpTransport })}>
              <option value="stdio">{tm(lang, 'mcp.form.stdioOption')}</option>
              <option value="http">{tm(lang, 'mcp.form.httpOption')}</option>
            </select>
          </label>
          {draft.transport === 'stdio' ? (
            <>
              <label className="mcp-field">
                <span>{tm(lang, 'mcp.form.commandLabel')}</span>
                <input value={draft.command} placeholder={tm(lang, 'mcp.form.commandPlaceholder')} disabled={busy} onChange={(event) => patch({ command: event.target.value })} />
                {errors['command'] && <small className="field-error">{errors['command']}</small>}
              </label>
              <label className="mcp-field">
                <span>{tm(lang, 'mcp.form.argsLabel')}</span>
                <input value={draft.args} placeholder={tm(lang, 'mcp.form.argsPlaceholder')} disabled={busy} onChange={(event) => patch({ args: event.target.value })} />
              </label>
            </>
          ) : (
            <label className="mcp-field">
              <span>{tm(lang, 'mcp.form.urlLabel')}</span>
              <input value={draft.url} placeholder={tm(lang, 'mcp.form.urlPlaceholder')} disabled={busy} onChange={(event) => patch({ url: event.target.value })} />
              {errors['url'] && <small className="field-error">{errors['url']}</small>}
            </label>
          )}
          <label className="mcp-field">
            <span>{tm(lang, 'mcp.form.envLabel')}</span>
            <input value={draft.envNames} placeholder={tm(lang, 'mcp.form.envPlaceholder')} disabled={busy} onChange={(event) => patch({ envNames: event.target.value })} />
            {errors['envNames'] && <small className="field-error">{errors['envNames']}</small>}
            <small className="data-note">{tm(lang, 'mcp.form.envNote')}</small>
          </label>
          <label className="mcp-trust-toggle">
            <input type="checkbox" checked={draft.trusted} disabled={busy} onChange={(event) => patch({ trusted: event.target.checked })} />
            <span>{tm(lang, 'mcp.trust.toggle')}</span>
          </label>
          {!draft.trusted && <p className="mcp-untrusted-notice" role="note">{mcpUntrustedNotice(lang)}</p>}
          <div className="mcp-form-actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>{tm(lang, 'mcp.form.addButton')}</button>
          </div>
        </form>
        <p className="data-note">{tm(lang, 'mcp.form.addNote')}</p>
      </section>

      <section className="capability-note">
        <p className="data-note">{tm(lang, 'mcp.capabilityNote')}</p>
      </section>
    </div>
  );
}
