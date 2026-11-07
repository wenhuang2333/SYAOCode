import { useEffect, useId, useRef, useState } from 'react';
import type { ChannelConfig, ChannelInfo, ChannelModel, ChannelProtocol, QuotaSnapshot } from '@syaocode/dhp';
import { tv, type Lang } from './i18n-views';

/** 界面语言选项。文案用各自语言书写，切换时不需要翻译。 */
export function languageOptions(lang: Lang = 'zh'): readonly { readonly value: 'en' | 'zh'; readonly label: string }[] {
  return [
    { value: 'zh', label: tv(lang, 'settings.language.zh') },
    { value: 'en', label: tv(lang, 'settings.language.en') },
  ];
}

/** 中文选项（默认语言），保留给既有调用方与测试。 */
export const LANGUAGE_OPTIONS: readonly { readonly value: 'en' | 'zh'; readonly label: string }[] = languageOptions('zh');

export interface SettingsPageProps {
  readonly channels: readonly ChannelInfo[];
  readonly saving: boolean;
  readonly onSave: (channel: ChannelConfig) => Promise<void>;
  /** 当前界面语言（来自 Host 的 `config/get`）。 */
  readonly language?: 'en' | 'zh';
  /** 切换界面语言；写入 Host 配置，不是本地偏好。 */
  readonly onChangeLanguage?: (language: 'en' | 'zh') => Promise<void> | void;
  /** 界面语言（渲染文案用）；默认中文。 */
  readonly lang?: Lang | undefined;
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
export function modelFieldLabels(lang: Lang = 'zh'): Readonly<Record<typeof MODEL_NUMBER_FIELDS[number], string>> {
  return {
    contextWindow: tv(lang, 'settings.models.fieldContextWindow'),
    inputPricePerMillion: tv(lang, 'settings.models.fieldInputPrice'),
    outputPricePerMillion: tv(lang, 'settings.models.fieldOutputPrice'),
    cacheReadPricePerMillion: tv(lang, 'settings.models.fieldCacheReadPrice'),
  };
}

/** 中文字段名（默认语言），保留给既有调用方与测试。 */
export const MODEL_FIELD_LABELS = modelFieldLabels('zh');

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
  readonly lang?: Lang;
} = {}): ChannelValidation {
  const lang = options.lang ?? 'zh';
  const errors: Record<string, string> = {};
  const id = draft.id.trim(); const name = draft.name.trim();
  const baseUrl = draft.baseUrl.trim(); const apiKeyEnv = draft.apiKeyEnv.trim();
  const existing = options.existing;
  const builtinMock = existing?.builtin === true && existing.protocol === 'mock';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) errors['id'] = tv(lang, 'settings.error.idFormat');
  if (existing && id !== existing.id) errors['id'] = tv(lang, 'settings.error.idImmutable');
  if (!existing && options.channels?.some((channel) => channel.id === id)) errors['id'] = tv(lang, 'settings.error.idTaken');
  if (!name) errors['name'] = tv(lang, 'settings.error.nameRequired');
  if (builtinMock && draft.protocol !== 'mock') errors['protocol'] = tv(lang, 'settings.error.mockProtocolLocked');
  if (!builtinMock && draft.protocol !== 'openai-compatible' && draft.protocol !== 'anthropic') errors['protocol'] = tv(lang, 'settings.error.protocolChoice');
  if (!builtinMock && id.toLowerCase() === 'mock') errors['id'] = tv(lang, 'settings.error.mockReserved');
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
      if (url.username || url.password || url.search || url.hash) errors['baseUrl'] = tv(lang, 'settings.error.baseUrlParts');
      else if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) errors['baseUrl'] = tv(lang, 'settings.error.baseUrlHttps');
    } catch { errors['baseUrl'] = tv(lang, 'settings.error.baseUrlInvalid'); }
  }
  if (!builtinMock && !apiKeyEnv) errors['apiKeyEnv'] = tv(lang, 'settings.error.apiKeyRequired');
  if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) errors['apiKeyEnv'] = tv(lang, 'settings.error.apiKeyFormat');

  const number = (raw: string, key: string, required = false, positive = false, integer = false): number | undefined => {
    const value = raw.trim();
    if (!value) { if (required) errors[key] = tv(lang, 'settings.error.numberRequired'); return undefined; }
    const parsed = Number(value);
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(parsed) || parsed < 0) {
      errors[key] = tv(lang, 'settings.error.numberInvalid'); return undefined;
    }
    if (positive && parsed <= 0) { errors[key] = tv(lang, 'settings.error.quotaPositive'); return undefined; }
    if (integer && !Number.isSafeInteger(parsed)) { errors[key] = tv(lang, 'settings.error.contextInteger'); return undefined; }
    return parsed;
  };
  if (draft.models.length === 0) errors['models'] = tv(lang, 'settings.error.modelsEmpty');
  const seen = new Set<string>();
  const models: ChannelModel[] = draft.models.map((model, index) => {
    const prefix = `models.${index}`;
    const modelId = model.id.trim(); const modelName = model.name.trim();
    if (!modelId || /[\s\u0000-\u001f\u007f]/.test(modelId)) errors[`${prefix}.id`] = tv(lang, 'settings.error.modelIdInvalid');
    else if (seen.has(modelId)) errors[`${prefix}.id`] = tv(lang, 'settings.error.modelIdDuplicate');
    seen.add(modelId);
    if (!modelName) errors[`${prefix}.name`] = tv(lang, 'settings.error.modelNameRequired');
    const values: { -readonly [K in keyof Pick<ChannelModel, typeof MODEL_NUMBER_FIELDS[number]>]?: number } = {};
    for (const field of MODEL_NUMBER_FIELDS) {
      const parsed = number(model[field], `${prefix}.${field}`, false, false, field === 'contextWindow');
      if (parsed !== undefined) values[field] = parsed;
    }
    return { id: modelId, name: modelName, ...values };
  });
  if (!['USD', 'CNY'].includes(draft.balanceCurrency)) errors['balanceCurrency'] = tv(lang, 'settings.error.currencyInvalid');
  if (!['tokens', 'requests', 'credits'].includes(draft.quotaUnit)) errors['quotaUnit'] = tv(lang, 'settings.error.quotaUnitInvalid');
  const balanceAmount = number(draft.balanceAmount, 'balanceAmount');
  const hasQuota = Boolean(draft.quotaUsed.trim() || draft.quotaLimit.trim() || draft.quotaResetsAt.trim());
  const quotaUsed = number(draft.quotaUsed, 'quotaUsed', hasQuota);
  const quotaLimit = number(draft.quotaLimit, 'quotaLimit', hasQuota, true);
  let resetsAt: number | undefined;
  if (draft.quotaResetsAt.trim()) {
    const date = new Date(draft.quotaResetsAt);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(draft.quotaResetsAt) || !Number.isFinite(date.getTime()) || localDateTimeValue(date.getTime()) !== draft.quotaResetsAt) errors['quotaResetsAt'] = tv(lang, 'settings.error.resetsAtInvalid');
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

function snapshotLabel(timestamp: number | undefined, lang: Lang): string {
  if (timestamp === undefined) return tv(lang, 'settings.snapshot.never');
  return tv(lang, 'settings.snapshot.lastManual', {
    time: new Date(timestamp).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false }),
  });
}

export function SettingsPage({ channels, saving, onSave, language, onChangeLanguage, lang = 'zh' }: SettingsPageProps): React.JSX.Element {
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
      setErrors(result.errors); setFeedback({ kind: 'error', text: tv(lang, 'settings.save.invalid') });
      // Focus after React has applied aria-invalid; no custom keyboard trap.
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    submitting.current = true; appliedChannel.current = selectedChannel;
    setLocalSaving(true); setErrors({}); setFeedback(null);
    try {
      await onSave(result.channel);
      dirty.current = false; setSelectedId(result.channel.id); setDraft(createChannelDraft(result.channel));
      setFeedback({ kind: 'success', text: tv(lang, 'settings.save.success') });
    } catch (error) {
      setFeedback({ kind: 'error', text: tv(lang, 'settings.save.failed', { message: error instanceof Error && error.message ? error.message : tv(lang, 'settings.save.failedDefault') }) });
    } finally { submitting.current = false; setLocalSaving(false); }
  };
  const field = (key: 'id' | 'name' | 'baseUrl' | 'apiKeyEnv' | 'balanceAmount' | 'quotaUsed' | 'quotaLimit' | 'quotaResetsAt', label: string, extras: {
    help?: string; placeholder?: string; readOnly?: boolean; inputMode?: 'decimal' | 'numeric'; type?: 'text' | 'datetime-local';
  } = {}): React.JSX.Element => <Field id={`${id}-${key}`} label={label} value={draft[key]} error={errors[key]} onChange={(value) => update(key, value)} {...extras}/>;

  return <main className="settings-page dash-page" aria-labelledby={`${id}-title`}>
    <header className="dash-page-header"><div><p className="dash-eyebrow">{tv(lang, 'settings.header.eyebrow')}</p><h1 id={`${id}-title`}>{tv(lang, 'settings.header.title')}</h1><p className="dash-subtitle">{tv(lang, 'settings.header.subtitle')}</p></div><span className="dash-tag">{tv(lang, 'settings.header.tag')}</span></header>
    {onChangeLanguage !== undefined && <section className="dash-panel settings-preference" aria-labelledby={`${id}-lang`}>
      <div className="dash-panel-heading"><h2 id={`${id}-lang`}>{tv(lang, 'settings.language.heading')}</h2></div>
      <p className="settings-preference-note">{tv(lang, 'settings.language.note')}</p>
      <div className="settings-language-options" role="radiogroup" aria-labelledby={`${id}-lang`}>
        {languageOptions(lang).map((option) => <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={(language ?? 'zh') === option.value}
          className={`dash-button dash-button-small${(language ?? 'zh') === option.value ? ' dash-button-primary' : ''}`}
          onClick={() => { if ((language ?? 'zh') !== option.value) void onChangeLanguage(option.value); }}
        >{option.label}</button>)}
      </div>
      <p className="settings-preference-note">{tv(lang, 'settings.language.untranslatedNote')}</p>
    </section>}
    <div className="settings-layout">
      <aside className="dash-panel settings-channel-sidebar" aria-label={tv(lang, 'settings.sidebar.aria')}>
        <div className="dash-panel-heading"><h2>{tv(lang, 'settings.sidebar.heading')} <span className="settings-count">{channels.length}</span></h2><button className="dash-button dash-button-small" type="button" disabled={busy} onClick={() => selectChannel()}>{tv(lang, 'settings.sidebar.add')}</button></div>
        <nav className="settings-channel-list" aria-label={tv(lang, 'settings.sidebar.listAria')}>{channels.length === 0 ? <p className="dash-empty">{tv(lang, 'settings.sidebar.empty')}</p> : channels.map((channel) => <button type="button" className={`settings-channel-item${selectedId === channel.id ? ' settings-channel-selected' : ''}`} key={channel.id} aria-pressed={selectedId === channel.id} disabled={busy} onClick={() => selectChannel(channel)}>
          <span className="settings-channel-avatar" aria-hidden="true">{channel.name.slice(0, 1).toUpperCase()}</span><span className="settings-channel-copy"><strong>{channel.name}</strong><small>{channel.protocol === 'mock' ? tv(lang, 'settings.sidebar.mockProtocol') : channel.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'}</small><span>{tv(lang, 'settings.sidebar.modelCount', { count: channel.models.length, state: channel.protocol === 'mock' ? tv(lang, 'settings.sidebar.builtinDemo') : channel.credentialReady ? tv(lang, 'settings.sidebar.credentialReady') : tv(lang, 'settings.sidebar.credentialNotReady') })}</span></span><span className="settings-channel-arrow" aria-hidden="true">›</span>
        </button>)}</nav>
        {selectedId === null && <p className="settings-new-hint">{tv(lang, 'settings.sidebar.newHint')}</p>}
        <p className="settings-sidebar-note">{tv(lang, 'settings.sidebar.note')}</p>
      </aside>
      <form className="settings-editor" ref={formRef} noValidate aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="settings-editor-heading"><div><h2>{selectedId === null ? tv(lang, 'settings.editor.newChannel') : draft.name || tv(lang, 'settings.editor.editChannel')}</h2><p className="dash-caption">{tv(lang, 'settings.editor.caption')}</p></div>{lockedMock && <span className="dash-tag dash-tag-demo">{tv(lang, 'settings.editor.demoTag')}</span>}</div>
        {feedback?.kind === 'error' && <p className="dash-notice dash-notice-error" role="alert">{feedback.text}</p>}
        <fieldset className="settings-form-fields" disabled={busy}>
          <section className="dash-panel settings-section" aria-labelledby={`${id}-connection-title`}>
            <div className="settings-section-heading"><span className="settings-step" aria-hidden="true">01</span><div><h3 id={`${id}-connection-title`}>{tv(lang, 'settings.connection.title')}</h3><p>{tv(lang, 'settings.connection.subtitle')}</p></div></div>
            <div className="settings-fields-grid">
              {field('id', tv(lang, 'settings.connection.idLabel'), { readOnly: selectedId !== null, placeholder: tv(lang, 'settings.connection.idPlaceholder'), help: selectedId === null ? tv(lang, 'settings.connection.idHelpNew') : tv(lang, 'settings.connection.idHelpExisting') })}
              {field('name', tv(lang, 'settings.connection.nameLabel'), { placeholder: tv(lang, 'settings.connection.namePlaceholder') })}
              <div className="settings-field"><label htmlFor={`${id}-protocol`}>{tv(lang, 'settings.connection.protocolLabel')}</label><select id={`${id}-protocol`} value={draft.protocol} disabled={lockedMock} aria-invalid={Boolean(errors['protocol'])} aria-describedby={`${id}-protocol-help${errors['protocol'] ? ` ${id}-protocol-error` : ''}`} onChange={(event) => update('protocol', event.target.value as ChannelProtocol)}>{lockedMock ? <option value="mock">{tv(lang, 'settings.connection.protocolMockOption')}</option> : <><option value="openai-compatible">OpenAI-compatible</option><option value="anthropic">Anthropic Messages</option></>}</select><small id={`${id}-protocol-help`} className="settings-field-help">{lockedMock ? tv(lang, 'settings.connection.protocolHelpMock') : tv(lang, 'settings.connection.protocolHelp')}</small>{errors['protocol'] && <small className="settings-field-error" id={`${id}-protocol-error`}>{errors['protocol']}</small>}</div>
              {!lockedMock && field('baseUrl', tv(lang, 'settings.connection.baseUrlLabel'), { placeholder: tv(lang, 'settings.connection.baseUrlPlaceholder'), help: tv(lang, 'settings.connection.baseUrlHelp') })}
            </div>
            {!lockedMock && <div className="settings-credential-field">{field('apiKeyEnv', tv(lang, 'settings.connection.apiKeyLabel'), { placeholder: tv(lang, 'settings.connection.apiKeyPlaceholder'), help: tv(lang, 'settings.connection.apiKeyHelp') })}<span className={`dash-tag dash-tag-${selectedChannel?.credentialReady ? 'good' : 'neutral'}`}>{selectedChannel?.credentialReady ? tv(lang, 'settings.connection.credentialReadyTag') : tv(lang, 'settings.connection.credentialNotReadyTag')}</span></div>}
          </section>
          <section className="dash-panel settings-section" aria-labelledby={`${id}-models-title`}>
            <div className="settings-section-heading"><span className="settings-step" aria-hidden="true">02</span><div><h3 id={`${id}-models-title`}>{tv(lang, 'settings.models.title')}</h3><p>{tv(lang, 'settings.models.subtitle')}</p></div><button className="dash-button dash-button-small settings-add-model" type="button" onClick={() => {
              update('models', [...draft.models, newModelDraft(`added-${++nextModelKey.current}`)]);
            }}>{tv(lang, 'settings.models.add')}</button></div>
            <p className="settings-section-note">{tv(lang, 'settings.models.note')}</p>
            {errors['models'] && <p className="settings-field-error" role="alert">{errors['models']}</p>}
            <div className="settings-model-list">{draft.models.map((model, index) => <fieldset className="settings-model-row" key={model.key}>
              <legend>{tv(lang, 'settings.models.rowLegend', { index: index + 1 })}</legend><div className="settings-model-row-heading"><span>{model.name || tv(lang, 'settings.models.unnamed')}</span><button className="dash-button dash-button-small settings-remove-model" type="button" aria-label={tv(lang, 'settings.models.removeAria', { index: index + 1, name: model.name ? tv(lang, 'settings.models.removeNameSuffix', { name: model.name }) : '' })} onClick={() => {
                update('models', draft.models.filter((_, current) => current !== index)); setErrors({});
              }}>{tv(lang, 'settings.models.remove')}</button></div>
              <div className="settings-model-identity"><Field id={`${id}-model-${model.key}-id`} label={tv(lang, 'settings.models.idLabel')} value={model.id} error={errors[`models.${index}.id`]} placeholder={tv(lang, 'settings.models.idPlaceholder')} onChange={(value) => updateModel(index, 'id', value)}/><Field id={`${id}-model-${model.key}-name`} label={tv(lang, 'settings.models.nameLabel')} value={model.name} error={errors[`models.${index}.name`]} placeholder={tv(lang, 'settings.models.namePlaceholder')} onChange={(value) => updateModel(index, 'name', value)}/></div>
              <div className="settings-model-prices">{MODEL_NUMBER_FIELDS.map((key) => <Field key={key} id={`${id}-model-${model.key}-${key}`} label={modelFieldLabels(lang)[key]} value={model[key]} error={errors[`models.${index}.${key}`]} inputMode={key === 'contextWindow' ? 'numeric' : 'decimal'} placeholder={tv(lang, 'settings.models.notProvided')} onChange={(value) => updateModel(index, key, value)}/>)}</div>
            </fieldset>)}</div>
          </section>
          <section className="dash-panel settings-section" aria-labelledby={`${id}-balance-title`}>
            <div className="settings-section-heading"><span className="settings-step" aria-hidden="true">03</span><div><h3 id={`${id}-balance-title`}>{tv(lang, 'settings.snapshot.title')}</h3><p>{tv(lang, 'settings.snapshot.subtitle')}</p></div><span className="dash-tag settings-manual-tag">{tv(lang, 'settings.snapshot.manualTag')}</span></div>
            <div className="settings-snapshot-block"><div className="settings-snapshot-heading"><h4>{tv(lang, 'settings.snapshot.balanceHeading')}</h4><span>{snapshotLabel(selectedChannel?.balance?.updatedAt, lang)}</span></div><div className="settings-fields-grid">
              {field('balanceAmount', tv(lang, 'settings.snapshot.balanceAmount'), { inputMode: 'decimal', placeholder: tv(lang, 'settings.models.notProvided'), help: tv(lang, 'settings.snapshot.balanceHelp') })}
              <div className="settings-field"><label htmlFor={`${id}-balance-currency`}>{tv(lang, 'settings.snapshot.currencyLabel')}</label><select id={`${id}-balance-currency`} value={draft.balanceCurrency} aria-invalid={Boolean(errors['balanceCurrency'])} aria-describedby={errors['balanceCurrency'] ? `${id}-balance-currency-error` : undefined} onChange={(event) => update('balanceCurrency', event.target.value as ChannelDraft['balanceCurrency'])}><option value="USD">{tv(lang, 'settings.snapshot.currencyUsd')}</option><option value="CNY">{tv(lang, 'settings.snapshot.currencyCny')}</option></select>{errors['balanceCurrency'] && <small className="settings-field-error" id={`${id}-balance-currency-error`}>{errors['balanceCurrency']}</small>}<small className="settings-field-help">{tv(lang, 'settings.snapshot.currencyHelp')}</small></div>
            </div></div>
            <div className="settings-snapshot-block"><div className="settings-snapshot-heading"><h4>{tv(lang, 'settings.snapshot.quotaHeading')}</h4><span>{snapshotLabel(selectedChannel?.quota?.updatedAt, lang)}</span></div><div className="settings-fields-grid">
              {field('quotaUsed', tv(lang, 'settings.snapshot.quotaUsed'), { inputMode: 'decimal', placeholder: tv(lang, 'settings.models.notProvided'), help: tv(lang, 'settings.snapshot.quotaUsedHelp') })}
              {field('quotaLimit', tv(lang, 'settings.snapshot.quotaLimit'), { inputMode: 'decimal', placeholder: tv(lang, 'settings.models.notProvided'), help: tv(lang, 'settings.snapshot.quotaLimitHelp') })}
              <div className="settings-field"><label htmlFor={`${id}-quota-unit`}>{tv(lang, 'settings.snapshot.quotaUnitLabel')}</label><select id={`${id}-quota-unit`} value={draft.quotaUnit} aria-invalid={Boolean(errors['quotaUnit'])} aria-describedby={errors['quotaUnit'] ? `${id}-quota-unit-error` : undefined} onChange={(event) => update('quotaUnit', event.target.value as ChannelDraft['quotaUnit'])}><option value="tokens">tokens</option><option value="requests">{tv(lang, 'settings.snapshot.unitRequests')}</option><option value="credits">{tv(lang, 'settings.snapshot.unitCredits')}</option></select>{errors['quotaUnit'] && <small className="settings-field-error" id={`${id}-quota-unit-error`}>{errors['quotaUnit']}</small>}</div>
              {field('quotaResetsAt', tv(lang, 'settings.snapshot.resetsAt'), { type: 'datetime-local' })}
            </div><p className="settings-section-note">{tv(lang, 'settings.snapshot.note')}</p></div>
          </section>
          <footer className="settings-save-bar">{feedback?.kind === 'success' ? <p className="settings-save-success" role="status">{feedback.text}</p> : <p>{feedback?.kind === 'error' ? tv(lang, 'settings.save.notSaved') : tv(lang, 'settings.save.onlyConfig')}</p>}<button className="dash-button dash-button-primary" type="submit" disabled={busy}>{busy ? tv(lang, 'settings.save.saving') : selectedId === null ? tv(lang, 'settings.save.create') : tv(lang, 'settings.save.update')}</button></footer>
        </fieldset>
      </form>
    </div>
  </main>;
}
