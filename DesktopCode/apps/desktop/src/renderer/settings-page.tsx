import { useEffect, useId, useRef, useState } from 'react';
import type { ChannelConfig, ChannelInfo, ChannelModel, ChannelProtocol, QuotaSnapshot } from '@syaocode/dhp';

/** 界面语言选项。文案用各自语言书写，切换时不需要翻译。 */
const LANGUAGE_OPTIONS: readonly { readonly value: 'en' | 'zh'; readonly label: string }[] = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
];

export interface SettingsPageProps {
  readonly channels: readonly ChannelInfo[];
  readonly saving: boolean;
  readonly onSave: (channel: ChannelConfig) => Promise<void>;
  /** 当前界面语言（来自 Host 的 `config/get`）。 */
  readonly language?: 'en' | 'zh';
  /** 切换界面语言；写入 Host 配置，不是本地偏好。 */
  readonly onChangeLanguage?: (language: 'en' | 'zh') => Promise<void> | void;
}

export interface ChannelModelDraft {
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly contextWindow: string;
  readonly inputPricePerMillion: string;
  readonly outputPricePerMillion: string;
  readonly cacheReadPricePerMillion: string;
}

export interface ChannelDraft {
  readonly id: string;
  readonly name: string;
  readonly protocol: ChannelProtocol;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly models: readonly ChannelModelDraft[];
  readonly balanceAmount: string;
  readonly balanceCurrency: 'USD' | 'CNY';
  readonly quotaUsed: string;
  readonly quotaLimit: string;
  readonly quotaUnit: QuotaSnapshot['unit'];
  readonly quotaResetsAt: string;
}

export type ChannelFormErrors = Readonly<Record<string, string>>;
export type ChannelValidation = { readonly ok: true; readonly channel: ChannelConfig } | { readonly ok: false; readonly errors: ChannelFormErrors };
const MODEL_NUMBER_FIELDS = ['contextWindow', 'inputPricePerMillion', 'outputPricePerMillion', 'cacheReadPricePerMillion'] as const;
const MODEL_FIELD_LABELS = {
  contextWindow: '上下文容量 (tokens)', inputPricePerMillion: '输入 (USD / 百万)',
  outputPricePerMillion: '输出 (USD / 百万)', cacheReadPricePerMillion: '缓存读取 (USD / 百万)',
} as const;

function optionalNumber(value: number | undefined): string { return value === undefined ? '' : String(value); }

export function localDateTimeValue(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function newModelDraft(key: string, model?: ChannelModel): ChannelModelDraft {
  return {
    key, id: model?.id ?? '', name: model?.name ?? '', contextWindow: optionalNumber(model?.contextWindow),
    inputPricePerMillion: optionalNumber(model?.inputPricePerMillion), outputPricePerMillion: optionalNumber(model?.outputPricePerMillion),
    cacheReadPricePerMillion: optionalNumber(model?.cacheReadPricePerMillion),
  };
}

export function createChannelDraft(channel?: ChannelConfig): ChannelDraft {
  return {
    id: channel?.id ?? '', name: channel?.name ?? '', protocol: channel?.protocol ?? 'openai-compatible',
    baseUrl: channel?.baseUrl ?? '', apiKeyEnv: channel?.apiKeyEnv ?? '',
    models: channel ? channel.models.map((model, index) => newModelDraft(`existing-${index}`, model)) : [newModelDraft('initial')],
    balanceAmount: channel?.balance ? String(channel.balance.amount) : '', balanceCurrency: channel?.balance?.currency ?? 'USD',
    quotaUsed: channel?.quota ? String(channel.quota.used) : '', quotaLimit: channel?.quota ? String(channel.quota.limit) : '',
    quotaUnit: channel?.quota?.unit ?? 'tokens', quotaResetsAt: channel?.quota?.resetsAt === undefined ? '' : localDateTimeValue(channel.quota.resetsAt),
  };
}

/** UI validation only; Host remains the authoritative validation/persistence boundary. */
export function validateChannelDraft(draft: ChannelDraft, options: {
  readonly existing?: ChannelInfo;
  readonly channels?: readonly ChannelInfo[];
  readonly now?: number;
} = {}): ChannelValidation {
  const errors: Record<string, string> = {};
  const id = draft.id.trim(); const name = draft.name.trim();
  const baseUrl = draft.baseUrl.trim(); const apiKeyEnv = draft.apiKeyEnv.trim();
  const existing = options.existing;
  const builtinMock = existing?.builtin === true && existing.protocol === 'mock';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) errors['id'] = '使用字母、数字、点、短横线或下划线，并以字母或数字开头。';
  if (existing && id !== existing.id) errors['id'] = '现有渠道 ID 不可修改；请通过新增创建另一个渠道。';
  if (!existing && options.channels?.some((channel) => channel.id === id)) errors['id'] = '此渠道 ID 已存在，请选择其他 ID。';
  if (!name) errors['name'] = '请输入渠道名称。';
  if (builtinMock && draft.protocol !== 'mock') errors['protocol'] = '内置 Mock 的协议不可修改。';
  if (!builtinMock && draft.protocol !== 'openai-compatible' && draft.protocol !== 'anthropic') errors['protocol'] = '请选择 OpenAI-compatible 或 Anthropic 协议；不可创建 Mock。';
  if (!builtinMock && id.toLowerCase() === 'mock') errors['id'] = 'mock 是内置离线演示渠道的保留 ID。';
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
      if (url.username || url.password || url.search || url.hash) errors['baseUrl'] = 'URL 不可包含用户名、密码、查询参数或片段；密钥请由 Host 环境变量提供。';
      else if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) errors['baseUrl'] = '远程服务必须使用 HTTPS；仅本机回环地址允许 HTTP。';
    } catch { errors['baseUrl'] = '请输入完整有效的 URL（含 https://）。'; }
  }
  if (!builtinMock && !apiKeyEnv) errors['apiKeyEnv'] = '请输入 Host 读取的环境变量名，不要输入真实 API Key。';
  if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) errors['apiKeyEnv'] = '仅填写环境变量名，例如 MY_PROVIDER_API_KEY；不要粘贴密钥。';

  const number = (raw: string, key: string, required = false, positive = false, integer = false): number | undefined => {
    const value = raw.trim();
    if (!value) { if (required) errors[key] = '请填写此数值；若不录入配额，请将配额字段全部留空。'; return undefined; }
    const parsed = Number(value);
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(parsed) || parsed < 0) {
      errors[key] = '请输入有限的非负数，不可填写负数、Infinity 或非数字。'; return undefined;
    }
    if (positive && parsed <= 0) { errors[key] = '额度上限必须大于 0。'; return undefined; }
    if (integer && !Number.isSafeInteger(parsed)) { errors[key] = '上下文容量必须为安全范围内的非负整数。'; return undefined; }
    return parsed;
  };
  if (draft.models.length === 0) errors['models'] = '至少添加一个可用模型。';
  const seen = new Set<string>();
  const models: ChannelModel[] = draft.models.map((model, index) => {
    const prefix = `models.${index}`;
    const modelId = model.id.trim(); const modelName = model.name.trim();
    if (!modelId || /[\s\u0000-\u001f\u007f]/.test(modelId)) errors[`${prefix}.id`] = '填写真实模型 ID，不可包含空白或控制字符。';
    else if (seen.has(modelId)) errors[`${prefix}.id`] = '同一渠道内模型 ID 不可重复。';
    seen.add(modelId);
    if (!modelName) errors[`${prefix}.name`] = '请输入模型显示名称。';
    const values: { -readonly [K in keyof Pick<ChannelModel, typeof MODEL_NUMBER_FIELDS[number]>]?: number } = {};
    for (const field of MODEL_NUMBER_FIELDS) {
      const parsed = number(model[field], `${prefix}.${field}`, false, false, field === 'contextWindow');
      if (parsed !== undefined) values[field] = parsed;
    }
    return { id: modelId, name: modelName, ...values };
  });
  if (!['USD', 'CNY'].includes(draft.balanceCurrency)) errors['balanceCurrency'] = '币种仅支持 USD 或 CNY。';
  if (!['tokens', 'requests', 'credits'].includes(draft.quotaUnit)) errors['quotaUnit'] = '请选择有效的配额单位。';
  const balanceAmount = number(draft.balanceAmount, 'balanceAmount');
  const hasQuota = Boolean(draft.quotaUsed.trim() || draft.quotaLimit.trim() || draft.quotaResetsAt.trim());
  const quotaUsed = number(draft.quotaUsed, 'quotaUsed', hasQuota);
  const quotaLimit = number(draft.quotaLimit, 'quotaLimit', hasQuota, true);
  let resetsAt: number | undefined;
  if (draft.quotaResetsAt.trim()) {
    const date = new Date(draft.quotaResetsAt);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(draft.quotaResetsAt) || !Number.isFinite(date.getTime()) || localDateTimeValue(date.getTime()) !== draft.quotaResetsAt) errors['quotaResetsAt'] = '请选择有效的本地重置日期和时间。';
    else resetsAt = date.getTime();
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  const updatedAt = options.now ?? Date.now();
  return { ok: true, channel: {
    id, name, protocol: draft.protocol,
    ...(!builtinMock && baseUrl ? { baseUrl } : {}), ...(!builtinMock && apiKeyEnv ? { apiKeyEnv } : {}), models,
    balance: balanceAmount === undefined ? null : { amount: balanceAmount, currency: draft.balanceCurrency, updatedAt, source: 'manual' },
    quota: quotaUsed === undefined || quotaLimit === undefined ? null : {
      used: quotaUsed, limit: quotaLimit, unit: draft.quotaUnit, ...(resetsAt === undefined ? {} : { resetsAt }), updatedAt, source: 'manual',
    },
  } };
}

function Field({ id, label, value, onChange, error, help, readOnly = false, placeholder, inputMode, type = 'text' }: {
  id: string; label: string; value: string; onChange: (value: string) => void;
  error?: string | undefined; help?: string | undefined; readOnly?: boolean; placeholder?: string | undefined;
  inputMode?: 'decimal' | 'numeric' | undefined; type?: 'text' | 'datetime-local';
}): React.JSX.Element {
  return <div className={`settings-field${error ? ' settings-field-invalid' : ''}`}>
    <label htmlFor={id}>{label}</label>
    <input id={id} type={type} value={value} readOnly={readOnly} placeholder={placeholder} inputMode={inputMode}
      autoComplete="off" spellCheck={false} aria-invalid={Boolean(error)} aria-describedby={[help ? `${id}-help` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined}
      onChange={(event) => onChange(event.target.value)}/>
    {help && <small id={`${id}-help`} className="settings-field-help">{help}</small>}
    {error && <small id={`${id}-error`} className="settings-field-error">{error}</small>}
  </div>;
}

function snapshotLabel(timestamp: number | undefined): string {
  return timestamp === undefined ? '尚未录入快照' : `上次手动记录：${new Date(timestamp).toLocaleString('zh-CN', { hour12: false })}`;
}

export function SettingsPage({ channels, saving, onSave, language, onChangeLanguage }: SettingsPageProps): React.JSX.Element {
  const id = useId();
  const [selectedId, setSelectedId] = useState<string | null>(channels[0]?.id ?? null);
  const [draft, setDraft] = useState<ChannelDraft>(() => createChannelDraft(channels[0]));
  const [errors, setErrors] = useState<ChannelFormErrors>({});
  const [localSaving, setLocalSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const dirty = useRef(false);
  const submitting = useRef(false);
  const nextModelKey = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);
  const selectedChannel = channels.find((channel) => channel.id === selectedId);
  const appliedChannel = useRef(selectedChannel);
  const lockedMock = selectedChannel?.builtin === true && selectedChannel.protocol === 'mock';
  const busy = saving || localSaving;
  useEffect(() => {
    // Defer props received during a save, then apply them after its ACK. Do not
    // reset dirty edits or roll a successful save back to the pre-save props.
    if (selectedChannel && !dirty.current && !localSaving && selectedChannel !== appliedChannel.current) {
      appliedChannel.current = selectedChannel;
      setDraft(createChannelDraft(selectedChannel));
    }
  }, [selectedChannel, localSaving]);

  const update = <K extends keyof ChannelDraft>(key: K, value: ChannelDraft[K]): void => {
    dirty.current = true; setDraft((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => { const next = { ...previous }; delete next[key]; return next; }); setFeedback(null);
  };
  const updateModel = (index: number, key: Exclude<keyof ChannelModelDraft, 'key'>, value: string): void => {
    dirty.current = true;
    setDraft((previous) => ({ ...previous, models: previous.models.map((model, current) => current === index ? { ...model, [key]: value } : model) }));
    setErrors((previous) => { const next = { ...previous }; delete next[`models.${index}.${key}`]; return next; }); setFeedback(null);
  };
  const selectChannel = (channel?: ChannelInfo): void => {
    if (busy) return;
    setSelectedId(channel?.id ?? null); setDraft(createChannelDraft(channel)); dirty.current = false;
    appliedChannel.current = channel; setErrors({}); setFeedback(null);
  };
  const save = async (): Promise<void> => {
    if (busy || submitting.current) return;
    const result = validateChannelDraft(draft, { ...(selectedChannel ? { existing: selectedChannel } : {}), channels });
    if (!result.ok) {
      setErrors(result.errors); setFeedback({ kind: 'error', text: '请检查标出的字段，尚未保存任何更改。' });
      // Focus after React has applied aria-invalid; no custom keyboard trap.
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    submitting.current = true; appliedChannel.current = selectedChannel;
    setLocalSaving(true); setErrors({}); setFeedback(null);
    try {
      await onSave(result.channel);
      dirty.current = false; setSelectedId(result.channel.id); setDraft(createChannelDraft(result.channel));
      setFeedback({ kind: 'success', text: '保存成功。渠道列表与凭据状态以 Host 返回的配置为准。' });
    } catch (error) {
      setFeedback({ kind: 'error', text: `保存失败：${error instanceof Error && error.message ? error.message : 'Host 未能保存配置，请稍后重试。'}` });
    } finally { submitting.current = false; setLocalSaving(false); }
  };
  const field = (key: 'id' | 'name' | 'baseUrl' | 'apiKeyEnv' | 'balanceAmount' | 'quotaUsed' | 'quotaLimit' | 'quotaResetsAt', label: string, extras: {
    help?: string; placeholder?: string; readOnly?: boolean; inputMode?: 'decimal' | 'numeric'; type?: 'text' | 'datetime-local';
  } = {}): React.JSX.Element => <Field id={`${id}-${key}`} label={label} value={draft[key]} error={errors[key]} onChange={(value) => update(key, value)} {...extras}/>;

  return <main className="settings-page dash-page" aria-labelledby={`${id}-title`}>
    <header className="dash-page-header"><div><p className="dash-eyebrow">CHANNEL SETTINGS</p><h1 id={`${id}-title`}>渠道与模型</h1><p className="dash-subtitle">你的模型，你的连接方式。</p></div><span className="dash-tag">密钥仅由 Host 环境读取</span></header>
    {onChangeLanguage !== undefined && <section className="dash-panel settings-preference" aria-labelledby={`${id}-lang`}>
      <div className="dash-panel-heading"><h2 id={`${id}-lang`}>界面语言</h2></div>
      <p className="settings-preference-note">语言由 Host 配置决定，对所有会话生效。</p>
      <div className="settings-language-options" role="radiogroup" aria-labelledby={`${id}-lang`}>
        {LANGUAGE_OPTIONS.map((option) => <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={(language ?? 'zh') === option.value}
          className={`dash-button dash-button-small${(language ?? 'zh') === option.value ? ' dash-button-primary' : ''}`}
          onClick={() => { if ((language ?? 'zh') !== option.value) void onChangeLanguage(option.value); }}
        >{option.label}</button>)}
      </div>
      <p className="settings-preference-note">部分界面文案目前仍只有中文（界面文案正在分模块抽取）；未翻译的地方保持中文，不会显示占位符或空白。</p>
    </section>}
    <div className="settings-layout">
      <aside className="dash-panel settings-channel-sidebar" aria-label="渠道选择">
        <div className="dash-panel-heading"><h2>我的渠道 <span className="settings-count">{channels.length}</span></h2><button className="dash-button dash-button-small" type="button" disabled={busy} onClick={() => selectChannel()}>＋ 新增</button></div>
        <nav className="settings-channel-list" aria-label="已配置渠道">{channels.length === 0 ? <p className="dash-empty">还没有配置渠道。填写右侧表单，创建第一个渠道。</p> : channels.map((channel) => <button type="button" className={`settings-channel-item${selectedId === channel.id ? ' settings-channel-selected' : ''}`} key={channel.id} aria-pressed={selectedId === channel.id} disabled={busy} onClick={() => selectChannel(channel)}>
          <span className="settings-channel-avatar" aria-hidden="true">{channel.name.slice(0, 1).toUpperCase()}</span><span className="settings-channel-copy"><strong>{channel.name}</strong><small>{channel.protocol === 'mock' ? '离线演示 · Mock' : channel.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'}</small><span>{channel.models.length} 个模型 · {channel.protocol === 'mock' ? '内置演示' : channel.credentialReady ? '凭据已配置' : '凭据未配置'}</span></span><span className="settings-channel-arrow" aria-hidden="true">›</span>
        </button>)}</nav>
        {selectedId === null && <p className="settings-new-hint">正在创建新渠道</p>}
        <p className="settings-sidebar-note">凭据已配置不代表服务可连通。渠道健康请查看真实请求统计。</p>
      </aside>
      <form className="settings-editor" ref={formRef} noValidate aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="settings-editor-heading"><div><h2>{selectedId === null ? '新增渠道' : draft.name || '编辑渠道'}</h2><p className="dash-caption">配置保存到本机 Host，不包含真实 API Key。</p></div>{lockedMock && <span className="dash-tag dash-tag-demo">离线演示</span>}</div>
        {feedback?.kind === 'error' && <p className="dash-notice dash-notice-error" role="alert">{feedback.text}</p>}
        <fieldset className="settings-form-fields" disabled={busy}>
          <section className="dash-panel settings-section" aria-labelledby={`${id}-connection-title`}>
            <div className="settings-section-heading"><span className="settings-step" aria-hidden="true">01</span><div><h3 id={`${id}-connection-title`}>连接配置</h3><p>选择协议并绑定模型服务</p></div></div>
            <div className="settings-fields-grid">
              {field('id', '渠道 ID', { readOnly: selectedId !== null, placeholder: 'my-provider', help: selectedId === null ? '创建时自定义唯一 ID，保存后不可修改。' : '现有渠道的稳定标识，不随名称变化。' })}
              {field('name', '渠道名称', { placeholder: '我的模型服务' })}
              <div className="settings-field"><label htmlFor={`${id}-protocol`}>API 协议</label><select id={`${id}-protocol`} value={draft.protocol} disabled={lockedMock} aria-invalid={Boolean(errors['protocol'])} aria-describedby={`${id}-protocol-help${errors['protocol'] ? ` ${id}-protocol-error` : ''}`} onChange={(event) => update('protocol', event.target.value as ChannelProtocol)}>{lockedMock ? <option value="mock">Mock · 内置离线演示</option> : <><option value="openai-compatible">OpenAI-compatible</option><option value="anthropic">Anthropic Messages</option></>}</select><small id={`${id}-protocol-help`} className="settings-field-help">{lockedMock ? '内置 Mock 不发送真实模型请求，协议不可修改，也不可创建新的 Mock。' : '协议必须与服务实际支持的接口一致。'}</small>{errors['protocol'] && <small className="settings-field-error" id={`${id}-protocol-error`}>{errors['protocol']}</small>}</div>
              {!lockedMock && field('baseUrl', 'Base URL（可选）', { placeholder: 'https://api.example.com/v1', help: '留空使用协议默认地址。远程仅 HTTPS；不允许 URL 内嵌凭据。' })}
            </div>
            {!lockedMock && <div className="settings-credential-field">{field('apiKeyEnv', 'API Key 环境变量名', { placeholder: 'MY_PROVIDER_API_KEY', help: '只填写变量名，绝不要输入真实 Key。请在启动 Host 的环境中设置该变量，然后重启 Host。网页不会读取或显示变量值。' })}<span className={`dash-tag dash-tag-${selectedChannel?.credentialReady ? 'good' : 'neutral'}`}>{selectedChannel?.credentialReady ? 'Host 报告：凭据已配置（非连通检测）' : '保存变量名不会自动配置凭据'}</span></div>}
          </section>
          <section className="dash-panel settings-section" aria-labelledby={`${id}-models-title`}>
            <div className="settings-section-heading"><span className="settings-step" aria-hidden="true">02</span><div><h3 id={`${id}-models-title`}>模型目录</h3><p>真实模型 ID · 用户配置的容量与定价</p></div><button className="dash-button dash-button-small settings-add-model" type="button" onClick={() => {
              update('models', [...draft.models, newModelDraft(`added-${++nextModelKey.current}`)]);
            }}>＋ 添加模型</button></div>
            <p className="settings-section-note">价格单位均为 USD / 百万 tokens。未知价格或容量请留空；留空不等于免费，也不会自动填入厂商价格。</p>
            {errors['models'] && <p className="settings-field-error" role="alert">{errors['models']}</p>}
            <div className="settings-model-list">{draft.models.map((model, index) => <fieldset className="settings-model-row" key={model.key}>
              <legend>模型 {index + 1}</legend><div className="settings-model-row-heading"><span>{model.name || '未命名模型'}</span><button className="dash-button dash-button-small settings-remove-model" type="button" aria-label={`移除模型 ${index + 1}${model.name ? ` ${model.name}` : ''}`} onClick={() => {
                update('models', draft.models.filter((_, current) => current !== index)); setErrors({});
              }}>移除此模型</button></div>
              <div className="settings-model-identity"><Field id={`${id}-model-${model.key}-id`} label="模型 ID" value={model.id} error={errors[`models.${index}.id`]} placeholder="服务商提供的真实模型 ID" onChange={(value) => updateModel(index, 'id', value)}/><Field id={`${id}-model-${model.key}-name`} label="显示名称" value={model.name} error={errors[`models.${index}.name`]} placeholder="用于界面显示的名称" onChange={(value) => updateModel(index, 'name', value)}/></div>
              <div className="settings-model-prices">{MODEL_NUMBER_FIELDS.map((key) => <Field key={key} id={`${id}-model-${model.key}-${key}`} label={MODEL_FIELD_LABELS[key]} value={model[key]} error={errors[`models.${index}.${key}`]} inputMode={key === 'contextWindow' ? 'numeric' : 'decimal'} placeholder="未提供" onChange={(value) => updateModel(index, key, value)}/>)}</div>
            </fieldset>)}</div>
          </section>
          <section className="dash-panel settings-section" aria-labelledby={`${id}-balance-title`}>
            <div className="settings-section-heading"><span className="settings-step" aria-hidden="true">03</span><div><h3 id={`${id}-balance-title`}>余额与配额</h3><p>手动账户快照 · 非实时账单</p></div><span className="dash-tag settings-manual-tag">来源：手动</span></div>
            <div className="settings-snapshot-block"><div className="settings-snapshot-heading"><h4>余额快照</h4><span>{snapshotLabel(selectedChannel?.balance?.updatedAt)}</span></div><div className="settings-fields-grid">
              {field('balanceAmount', '余额金额', { inputMode: 'decimal', placeholder: '未提供', help: '留空清除余额快照；0 表示明确的零余额。' })}
              <div className="settings-field"><label htmlFor={`${id}-balance-currency`}>币种</label><select id={`${id}-balance-currency`} value={draft.balanceCurrency} aria-invalid={Boolean(errors['balanceCurrency'])} aria-describedby={errors['balanceCurrency'] ? `${id}-balance-currency-error` : undefined} onChange={(event) => update('balanceCurrency', event.target.value as ChannelDraft['balanceCurrency'])}><option value="USD">USD · 美元</option><option value="CNY">CNY · 人民币</option></select>{errors['balanceCurrency'] && <small className="settings-field-error" id={`${id}-balance-currency-error`}>{errors['balanceCurrency']}</small>}<small className="settings-field-help">不同币种独立记录，不自动换汇。</small></div>
            </div></div>
            <div className="settings-snapshot-block"><div className="settings-snapshot-heading"><h4>配额快照</h4><span>{snapshotLabel(selectedChannel?.quota?.updatedAt)}</span></div><div className="settings-fields-grid">
              {field('quotaUsed', '已使用额度', { inputMode: 'decimal', placeholder: '未提供', help: '可以达到或超过上限；不会自动截断。' })}
              {field('quotaLimit', '额度上限', { inputMode: 'decimal', placeholder: '未提供', help: '录入时必须大于 0，并同时填写已使用额度。' })}
              <div className="settings-field"><label htmlFor={`${id}-quota-unit`}>配额单位</label><select id={`${id}-quota-unit`} value={draft.quotaUnit} aria-invalid={Boolean(errors['quotaUnit'])} aria-describedby={errors['quotaUnit'] ? `${id}-quota-unit-error` : undefined} onChange={(event) => update('quotaUnit', event.target.value as ChannelDraft['quotaUnit'])}><option value="tokens">tokens</option><option value="requests">requests · 请求</option><option value="credits">credits · 积分</option></select>{errors['quotaUnit'] && <small className="settings-field-error" id={`${id}-quota-unit-error`}>{errors['quotaUnit']}</small>}</div>
              {field('quotaResetsAt', '重置时间（本地，可选）', { type: 'datetime-local' })}
            </div><p className="settings-section-note">清空“已使用额度 / 额度上限 / 重置时间”可清除配额快照。保存时记录当前时间和手动来源；不会调用上游账单 API。</p></div>
          </section>
          <footer className="settings-save-bar">{feedback?.kind === 'success' ? <p className="settings-save-success" role="status">{feedback.text}</p> : <p>{feedback?.kind === 'error' ? '保存未完成，请检查提示与标出的字段。' : '仅保存配置与手动快照，不保存任何真实密钥。'}</p>}<button className="dash-button dash-button-primary" type="submit" disabled={busy}>{busy ? '正在保存…' : selectedId === null ? '创建渠道' : '保存更改'}</button></footer>
        </fieldset>
      </form>
    </div>
  </main>;
}
