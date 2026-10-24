/**
 * Slash-command parsing and metadata (FR-137). Pure logic — unit-testable
 * without a terminal. Handlers live in interactive.ts (REPL) and tui/tui.ts.
 *
 * All user-facing strings come from the i18n catalog so the output follows the
 * configured CLI language; command names and syntax tokens stay literal.
 */

import type { PermissionMode } from '@syaocode/core';
import { t } from './i18n/index.js';

export interface SlashCommand {
  name: string;
  args: string[];
  raw: string;
}

export interface CommandDoc {
  name: string;
  usage: string;
  summary: string;
  since: 'v0.1' | 'M2+' | 'M3+' | 'M4+';
}

/** Commands available in v0.1 (implemented) plus planned ones (stubbed). */
export function commandDocs(): CommandDoc[] {
  return [
    { name: '/help', usage: t('cmd.help.usage'), summary: t('cmd.help.summary'), since: 'v0.1' },
    { name: '/model', usage: t('cmd.model.usage'), summary: t('cmd.model.summary'), since: 'v0.1' },
    { name: '/permission', usage: t('cmd.permission.usage'), summary: t('cmd.permission.summary'), since: 'v0.1' },
    { name: '/permissions', usage: t('cmd.permissions.usage'), summary: t('cmd.permissions.summary'), since: 'v0.1' },
    { name: '/status', usage: t('cmd.status.usage'), summary: t('cmd.status.summary'), since: 'v0.1' },
    { name: '/cost', usage: t('cmd.cost.usage'), summary: t('cmd.cost.summary'), since: 'v0.1' },
    { name: '/tools', usage: t('cmd.tools.usage'), summary: t('cmd.tools.summary'), since: 'v0.1' },
    { name: '/compact', usage: t('cmd.compact.usage'), summary: t('cmd.compact.summary'), since: 'v0.1' },
    { name: '/clear', usage: t('cmd.clear.usage'), summary: t('cmd.clear.summary'), since: 'v0.1' },
    { name: '/resume', usage: t('cmd.resume.usage'), summary: t('cmd.resume.summary'), since: 'v0.1' },
    { name: '/doctor', usage: t('cmd.doctor.usage'), summary: t('cmd.doctor.summary'), since: 'v0.1' },
    { name: '/setup', usage: t('cmd.setup.usage'), summary: t('cmd.setup.summary'), since: 'v0.1' },
    { name: '/manage', usage: t('cmd.manage.usage'), summary: t('cmd.manage.summary'), since: 'v0.1' },
    { name: '/set-agents', usage: t('cmd.setAgents.usage'), summary: t('cmd.setAgents.summary'), since: 'v0.1' },
    { name: '/setting', usage: t('cmd.setting.usage'), summary: t('cmd.setting.summary'), since: 'v0.1' },
    { name: '/language', usage: t('cmd.language.usage'), summary: t('cmd.language.summary'), since: 'v0.1' },
    { name: '/exit', usage: t('cmd.exit.usage'), summary: t('cmd.exit.summary'), since: 'v0.1' },
    { name: '/agents', usage: t('cmd.agents.usage'), summary: t('cmd.agents.summary'), since: 'M3+' },
    { name: '/mcp', usage: t('cmd.mcp.usage'), summary: t('cmd.mcp.summary'), since: 'M4+' },
    { name: '/goal', usage: t('cmd.goal.usage'), summary: t('cmd.goal.summary'), since: 'M3+' },
    { name: '/rewind', usage: t('cmd.rewind.usage'), summary: t('cmd.rewind.summary'), since: 'M2+' },
  ];
}

// ── 权限档位（三档）────────────────────────────────────────────────────
// 与 CLI 参数一一对应：无参数=strict（严格档）/ --YAO=default（部分权限）
// / --SI=bypass（完全权限）。/permission 指令在会话内直接切换档位。

export interface PermissionTierDef {
  /** 档位名（/permission 指令与命令行参数使用的名字） */
  key: string;
  /** 引擎权限模式 */
  mode: PermissionMode;
  /** 短标签（随 CLI 语言变化） */
  label: string;
  /** 一句话说明 */
  desc: string;
}

export function permissionTiers(): PermissionTierDef[] {
  return [
    { key: 'strict', mode: 'strict', label: t('tier.strict.label'), desc: t('tier.strict.desc') },
    { key: 'YAO', mode: 'default', label: t('tier.yao.label'), desc: t('tier.yao.desc') },
    { key: 'SI', mode: 'bypass', label: t('tier.si.label'), desc: t('tier.si.desc') },
  ];
}

/**
 * 解析 /permission 的参数：接受档位名（strict / YAO / SI，大小写不敏感）、
 * 高级模式名（acceptEdits / plan）以及模式别名（default / bypass）。
 * 无法识别返回 null。
 */
export function parsePermissionArg(raw: string): { key: string; mode: PermissionMode } | null {
  const a = raw.trim().toLowerCase().replace(/[-_]/g, '');
  switch (a) {
    case 'strict':
      return { key: 'strict', mode: 'strict' };
    case 'yao':
    case 'default':
      return { key: 'YAO', mode: 'default' };
    case 'si':
    case 'bypass':
      return { key: 'SI', mode: 'bypass' };
    case 'acceptedits':
      return { key: 'acceptEdits', mode: 'acceptEdits' };
    case 'plan':
      return { key: 'plan', mode: 'plan' };
    default:
      return null;
  }
}

/** 当前模式的短标签（TUI 标题栏 / 状态输出共用） */
export function permissionModeShort(mode: PermissionMode): string {
  switch (mode) {
    case 'strict': return t('tier.mode.strict');
    case 'default': return t('tier.mode.default');
    case 'acceptEdits': return t('tier.mode.acceptEdits');
    case 'plan': return t('tier.mode.plan');
    case 'bypass': return t('tier.mode.bypass');
  }
}

/** 档位速查面板（/permission 无参数时显示；● 标记当前档位） */
export function permissionTierPanel(current: PermissionMode): string[] {
  const rows = permissionTiers().map(
    (tier) => `  ${current === tier.mode ? '●' : ' '} ${tier.key.padEnd(10)} ${tier.label} — ${tier.desc}`,
  );
  const advanced =
    current === 'acceptEdits' || current === 'plan'
      ? [t('tier.panel.advancedCurrent', { mode: current.padEnd(10), label: permissionModeShort(current) })]
      : [t('tier.panel.advancedHint')];
  return [t('tier.panel.title'), ...rows, ...advanced];
}

export function parseSlash(line: string): SlashCommand | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.slice(1).split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  return { name: `/${parts[0]}`, args: parts.slice(1), raw: trimmed };
}

export function helpText(filter?: string): string {
  const docs = commandDocs();
  const available = docs.filter((c) => c.since === 'v0.1');
  const planned = docs.filter((c) => c.since !== 'v0.1');
  if (filter !== undefined) {
    const cmd = docs.find((c) => c.name === filter || c.name === `/${filter}`);
    if (cmd === undefined) return t('help.unknown', { filter });
    return t('help.detail', { usage: cmd.usage, summary: cmd.summary, since: cmd.since });
  }
  const line = (c: CommandDoc) => `  ${c.usage.padEnd(46)} ${c.summary}`;
  return [
    t('help.available'),
    ...available.map(line),
    '',
    t('help.syntax'),
    t('help.atPath'),
    t('help.bang'),
    t('help.ctrlC'),
    '',
    t('help.planned'),
    ...planned.map((c) => t('help.plannedLine', { name: c.name.padEnd(12), summary: c.summary, since: c.since })),
  ].join('\n');
}
