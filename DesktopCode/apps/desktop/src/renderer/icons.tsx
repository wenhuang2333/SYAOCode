/**
 * 语义图标层（FR-N-037 / UI 规范）。
 *
 * 图标来自 **lucide-react**（成熟组件库），不再自绘路径：自绘的 24×24 stroke
 * 形状在 12–16px 下会糊成一团，而且每加一个语义就要重画一遍。这里保留
 * `Icon({ name, size })` 的调用形态，把业务语义映射到 lucide 组件，
 * 于是调用点不必记住库里的命名，新增语义只需要在 MAP 里加一行。
 *
 * 颜色永远不是唯一信息载体：真正的状态另有文本或 `aria-label` 兜底。
 */

import {
  Archive,
  ArrowUp,
  BarChart3,
  Bot,
  Boxes,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  CircleAlert,
  CircleCheck,
  Clock,
  Code2,
  Coins,
  Copy,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  History,
  Info,
  Link2,
  LoaderCircle,
  MessageSquare,
  Monitor,
  Moon,
  PanelRight,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SendHorizontal,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  Terminal,
  TriangleAlert,
  Upload,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';

/** 业务语义 → lucide 组件。名字是稳定契约，换库只改这张表。 */
const MAP: Record<string, LucideIcon> = {
  plus: Plus,
  search: Search,
  chat: MessageSquare,
  usage: BarChart3,
  sessions: History,
  files: FileText,
  agents: Bot,
  resources: Boxes,
  folder: Folder,
  'folder-open': FolderOpen,
  chevron: ChevronRight,
  'chevron-left': ChevronLeft,
  'chevron-up': ChevronUp,
  down: ChevronDown,
  'chevron-down': ChevronDown,
  'chevrons-up-down': ChevronsUpDown,
  close: X,
  panel: PanelRight,
  settings: Settings,
  edit: Pencil,
  archive: Archive,
  shield: ShieldCheck,
  code: Code2,
  terminal: Terminal,
  arrow: ArrowUp,
  send: SendHorizontal,
  refresh: RefreshCw,
  loading: LoaderCircle,
  stop: Square,
  attach: Paperclip,
  git: GitCommitHorizontal,
  branch: GitBranch,
  upload: Upload,
  copy: Copy,
  check: CircleCheck,
  'check-plain': Check,
  warn: TriangleAlert,
  info: Info,
  link: Link2,
  clock: Clock,
  coins: Coins,
  sparkles: Sparkles,
  'file-code': FileCode2,
  users: Users,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
};

export type IconName = keyof typeof MAP | string;

export function Icon({ name, size = 16, strokeWidth }: { name: IconName; size?: number; strokeWidth?: number }) {
  const Cmp = MAP[name] ?? Code2;
  return <Cmp size={size} strokeWidth={strokeWidth ?? 1.7} aria-hidden="true" absoluteStrokeWidth />;
}

export const iconNames = Object.keys(MAP);
