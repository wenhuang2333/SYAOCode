/**
 * Internal message model — content-block based (ADR-01).
 * Provider adapters own the translation to/from wire formats; the kernel
 * never sees vendor-specific shapes. `meta.providerData` passes through
 * provider-proprietary fields (signatures, cache markers) uninterpreted.
 */

export type ImageSource =
  | { type: 'base64'; mediaType: string; data: string }
  | { type: 'url'; url: string };

export type ToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource };

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: ToolResultContent[];
  isError?: boolean;
  /** Untrusted provenance (MCP, web). Untrusted content never affects permission decisions (BR-007). */
  trust?: 'trusted' | 'untrusted';
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'thinking'; text: string; signature?: string; redacted?: boolean }
  | ToolUseBlock
  | ToolResultBlock;

export type Role = 'user' | 'assistant';

export interface MessageMeta {
  providerData?: unknown;
  createdAt: number;
}

export interface Message {
  id: string;
  role: Role;
  content: ContentBlock[];
  meta?: MessageMeta;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'error';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** 供应商直接上报的费用（网关/OpenRouter 等）；优先于本地定价表计算 */
  costUsd?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export function textOf(message: Message): string {
  return message.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export function toolCallsOf(message: Message): ToolCall[] {
  return message.content
    .filter((b): b is ToolUseBlock => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
}

export function userText(text: string, id: string): Message {
  return { id, role: 'user', content: [{ type: 'text', text }], meta: { createdAt: 0 } };
}

export function assistantText(text: string, id: string): Message {
  return { id, role: 'assistant', content: [{ type: 'text', text }], meta: { createdAt: 0 } };
}
