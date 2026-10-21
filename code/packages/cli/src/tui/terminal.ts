/**
 * 终端健壮层：应对 TUI 常见环境问题（崩溃后终端污染、粘贴、转义序列
 * 分片、极小窗口、浅色主题、无 UTF-8 字体环境）。
 *
 * - installTerminalGuards：uncaughtException / unhandledRejection / exit /
 *   SIGINT / SIGTERM / SIGHUP 统一清理（恢复 raw、光标、粘贴模式、同步输出）；
 *   等价于 Rust TUI 的 panic hook，避免崩溃后终端残留 raw 模式。
 * - bracketed paste（DEC 2004）：粘贴多行不会触发多次提交。
 * - 转义序列分片缓冲：ESC 与后续字节分两个 chunk 到达时仍正确解析。
 * - 极小终端（<40 列或 <8 行）：调用方切换为无边框最小界面。
 * - 主题探测（OSC 11）：浅色终端上欢迎面板艺术字使用深色系，避免白底白字。
 * - ASCII 降级（SYAO_TUI_ASCII=1）：BoxDrawing/半块字符替换为等价 ASCII，
 *   兼容字体缺失或非 UTF-8 会话。
 */

export const SHOW_CURSOR = '\x1b[?25h';
export const HIDE_CURSOR = '\x1b[?25l';
export const SYNC_ON = '\x1b[?2026h';
export const SYNC_OFF = '\x1b[?2026l';
export const BRACKET_PASTE_ON = '\x1b[?2004h';
export const BRACKET_PASTE_OFF = '\x1b[?2004l';
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/** 极小终端判定：低于该尺寸不画边框/面板，仅保留最小输入行 */
export function isTinyTerminal(cols: number, rows: number): boolean {
  return cols < 40 || rows < 8;
}

/** ASCII 降级模式（环境变量显式开启；默认使用 BoxDrawing 与半块字符） */
export function asciiMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SYAO_TUI_ASCII === '1';
}

const ASCII_MAP: Record<string, string> = {
  '─': '-', '│': '|', '╭': '+', '╮': '+', '╰': '+', '╯': '+',
  '┌': '+', '┐': '+', '└': '+', '┘': '+', '├': '+', '┤': '+',
  '┬': '+', '┴': '+', '┼': '+', '▕': '|', '┃': '|', '╌': '-',
  '▀': '#', '▄': '#', '█': '#', '▍': '|', '░': '.', '▒': ':', '▓': '%',
  '●': '*', '◉': 'o', '○': 'o', '❯': '>', '▸': '>', '·': '.', '…': '...',
  '↑': '^', '↓': 'v', '✔': '+', '✖': 'x', '⚠': '!', '▮': '|',
};

/** 把渲染行中的 BoxDrawing/半块字符替换为 ASCII 等价物（颜色转义不受影响） */
export function toAscii(line: string): string {
  if (!asciiMode()) return line;
  let out = '';
  for (const ch of line) out += ASCII_MAP[ch] ?? ch;
  return out;
}

export interface GuardHandle {
  /** 幂等清理：恢复 raw 模式 / 光标 / 粘贴与同步输出 */
  cleanup(): void;
  /** 卸载 hooks（测试用） */
  dispose(): void;
}

/**
 * 安装终端清理钩子。任何未捕获异常、退出信号或进程退出都会先恢复终端状态，
 * 避免「程序崩了终端一起废」：raw 模式残留、光标隐藏、粘贴模式开启。
 */
export function installTerminalGuards(input: NodeJS.ReadStream, output: NodeJS.WriteStream): GuardHandle {
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    try {
      input.setRawMode?.(false);
    } catch {
      /* stdin 可能已销毁 */
    }
    try {
      output.write(BRACKET_PASTE_OFF + SYNC_OFF + SHOW_CURSOR);
    } catch {
      /* stdout 可能已关闭（EPIPE） */
    }
  };

  const onSignal = (code: number) => {
    cleanup();
    process.exit(code);
  };
  const onUncaught = (err: unknown) => {
    cleanup();
    try {
      process.stderr.write(`\nfatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    } catch {
      /* ignore */
    }
    process.exit(1);
  };
  const onRejection = (reason: unknown) => onUncaught(reason);
  const onSigint = () => onSignal(130);
  const onSigterm = () => onSignal(143);
  const onSighup = () => onSignal(129);

  // stdout 断开（管道读取端关闭）不应把整个进程打崩
  const onOutputError = () => {
    /* EPIPE：静默，等待下一次写入失败被忽略 */
  };

  process.on('exit', cleanup);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('SIGHUP', onSighup);
  output.on('error', onOutputError);

  return {
    cleanup,
    dispose: () => {
      process.off('exit', cleanup);
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onRejection);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      process.off('SIGHUP', onSighup);
      output.off('error', onOutputError);
    },
  };
}

// ── 输入清洗：粘贴 / OSC 应答 / 转义分片 ─────────────────────────────────

const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * 单次到达的输入是否像"粘贴"：不能只看"含换行"——用户正常输入时，文字与
 * Enter 也常在同一块里到达（如 "/exit\r"），误判会吞掉命令。
 * 判定：块内 ≥2 个换行，或块本身超长（>200 字符）。
 */
function looksLikePaste(chunk: string): boolean {
  const newlines = (chunk.match(/[\r\n]/g) ?? []).length;
  return chunk.length > 200 || newlines >= 2;
}

/**
 * 清洗一个输入块：
 * - 移除终端对 OSC 查询的应答（避免漏进编辑器）；
 * - 识别 bracketed-paste 边界（DEC 2004），粘贴内容中的换行转空格——防止
 *   一次多行粘贴被拆成多次提交（经典 TUI 粘贴事故）；
 * - 无 bracketed-paste 的终端：多字符且含换行的块同样按粘贴处理。
 * state.pasteActive 跨块保持（大型粘贴可能分多次到达）。
 */
export function sanitizeInputChunk(chunk: string, state: { pasteActive: boolean }): string {
  let s = chunk.replace(OSC_RE, '');
  const pasteParts: string[] = [];
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf(PASTE_START, i);
    if (state.pasteActive) {
      const end = s.indexOf(PASTE_END, i);
      if (end < 0) {
        pasteParts.push(s.slice(i));
        i = s.length;
      } else {
        pasteParts.push(s.slice(i, end));
        state.pasteActive = false;
        i = end + PASTE_END.length;
      }
    } else if (start >= 0) {
      pasteParts.push(s.slice(i, start));
      state.pasteActive = true;
      i = start + PASTE_START.length;
    } else {
      pasteParts.push(s.slice(i));
      i = s.length;
    }
  }
  const joined = pasteParts.join('');
  if (state.pasteActive || looksLikePaste(joined)) {
    // 粘贴内容中的换行不触发提交
    return joined.replace(/[\r\n]+/g, ' ');
  }
  return joined;
}

/**
 * 若字符串末尾是"未完成的转义序列"，返回该后缀（调用方暂存等待下一块）。
 * 覆盖 ESC 单独到达、ESC[ 后数字/参数未收完的情况。
 */
export function incompleteEscapeSuffix(s: string): string {
  const m = /(\x1b\[[0-9;?]*|\x1b\][^\x07\x1b]*|\x1b)$/.exec(s);
  return m?.[1] ?? '';
}

// ── 主题探测（OSC 11） ───────────────────────────────────────────────────

let darkTheme = true;
export function setDarkTheme(dark: boolean): void {
  darkTheme = dark;
}
export function isDarkTheme(): boolean {
  return darkTheme;
}

/** 欢迎面板艺术字配色：浅色终端用深色主字 + 中灰投影，保证可读 */
export function artColors(): { main: number; shadow: number } {
  return darkTheme ? { main: 255, shadow: 238 } : { main: 240, shadow: 248 };
}

/** 解析 OSC 11 应答（rgb:RRRR/GGGG/BBBB）为亮度是否偏暗；无法解析返回 null */
export function parseOsc11Dark(buf: string): boolean | null {
  const m = /rgb:([0-9a-f]{2,4})\/([0-9a-f]{2,4})\/([0-9a-f]{2,4})/i.exec(buf);
  if (m === null) return null;
  const norm = (hex: string) => parseInt(hex, 16) / (hex.length >= 4 ? 0xffff : 0xff);
  const lum = 0.2126 * norm(m[1]!) + 0.7152 * norm(m[2]!) + 0.0722 * norm(m[3]!);
  return lum < 0.5;
}

/**
 * 查询终端背景色（OSC 11），超时/不支持则视为深色（主流默认）。
 * 必须在主输入处理挂载之前调用，避免把终端的应答字节漏进编辑器；
 * 应答也会被 sanitizeInputChunk 兜底清除。
 */
export function detectDarkBackground(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  timeoutMs = 150,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let buf = '';
    let settled = false;
    const finish = (dark: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.off('data', onData);
      resolve(dark);
    };
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      const dark = parseOsc11Dark(buf);
      if (dark !== null) finish(dark);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    input.on('data', onData);
    try {
      output.write('\x1b]11;?\x07');
    } catch {
      finish(true);
    }
  });
}
