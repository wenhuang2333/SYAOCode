import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContextConfig } from '@syaocode/core';
import { t } from './i18n/index.js';

/**
 * 系统提示上下文装配（FR-051 / FR-083 / DD-6）：
 * - environmentInfo：工作目录、平台、日期 — 模型必须知道相对路径的基准。
 * - projectInstructions：用户级 + 仓库根的项目指令文件，默认 AGENTS.md，
 *   兼容 CLAUDE.md；可用 SYAO_INSTRUCTION_FILES=a.md,b.md 覆盖文件名列表。
 *
 * 子目录指令惰性加载（DD-6）留待 M2；这里只做启动时的用户级与仓库根。
 * 读取失败/文件过大都不阻塞启动：截断并继续。
 */

const DEFAULT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];
const MAX_INSTRUCTION_BYTES = 32 * 1024;

export function instructionFileNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.SYAO_INSTRUCTION_FILES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_INSTRUCTION_FILES;
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return names.length > 0 ? names : DEFAULT_INSTRUCTION_FILES;
}

/** 在 dir 下按候选文件名取第一个存在的指令文件；返回正文与文件名 */
export function readInstructionFile(
  dir: string,
  names: string[] = DEFAULT_INSTRUCTION_FILES,
): { file: string; text: string } | undefined {
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      let text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
      if (text === '') continue;
      if (Buffer.byteLength(text, 'utf8') > MAX_INSTRUCTION_BYTES) {
        text = `${Buffer.from(text, 'utf8').subarray(0, MAX_INSTRUCTION_BYTES).toString('utf8')}\n\n${t('context.truncated', { bytes: MAX_INSTRUCTION_BYTES })}`;
      }
      return { file, text };
    } catch {
      // 不存在/不可读 → 尝试下一个候选名
    }
  }
  return undefined;
}

export interface CliContextOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  platform?: string;
  arch?: string;
  /** 当前模型（provider:model 或 @档案:模型）——让模型能如实回答"你是什么模型" */
  model?: string;
  /** 运行载体名称与版本 */
  harness?: string;
}

/** 构建 createAgent 的 context 配置（纯读，无副作用；失败静默降级）。 */
export function buildCliContext(cwd: string, opts: CliContextOptions = {}): ContextConfig {
  const env = opts.env ?? process.env;
  const home = opts.home ?? env.HOME ?? '.';
  const now = opts.now ?? new Date();
  const names = instructionFileNames(env);

  const segments: string[] = [];
  const userFile = readInstructionFile(path.join(home, '.syaocode'), names);
  if (userFile !== undefined) {
    segments.push(`${t('context.userInstructions', { file: path.basename(userFile.file) })}\n\n${userFile.text}`);
  }
  const projectFile = readInstructionFile(cwd, names);
  if (projectFile !== undefined) {
    segments.push(`${t('context.projectInstructions', { file: projectFile.file })}\n\n${projectFile.text}`);
  }

  const environmentInfo = [
    `Working directory: ${cwd}`,
    `Platform: ${opts.platform ?? process.platform} (${opts.arch ?? process.arch})`,
    `Date: ${now.toISOString().slice(0, 10)}`,
    ...(opts.harness !== undefined ? [`Harness: ${opts.harness}`] : []),
    // 模型身份：模型无法自省底层版本，这里给出配置侧的事实，避免它凭空猜测
    ...(opts.model !== undefined ? [`Model: ${opts.model} (configured by the user; answer truthfully when asked)`] : []),
  ].join('\n');

  return {
    environmentInfo,
    ...(segments.length > 0 ? { projectInstructions: segments.join('\n\n') } : {}),
  };
}
