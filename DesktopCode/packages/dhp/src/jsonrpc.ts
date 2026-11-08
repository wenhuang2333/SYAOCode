/**
 * JSON-RPC 2.0 传输层（`06` §3）
 *
 * 三类帧，形状固定；**边界的每一帧都要校验**（zod），不做"尽力解析"。
 * 这让畸形帧在入口被拒绝，而不是在业务层以某种奇怪的方式炸开。
 */

import { z } from 'zod';

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** 请求 id：数字或字符串。 */
export const RequestIdSchema = z.union([z.string(), z.number()]);

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: RequestIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const JsonRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z
    .object({
      /** L2 的 `kind` —— 客户端必须按它分支。 */
      kind: z.string().optional(),
      /** L1 内核错误码（`SY-<域>-<序号>`）。 */
      liwenCode: z.string().optional(),
      /** 面向用户的中英文案（由 `16` 决定，Host 填充）。 */
      messageZh: z.string().optional(),
      messageEn: z.string().optional(),
      retryable: z.boolean().optional(),
      /** 结构化上下文（路径、命令、字段名等），已脱敏。 */
      detail: z.record(z.unknown()).optional(),
    })
    .partial()
    .optional(),
});

/**
 * 成功响应。
 *
 * 注意 `z.unknown()` 本身接受 `undefined`，所以必须显式断言 `result` 键存在——
 * 否则 `{jsonrpc, id}` 这种既无 method 也无 result 的畸形帧会被误判为成功响应。
 */
export const JsonRpcSuccessSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: RequestIdSchema,
    result: z.unknown(),
  })
  .refine((obj) => 'result' in obj, { message: 'missing result', path: ['result'] });

export const JsonRpcFailureSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: RequestIdSchema.nullable(),
  error: JsonRpcErrorSchema,
});

export const JsonRpcResponseSchema = z.union([JsonRpcSuccessSchema, JsonRpcFailureSchema]);

export const JsonRpcFrameSchema = z.union([
  JsonRpcRequestSchema,
  JsonRpcNotificationSchema,
  JsonRpcResponseSchema,
]);

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;
export type JsonRpcSuccess = z.infer<typeof JsonRpcSuccessSchema>;
export type JsonRpcFailure = z.infer<typeof JsonRpcFailureSchema>;
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;
export type JsonRpcFrame = z.infer<typeof JsonRpcFrameSchema>;
export type JsonRpcErrorData = NonNullable<z.infer<typeof JsonRpcErrorSchema>['data']>;

export function isRequest(frame: JsonRpcFrame): frame is JsonRpcRequest {
  return 'id' in frame && 'method' in frame;
}

export function isNotification(frame: JsonRpcFrame): frame is JsonRpcNotification {
  return !('id' in frame) && 'method' in frame;
}

export function isResponse(frame: JsonRpcFrame): frame is JsonRpcResponse {
  return !('method' in frame) && 'id' in frame;
}

export function success(id: string | number, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

export function failure(
  id: string | number | null,
  code: number,
  message: string,
  data?: JsonRpcErrorData,
): JsonRpcFailure {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

// ── 编解码 ──────────────────────────────────────────────────────────────

export type DecodeResult =
  | { readonly ok: true; readonly frame: JsonRpcFrame }
  | { readonly ok: false; readonly code: number; readonly message: string };

/**
 * 解码一帧文本。
 *
 * 拒绝顺序刻意如此：
 *   1. 超长 → `frame_too_large`（-32000），**在读之前**就拒，避免把 8MB 塞进 JSON.parse
 *   2. 非法 JSON → `parse_error`（-32700）
 *   3. 结构不符 → `invalid_request`（-32600），并带上 zod 的字段路径
 */
export function decodeFrame(raw: string): DecodeResult {
  const bytes = new TextEncoder().encode(raw).byteLength;
  if (bytes > MAX_FRAME_BYTES) {
    return { ok: false, code: -32000, message: `frame too large: ${bytes} > ${MAX_FRAME_BYTES}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, code: -32700, message: `parse error: ${(err as Error).message}` };
  }

  const result = JsonRpcFrameSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first === undefined ? '?' : first.path.join('.');
    return { ok: false, code: -32600, message: `invalid request at ${path}: ${first?.message ?? ''}` };
  }
  return { ok: true, frame: result.data };
}

export function encodeFrame(frame: JsonRpcFrame): string {
  return JSON.stringify(frame);
}
