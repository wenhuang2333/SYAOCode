/**
 * 文案层（i18n）。
 *
 * 规则（`03-产品规格说明书` E-05 / `05` DD-D-309）：
 *  - **所有**面向用户的字符串必须走这里，组件里不出现裸中文字面量
 *  - 未知键**显式可见**（`⟦key⟧`），不静默回退成空串——
 *    空串会让一个"漏翻译"看起来像"设计如此"
 *  - 语言由配置（`language`）决定，不由系统语言猜测
 */

export type Lang = 'en' | 'zh';

export interface Messages {
  readonly appName: string;
  readonly newSession: string;
  readonly composerPlaceholder: string;
  readonly send: string;
  readonly sending: string;
  readonly stop: string;
  readonly emptyTitle: string;
  readonly emptyHint: string;
  readonly thinking: string;
  readonly you: string;
  readonly assistant: string;
  readonly approvalTitle: string;
  readonly approvalPending: string;
  readonly approvalExplain: string;
  readonly approvalSensitive: string;
  readonly riskRead: string;
  readonly riskWrite: string;
  readonly riskExec: string;
  readonly statusReady: string;
  readonly statusConnecting: string;
  readonly statusError: string;
  readonly statusReconnecting: string;
  readonly toolRunning: string;
  readonly toolOk: string;
  readonly toolError: string;
}

const zh: Messages = {
  appName: 'SYAOCode',
  newSession: '新会话',
  composerPlaceholder: '输入消息…（Enter 发送 / Shift+Enter 换行）',
  send: '发送',
  sending: '执行中…',
  stop: '停止',
  emptyTitle: '还没有内容。',
  emptyHint: '在下方输入一句话开始。',
  thinking: '思考过程',
  you: '你',
  assistant: 'SYAOCode',
  approvalTitle: '需要你的确认',
  approvalPending: '待处理审批',
  approvalExplain: '为什么问我',
  approvalSensitive: '敏感操作：该授权不可被记住',
  riskRead: '读取',
  riskWrite: '写入',
  riskExec: '执行',
  statusReady: '就绪',
  statusConnecting: '正在连接本地运行时…',
  statusError: '连接出错',
  statusReconnecting: '连接中断，正在重连…',
  toolRunning: '执行中',
  toolOk: '已完成',
  toolError: '失败',
};

const en: Messages = {
  appName: 'SYAOCode',
  newSession: 'New session',
  composerPlaceholder: 'Type a message… (Enter to send / Shift+Enter for newline)',
  send: 'Send',
  sending: 'Running…',
  stop: 'Stop',
  emptyTitle: 'Nothing here yet.',
  emptyHint: 'Type below to get started.',
  thinking: 'Thinking',
  you: 'You',
  assistant: 'SYAOCode',
  approvalTitle: 'Needs your approval',
  approvalPending: 'Pending approvals',
  approvalExplain: 'Why am I being asked',
  approvalSensitive: 'Sensitive: this grant cannot be remembered',
  riskRead: 'read',
  riskWrite: 'write',
  riskExec: 'exec',
  statusReady: 'Ready',
  statusConnecting: 'Connecting to local runtime…',
  statusError: 'Connection error',
  statusReconnecting: 'Disconnected, reconnecting…',
  toolRunning: 'running',
  toolOk: 'done',
  toolError: 'failed',
};

const BUNDLES: Readonly<Record<Lang, Messages>> = { zh, en };

/** 取文案。未知键返回 `⟦key⟧`，让缺失在界面上直接可见。 */
export function t(lang: Lang, key: keyof Messages): string {
  const bundle = BUNDLES[lang];
  const value = bundle[key];
  return value ?? `⟦${String(key)}⟧`;
}

export function messages(lang: Lang): Messages {
  return BUNDLES[lang];
}
