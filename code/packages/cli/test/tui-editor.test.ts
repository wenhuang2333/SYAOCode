import { describe, expect, it } from 'vitest';
import { LineEditor } from '../src/tui/editor';

function eventsOf(ed: LineEditor, input: string): string {
  return ed.feed(input)
    .map((e) => (e.type === 'submit' ? `submit(${e.text})` : e.type))
    .join(',');
}

describe('tui/editor 行编辑器', () => {
  it('输入与提交', () => {
    const ed = new LineEditor();
    expect(eventsOf(ed, 'hello')).toBe('update,update,update,update,update');
    expect(ed.text()).toBe('hello');
    expect(eventsOf(ed, '\r')).toBe('submit(hello)');
    expect(ed.text()).toBe('');
  });

  it('Backspace / Delete / 光标移动', () => {
    const ed = new LineEditor();
    ed.insert('abc');
    ed.feed('\x1b[D\x1b[D'); // ←←
    expect(ed.cursorCol()).toBe(1);
    ed.feed('\x7f'); // Backspace 删 'a'
    expect(ed.text()).toBe('bc');
    ed.feed('\x1b[C'); // →
    ed.feed('\x1b[3~'); // Del 删 'c'
    expect(ed.text()).toBe('b');
    ed.feed('\x1b[H'); // Home
    expect(ed.cursorCol()).toBe(0);
    ed.feed('\x1b[F'); // End
    expect(ed.cursorCol()).toBe(1);
  });

  it('CJK 按码点删除与列宽计算', () => {
    const ed = new LineEditor();
    ed.insert('中文a');
    expect(ed.cursorCol()).toBe(5); // 2+2+1
    ed.feed('\x7f'); // 删 'a'
    expect(ed.text()).toBe('中文');
    ed.feed('\x7f'); // 删 '文'（整个码点）
    expect(ed.text()).toBe('中');
    expect(ed.cursorCol()).toBe(2);
  });

  it('历史：上/下浏览且保留草稿', () => {
    const ed = new LineEditor();
    ed.feed('one\r');
    ed.feed('two\r');
    expect(ed.getHistory()).toEqual(['one', 'two']);
    ed.insert('thr');
    ed.feed('\x1b[A'); // ↑ two
    expect(ed.text()).toBe('two');
    ed.feed('\x1b[A'); // ↑ one
    expect(ed.text()).toBe('one');
    ed.feed('\x1b[B'); // ↓ two
    expect(ed.text()).toBe('two');
    ed.feed('\x1b[B'); // ↓ 回到草稿
    expect(ed.text()).toBe('thr');
  });

  it('连续重复的历史不入栈', () => {
    const ed = new LineEditor();
    ed.feed('same\r');
    ed.feed('same\r');
    expect(ed.getHistory()).toEqual(['same']);
  });

  it('Ctrl+U 清行、Ctrl+K 删到行尾', () => {
    const ed = new LineEditor();
    ed.insert('abcdef');
    ed.feed('\x01'); // Ctrl+A → Home
    ed.feed('\x1b[C\x1b[C'); // →→
    ed.feed('\x0b'); // Ctrl+K
    expect(ed.text()).toBe('ab');
    ed.feed('\x15'); // Ctrl+U
    expect(ed.text()).toBe('');
  });

  it('Ctrl+C 中断、Ctrl+D 空行 EOF', () => {
    const ed = new LineEditor();
    expect(eventsOf(ed, '\x03')).toBe('interrupt');
    expect(eventsOf(ed, '\x04')).toBe('eof');
    ed.insert('xy');
    ed.feed('\x1b[D'); // ← 光标到 'x' 后
    expect(eventsOf(ed, '\x04')).toBe('update'); // 非空时 Ctrl+D 充当 Del
    expect(ed.text()).toBe('x');
  });

  it('一次 feed 多个键（粘贴场景）', () => {
    const ed = new LineEditor();
    const out = ed.feed('ab\r');
    expect(out.some((e) => e.type === 'submit' && e.text === 'ab')).toBe(true);
    const out2 = ed.feed('\x1b[Dx\r'); // ← x ↵
    expect(out2.some((e) => e.type === 'submit' && e.text === 'x')).toBe(true);
  });
});
