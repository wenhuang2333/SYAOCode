/**
 * Agent 群配置页（`27` FR-N-003）。
 *
 * 三角色固定：`hyaki`（提取摘要）/ `sota`（规划评审）/ `common`（执行验证）。
 * 每个角色绑定一个 `渠道:模型`；同一模型可以兼任多个角色。
 * **执行模型取 `common`**——页面上必须显式写出这一点，避免用户误以为用 `hyaki` 执行。
 */

import { useState } from 'react';
import { AGENT_ROLES, type AgentGroup, type AgentRole, type AgentsListResult, type AgentsSaveParams, type ChannelInfo } from '@liwencode/dhp';
import type { Lang } from './i18n';
import { ta } from './i18n-agents';

// ── 纯函数（可被测试直接断言）────────────────────────────────────────────

/** 三个角色的显示标签（按语言生成）。 */
export function agentRoleLabels(lang: Lang = 'zh'): Readonly<Record<AgentRole, string>> {
  return {
    hyaki: ta(lang, 'roles.hyaki'),
    sota: ta(lang, 'roles.sota'),
    common: ta(lang, 'roles.common'),
  };
}

/** 中文角色标签（兼容既有调用方与测试）。 */
export const AGENT_ROLE_LABELS: Readonly<Record<AgentRole, string>> = agentRoleLabels('zh');

/** 三个角色的职责说明（按语言生成）。 */
export function agentRoleHints(lang: Lang = 'zh'): Readonly<Record<AgentRole, string>> {
  return {
    hyaki: ta(lang, 'roleHints.hyaki'),
    sota: ta(lang, 'roleHints.sota'),
    common: ta(lang, 'roleHints.common'),
  };
}

/** 中文职责说明（兼容既有调用方与测试）。 */
export const AGENT_ROLE_HINTS: Readonly<Record<AgentRole, string>> = agentRoleHints('zh');

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
export function agentRoleLabel(role: AgentRole, lang: Lang = 'zh'): string {
  return agentRoleLabels(lang)[role] ?? role;
}

/** `渠道:模型` 绑定文案；未绑定显式说明。 */
export function modelBindingLabel(binding: string | undefined, lang: Lang = 'zh'): string {
  const value = binding?.trim() ?? '';
  return value === '' ? ta(lang, 'unbound') : value;
}

/** 当前激活群与执行模型的一句话摘要（TC-N-022：执行模型取 common）。 */
export function agentsSummary(result: AgentsListResult | undefined, lang: Lang = 'zh'): string {
  if (!result || result.active === null) return ta(lang, 'summaryNone');
  const active = result.groups.find((group) => group.name === result.active);
  if (!active) return ta(lang, 'summaryMissing', { active: result.active });
  return ta(lang, 'summaryActive', { name: active.name, model: modelBindingLabel(active.roles.common, lang) });
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
export function validateAgentDraft(
  draft: AgentDraft,
  options: { readonly existing?: readonly string[]; readonly lang?: Lang } = {},
): AgentValidation {
  const lang = options.lang ?? 'zh';
  const errors: Record<string, string> = {};
  const name = draft.name.trim();
  if (name === '') errors['name'] = ta(lang, 'errorNameRequired');
  else if (name.length > 64) errors['name'] = ta(lang, 'errorNameTooLong');
  else if (options.existing?.includes(name)) errors['name'] = ta(lang, 'errorNameDuplicate');
  for (const role of AGENT_ROLES) {
    const binding = draft[role].trim();
    if (binding === '') errors[role] = ta(lang, 'errorBindingRequired', { role });
    else if (!BINDING_PATTERN.test(binding)) errors[role] = ta(lang, 'errorBindingFormat');
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
  /** 界面语言（默认中文，与桌面端默认一致）。 */
  readonly lang?: Lang;
}

export function AgentsPage({ result, channels, loading, error, busy, onSave, onDelete, onActivate, lang = 'zh' }: AgentsPageProps) {
  const [draft, setDraft] = useState<AgentDraft>(() => createAgentDraft());
  const [editing, setEditing] = useState(false);
  const [errors, setErrors] = useState<AgentFormErrors>({});
  const [notice, setNotice] = useState('');
  // 删除是破坏性且**无法撤销**的操作（Host 侧直接删掉该群），
  // 必须先确认。归档会话、bypass 切换都有确认，这里以前点一下就直接删。
  const [pendingDelete, setPendingDelete] = useState('');

  const groups = result?.groups ?? [];
  const options = channels.flatMap((channel) => channel.models.map((model) => `${channel.id}:${model.id}`));

  const field = (role: AgentRole) => draft[role];
  const setField = (role: AgentRole, value: string) => setDraft((previous) => ({ ...previous, [role]: value }));

  const submit = async () => {
    const validation = validateAgentDraft(draft, { existing: editing ? [] : groups.map((group) => group.name), lang });
    if (!validation.ok) { setErrors(validation.errors); setNotice(''); return; }
    setErrors({});
    try {
      await onSave(validation.params);
      setNotice(ta(lang, 'saved'));
      setEditing(false);
      setDraft(createAgentDraft());
    } catch (e) {
      setNotice(ta(lang, 'saveFailed', { message: (e as Error).message }));
    }
  };

  return (
    <div className="standard-page agents-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">AGENT TEAM</span>
          <h1>{ta(lang, 'pageTitle')}</h1>
          <p>{ta(lang, 'pageSubtitle')} <code>common</code></p>
        </div>
        <span className="subtle-badge">{ta(lang, 'hostBadge')}</span>
      </div>

      <p className="agents-summary" role="status">{agentsSummary(result, lang)}</p>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {notice && <p className="data-note">{notice}</p>}

      <div className="agents-layout">
        <section className="agents-groups">
          <h2>{ta(lang, 'configuredTitle')} <small>{groups.length}</small></h2>
          {loading && <p className="data-note">{ta(lang, 'loading')}</p>}
          {!loading && groups.length === 0 && <p className="detail-empty">{ta(lang, 'emptyGroups')}</p>}
          <ul>
            {groups.map((group) => (
              <li className="agent-group-card" key={group.name}>
                <div className="agent-group-head">
                  <strong>{group.name}</strong>
                  {result?.active === group.name && <span className="subtle-badge">{ta(lang, 'activeBadge')}</span>}
                </div>
                <dl className="agent-role-list">
                  {AGENT_ROLES.map((role) => (
                    <div key={role}>
                      <dt>{agentRoleLabel(role, lang)}{role === AGENT_EXECUTION_ROLE && <b className="agent-exec-tag">{ta(lang, 'execBadge')}</b>}</dt>
                      <dd>{modelBindingLabel(group.roles[role], lang)}</dd>
                    </div>
                  ))}
                </dl>
                <div className="agent-group-actions">
                  <button className="btn" disabled={busy} onClick={() => { setDraft(createAgentDraft(group)); setEditing(true); setErrors({}); }}>{ta(lang, 'edit')}</button>
                  <button className="btn" disabled={busy || result?.active === group.name} onClick={() => { void onActivate(group.name); }}>{ta(lang, 'activate')}</button>
                  <button className="btn" disabled={busy} onClick={() => setPendingDelete(group.name)}>{ta(lang, 'remove')}</button>
                </div>
                {pendingDelete === group.name && (
                  <div className="inline-confirm" role="alertdialog" aria-label={ta(lang, 'removeConfirmTitle')}>
                    <p><strong>{ta(lang, 'removeConfirmTitle')}</strong></p>
                    <p className="data-note">{ta(lang, 'removeConfirmBody', { name: group.name })}</p>
                    <div className="agent-group-actions">
                      <button className="btn" disabled={busy} onClick={() => setPendingDelete('')}>{ta(lang, 'removeConfirmCancel')}</button>
                      <button
                        className="btn btn-danger"
                        disabled={busy}
                        onClick={() => { const name = group.name; setPendingDelete(''); void onDelete(name); }}
                      >{ta(lang, 'removeConfirmOk')}</button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="agents-editor">
          <h2>{editing ? ta(lang, 'editTitle') : ta(lang, 'newTitle')}</h2>
          <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <label className="agents-field">
              <span>{ta(lang, 'nameLabel')}</span>
              <input value={draft.name} maxLength={64} disabled={busy || editing} onChange={(event) => setDraft((previous) => ({ ...previous, name: event.target.value }))} />
              {errors['name'] && <small className="field-error">{errors['name']}</small>}
            </label>
            {AGENT_ROLES.map((role) => (
              <label className="agents-field" key={role}>
                <span>{agentRoleLabel(role, lang)}</span>
                <input
                  value={field(role)}
                  list="agent-model-options"
                  placeholder={ta(lang, 'bindingPlaceholder')}
                  disabled={busy}
                  onChange={(event) => setField(role, event.target.value)}
                />
                {errors[role] && <small className="field-error">{errors[role]}</small>}
                <small className="data-note">{agentRoleHints(lang)[role]}</small>
              </label>
            ))}
            <datalist id="agent-model-options">
              {options.map((option) => <option key={option} value={option} />)}
            </datalist>
            <div className="agents-form-actions">
              {editing && <button type="button" className="btn" disabled={busy} onClick={() => { setEditing(false); setDraft(createAgentDraft()); setErrors({}); }}>{ta(lang, 'cancelEdit')}</button>}
              <button type="submit" className="btn btn-primary" disabled={busy}>{editing ? ta(lang, 'saveChanges') : ta(lang, 'createGroup')}</button>
            </div>
          </form>
          <p className="data-note">{ta(lang, 'activationNote')}</p>
        </section>
      </div>
    </div>
  );
}
