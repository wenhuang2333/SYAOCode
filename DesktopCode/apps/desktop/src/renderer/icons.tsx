/**
 * 语义图标（自绘 SVG，零依赖）。
 *
 * 与 `07-UI-设计系统与组件规范` 一致：不引入图形库，图标只表达语义，
 * 颜色不作为唯一信息载体——真正的状态永远有文本或 `aria-label` 兜底。
 */

import type { ReactNode } from 'react';

const PATHS: Record<string, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  chat: <path d="M4 4h16v12H9l-5 4V4Z" />,
  usage: <><path d="M4 3v18h17M8 16v-4M13 16V7M18 16v-7" /></>,
  sessions: <><path d="M6 3v14h13M6 8h13" /><circle cx="19" cy="8" r="2" /><circle cx="19" cy="17" r="2" /></>,
  files: <><path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6" /></>,
  agents: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M17 14a5 5 0 0 1 4 6" /></>,
  resources: <><path d="m12 3 8 5v9l-8 4-8-4V8zM4 8l8 5 8-5M12 13v8" /></>,
  folder: <path d="M3 6h7l2 2h9v12H3z" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  down: <path d="m5 9 7 7 7-7" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
  settings: <><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" /></>,
  edit: <><path d="m4 16 12-12 4 4L8 20H4zM13 7l4 4" /></>,
  archive: <><path d="M4 8h16v13H4zM3 3h18v5H3zM9 12h6" /></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6" /></>,
  code: <path d="m7 7-5 5 5 5M17 7l5 5-5 5M14 3l-4 18" />,
  arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 14-2l1 6M4 12l1 6a8 8 0 0 0 14-2" /></>,
  /** Git：分支与节点（顶部工具栏入口）。 */
  git: <><circle cx="7" cy="5" r="2" /><circle cx="7" cy="19" r="2" /><circle cx="17" cy="8" r="2" /><path d="M7 7v10M17 10c0 5-5 4-8 7" /></>,
  /** 分支页。 */
  branch: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10M18 9c0 4-6 4-9 8" /></>,
  /** 上传。 */
  upload: <><path d="M12 16V4m-5 5 5-5 5 5" /><path d="M4 20h16" /></>,
  /** 复制。 */
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></>,
  /** 完成 / 已就绪。 */
  check: <path d="m4 12 5 5L20 6" />,
  /** 警告。 */
  warn: <><path d="M12 3 2 21h20z" /><path d="M12 9v5M12 18h.01" /></>,
  /** 外部链接（不自动打开，只展示）。 */
  link: <><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></>,
};

export function Icon({ name, size = 17 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name] ?? PATHS.code}
    </svg>
  );
}
