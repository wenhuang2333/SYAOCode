/**
 * 提示词预处理（REPL 与 TUI 共享）：
 * - expandAtPaths：@文件 引用展开（FR-134）
 * - summarizeInput：工具入参的一行摘要
 */

import type { Runtime } from '@syaocode/core';
import { t } from './i18n/index.js';

/** @path 展开：把 @引用的文件内容附加到提示词（最多 8 个文件，每个截断 500 行） */
export async function expandAtPaths(prompt: string, cwd: string, runtime: Runtime): Promise<string> {
  const refs = [...prompt.matchAll(/(?:^|\s)@([^\s]+)/g)].map((m) => m[1]!).slice(0, 8);
  if (refs.length === 0) return prompt;
  const parts: string[] = [prompt];
  for (const ref of refs) {
    const abs = ref.startsWith('/') ? ref : `${cwd}/${ref}`;
    try {
      const content = await runtime.fs.readFile(abs);
      const lines = content.split('\n');
      const truncated = lines.slice(0, 500).join('\n');
      parts.push(`--- @${ref} ---\n${truncated}${lines.length > 500 ? `\n${t('repl.truncated')}` : ''}`);
    } catch {
      parts.push(`--- @${ref} --- ${t('repl.fileSkipped')}`);
    }
  }
  return parts.join('\n\n');
}

/** 工具入参的一行摘要（JSON 截断） */
export function summarizeInput(input: unknown): string {
  const json = JSON.stringify(input ?? {});
  return json.length > 80 ? `${json.slice(0, 77)}…` : json;
}
