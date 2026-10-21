import { describe, expect, it } from 'vitest';
import {
  incompleteEscapeSuffix,
  isTinyTerminal,
  parseOsc11Dark,
  sanitizeInputChunk,
  toAscii,
} from '../src/tui/terminal';

describe('tui/terminal 终端健壮层', () => {
  it('isTinyTerminal：极小窗口判定', () => {
    expect(isTinyTerminal(39, 24)).toBe(true);
    expect(isTinyTerminal(100, 7)).toBe(true);
    expect(isTinyTerminal(40, 8)).toBe(false);
    expect(isTinyTerminal(120, 40)).toBe(false);
  });

  it('incompleteEscapeSuffix：识别未完成的转义序列（ESC 分片）', () => {
    expect(incompleteEscapeSuffix('\x1b')).toBe('\x1b');
    expect(incompleteEscapeSuffix('\x1b[')).toBe('\x1b[');
    expect(incompleteEscapeSuffix('\x1b[1;5')).toBe('\x1b[1;5');
    expect(incompleteEscapeSuffix('\x1b[A')).toBe(''); // 完整
    expect(incompleteEscapeSuffix('abc')).toBe('');
    expect(incompleteEscapeSuffix('abc\x1b')).toBe('\x1b');
  });

  it('sanitizeInputChunk：剥离 OSC 应答、bracketed paste 内换行转空格', () => {
    // OSC 11 应答不应漏进编辑器
    expect(sanitizeInputChunk('\x1b]11;rgb:0000/0000/0000\x07abc', { pasteActive: false })).toBe('abc');
    // 括号粘贴：多行不触发提交
    const st = { pasteActive: false };
    const out = sanitizeInputChunk('\x1b[200~line1\nline2\r\nline3\x1b[201~', st);
    expect(out).toBe('line1 line2 line3');
    expect(st.pasteActive).toBe(false);
  });

  it('sanitizeInputChunk：粘贴分块到达（跨块状态保持）', () => {
    const st = { pasteActive: false };
    expect(sanitizeInputChunk('\x1b[200~first\n', st)).toBe('first ');
    expect(st.pasteActive).toBe(true);
    expect(sanitizeInputChunk('second\x1b[201~', st)).toBe('second');
    expect(st.pasteActive).toBe(false);
  });

  it('sanitizeInputChunk：无括号粘贴的终端也按粘贴处理多行块', () => {
    expect(sanitizeInputChunk('a\nb\nc', { pasteActive: false })).toBe('a b c');
    // 单独的 Enter（单字符）不受影响
    expect(sanitizeInputChunk('\r', { pasteActive: false })).toBe('\r');
  });

  it('sanitizeInputChunk：文字+Enter 同块不是粘贴（回归：/exit\\r 曾被改成 /exit 空格）', () => {
    expect(sanitizeInputChunk('/exit\r', { pasteActive: false })).toBe('/exit\r');
    expect(sanitizeInputChunk('hello\r', { pasteActive: false })).toBe('hello\r');
    expect(sanitizeInputChunk('/status\r', { pasteActive: false })).toBe('/status\r');
  });

  it('parseOsc11Dark：亮度判定', () => {
    expect(parseOsc11Dark('rgb:0000/0000/0000')).toBe(true);
    expect(parseOsc11Dark('rgb:ffff/ffff/ffff')).toBe(false);
    expect(parseOsc11Dark('rgb:1e1e/1e1e/1e1e')).toBe(true);
    expect(parseOsc11Dark('no color here')).toBeNull();
  });

  it('toAscii：默认不转换；开启降级后 BoxDrawing/半块 → ASCII', () => {
    expect(toAscii('╭─╮│▀')).toBe('╭─╮│▀');
    process.env.SYAO_TUI_ASCII = '1';
    try {
      expect(toAscii('╭─╮│▀▄█')).toBe('+ - + | ###'.replace(/ /g, ''));
      expect(toAscii('❯ /help')).toBe('> /help');
    } finally {
      delete process.env.SYAO_TUI_ASCII;
    }
  });
});
