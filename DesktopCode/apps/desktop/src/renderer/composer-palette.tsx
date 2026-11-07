/**
 * 输入区 `/` 命令面板与 `@` 文件引用（`27` §4.4 / FR-N-036）。
 *
 * 设计约束（与 `07-UI-设计系统与组件规范` 一致）：
 *  - **全部在渲染层完成**：命令只映射到既有 `Workbench` API，不新增 Host 方法；
 *  - `@` 的数据源只读 `workspace/tree`（`w.readTree`），渲染层不直接碰 fs；
 *  - `!` 直接执行命令：走 `session/run-command`（与模型 `bash` 同一个权限闸门），
 *    结果只在本地渲染，不写会话历史、不进模型上下文；
 *  - 颜色不是唯一信息载体：每一项都有文本标题、提示与 `aria-*`；
 *  - 面板打开时 `Enter` 只作用于面板，绝不发送消息（见 `stopPropagation`）。
 *
 * 与 `packages/ui` 的 `Composer` 保持零耦合：`Composer` 内部有自己的 `onKeyDown`
 * （Enter 发送 / Shift+Enter 换行 / IME 保护），我们**不修改**它，而是在
 * `window` 捕获阶段拦截面板导航键；被拦截的键不会继续到达 React 的冒泡处理器。
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { TreeNode } from '@syaocode/dhp';

// ── 命令集（顺序固定，测试直接断言）────────────────────────────────────

export type CommandId = 'new' | 'model' | 'permission' | 'stop' | 'archive' | 'git' | 'detail' | 'usage' | 'help';

export interface Command {
  readonly id: CommandId;
  /** 面板里的中文标题。 */
  readonly title: string;
  /** 一行说明（展示用）。 */
  readonly hint: string;
  /** 触发关键字（第一个用于展示与补全，如 `/new`）。 */
  readonly keys: readonly string[];
}

export const COMMANDS: readonly Command[] = [
  { id: 'new', title: '新建会话', hint: '在当前项目创建新会话', keys: ['/new'] },
  { id: 'model', title: '选择模型', hint: '打开渠道与模型选择器', keys: ['/model'] },
  { id: 'permission', title: '切换权限', hint: '聚焦会话权限下拉框', keys: ['/permission'] },
  { id: 'stop', title: '停止运行', hint: '停止当前轮次（运行中可用）', keys: ['/stop'] },
  { id: 'archive', title: '归档会话', hint: '归档当前会话，可在会话树恢复', keys: ['/archive'] },
  { id: 'git', title: '打开 Git 侧栏', hint: '切换到右栏 Git 槽位', keys: ['/git'] },
  { id: 'detail', title: '会话详情', hint: '切换到右栏会话详情', keys: ['/detail'] },
  { id: 'usage', title: '用量统计', hint: '打开用量页', keys: ['/usage'] },
  { id: 'help', title: '帮助', hint: '在输入区插入命令与快捷键帮助（不发送）', keys: ['/help'] },
];

/** `/help` 插入到输入区的帮助文本（只插入，不发送）。 */
export const HELP_TEXT = '可用命令：/new 新建会话 · /model 选择模型 · /permission 切换权限 · /stop 停止运行 · /archive 归档会话 · /git Git 侧栏 · /detail 会话详情 · /usage 用量统计 · /help 帮助。输入 @ 引用工作区文件；Enter 发送，Shift Enter 换行。';

/**
 * `!` 前缀的提示：现在会**真的执行**（FR-N-036），但仍与模型的 `bash` 工具
 * 共用同一个内核权限闸门——危险命令会被直接拒绝，写类命令会先弹审批卡。
 */
export const SHELL_HINT = '! 直接在本机会话工作区执行命令（结果不回传给模型）；仍过权限闸门：危险命令会被拒绝，写类命令会先请你批准。';

/** 文件引用列表上限（防止一次渲染几千项）。 */
export const FILE_LIMIT = 50;

/** 命令面板选中后的动作；`insert` 表示文本已由 `applyCommand` 插入，无需再执行动作。 */
export type CommandAction =
  | { readonly kind: CommandId }
  | { readonly kind: 'insert'; readonly text: string }
  | { readonly kind: 'none' };

// ── 触发检测与编辑（纯函数，可被测试直接断言）──────────────────────────

export interface Trigger {
  readonly kind: 'slash' | 'mention';
  /** 触发字符之后、光标之前的过滤片段（不含触发字符本身）。 */
  readonly query: string;
  /** 触发字符在文本中的下标。 */
  readonly start: number;
  /** 当前触发词（连续非空白字符）的结束下标（不含）。 */
  readonly end: number;
}

const SLASH_HEAD = /^[ \t\r\n]*\//;
const MENTION_BLOCKED_PREFIX = /[A-Za-z0-9_.+-]/;
/** 命令名只含 ASCII 字母、数字与连字符（`/permission` 这类）。 */
const COMMAND_CHAR = /[A-Za-z0-9-]/;
/**
 * 文件引用片段：允许中文文件名与相对路径字符，但遇到空白或常见中英文标点就结束。
 * （用户常直接接中文标点继续写正文，如 `@src/a.ts，谢谢`——不能把正文吞进引用。）
 */
const MENTION_CHAR = /[^\s，。、；：！？（）【】「」《》“”‘’…—,;:!?()[\]{}"'<>@]/;

function isMentionChar(char: string): boolean {
  return char !== '' && MENTION_CHAR.test(char);
}

function triggerKeyOf(trigger: Trigger | null): string {
  return trigger === null ? '' : `${trigger.kind}:${trigger.start}:${trigger.end}:${trigger.query}`;
}

/** 从 `start` 开始、连续满足 `allowed` 的字符的结束位置（不含）。 */
function tokenEnd(text: string, start: number, allowed: RegExp): number {
  let end = start + 1;
  while (end < text.length && allowed.test(text[end] ?? '')) end += 1;
  return end;
}

/**
 * 检测光标处是否处于 `/` 命令或 `@` 文件引用触发中。
 *
 * 规则：
 *  - `/` 只在**文本开头**（允许前置空白）触发；词中的 `/`（如 `src/main.ts`）不触发；
 *  - 光标越过触发词（例如 `/new ` 之后再输入内容）时不再触发，避免把普通消息当成命令；
 *  - `@` 可在任意位置触发，但前面紧跟 ASCII 标识符字符时不触发（避免 `test@example.com`）。
 */
export function detectTrigger(text: string, caret: number): Trigger | null {
  const position = Math.max(0, Math.min(Math.trunc(caret), text.length));
  const slash = SLASH_HEAD.exec(text.slice(0, position));
  if (slash) {
    const start = slash[0].length - 1;
    const end = tokenEnd(text, start, COMMAND_CHAR);
    // 光标越过命令词（`/new ` 之后继续输入）就不再是命令，转而按 `@` 扫描。
    if (position <= end) return { kind: 'slash', query: text.slice(start + 1, position), start, end };
  }
  for (let index = position - 1; index >= 0; index -= 1) {
    const char = text[index] ?? '';
    if (char === '@') {
      const previous = index > 0 ? text[index - 1] ?? '' : '';
      if (previous !== '' && MENTION_BLOCKED_PREFIX.test(previous)) continue;
      const end = tokenEnd(text, index, MENTION_CHAR);
      if (position > end) return null;
      return { kind: 'mention', query: text.slice(index + 1, Math.min(position, end)), start: index, end };
    }
    if (!isMentionChar(char)) break;
  }
  return null;
}

/** 命令面板：按 id / 标题 / 关键字做大小写不敏感的包含匹配；空查询返回全部（顺序固定）。 */
export function matchCommands(query: string): readonly Command[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return COMMANDS;
  return COMMANDS.filter((command) => command.id.toLowerCase().includes(needle)
    || command.title.toLowerCase().includes(needle)
    || command.keys.some((key) => key.slice(1).toLowerCase().includes(needle)));
}

/**
 * 命令面板：删掉触发用的 `/xxx` 文本（不发送），并返回要执行的动作。
 *
 * `/help` 例外：把触发串替换为帮助文本（`action.kind === 'insert'`），由调用方回写输入区。
 */
export function applyCommand(
  text: string,
  trigger: Trigger,
  commandId: CommandId | string,
  caret: number,
): { readonly text: string; readonly caret: number; readonly action: CommandAction } {
  const position = Math.max(0, Math.min(Math.trunc(caret), text.length));
  const command = COMMANDS.find((entry) => entry.id === commandId);
  // 触发已失效（类型不对、命令不存在、光标离开触发串）时不动文本。
  if (trigger.kind !== 'slash' || !command || position < trigger.start || position > trigger.end) {
    return { text, caret: position, action: { kind: 'none' } };
  }
  const before = text.slice(0, trigger.start);
  const after = text.slice(trigger.end);
  if (command.id === 'help') {
    return { text: `${before}${HELP_TEXT}${after}`, caret: before.length + HELP_TEXT.length, action: { kind: 'insert', text: HELP_TEXT } };
  }
  return { text: `${before}${after}`, caret: before.length, action: { kind: command.id } };
}

/** `@` 文件引用：用 `@<相对路径>` 替换当前触发串，保留前后文本，只替换当前这一个 `@`。 */
export function applyMention(text: string, trigger: Trigger, path: string): { readonly text: string; readonly caret: number } {
  if (trigger.kind !== 'mention') return { text, caret: trigger.start };
  const before = text.slice(0, trigger.start);
  const after = text.slice(trigger.end);
  const mention = `@${path}`;
  return { text: `${before}${mention}${after}`, caret: before.length + mention.length };
}

/** 文件过滤：大小写不敏感、按路径包含匹配、上限 `FILE_LIMIT` 条。 */
export function filterFiles(paths: readonly string[], query: string): readonly string[] {
  const needle = query.trim().toLowerCase();
  const matched = needle === '' ? paths : paths.filter((path) => path.toLowerCase().includes(needle));
  return matched.slice(0, FILE_LIMIT);
}

/** 把 `workspace/tree` 的节点树摊平成文件相对路径列表（目录不进入引用）。 */
export function collectFilePaths(nodes: readonly TreeNode[] | undefined): readonly string[] {
  const files: string[] = [];
  const walk = (list: readonly TreeNode[]): void => {
    for (const node of list) {
      if (node.type === 'file') files.push(node.path);
      else if (node.children) walk(node.children);
    }
  };
  if (nodes) walk(nodes);
  return files;
}

/** 草稿以 `!` 开头时返回诚实提示；其他返回 `null`。 */
export function shellHintFor(text: string): string | null {
  return /^\s*!/.test(text) ? SHELL_HINT : null;
}

// ── 组件 ──────────────────────────────────────────────────────────────

export interface ComposerPaletteProps {
  /** 输入区当前文本（受控）。 */
  readonly text: string;
  /** 输入区当前光标位置（用于触发检测与补全后回写）。 */
  readonly caret: number;
  /** 工作区文件相对路径（由 workbench 通过 `w.readTree` 取得）。 */
  readonly files: readonly string[];
  readonly filesLoading?: boolean;
  /** 读取失败时的说明（只用于决定空态文案，不弹窗）。 */
  readonly filesError?: string;
  /** 当前是否有可停止的轮次；否则 `/stop` 项禁用。 */
  readonly canStop?: boolean;
  readonly disabled?: boolean;
  /** 输入区容器（用于回写后归还焦点、设置 aria 关系属性）。 */
  readonly anchorRef?: RefObject<HTMLElement | null>;
  /** 选中命令后上抛动作（由 workbench 映射到既有 API）。 */
  readonly onAction: (action: CommandAction) => void;
  /** 补全 / 插入 / 删除触发串后回写文本与光标。 */
  readonly onText: (next: { readonly text: string; readonly caret: number }) => void;
}

interface PaletteItem {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly hint: string;
  readonly disabled: boolean;
}

function focusComposer(anchorRef: RefObject<HTMLElement | null> | undefined): void {
  anchorRef?.current?.querySelector('textarea')?.focus();
}

export function ComposerPalette({
  text,
  caret,
  files,
  filesLoading = false,
  filesError = '',
  canStop = false,
  disabled = false,
  anchorRef,
  onAction,
  onText,
}: ComposerPaletteProps): ReactNode {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const paletteRef = useRef<HTMLDivElement | null>(null);
  const trigger = disabled ? null : detectTrigger(text, caret);
  const triggerKey = triggerKeyOf(trigger);
  // Esc / 点击面板外后，同一触发串保持关闭；触发串变化后自动重新打开。
  const [closedKey, setClosedKey] = useState('');
  const [active, setActive] = useState(0);
  // 选中的文件已经是完整路径（`@src/a.ts` 后光标在末尾）时不再弹面板，避免选完立刻又弹出来。
  const mentionComplete = trigger?.kind === 'mention' && caret >= trigger.end && files.includes(trigger.query);
  const open = trigger !== null && !mentionComplete && closedKey !== triggerKey;
  const commands = useMemo(() => (trigger?.kind === 'slash' ? matchCommands(trigger.query) : []), [trigger?.kind, trigger?.query]);
  const visibleFiles = useMemo(() => (trigger?.kind === 'mention' ? filterFiles(files, trigger.query) : []), [trigger?.kind, trigger?.query, files]);
  const items: readonly PaletteItem[] = trigger?.kind === 'slash'
    ? commands.map((command) => ({
      id: command.id,
      key: command.keys[0] ?? `/${command.id}`,
      title: command.title,
      hint: command.hint,
      disabled: command.id === 'stop' && !canStop,
    }))
    : visibleFiles.map((path) => ({ id: path, key: path, title: path, hint: '引用工作区文件', disabled: false }));
  const selected = items.length === 0 ? -1 : Math.min(active, items.length - 1);
  // 触发串 / 过滤词变化时把高亮重置到第一项（键盘上下键仍可继续移动）。
  useEffect(() => { setActive(0); }, [triggerKey]);
  const emptyText = trigger?.kind === 'slash'
    ? '没有匹配的命令'
    : filesLoading
      ? '正在读取工作区文件…'
      : filesError !== '' || files.length === 0
        ? '未取到工作区文件（可在会话详情查看）'
        : '没有匹配的文件';

  const execute = (item: PaletteItem | undefined): void => {
    if (!item || item.disabled || trigger === null) return;
    if (trigger.kind === 'slash') {
      const result = applyCommand(text, trigger, item.id, caret);
      onText({ text: result.text, caret: result.caret });
      if (result.action.kind !== 'none' && result.action.kind !== 'insert') onAction(result.action);
    } else {
      onText(applyMention(text, trigger, item.id));
    }
    setClosedKey(triggerKey);
  };

  const complete = (item: PaletteItem | undefined): void => {
    if (!item || trigger === null) return;
    const next = `${text.slice(0, trigger.start)}/${item.id}${text.slice(trigger.end)}`;
    onText({ text: next, caret: trigger.start + 1 + item.id.length });
  };

  // 输入框的 aria 关系属性只能通过 DOM 设置：`Composer` 在 `packages/ui` 内，本轮不改包。
  useEffect(() => {
    const textarea = anchorRef?.current?.querySelector('textarea');
    if (!textarea) return;
    if (!open) {
      textarea.setAttribute('aria-expanded', 'false');
      textarea.removeAttribute('aria-activedescendant');
      textarea.removeAttribute('aria-controls');
      return;
    }
    textarea.setAttribute('aria-expanded', 'true');
    textarea.setAttribute('aria-controls', listId);
    if (selected >= 0) textarea.setAttribute('aria-activedescendant', `${baseId}-option-${selected}`);
    else textarea.removeAttribute('aria-activedescendant');
  }, [open, selected, listId, baseId, anchorRef]);

  // 面板打开时，在 window 捕获阶段拦截导航键：React 的冒泡处理器（Composer 的 Enter 发送）不会收到。
  useEffect(() => {
    if (!open || trigger === null) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.isComposing) return;
      // 焦点不在输入区（例如对话框里的 Enter）时绝不劫持按键。
      const anchor = anchorRef?.current;
      const inAnchor = anchor == null || (event.target instanceof Node && anchor.contains(event.target));
      if (!inAnchor) return;
      // 只有输入区（或面板自身）获得焦点时才劫持导航键；工具栏下拉的 Enter 保持原样。
      const fromComposer = event.target instanceof HTMLTextAreaElement;
      if (!fromComposer && event.key !== 'Escape') return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setClosedKey(triggerKey);
        focusComposer(anchorRef);
        return;
      }
      // Shift+Enter 仍然是换行（既有行为），面板不劫持。
      if (event.key === 'Enter' && event.shiftKey) return;
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter' && event.key !== 'Tab') return;
      event.preventDefault();
      event.stopPropagation();
      if (items.length === 0) return;
      if (event.key === 'ArrowDown') {
        setActive((current) => (Math.min(current, items.length - 1) + 1) % items.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        setActive((current) => (Math.min(current, items.length - 1) - 1 + items.length) % items.length);
        return;
      }
      if (event.key === 'Tab') {
        if (trigger.kind === 'slash') complete(items[selected]);
        else execute(items[selected]);
        return;
      }
      execute(items[selected]);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  });

  // 点击面板外 / 输入区外关闭面板（不阻止输入区继续编辑）。
  useEffect(() => {
    if (!open) return;
    const handler = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (paletteRef.current?.contains(target)) return;
      const textarea = anchorRef?.current?.querySelector('textarea');
      if (textarea && textarea.contains(target)) return;
      setClosedKey(triggerKey);
    };
    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, [open, triggerKey, anchorRef]);

  if (!open || trigger === null) return null;

  const body = items.length === 0
    ? <p className="palette-empty">{emptyText}</p>
    : items.map((item, index) => (
      <button
        key={item.key}
        id={`${baseId}-option-${index}`}
        type="button"
        role="option"
        aria-selected={index === selected}
        aria-disabled={item.disabled}
        className={`palette-item${index === selected ? ' selected' : ''}${item.disabled ? ' disabled' : ''}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => execute(item)}
      >
        {trigger.kind === 'slash' && <span className="palette-key">{item.key}</span>}
        <span className="palette-title">{item.title}</span>
        <small className="palette-hint">{item.hint}</small>
      </button>
    ));

  return (
    <div className="composer-palette" data-kind={trigger.kind} ref={paletteRef}>
      <div className="composer-palette-head">
        <strong>{trigger.kind === 'slash' ? '命令' : '文件引用'}</strong>
        <small>{trigger.kind === 'slash' ? '↑↓ 选择 · Enter 执行 · Tab 补全 · Esc 关闭' : '↑↓ 选择 · Enter 引用 · Esc 关闭'}</small>
      </div>
      {trigger.kind === 'slash'
        ? <div id={listId} className="composer-palette-list" role="listbox" aria-label="命令面板">{body}</div>
        : <div id={listId} className="composer-palette-list" role="listbox" aria-label="文件引用">{body}</div>}
    </div>
  );
}
