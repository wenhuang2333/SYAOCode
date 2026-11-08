/**
 * Agent 群页文案目录（`27` FR-N-003）。
 *
 * 与 `i18n.ts` / `i18n-views.ts` 同一套纪律（中英键集对等、无空串、
 * 未知键 `⟦path⟧`、`{name}` 插值）。单独成文件的原因：这三个页面是最后一批
 * 并行抽取的，合进已有大文件只会让合并本身变成风险。
 */

import type { Lang } from './i18n';

export interface AgentsMessages {
  readonly roles: {
    readonly hyaki: string;
    readonly sota: string;
    readonly common: string;
  };
  readonly roleHints: {
    readonly hyaki: string;
    readonly sota: string;
    readonly common: string;
  };
  readonly unbound: string;
  readonly summaryNone: string;
  readonly summaryMissing: string;
  readonly summaryActive: string;
  readonly pageTitle: string;
  readonly pageSubtitle: string;
  readonly hostBadge: string;
  readonly configuredTitle: string;
  readonly loading: string;
  readonly emptyGroups: string;
  readonly activeBadge: string;
  readonly execBadge: string;
  readonly edit: string;
  readonly activate: string;
  readonly remove: string;
  readonly newTitle: string;
  readonly editTitle: string;
  readonly nameLabel: string;
  readonly bindingPlaceholder: string;
  readonly cancelEdit: string;
  readonly saveChanges: string;
  readonly createGroup: string;
  readonly activationNote: string;
  readonly saved: string;
  readonly saveFailed: string;
  readonly errorNameRequired: string;
  readonly errorNameTooLong: string;
  readonly errorNameDuplicate: string;
  readonly errorBindingRequired: string;
  readonly errorBindingFormat: string;
  readonly removeConfirmTitle: string;
  readonly removeConfirmBody: string;
  readonly removeConfirmOk: string;
  readonly removeConfirmCancel: string;
}

const zh: AgentsMessages = {
  roles: {
    hyaki: 'hyaki · 提取摘要',
    sota: 'sota · 规划评审',
    common: 'common · 执行验证',
  },
  roleHints: {
    hyaki: '从上下文里提取要点与摘要。',
    sota: '制定与评审分步计划。',
    common: '真正执行工具与验证结果（**执行模型**）。',
  },
  unbound: '未绑定',
  summaryNone: '尚未激活任何 Agent 群，当前按单 Agent 运行。',
  summaryMissing: '已激活「{active}」，但找不到该群配置。',
  summaryActive: '当前激活群：{name} · 执行模型（common）：{model}',
  pageTitle: 'Agent 群',
  pageSubtitle: '三角色各自绑定「渠道:模型」；执行模型永远取 common。',
  hostBadge: '本机 Host',
  configuredTitle: '已配置的群',
  loading: '正在读取 Agent 群…',
  emptyGroups: '尚未配置任何 Agent 群。',
  activeBadge: '当前激活',
  execBadge: '执行模型',
  edit: '编辑',
  activate: '激活',
  remove: '删除',
  newTitle: '新建 Agent 群',
  editTitle: '编辑 Agent 群',
  nameLabel: '群名称',
  bindingPlaceholder: '渠道:模型',
  cancelEdit: '取消编辑',
  saveChanges: '保存修改',
  createGroup: '创建群',
  activationNote: '保存后需要显式“激活”才会生效；重启应用后保留激活状态。',
  saved: '已保存 Agent 群配置。',
  saveFailed: '保存失败：{message}',
  errorNameRequired: '请输入群名称。',
  errorNameTooLong: '群名称不超过 64 个字符。',
  errorNameDuplicate: '此群名称已存在，请直接编辑现有群。',
  errorBindingRequired: '{role} 需要绑定「渠道:模型」。',
  errorBindingFormat: '格式应为「渠道:模型」，例如 provider:model-a（不能含空白）。',
  removeConfirmTitle: '删除 Agent 群？',
  removeConfirmBody: '将删除「{name}」。删除后该群的三角色绑定会一并消失；如果它正在激活中，激活状态也会被清除。',
  removeConfirmOk: '删除',
  removeConfirmCancel: '取消',
};

const en: AgentsMessages = {
  roles: {
    hyaki: 'hyaki · summarize',
    sota: 'sota · plan review',
    common: 'common · execute and verify',
  },
  roleHints: {
    hyaki: 'Extract key points and summaries from the context.',
    sota: 'Draft and review the step-by-step plan.',
    common: 'Actually run the tools and verify the results (**the execution model**).',
  },
  unbound: 'Not bound',
  summaryNone: 'No agent group is active; the session runs as a single agent.',
  summaryMissing: 'The active group "{active}" was selected but its configuration is missing.',
  summaryActive: 'Active group: {name} · execution model (common): {model}',
  pageTitle: 'Agent groups',
  pageSubtitle: 'Each of the three roles binds a channel:model; the execution model is always common.',
  hostBadge: 'Local host',
  configuredTitle: 'Configured groups',
  loading: 'Reading agent groups…',
  emptyGroups: 'No agent group has been configured yet.',
  activeBadge: 'Active',
  execBadge: 'execution model',
  edit: 'Edit',
  activate: 'Activate',
  remove: 'Delete',
  newTitle: 'New agent group',
  editTitle: 'Edit agent group',
  nameLabel: 'Group name',
  bindingPlaceholder: 'channel:model',
  cancelEdit: 'Cancel editing',
  saveChanges: 'Save changes',
  createGroup: 'Create group',
  activationNote: 'Saving is not enough: the group takes effect only after you activate it. The activation survives an app restart.',
  saved: 'Agent group configuration saved.',
  saveFailed: 'Save failed: {message}',
  errorNameRequired: 'Enter a group name.',
  errorNameTooLong: 'The group name must be at most 64 characters.',
  errorNameDuplicate: 'This group name already exists; edit the existing group instead.',
  errorBindingRequired: '{role} must bind a channel:model.',
  errorBindingFormat: 'Use the form channel:model, for example provider:model-a (no whitespace).',
  removeConfirmTitle: 'Delete this agent group?',
  removeConfirmBody: 'This deletes "{name}". Its three role bindings disappear with it, and if it was active the activation is cleared too.',
  removeConfirmOk: 'Delete',
  removeConfirmCancel: 'Cancel',
};

/** 取 Agent 群页文案目录。 */
export function agentsMessages(lang: Lang): AgentsMessages {
  return lang === 'zh' ? zh : en;
}

/** 与 `i18n.ts` 的 `t()` 同语义：`a.b.c` 取值 + `{name}` 插值，未知键 `⟦path⟧`。 */
export function ta(lang: Lang, path: string, vars: Readonly<Record<string, string | number>> = {}): string {
  const found = path.split('.').reduce<unknown>(
    (node, key) => (node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
    agentsMessages(lang) as unknown,
  );
  if (typeof found !== 'string') return `⟦${path}⟧`;
  return found.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}
