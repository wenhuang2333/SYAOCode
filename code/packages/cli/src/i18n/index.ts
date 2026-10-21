import { en, type MsgKey } from './en.js';
import { zh } from './zh.js';

/**
 * CLI 文案国际化（v0.1 追加）。
 *
 * 设计：
 * - 默认语言为英语；`/language` 写入 ~/.syaocode/config.json 的 language 字段，
 *   下次启动生效（指令本身会立即退出 CLI）。
 * - 键集合以 en.ts 为准，zh.ts 为 Record<MsgKey, string>，漏译即 typecheck 失败。
 * - 插值语法 `{name}`；缺键时回退英语再回退键名，绝不抛错（UI 不能因文案崩溃）。
 * - 每个语言目录内部不出现其他语言（专有名词/命令名/协议名除外），由单测约束。
 */

export type Lang = 'en' | 'zh';

export const LANGUAGES: readonly Lang[] = ['en', 'zh'];

let current: Lang = 'en';

export function setLanguage(lang: Lang): void {
  current = lang;
}

export function getLanguage(): Lang {
  return current;
}

export function isLang(value: string): value is Lang {
  return (LANGUAGES as readonly string[]).includes(value);
}

/** 语言自身的名字（专有名词，各语言目录中保持一致） */
export function languageName(lang: Lang): string {
  return t(lang === 'en' ? 'language.name.en' : 'language.name.zh');
}

export function t(key: MsgKey, vars?: Record<string, string | number>): string {
  const table: Record<string, string> = current === 'zh' ? zh : en;
  const raw = table[key] ?? en[key] ?? String(key);
  if (vars === undefined) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : match,
  );
}

export type { MsgKey };
