/**
 * 斜杠指令联想（Command Palette）：输入 "/" 触发，前缀过滤。
 *
 * 显示全部匹配命令（不再截断），每行带当前语言的简短介绍；列表长于视窗时
 * 由 paletteWindow 计算滚动窗口（选中项始终可见，可一路 ↓ 选到底）。
 *
 * 纯逻辑模块：suggestCommands(text) 对编辑器当前内容给出候选、
 * paletteWindow(total, selected, max) 计算视窗；渲染与键位拦截在 tui.ts。
 */

import { t, type MsgKey } from '../i18n/index.js';

export interface CommandHint {
  name: string;
  args: string;
  /** 行内简短介绍（按当前语言解析） */
  brief: string;
}

interface HintDef {
  name: string;
  args: string;
  key: MsgKey;
}

const HINTS: readonly HintDef[] = [
  { name: '/help', args: '[command]', key: 'cmd.help.summary' },
  { name: '/model', args: '[list|use|config]', key: 'cmd.model.summary' },
  { name: '/permission', args: '[tier]', key: 'cmd.permission.summary' },
  { name: '/permissions', args: '[mode|allow|deny]', key: 'cmd.permissions.summary' },
  { name: '/status', args: '', key: 'cmd.status.summary' },
  { name: '/cost', args: '', key: 'cmd.cost.summary' },
  { name: '/tools', args: '', key: 'cmd.tools.summary' },
  { name: '/compact', args: '', key: 'cmd.compact.summary' },
  { name: '/clear', args: '', key: 'cmd.clear.summary' },
  { name: '/resume', args: '[id]', key: 'cmd.resume.summary' },
  { name: '/doctor', args: '', key: 'cmd.doctor.summary' },
  { name: '/setup', args: '', key: 'cmd.setup.summary' },
  { name: '/manage', args: '[name]', key: 'cmd.manage.summary' },
  { name: '/set-agents', args: '[group]', key: 'cmd.setAgents.summary' },
  { name: '/setting', args: '', key: 'cmd.setting.summary' },
  { name: '/language', args: '[en|zh]', key: 'cmd.language.summary' },
  { name: '/exit', args: '', key: 'cmd.exit.summary' },
  { name: '/agents', args: '', key: 'cmd.agents.summary' },
  { name: '/goal', args: '', key: 'cmd.goal.summary' },
  { name: '/mcp', args: '', key: 'cmd.mcp.summary' },
  { name: '/rewind', args: '', key: 'cmd.rewind.summary' },
];

/** 按当前语言生成候选表 */
export function commandHints(): CommandHint[] {
  return HINTS.map((h) => ({ name: h.name, args: h.args, brief: t(h.key) }));
}

/**
 * 候选规则：文本以 "/" 开头且尚未出现空格时按前缀过滤；其余情况（普通文本、
 * 已带参数的命令、空行）无候选。返回全部匹配项（渲染层按视窗滚动）。
 */
export function suggestCommands(text: string): CommandHint[] {
  if (!text.startsWith('/') || text.includes(' ')) return [];
  const q = text.slice(1).toLowerCase();
  return commandHints().filter((h) => h.name.slice(1).toLowerCase().startsWith(q));
}

/**
 * 计算滚动视窗：返回 [start, end) 区间。选中项始终落在视窗内；
 * max 为可见行数上限（其余由调用方按终端高度决定）。
 */
export function paletteWindow(total: number, selected: number, max: number): { start: number; end: number } {
  const size = Math.max(1, Math.min(total, max));
  if (total <= size) return { start: 0, end: total };
  // 居中跟随：选中项尽量位于视窗中部，向两端收敛
  let start = selected - Math.floor((size - 1) / 2);
  start = Math.max(0, Math.min(start, total - size));
  return { start, end: start + size };
}

/** 候选中第一个与输入完全同名的索引（Enter 直接执行完整命令名时高亮它） */
export function exactIndex(hints: readonly CommandHint[], text: string): number {
  return hints.findIndex((h) => h.name === text);
}
