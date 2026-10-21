import type { Message } from './types.js';
import type { ToolDefinition } from './provider.js';

/**
 * Context assembly & token estimation (DD-6). v0.1 implements the stable
 * prompt segmenting and heuristic estimation with per-usage calibration;
 * auto-compaction ships in M2 (BR-013 hooks exist in Limits/budget events).
 */

export interface ContextConfig {
  baseInstructions?: string;
  projectInstructions?: string;
  environmentInfo?: string;
}

export function assembleSystemPrompt(cfg: ContextConfig): string {
  const segments: string[] = [];
  segments.push(
    cfg.baseInstructions ??
      'You are SYAOCode, a coding agent operating in a workspace. ' +
      'Use the provided tools to read, modify and verify files. ' +
      'Prefer precise, minimal changes and verify your work by running tests when possible.',
  );
  if (cfg.projectInstructions !== undefined && cfg.projectInstructions.trim().length > 0) {
    segments.push(`# Project instructions\n\n${cfg.projectInstructions}`);
  }
  if (cfg.environmentInfo !== undefined && cfg.environmentInfo.trim().length > 0) {
    segments.push(`# Environment\n\n${cfg.environmentInfo}`);
  }
  return segments.join('\n\n');
}

/** Heuristic estimate: latin ≈ 4 chars/token, CJK ≈ 1.5 chars/token. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef]/g) ?? []).length;
  const latin = text.length - cjk;
  return Math.ceil(latin / 4) + Math.ceil(cjk / 1.5);
}

export function estimateMessagesTokens(messages: Message[], tools?: ToolDefinition[]): number {
  let total = 0;
  for (const m of messages) {
    for (const block of m.content) {
      if (block.type === 'text' || block.type === 'thinking') total += estimateTokens(block.text) + 4;
      else if (block.type === 'tool_use') total += estimateTokens(JSON.stringify(block.input ?? {})) + 8;
      else if (block.type === 'tool_result') {
        total +=
          block.content.reduce((acc, c) => acc + (c.type === 'text' ? estimateTokens(c.text) : 256), 0) + 8;
      } else total += 256;
    }
  }
  if (tools !== undefined) {
    for (const t of tools) total += estimateTokens(t.description) + estimateTokens(JSON.stringify(t.inputSchema)) + 16;
  }
  return total;
}

/** Simplest stable compaction for v0.1: keep system-critical tail. */
export function trimOldToolResults(messages: Message[], keepLastN = 6): Message[] {
  const toolResultIndices = messages
    .map((m, i) => (m.role === 'user' && m.content.some((b) => b.type === 'tool_result') ? i : -1))
    .filter((i) => i >= 0);
  const cutoffIndex = toolResultIndices[Math.max(0, toolResultIndices.length - keepLastN)] ?? 0;
  const dropped = new Set<number>();
  for (const idx of toolResultIndices) {
    if (idx < cutoffIndex) dropped.add(idx);
  }
  return messages.map((m, i) => {
    if (!dropped.has(i)) return m;
    const content = m.content.map((b) =>
      b.type === 'tool_result'
        ? {
            ...b,
            content: [{ type: 'text' as const, text: '[old tool result dropped during compaction]' }],
          }
        : b,
    );
    return { ...m, content };
  });
}
