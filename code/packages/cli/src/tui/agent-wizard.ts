/**
 * /set-agents agent 群配置向导（TUI）。
 *
 * 三角色分工（差异化模型降本）：
 *   hyaki  — 大规模文本输入与总结（建议低成本模型）
 *   sota   — 思考、规划与评审（建议高能力模型）
 *   common — 落实与执行（建议均衡模型）
 *
 * 进入后可【新建群】（自行命名）或【修改已有群】；三个角色从"当前已有的
 * 模型"（内置 Provider 目录 + /setup 自定义档案）中选择；**允许同一模型
 * 担任多个角色**（低成本场景三角色可同一模型）。
 *
 * 纯状态机 + 纯渲染（无 I/O），键位与保存在 tui.ts。
 */

import { AGENT_ROLES, ROLE_META, type AgentRole } from '../model-config.js';
import { t } from '../i18n/index.js';

export type GroupStepId = 'target' | 'name' | 'hyaki' | 'sota' | 'common';

export interface GroupStep {
  id: GroupStepId;
  kind: 'select' | 'text' | 'role';
  label: string;
  hint: string;
}

/** 步骤定义（标签/提示按当前 CLI 语言解析；顺序与 id 固定） */
export function groupSteps(): GroupStep[] {
  return [
    { id: 'target', kind: 'select', label: t('groups.step.target'), hint: t('groups.hint.target') },
    { id: 'name', kind: 'text', label: t('groups.step.name'), hint: t('groups.hint.name') },
    { id: 'hyaki', kind: 'role', label: t('groups.step.hyaki'), hint: t('groups.hint.hyaki') },
    { id: 'sota', kind: 'role', label: t('groups.step.sota'), hint: t('groups.hint.sota') },
    { id: 'common', kind: 'role', label: t('groups.step.common'), hint: t('groups.hint.common') },
  ];
}

/** 新建群选项的显示文本（随语言变化） */
export function newGroupSentinel(): string {
  return t('groups.newSentinel');
}

/** 列表窗口：select/role 步选项过多时只显示一段 */
export const OPTION_WINDOW = 8;

export interface GroupAnswers {
  name?: string;
  hyaki?: string;
  sota?: string;
  common?: string;
}

export interface GroupWizardState {
  stepIdx: number;
  answers: GroupAnswers;
  selIdx: number;
  /** 选项窗口滚动起点 */
  scroll: number;
  /** 编辑已有群时 = 群名（允许同名覆盖） */
  editing?: string;
  error?: string;
}

export interface GroupWizardDeps {
  /** 已有群名列表 */
  groupNames: () => string[];
  /** 可选模型引用（"provider:model" / "@profile"） */
  modelRefs: () => string[];
}

let deps: GroupWizardDeps = { groupNames: () => [], modelRefs: () => [] };
export function setGroupWizardDeps(d: GroupWizardDeps): void {
  deps = d;
}

export function newGroupWizard(editing?: string, prefill?: GroupAnswers): GroupWizardState {
  const names = deps.groupNames();
  if (editing !== undefined) {
    // 改群：跳过 target 步，直接命名/角色（name 预填，回车沿用）
    return { stepIdx: 1, answers: { name: editing, ...prefill }, selIdx: 0, scroll: 0, editing };
  }
  if (names.length === 0) {
    // 无群：跳过 target 步，直接新建
    return { stepIdx: 1, answers: { ...prefill }, selIdx: 0, scroll: 0 };
  }
  return { stepIdx: 0, answers: {}, selIdx: 0, scroll: 0 };
}

export function stepOf(state: GroupWizardState): GroupStep | undefined {
  return groupSteps()[state.stepIdx];
}

/** 当前步选项（select=群列表；role=模型引用列表） */
export function optionsOf(state: GroupWizardState): string[] {
  const step = stepOf(state);
  if (step === undefined) return [];
  if (step.id === 'target') return [...deps.groupNames(), t('groups.newSentinel')];
  if (step.kind === 'role') return deps.modelRefs();
  return [];
}

export function isSelectStep(state: GroupWizardState): boolean {
  const kind = stepOf(state)?.kind;
  return kind === 'select' || kind === 'role';
}

export function moveSelection(state: GroupWizardState, delta: number): GroupWizardState {
  const n = optionsOf(state).length;
  if (n === 0) return state;
  const selIdx = (state.selIdx + delta + n) % n;
  // 窗口跟随
  let scroll = state.scroll;
  if (selIdx < scroll) scroll = selIdx;
  if (selIdx >= scroll + OPTION_WINDOW) scroll = selIdx - OPTION_WINDOW + 1;
  return { ...state, selIdx, scroll };
}

export function questionOf(state: GroupWizardState): string {
  const step = stepOf(state);
  if (step === undefined) return '';
  return `[${state.stepIdx + 1}/${groupSteps().length}] ${step.label} — ${step.hint}`;
}

/** 提交当前步；done=true 表示三角色齐备可保存 */
export function submitStep(state: GroupWizardState, text: string): { state: GroupWizardState; done: boolean } {
  const step = stepOf(state);
  if (step === undefined) return { state, done: true };
  const value = text.trim();

  if (step.id === 'target') {
    const opts = optionsOf(state);
    const picked = opts[state.selIdx] ?? opts[0] ?? newGroupSentinel();
    if (picked === newGroupSentinel()) {
      const next: GroupWizardState = { stepIdx: 1, answers: {}, selIdx: 0, scroll: 0 };
      return { state: next, done: false };
    }
    // 编辑已有群：预填其三角色
    return { state: newGroupWizard(picked, prefillOf(picked)), done: false };
  }

  if (step.id === 'name') {
    const name = value !== '' ? value : state.editing ?? '';
    if (name === '') return { state: { ...state, error: t('groups.err.nameRequired') }, done: false };
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name.length > 48) {
      return { state: { ...state, error: t('groups.err.nameInvalid') }, done: false };
    }
    if (name !== state.editing && deps.groupNames().includes(name)) {
      return { state: { ...state, error: t('groups.err.nameExists', { name }) }, done: false };
    }
    const { error: _e, ...rest } = state;
    return { state: advance({ ...rest, answers: { ...state.answers, name } }), done: false };
  }

  if (step.kind === 'role') {
    const opts = optionsOf(state);
    const picked = opts[state.selIdx] ?? opts[0] ?? '';
    if (picked === '') return { state: { ...state, error: t('groups.err.noModel') }, done: false };
    const { error: _e, ...rest } = state;
    const answers = { ...state.answers, [step.id]: picked } as GroupAnswers;
    const next = advance({ ...rest, answers });
    const done = next.stepIdx >= groupSteps().length;
    return { state: next, done };
  }
  return { state, done: false };
}

function advance(state: GroupWizardState): GroupWizardState {
  const nextIdx = state.stepIdx + 1;
  const next = { ...state, stepIdx: nextIdx, selIdx: 0, scroll: 0 };
  // 进入角色步时若已有预填值（改群场景），高亮对应模型
  const step = groupSteps()[nextIdx];
  if (step?.kind === 'role') {
    const opts = optionsOf(next);
    const idx = opts.indexOf(next.answers[step.id as AgentRole] ?? '');
    if (idx >= 0) return { ...next, selIdx: idx, scroll: Math.max(0, idx - Math.floor(OPTION_WINDOW / 2)) };
  }
  return next;
}

/** 编辑已有群时的角色预填 */
let prefillProvider: (name: string) => GroupAnswers = () => ({});
export function setGroupPrefillProvider(fn: (name: string) => GroupAnswers): void {
  prefillProvider = fn;
}
function prefillOf(name: string): GroupAnswers {
  return prefillProvider(name);
}

// ── 渲染 ─────────────────────────────────────────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const c256 = (n: number, s: string) => `\x1b[38;5;${n}m${s}\x1b[39m`;

function plainLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** 渲染 agent 群向导面板（等宽行数组） */
export function renderGroupWizard(state: GroupWizardState, cols: number): string[] {
  const panelW = Math.min(cols, 68);
  const innerW = panelW - 4;
  const lines: string[] = [];
  let title = ` ${state.editing !== undefined ? t('groups.titleEdit', { name: state.editing }) : t('groups.title')} `;
  // 窄终端保护：标题超宽时截断，fill 不得为负（repeat 负数会抛 RangeError）
  if (plainLen(title) > panelW - 6) title = title.slice(0, Math.max(1, panelW - 7));
  const fill = Math.max(0, panelW - 2 - plainLen(title));
  lines.push(`╭${'─'.repeat(Math.floor(fill / 2))}${title}${'─'.repeat(fill - Math.floor(fill / 2))}╮`);
  const pushRow = (left: string, right = '') => {
    const pad = Math.max(1, innerW - plainLen(left) - plainLen(right));
    lines.push(`│ ${left}${right}${' '.repeat(pad)} │`);
  };

  for (let i = 0; i < groupSteps().length; i++) {
    const step = groupSteps()[i]!;
    const roleColor = step.kind === 'role' ? ROLE_META[step.id as AgentRole].color : 45;
    const done = i < state.stepIdx;
    const current = i === state.stepIdx;
    const answer = answerOf(state, step.id);
    const rail = i < groupSteps().length - 1 ? c256(step.kind === 'role' ? ROLE_META[step.id as AgentRole].color : 45, '│') : ' ';

    if (current) {
      pushRow(`${c256(roleColor, '◉')}  `, bold(step.label));
      if (isSelectStep(state)) {
        const opts = optionsOf(state);
        const start = state.scroll;
        const end = Math.min(opts.length, start + OPTION_WINDOW);
        if (start > 0) pushRow(`  ${c256(roleColor, '│')}     ${dim(t('groups.windowAbove', { n: start }))}`);
        for (let oi = start; oi < end; oi++) {
          const sel = oi === state.selIdx;
          const label = opts[oi]!;
          const marker = sel ? '❯ ' : '  ';
          const text = sel ? bold(label) : dim(label);
          pushRow(`  ${c256(roleColor, '│')}     ${marker}${text}`);
        }
        if (end < opts.length) pushRow(`  ${c256(roleColor, '│')}     ${dim(t('groups.windowBelow', { n: opts.length - end }))}`);
      }
      if (state.error !== undefined) {
        pushRow(`  ${c256(roleColor, '│')}     ${c256(196, state.error.slice(0, innerW - 10))}`);
      }
    } else if (done) {
      pushRow(`${c256(roleColor, '●')}  `, `${dim(step.label.padEnd(18))} ${answer ?? ''}`);
    } else {
      pushRow(`${c256(roleColor, '○')}  `, dim(step.label));
    }
    if (i < groupSteps().length - 1) pushRow(`  ${rail}`);
  }
  pushRow(dim(t('groups.footer')));
  lines.push(`╰${'─'.repeat(panelW - 2)}╯`);
  return lines;
}

function answerOf(state: GroupWizardState, id: GroupStepId): string | undefined {
  if (id === 'target') return state.editing;
  return state.answers[id];
}

/** 群摘要（保存后打印） */
export function groupSummary(name: string, answers: GroupAnswers): string[] {
  return AGENT_ROLES.map((role) => {
    const ref = answers[role] ?? t('groups.unset');
    const meta = ROLE_META[role];
    return `  ${c256(meta.color, meta.title.padEnd(7))} ${ref.padEnd(24)} ${dim(meta.desc)}`;
  });
}
