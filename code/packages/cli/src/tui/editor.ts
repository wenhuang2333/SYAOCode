/**
 * 原始模式行编辑器（纯状态机，无 I/O）。
 *
 * TUI 层把 stdin 的字节流喂给 feed()，根据返回的事件重绘；
 * 单测直接驱动 feed() 断言状态。支持：
 * - 字符插入 / Backspace / Delete / 左右 / Home / End（CJK 码点安全）
 * - Ctrl+A/E/U/K 快捷键，Enter 提交，Ctrl+C 中断，Ctrl+D（空行时 EOF）
 * - 上/下箭头浏览历史（浏览时保留草稿）
 */

import { charWidth } from './width.js';

export type EditorEvent =
  | { type: 'update' } // 内容或光标变化，需要重绘
  | { type: 'submit'; text: string }
  | { type: 'interrupt' } // Ctrl+C：由 TUI 层决定中止当前任务或退出
  | { type: 'eof' } // Ctrl+D 且缓冲区为空
  | { type: 'nav'; dir: 'up' | 'down' } // ↑↓（navCapture 开启时，供指令联想选择）
  | { type: 'escape' } // 独立 Esc 键（关闭联想等）
  | { type: 'tab' }; // Tab（联想补全；无联想时由 TUI 决定插入空格）

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const RIGHT = '\x1b[C';
const LEFT = '\x1b[D';
const HOME = '\x1b[H';
const END = '\x1b[F';
const HOME2 = '\x1b[1~';
const END2 = '\x1b[4~';
const DEL = '\x1b[3~';

export class LineEditor {
  private buf: string[] = [];
  private cursor = 0; // 码点索引
  private history: string[] = [];
  private historyIdx = -1; // -1 = 不在历史中
  private draft = '';
  private navCapture = false; // 开启时 ↑↓ 发 nav 事件而非浏览历史

  constructor(history: readonly string[] = []) {
    this.history = [...history];
  }

  /** 指令联想激活时调用：↑↓ 转为 nav 事件用于选择候选 */
  setNavCapture(on: boolean): void {
    this.navCapture = on;
  }

  /** 程序化整行替换（联想补全） */
  setLine(text: string): void {
    this.buf = Array.from(text);
    this.cursor = this.buf.length;
    this.historyIdx = -1;
  }

  getHistory(): readonly string[] {
    return this.history;
  }

  text(): string {
    return this.buf.join('');
  }

  /** 光标前文本的显示列宽（含 CJK），供渲染光标定位 */
  cursorCol(): number {
    let w = 0;
    for (let i = 0; i < this.cursor; i++) w += charWidth(this.buf[i]!.codePointAt(0) ?? 0);
    return w;
  }

  isEmpty(): boolean {
    return this.buf.length === 0;
  }

  /** 程序化插入（粘贴 / 测试） */
  insert(text: string): EditorEvent[] {
    for (const ch of text) {
      if (ch === '\n' || ch === '\r') continue;
      this.buf.splice(this.cursor, 0, ch);
      this.cursor++;
    }
    return this.buf.length > 0 ? [{ type: 'update' }] : [];
  }

  clear(): void {
    this.buf = [];
    this.cursor = 0;
    this.historyIdx = -1;
    this.draft = '';
  }

  /** 喂入一段原始输入（可能包含多个键 / 转义序列 / 粘贴文本），返回产生的事件 */
  feed(data: string): EditorEvent[] {
    const events: EditorEvent[] = [];
    let i = 0;
    while (i < data.length) {
      const rest = data.slice(i);

      // 转义序列最长匹配
      let matched = false;
      for (const seq of [UP, DOWN, RIGHT, LEFT, HOME, END, HOME2, END2, DEL]) {
        if (rest.startsWith(seq)) {
          events.push(...this.key(seq));
          i += seq.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;

      const ch = data[i]!;
      i += 1;
      if (ch === '\r' || ch === '\n') {
        const text = this.text();
        if (text.length > 0) {
          if (this.history[this.history.length - 1] !== text) this.history.push(text);
        }
        this.buf = [];
        this.cursor = 0;
        this.historyIdx = -1;
        this.draft = '';
        events.push({ type: 'submit', text });
      } else if (ch === '\x7f') {
        if (this.cursor > 0) {
          this.buf.splice(this.cursor - 1, 1);
          this.cursor--;
          events.push({ type: 'update' });
        }
      } else if (ch === '\x03') {
        events.push({ type: 'interrupt' });
      } else if (ch === '\x04') {
        if (this.buf.length === 0) events.push({ type: 'eof' });
        else events.push(...this.key(DEL));
      } else if (ch === '\x01') {
        events.push(...this.key(HOME));
      } else if (ch === '\x05') {
        events.push(...this.key(END));
      } else if (ch === '\x15') {
        if (this.buf.length > 0) {
          this.buf = [];
          this.cursor = 0;
          this.historyIdx = -1;
          events.push({ type: 'update' });
        }
      } else if (ch === '\x0b') {
        if (this.cursor < this.buf.length) {
          this.buf.splice(this.cursor);
          events.push({ type: 'update' });
        }
      } else if (ch === '\x1b') {
        // 独立 Esc（非转义序列开头，前面的序列匹配已处理 \x1b[... 形式）
        events.push({ type: 'escape' });
      } else if (ch === '\t') {
        events.push({ type: 'tab' });
      } else if (ch >= ' ') {
        // 可打印字符（含 CJK 的后续码元在此实现中不会出现：按码点遍历）
        this.buf.splice(this.cursor, 0, ch);
        this.cursor++;
        events.push({ type: 'update' });
      }
    }
    return events;
  }

  private key(seq: string): EditorEvent[] {
    switch (seq) {
      case LEFT:
        if (this.cursor > 0) {
          this.cursor--;
          return [{ type: 'update' }];
        }
        return [];
      case RIGHT:
        if (this.cursor < this.buf.length) {
          this.cursor++;
          return [{ type: 'update' }];
        }
        return [];
      case HOME:
      case HOME2:
        if (this.cursor !== 0) {
          this.cursor = 0;
          return [{ type: 'update' }];
        }
        return [];
      case END:
      case END2:
        if (this.cursor !== this.buf.length) {
          this.cursor = this.buf.length;
          return [{ type: 'update' }];
        }
        return [];
      case DEL:
        if (this.cursor < this.buf.length) {
          this.buf.splice(this.cursor, 1);
          return [{ type: 'update' }];
        }
        return [];
      case UP:
        if (this.navCapture) return [{ type: 'nav', dir: 'up' }];
        if (this.history.length === 0) return [];
        if (this.historyIdx === -1) {
          this.draft = this.text();
          this.historyIdx = this.history.length - 1;
        } else if (this.historyIdx > 0) {
          this.historyIdx--;
        } else {
          return [];
        }
        this.loadHistoryEntry();
        return [{ type: 'update' }];
      case DOWN:
        if (this.navCapture) return [{ type: 'nav', dir: 'down' }];
        if (this.historyIdx === -1) return [];
        if (this.historyIdx < this.history.length - 1) {
          this.historyIdx++;
          this.loadHistoryEntry();
        } else {
          this.historyIdx = -1;
          this.buf = Array.from(this.draft);
          this.cursor = this.buf.length;
        }
        return [{ type: 'update' }];
      default:
        return [];
    }
  }

  private loadHistoryEntry(): void {
    const entry = this.history[this.historyIdx] ?? '';
    this.buf = Array.from(entry);
    this.cursor = this.buf.length;
  }
}
