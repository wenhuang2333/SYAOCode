/**
 * 数据目录解析 —— 唯一入口（实现 `OI-D-07` / `DesktopDoc/00-基线` §7.3.1）
 *
 * 现有 CLI 的问题是路径解析散落在四处，且只认 `$HOME`：
 *   - `cli/src/model-config.ts:73` `syaoHome()`
 *   - `cli/src/main.ts:74`（`config path` 直接拼字符串）
 *   - `cli/src/doctor.ts:43`（同样直接拼）
 *   - `tools/src/bash.ts:75`（`~` 展开）
 *
 * 后果：Windows 上 `HOME` 常未设置 → 静默回退到 `.` → `.syaocode` 落在**当前工作目录**。
 *
 * 本模块是桌面端的唯一解析入口，规则：
 *   `SYAOCODE_HOME` → `os.homedir()/.syaocode` → **报错**（不再静默回退）
 *
 * 解析失败是**致命错误**，不是"用个默认值凑合"——数据写到错误位置比启动失败更糟。
 */

import * as os from 'node:os';
import * as path from 'node:path';

/** 覆盖变量名。与 CLI 侧（待合入）保持一致。 */
export const SYAOCODE_HOME_ENV = 'SYAOCODE_HOME';

export interface SyaoPaths {
  /** 家园目录（`<home>/.syaocode` 或 `SYAOCODE_HOME`）。 */
  readonly home: string;
  readonly configFile: string;
  readonly envFile: string;
  readonly sessionsDir: string;
  readonly usageDir: string;
  readonly evidenceDir: string;
  readonly arfDir: string;
  /** 桌面端专属（窗口布局、草稿、最近工作区）。 */
  readonly desktopDir: string;
}

export class SyaoHomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyaoHomeError';
  }
}

/**
 * 解析家园目录。
 *
 * `env` 可注入，便于测试（也避免测试去改 `process.env` 造成并行污染）。
 */
export function resolveSyaoHome(env: Record<string, string | undefined> = process.env): string {
  const override = env[SYAOCODE_HOME_ENV];
  if (override !== undefined && override.trim() !== '') {
    return path.resolve(override);
  }
  const home = os.homedir();
  if (home === undefined || home === '') {
    // 明确报错而不是 `path.join('.', '.syaocode')` —— 后者会把用户的会话
    // 写到当前工作目录里，且用户完全不会察觉。
    throw new SyaoHomeError(
      `cannot resolve SYAOCode home: ${SYAOCODE_HOME_ENV} is unset and os.homedir() is empty. ` +
        `Set ${SYAOCODE_HOME_ENV} to an absolute path.`,
    );
  }
  return path.join(home, '.syaocode');
}

/** 一次性构造全部路径。任何模块**不得**再手写拼接。 */
export function syaoPaths(env: Record<string, string | undefined> = process.env): SyaoPaths {
  const home = resolveSyaoHome(env);
  return {
    home,
    configFile: path.join(home, 'config.json'),
    envFile: path.join(home, 'env'),
    sessionsDir: path.join(home, 'sessions'),
    usageDir: path.join(home, 'usage'),
    evidenceDir: path.join(home, 'evidence'),
    arfDir: path.join(home, 'arf'),
    desktopDir: path.join(home, 'desktop'),
  };
}

/**
 * 把绝对路径里的家园前缀替换为 `~`，用于**诊断包与日志**。
 * 路径本身可能含用户名，不能原样进诊断包（`16` §5.3）。
 */
export function redactHomeInPath(p: string, home: string = os.homedir()): string {
  if (home === '') return p;
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** 会话日志路径：`<home>/sessions/<projectHash>/<sessionId>.jsonl`（与 CLI 同构）。 */
export function sessionLogPath(paths: SyaoPaths, projectHash: string, sessionId: string): string {
  return path.join(paths.sessionsDir, projectHash, `${sessionId}.jsonl`);
}
