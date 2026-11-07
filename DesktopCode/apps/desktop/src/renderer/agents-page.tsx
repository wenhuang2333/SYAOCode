/**
 * Agent 群配置页（`27` FR-N-003）。
 *
 * 三角色固定：`hyaki`（提取摘要）/ `sota`（规划评审）/ `common`（执行验证）。
 * 每个角色绑定一个 `渠道:模型`；同一模型可以兼任多个角色。
 * **执行模型取 `common`**——页面上必须显式写出这一点，避免用户误以为用 `hyaki` 执行。
 */

import { useState } from 'react';
import { AGENT_ROLES, type AgentGroup, type AgentRole, type AgentsListResult, type AgentsSaveParams, type ChannelInfo } from '@syaocode/dhp';

// ── 纯函数（可被测试直接断言）────────────────────────────────────────────

export const AGENT_ROLE_LABELS: Readonly<Record<AgentRole, string>> = {
  hyaki: 'hyaki · 提取摘要',
  sota: 'sota · 规划评审',
  common: 'common · 执行验证',
};

export const AGENT_ROLE_HINTS: Readonly<Record<AgentRole, string>> = {
  hyaki: '从上下文里提取要点与摘要。',
  sota: '制定与评审分步计划。',
  common: '真正执行工具与验证结果（**执行模型**）。',
};

export const AGENT_EXECUTION_ROLE: AgentRole = 'common';

export interface AgentDraft {
  readonly name: string;
  readonly hyaki: string;
  readonly sota: string;
  readonly common: string;
}

export type AgentFormErrors = Readonly<Record<string, string>>;
export type AgentValidation =
  | { readonly ok: true; readonly params: AgentsSaveParams }
  | { readonly ok: false; readonly errors: AgentFormErrors };

/** 角色名 → 中文标签。 */
export function agentRoleLabel(role: AgentRole): string {
  return AGENT_ROLE_LABELS[role] ?? role;
}

/** `渠道:模型` 绑定文案；未绑定显式说明。 */
export function modelBindingLabel(binding: string | undefined): string {
  const value = binding?.trim() ?? '';
  return value === '' ? '未绑定' : value;
}

/** 当前激活群与执行模型的一句话摘要（TC-N-022：执行模型取 common）。 */
export function agentsSummary(result: AgentsListResult | undefined): string {
  if (!result || result.active === null) return '尚未激活任何 Agent 群，当前按单 Agent 运行。';
  const active = result.groups.find((group) => group.name === result.active);
  if (!active) return `已激活「${result.active}」，但找不到该群配置。`;
  return `当前激活群：${active.name} · 执行模型（common）：${modelBindingLabel(active.roles.common)}`;
}

/** 新建 / 编辑草稿。 */
export function createAgentDraft(group?: AgentGroup): AgentDraft {
  return {
    name: group?.name ?? '',
    hyaki: group?.roles.hyaki ?? '',
    sota: group?.roles.sota ?? '',
    common: group?.roles.common ?? '',
  };
}

const BINDING_PATTERN = /^[^:\s]+:[^:\s]+$/;

/** 表单校验：群名唯一性由 Host 兜底，这里只做 UI 级校验。 */
export function validateAgentDraft(draft: AgentDraft, options: { readonly existing?: readonly string[] } = {}): AgentValidation {
  const errors: Record<string, string> = {};
  const name = draft.name.trim();
  if (name === '') errors['name'] = '请输入群名称。';
  else if (name.length > 64) errors['name'] = '群名称不超过 64 个字符。';
  else if (options.existing?.includes(name)) errors['name'] = '此群名称已存在，请直接编辑现有群。';
  for (const role of AGENT_ROLES) {
    const binding = draft[role].trim();
    if (binding === '') errors[role] = `${role} 需要绑定「渠道:模型」。`;
    else if (!BINDING_PATTERN.test(binding)) errors[role] = `格式应为「渠道:模型」，例如 provider:model-a（不能含空白）。`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    params: {
      name,
      roles: { hyaki: draft.hyaki.trim(), sota: draft.sota.trim(), common: draft.common.trim() },
    },
  };
}

// ── 组件 ────────────────────────────────────────────────────────────────

export interface AgentsPageProps {
  readonly result: AgentsListResult | undefined;
  readonly channels: readonly ChannelInfo[];
  readonly loading: boolean;
  readonly error: string;
  readonly busy: boolean;
  readonly onSave: (params: AgentsSaveParams) => Promise<void>;
  readonly onDelete: (name: string) => Promise<void>;
  readonly onActivate: (name: string) => Promise<void>;
}

export function AgentsPage({ result, channels, loading, error, busy, onSave, onDelete, onActivate }: AgentsPageProps) {
  const [draft, setDraft] = useState<AgentDraft>(() => createAgentDraft());
  const [editing, setEditing] = useState(false);
  const [errors, setErrors] = useState<AgentFormErrors>({});
  const [notice, setNotice] = useState('');

  const groups = result?.groups ?? [];
  const options = channels.flatMap((channel) => channel.models.map((model) => `${channel.id}:${model.id}`));

  const field = (role: AgentRole) => draft[role];
  const setField = (role: AgentRole, value: string) => setDraft((previous) => ({ ...previous, [role]: value }));

  const submit = async () => {
    const validation = validateAgentDraft(draft, { existing: editing ? [] : groups.map((group) => group.name) });
    if (!validation.ok) { setErrors(validation.errors); setNotice(''); return; }
    setErrors({});
    try {
      await onSave(validation.params);
      setNotice('已保存 Agent 群配置。');
      setEditing(false);
      setDraft(createAgentDraft());
    } catch (e) {
      setNotice(`保存失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="standard-page agents-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">AGENT TEAM</span>
          <h1>Agent 群</h1>
          <p>三角色各自绑定「渠道:模型」；执行模型永远取 <code>common</code>。</p>
        </div>
        <span className="subtle-badge">本机 Host</span>
      </div>

      <p className="agents-summary" role="status">{agentsSummary(result)}</p>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {notice && <p className="data-note">{notice}</p>}

      <div className="agents-layout">
        <section className="agents-groups">
          <h2>已配置的群 <small>{groups.length}</small></h2>
          {loading && <p className="data-note">正在读取 Agent 群…</p>}
          {!loading && groups.length === 0 && <p className="detail-empty">尚未配置任何 Agent 群。</p>}
          <ul>
            {groups.map((group) => (
              <li className="agent-group-card" key={group.name}>
                <div className="agent-group-head">
                  <strong>{group.name}</strong>
                  {result?.active === group.name && <span className="subtle-badge">当前激活</span>}
                </div>
                <dl className="agent-role-list">
                  {AGENT_ROLES.map((role) => (
                    <div key={role}>
                      <dt>{agentRoleLabel(role)}{role === AGENT_EXECUTION_ROLE && <b className="agent-exec-tag">执行模型</b>}</dt>
                      <dd>{modelBindingLabel(group.roles[role])}</dd>
                    </div>
                  ))}
                </dl>
                <div className="agent-group-actions">
                  <button className="btn" disabled={busy} onClick={() => { setDraft(createAgentDraft(group)); setEditing(true); setErrors({}); }}>编辑</button>
                  <button className="btn" disabled={busy || result?.active === group.name} onClick={() => { void onActivate(group.name); }}>激活</button>
                  <button className="btn" disabled={busy} onClick={() => { void onDelete(group.name); }}>删除</button>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="agents-editor">
          <h2>{editing ? '编辑 Agent 群' : '新建 Agent 群'}</h2>
          <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <label className="agents-field">
              <span>群名称</span>
              <input value={draft.name} maxLength={64} disabled={busy || editing} onChange={(event) => setDraft((previous) => ({ ...previous, name: event.target.value }))} />
              {errors['name'] && <small className="field-error">{errors['name']}</small>}
            </label>
            {AGENT_ROLES.map((role) => (
              <label className="agents-field" key={role}>
                <span>{agentRoleLabel(role)}</span>
                <input
                  value={field(role)}
                  list="agent-model-options"
                  placeholder="渠道:模型"
                  disabled={busy}
                  onChange={(event) => setField(role, event.target.value)}
                />
                {errors[role] && <small className="field-error">{errors[role]}</small>}
                <small className="data-note">{AGENT_ROLE_HINTS[role]}</small>
              </label>
            ))}
            <datalist id="agent-model-options">
              {options.map((option) => <option key={option} value={option} />)}
            </datalist>
            <div className="agents-form-actions">
              {editing && <button type="button" className="btn" disabled={busy} onClick={() => { setEditing(false); setDraft(createAgentDraft()); setErrors({}); }}>取消编辑</button>}
              <button type="submit" className="btn btn-primary" disabled={busy}>{editing ? '保存修改' : '创建群'}</button>
            </div>
          </form>
          <p className="data-note">保存后需要显式"激活"才会生效；重启应用后保留激活状态。</p>
        </section>
      </div>
    </div>
  );
}
