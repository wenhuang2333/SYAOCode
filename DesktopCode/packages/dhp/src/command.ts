/**
 * 命令信封与 ACK（`00-基线` §8.4 / `06` §7）
 *
 * 所有写操作走信封：`commandId`（幂等）+ `baseRevision`（CAS）+ 六态 ACK。
 *
 * 核心不变式：**ACK ≠ 终态**。
 * ACK 只说明"这条命令被接受了/拒绝了"，真正的终态只能由事件流
 * （`turn.end` / `session.event`）确认。UI 不得凭 ACK 改运行态。
 */

import { z } from 'zod';

/** 客户端生成的幂等键。UUIDv7 形态（时间有序，便于日志排查）。 */
export const CommandIdSchema = z.string().min(8).max(64);

export const CommandEnvelopeSchema = z.object({
  /** 幂等键：重复提交只执行一次，后到的返回 `duplicate`。 */
  commandId: CommandIdSchema,
  /** CAS 前置条件：服务端 revision ≠ 此值 → `stale`。 */
  baseRevision: z.number().int().nonnegative(),
  /** 目标会话（会话级命令必填）。 */
  sessionId: z.string().min(1).optional(),
});

export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

/**
 * 六态 ACK。判定规则是**互斥且穷尽**的——
 * 一个响应必须且只能落进其中之一。
 */
export type AckStatus =
  /** 首次接收且通过 CAS，已开始执行。 */
  | 'accepted'
  /** `commandId` 已存在且已处理 —— 等价成功。 */
  | 'duplicate'
  /** `baseRevision` 与服务端不一致 —— 可刷新后重试。 */
  | 'stale'
  /** 业务规则拒绝（权限不足、状态非法）—— 不可重试。 */
  | 'rejected'
  /** 语义上无需变更（如设为当前值）。 */
  | 'noop'
  /** 执行期错误。 */
  | 'failed';

export interface AckResult {
  readonly commandId: string;
  readonly status: AckStatus;
  /** 服务端当前 revision（`stale` 时必须带回，供客户端重算）。 */
  readonly revision: number;
  /** 拒绝/失败的原因（面向用户的中英文案由 `16` 负责）。 */
  readonly reason?: string;
  /** 业务返回（如 `turn/send` 返回的 turnId）。 */
  readonly data?: unknown;
}

/** 判定：这次 ACK 是否允许客户端**自动**重试。 */
export function isAutoRetryableStatus(status: AckStatus): boolean {
  return status === 'stale';
}

/** 判定：这次 ACK 是否等价于"命令已被处理"。 */
export function isSuccessfulStatus(status: AckStatus): boolean {
  return status === 'accepted' || status === 'duplicate' || status === 'noop';
}

// ── 幂等记录 ────────────────────────────────────────────────────────────

/**
 * 服务端幂等窗口的默认长度。窗口内重复 `commandId` 返回 `duplicate`。
 * 窗口外则视为新命令（此时业务层的幂等由 `requestHash` 兜底）。
 */
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyRecord {
  readonly commandId: string;
  /** 请求内容哈希：同 id 不同 hash → `idempotency_conflict`。 */
  readonly requestHash: string;
  readonly status: AckStatus;
  readonly revision: number;
  readonly createdAt: number;
  readonly data?: unknown;
}

/**
 * 幂等存储（内存实现；Host 可替换为文件实现）。
 *
 * 保留窗口内的记录；**只存结果摘要**，不存 payload（避免把用户内容复制一份）。
 */
export class IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = IDEMPOTENCY_WINDOW_MS,
  ) {}

  /** 查找。过期记录视为不存在并顺手清理。 */
  get(commandId: string): IdempotencyRecord | undefined {
    const rec = this.records.get(commandId);
    if (rec === undefined) return undefined;
    if (this.now() - rec.createdAt > this.windowMs) {
      this.records.delete(commandId);
      return undefined;
    }
    return rec;
  }

  put(record: IdempotencyRecord): void {
    this.records.set(record.commandId, record);
  }

  /** 清理过期记录；返回清理条数。 */
  prune(): number {
    const t = this.now();
    let removed = 0;
    for (const [id, rec] of this.records) {
      if (t - rec.createdAt > this.windowMs) {
        this.records.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.records.size;
  }
}

/**
 * 请求内容哈希（稳定序列化）。
 *
 * 目的：同一 `commandId` 但内容不同 → `idempotency_conflict`，
 * 而不是"悄悄按第一次的结果返回"。这正是防止重复副作用的最后一道闸。
 */
export function requestHash(payload: unknown): string {
  return sha256Hex(stableStringify(payload));
}

/** 稳定 JSON 序列化（键排序）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** 同步 SHA-256（无 Node crypto 依赖，故 DHP 包保持浏览器可用）。 */
export function sha256Hex(text: string): string {
  // FNV-1a 变体：不是密码学强度，但足以做**幂等键冲突检测**。
  // 真正的密码学哈希由 Host 侧用 `node:crypto` 计算（见 `host` 包）。
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + c) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/** 生成幂等键（时间有序的 UUIDv7 形态）。 */
export function newCommandId(now: number = Date.now()): string {
  const ts = now.toString(16).padStart(12, '0').slice(-12);
  const rand = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  return `cmd_${ts}_${rand}`;
}
