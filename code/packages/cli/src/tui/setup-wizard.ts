/**
 * /setup 模型配置向导（Vite create-app 风格）：
 * 左侧竖向进度线，每个流程点一个彩色圆点，连接线段颜色与下一流程点一致
 * （点与线颜色各不相同）；当前步高亮，已完成步展示答案，未到步置灰。
 *
 * 纯状态机 + 纯渲染（无 I/O），键位拦截与保存在 tui.ts。
 * 步骤顺序（按需求）：模型名称 → 请求地址 → API Key → API 协议（4 种）
 * → 认证字段 → 请求名称（档案名）→ 保存。
 */

import type { AuthFieldKind, ProtocolKind } from '../model-config.js';
import { AUTH_FIELD_LABELS, PROTOCOL_LABELS } from '../model-config.js';
import { t } from '../i18n/index.js';

export type WizardStepKind = 'text' | 'secret' | 'select';

export interface WizardStep {
  id: 'model' | 'baseUrl' | 'apiKey' | 'protocol' | 'authField' | 'profileName';
  label: string;
  kind: WizardStepKind;
  hint: string;
}

/** 步骤定义（标签/提示按当前 CLI 语言解析；顺序与 id 固定） */
export function wizardSteps(): WizardStep[] {
  return [
    { id: 'model', label: t('setup.step.model'), kind: 'text', hint: t('setup.hint.model') },
    { id: 'baseUrl', label: t('setup.step.baseUrl'), kind: 'text', hint: t('setup.hint.baseUrl') },
    { id: 'apiKey', label: t('setup.step.apiKey'), kind: 'secret', hint: t('setup.hint.apiKey') },
    { id: 'protocol', label: t('setup.step.protocol'), kind: 'select', hint: t('setup.hint.protocol') },
    { id: 'authField', label: t('setup.step.authField'), kind: 'select', hint: t('setup.hint.authField') },
    { id: 'profileName', label: t('setup.step.profileName'), kind: 'text', hint: t('setup.hint.profileName') },
  ];
}

/** 每步专属颜色（点与线互不相同）：绿/青/蓝/洋红/橙/黄 */
const STEP_COLORS = [46, 44, 33, 213, 208, 226];

export const PROTOCOL_ORDER: readonly ProtocolKind[] = ['anthropic', 'openai-chat', 'openai-responses', 'gemini'];

/** 各协议可选的认证字段（顺序即默认优先序） */
export function authOptionsFor(protocol: ProtocolKind | undefined): AuthFieldKind[] {
  switch (protocol) {
    case 'anthropic': return ['x-api-key'];
    case 'openai-chat': return ['bearer', 'x-api-key', 'query-key'];
    case 'openai-responses': return ['bearer', 'x-api-key'];
    case 'gemini': return ['query-key', 'x-goog-api-key'];
    default: return ['bearer'];
  }
}

export interface WizardAnswers {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  protocol?: ProtocolKind;
  authField?: AuthFieldKind;
  profileName?: string;
}

export interface WizardState {
  stepIdx: number;
  answers: WizardAnswers;
  /** select 步当前高亮项（选项数组内索引） */
  selIdx: number;
  /** /manage 编辑已有档案时的档案名（允许同名覆盖保存） */
  editing?: string;
  /** 校验错误（显示在当前步下方，输入后清除） */
  error?: string;
}

export function newWizard(prefill?: Partial<WizardAnswers>, editing?: string): WizardState {
  const state: WizardState = { stepIdx: 0, answers: { ...prefill }, selIdx: 0, ...(editing !== undefined ? { editing } : {}) };
  return resetSelection(state);
}

/** 模型名 → 合法的档案名（字母/数字/-/_/.，≤48；非法字符替换为 -） */
export function sanitizeProfileName(model: string): string {
  const cleaned = model
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^[-_.]+/, '')
    .replace(/[-_.]+$/, '')
    .slice(0, 48);
  return /^[A-Za-z0-9]/.test(cleaned) ? cleaned : '';
}

/** 由请求地址推断协议（用户仍可在协议步改选） */
export function guessProtocol(baseUrl: string, model: string): ProtocolKind {
  const url = baseUrl.toLowerCase();
  if (url.includes('generativelanguage.googleapis.com') || url.includes('gemini')) return 'gemini';
  if (url.includes('anthropic') || url.includes('/messages')) return 'anthropic';
  return 'openai-chat';
}

/** 进入 select 步时把高亮定位到已保存答案或协议默认项 */
function resetSelection(state: WizardState): WizardState {
  const step = wizardSteps()[state.stepIdx];
  if (step?.kind !== 'select') return { ...state, selIdx: 0 };
  const options = selectOptions(state);
  const saved = step.id === 'protocol' ? state.answers.protocol : state.answers.authField;
  const idx = saved !== undefined ? options.indexOf(saved as never) : -1;
  return { ...state, selIdx: idx >= 0 ? idx : 0 };
}

export function selectOptions(state: WizardState): string[] {
  const step = wizardSteps()[state.stepIdx]!;
  if (step.id === 'protocol') return [...PROTOCOL_ORDER];
  return authOptionsFor(state.answers.protocol);
}

export function optionLabel(stepId: WizardStep['id'], value: string): string {
  if (stepId === 'protocol') return PROTOCOL_LABELS[value as ProtocolKind] ?? value;
  return AUTH_FIELD_LABELS[value as AuthFieldKind] ?? value;
}

/** 当前步问题（显示在输入框标题） */
export function wizardQuestion(state: WizardState): string {
  const step = wizardSteps()[state.stepIdx];
  if (step === undefined) return '';
  const n = state.stepIdx + 1;
  const total = wizardSteps().length;
  if (step.kind === 'select') return `[${n}/${total}] ${step.label} — ${step.hint}`;
  return `[${n}/${total}] ${step.label} — ${step.hint}`;
}

/** 当前步是否为选择步（↑↓ 导航而非编辑文本） */
export function wizardIsSelect(state: WizardState): boolean {
  return wizardSteps()[state.stepIdx]?.kind === 'select';
}

/** 当前步是否需要掩码显示（API Key） */
export function wizardIsSecret(state: WizardState): boolean {
  return wizardSteps()[state.stepIdx]?.kind === 'secret';
}

/**
 * 提交当前步答案。返回新状态；done=true 表示全部完成（可保存）。
 * 校验失败时停在原步并带 error。
 */
export function submitAnswer(state: WizardState, answer: string): { state: WizardState; done: boolean } {
  const step = wizardSteps()[state.stepIdx];
  if (step === undefined) return { state, done: true };
  let value = answer.trim();
  if (step.kind === 'select') {
    const options = selectOptions(state);
    value = options[state.selIdx] ?? options[0] ?? '';
  }
  // 文本步空输入 = 沿用已有答案（编辑模式沿用档案值；新建模式沿用智能预填，
  // 例如模型名推导出的档案名——直接回车即可接受默认值）
  const keepExisting = value === '' && state.answers[step.id] !== undefined && step.kind !== 'select';
  // 校验（沿用现值时跳过）
  if (!keepExisting && step.id === 'model' && value === '') {
    return { state: { ...state, error: t('setup.err.modelRequired') }, done: false };
  }
  if (!keepExisting && step.id === 'baseUrl') {
    if (value === '') return { state: { ...state, error: t('setup.err.urlRequired') }, done: false };
    if (!/^https?:\/\//.test(value)) return { state: { ...state, error: t('setup.err.urlScheme') }, done: false };
  }
  if (step.id === 'profileName' && !keepExisting) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) || value.length > 48) {
      return { state: { ...state, error: t('setup.err.profileName') }, done: false };
    }
    if (value !== state.editing && getExistingNames().includes(value)) {
      return { state: { ...state, error: t('setup.err.profileExists', { name: value }) }, done: false };
    }
  }
  const answers: WizardAnswers = { ...state.answers };
  if (!keepExisting) {
    switch (step.id) {
      case 'model': answers.model = value; break;
      case 'baseUrl': answers.baseUrl = value; break;
      case 'apiKey': answers.apiKey = value; break;
      case 'protocol': answers.protocol = value as ProtocolKind; break;
      case 'authField': answers.authField = value as AuthFieldKind; break;
      case 'profileName': answers.profileName = value; break;
    }
  }
  // 智能默认：模型名 → 档案名（回车即接受）；URL → 协议与认证字段
  if (step.id === 'model' && answers.profileName === undefined) {
    const guessed = sanitizeProfileName(value);
    if (guessed !== '') answers.profileName = guessed;
  }
  if (step.id === 'baseUrl' && answers.protocol === undefined) {
    answers.protocol = guessProtocol(value, answers.model ?? '');
  }
  // 协议切换后认证字段可能不再适用 → 回退到该协议默认
  if (step.id === 'protocol' && (answers.authField === undefined || !authOptionsFor(answers.protocol).includes(answers.authField))) {
    answers.authField = authOptionsFor(answers.protocol)[0] ?? 'bearer';
  } else if (answers.authField === undefined && answers.protocol !== undefined) {
    answers.authField = authOptionsFor(answers.protocol)[0] ?? 'bearer';
  }
  const nextIdx = state.stepIdx + 1;
  if (nextIdx >= wizardSteps().length) {
    return { state: { stepIdx: nextIdx, answers, selIdx: 0 }, done: true };
  }
  const { error: _cleared, ...rest } = state;
  return { state: resetSelection({ ...rest, stepIdx: nextIdx, answers }), done: false };
}

// 档案重名校验需要读取已存档案；通过注入避免渲染模块直接做 I/O（测试可覆盖）
let existingNamesProvider: () => string[] = () => [];
export function setExistingNamesProvider(fn: () => string[]): void {
  existingNamesProvider = fn;
}
function getExistingNames(): string[] {
  return existingNamesProvider();
}

// ── 渲染（Vite 式进度线面板） ─────────────────────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const color256 = (c: number, s: string) => `\x1b[38;5;${c}m${s}\x1b[39m`;

function plainLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/**
 * 渲染向导面板（等宽行数组）。布局：
 *   ╭─ model setup ───────────────────╮
 *   │  ●  model name   deepseek-chat  │   完成：彩色点 + 答案
 *   │  │                              │   连接线（下一流程点颜色）
 *   │  ◉  request url                │   当前：高亮点 + 提示
 *   │  │    ❯ Anthropic Messages      │   选择步：选项列表
 *   │  ○  api key                     │   未到：灰点
 *   ╰─────────────────────────────────╯
 */
export function renderWizard(state: WizardState, cols: number): string[] {
  const panelW = Math.min(cols, 64);
  const innerW = panelW - 4;
  const lines: string[] = [];
  let title = ` ${state.editing !== undefined ? t('setup.titleEdit', { name: state.editing }) : t('setup.title')} `;
  // 窄终端保护：标题超宽时截断，fill 不得为负
  if (title.length > panelW - 6) title = title.slice(0, Math.max(1, panelW - 7));
  const fill = Math.max(0, panelW - 2 - title.length);
  lines.push(`╭${'─'.repeat(Math.floor(fill / 2))}${title}${'─'.repeat(fill - Math.floor(fill / 2))}╮`);

  const pushRow = (left: string, right: string) => {
    const visible = plainLen(left) + plainLen(right);
    const pad = Math.max(1, innerW - visible);
    lines.push(`│ ${left}${right}${' '.repeat(pad)} │`);
  };

  for (let i = 0; i < wizardSteps().length; i++) {
    const step = wizardSteps()[i]!;
    const color = STEP_COLORS[i]!;
    const isDone = i < state.stepIdx || (state.answers[step.id] !== undefined && i > state.stepIdx);
    const isCurrent = i === state.stepIdx;
    const answer = answerOf(state, step.id);

    if (isCurrent) {
      pushRow(`${color256(color, '◉')}  `, `${bold(step.label)}`);
      if (step.kind === 'select') {
        const options = selectOptions(state);
        for (let oi = 0; oi < options.length; oi++) {
          const sel = oi === state.selIdx;
          const marker = sel ? '❯ ' : '  ';
          const label = optionLabel(step.id, options[oi]!);
          const row = sel ? `  ${color256(color, '│')}     ${marker}${bold(label)}` : `  ${color256(color, '│')}     ${marker}${dim(label)}`;
          const pad = Math.max(1, innerW - plainLen(row));
          lines.push(`│ ${row}${' '.repeat(pad)} │`);
        }
      }
      if (state.error !== undefined) {
        const row = `  ${color256(color, '│')}     \x1b[31m${state.error.slice(0, innerW - 10)}\x1b[39m`;
        const pad = Math.max(1, innerW - plainLen(row));
        lines.push(`│ ${row}${' '.repeat(pad)} │`);
      }
    } else if (isDone) {
      const shown = step.id === 'apiKey' && answer !== undefined && answer !== '' ? '••••••••' : answer ?? '';
      pushRow(`${color256(color, '●')}  `, `${dim(step.label.padEnd(14))} ${shown}`);
    } else {
      pushRow(`${color256(color, '○')}  `, dim(step.label));
    }

    // 连接线：颜色 = 下一个流程点的颜色（点与线颜色互不相同）
    if (i < wizardSteps().length - 1) {
      const lineColor = STEP_COLORS[i + 1]!;
      const isRailLive = i >= state.stepIdx - 1; // 当前步上下保持亮色
      const seg = isRailLive ? color256(lineColor, '│') : dim('│');
      const pad = Math.max(1, innerW - 2);
      lines.push(`│ ${seg} ${' '.repeat(pad)} │`);
    }
  }
  pushRow('', dim(t('setup.footer')));
  lines.push(`╰${'─'.repeat(panelW - 2)}╯`);
  return lines;
}

function answerOf(state: WizardState, id: WizardStep['id']): string | undefined {
  const v = state.answers[id];
  if (v === undefined) return undefined;
  if (id === 'protocol' || id === 'authField') return optionLabel(id, String(v));
  return String(v);
}
