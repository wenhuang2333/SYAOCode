/**
 * `@syaocode/ui` —— 投影驱动的 UI 组件。
 *
 * 约束：**不 import electron、不 import `node:`**。
 * 因此同一套组件可用于 Electron 渲染层 / 浏览器（`syao web`）/ Storybook。
 */

export { ApprovalCard, type ApprovalCardProps } from './approval-card.tsx';
export { Composer, deleteLastCodePoint, type ComposerProps } from './composer.tsx';
export { Timeline, RowView, type TimelineProps } from './timeline.tsx';
export { StatusBar, type StatusBarProps } from './status-bar.tsx';
export { messages, t, type Lang, type Messages } from './i18n.ts';
