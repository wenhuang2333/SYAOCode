/**
 * 状态栏指标：当前模型 / 上下文已用 / 第几轮第几步 / 实时 token 输出速度 /
 * 缓存命中率 / 总消耗 token。
 *
 * StatusTracker 消费 AgentEvent 累计指标（纯逻辑，可单测）；
 * formatStatusLine 渲染为适配终端宽度的一行。
 */

import type { AgentEvent } from '@syaocode/core';
import { t } from '../i18n/index.js';
import { displayWidth } from './width.js';

export interface StatusModel {
  model: string;
  /** 模型上下文窗口上限（token）；未知时为 null */
  contextWindow: number | null;
}

export interface StatusSnapshot {
  model: string;
  contextUsed: number;
  contextWindow: number | null;
  turn: number;
  step: number;
  /** 最近一次输出速度（tok/s）；无输出时为 null。流式期间为实时值。 */
  tokensPerSecond: number | null;
  /** 缓存命中率 cacheRead / (cacheRead + input)；无缓存数据时为 null */
  cacheHitRate: number | null;
  totalTokens: number;
}

/** 近似 token 估算：CJK 约 1 字 1 token，ASCII 约 4 字符 1 token */
export function estimateTokensOfText(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x2e80 && cp <= 0x9fff) cjk++;
    else other++;
  }
  return Math.round(cjk + other / 4);
}

const EPS = 1e-9;

export class StatusTracker {
  private model: string;
  private contextWindow: number | null;
  private turn = 0;
  private step = 0;
  private totalInput = 0;
  private totalOutput = 0;
  private totalCacheRead = 0;
  /** 最近一次请求的 token（上下文占用 = 该次输入 + 输出，不是累计计费量） */
  private lastInput = 0;
  private lastOutput = 0;
  private sawCacheField = false;
  private lastSpeed: number | null = null;
  // 流式实时速度
  private streamStart: number | null = null;
  private streamChars = 0;

  constructor(model: StatusModel) {
    this.model = model.model;
    this.contextWindow = model.contextWindow;
  }

  setModel(model: StatusModel): void {
    this.model = model.model;
    this.contextWindow = model.contextWindow;
  }

  /** nowMs 用 Date.now()（生产）或注入（测试） */
  onEvent(ev: AgentEvent, nowMs: number): void {
    switch (ev.type) {
      case 'turn.start':
        // 每轮用户消息的 agent.run 都从 turn=1 开始（工具循环才会 2、3…）：
        // 只在 run 首轮递增，得到累计用户轮次（状态栏"第几轮"）
        if (ev.turn === 1) this.turn += 1;
        break;
      case 'tool.start':
        this.step++;
        break;
      case 'text.delta':
      case 'thinking.delta':
        if (this.streamStart === null) this.streamStart = nowMs;
        this.streamChars += ev.text.length;
        break;
      case 'message.complete': {
        // 一条 assistant 消息结束：以累计字符估算速度（估算器与 delta 计数一致）
        if (this.streamStart !== null) {
          const secs = Math.max(0.05, (nowMs - this.streamStart) / 1000);
          const streamed = ev.message.content
            .filter((b): b is Extract<typeof b, { type: 'text' | 'thinking' }> => b.type === 'text' || b.type === 'thinking')
            .map((b) => b.text)
            .join('');
          const outTokens = streamed !== '' ? estimateTokensOfText(streamed) : this.streamChars / 4;
          if (outTokens > 0) this.lastSpeed = Math.round((outTokens / secs) * 10) / 10;
        }
        this.streamStart = null;
        this.streamChars = 0;
        break;
      }
      case 'usage':
        this.totalInput += ev.usage.inputTokens;
        this.totalOutput += ev.usage.outputTokens;
        this.lastInput = ev.usage.inputTokens;
        this.lastOutput = ev.usage.outputTokens;
        if (ev.usage.cacheReadTokens !== undefined) {
          this.sawCacheField = true;
          this.totalCacheRead += ev.usage.cacheReadTokens;
        }
        break;
      default:
        break;
    }
  }

  /** 流式期间的实时速度（tok/s 估算）；空闲时返回末次速度 */
  speed(nowMs: number): number | null {
    if (this.streamStart !== null && this.streamChars > 0) {
      const secs = Math.max(0.05, (nowMs - this.streamStart) / 1000);
      return Math.round((this.streamChars / 4 / secs) * 10) / 10;
    }
    return this.lastSpeed;
  }

  snapshot(nowMs: number): StatusSnapshot {
    // 上下文占用：最近一次请求的输入 + 输出（累计量会把多轮请求叠加成“爆表”）
    const contextUsed = this.lastInput + this.lastOutput;
    const cacheTotal = this.totalCacheRead + this.totalInput;
    // provider 从未上报缓存字段（mock 等）时不显示命中率，避免把“未上报”当成 0%
    const cacheHitRate = this.sawCacheField && cacheTotal > EPS ? this.totalCacheRead / cacheTotal : null;
    return {
      model: this.model,
      contextUsed,
      contextWindow: this.contextWindow,
      turn: this.turn,
      step: this.step,
      tokensPerSecond: this.speed(nowMs),
      cacheHitRate,
      totalTokens: this.totalInput + this.totalOutput + this.totalCacheRead,
    };
  }
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** 渲染状态行（纯文本，颜色由调用方叠加；按显示宽度截断到 cols） */
export function formatStatusLine(s: StatusSnapshot, cols: number): string {
  const parts: string[] = [];
  parts.push(`${t('status.model')} ${s.model}`);
  const ctx =
    s.contextWindow !== null
      ? `${formatTokens(s.contextUsed)}/${formatTokens(s.contextWindow)}（${Math.min(100, Math.round((s.contextUsed / s.contextWindow) * 100))}%）`
      : formatTokens(s.contextUsed);
  parts.push(`${t('status.context')} ${ctx}`);
  parts.push(`${t('status.turn')} ${s.turn}:${s.step}`);
  parts.push(
    `${t('status.speed')} ${s.tokensPerSecond !== null ? t('status.tokPerSec', { n: s.tokensPerSecond }) : t('status.dash')}`,
  );
  parts.push(
    `${t('status.cache')} ${s.cacheHitRate !== null ? `${Math.round(s.cacheHitRate * 100)}%` : t('status.dash')}`,
  );
  parts.push(`${t('status.totalTokens')} ${formatTokens(s.totalTokens)}`);

  let line = parts.join('  ');
  if (displayWidth(line) > cols) {
    // 逐步丢弃右侧字段直到放得下（至少保留模型名）
    for (let keep = parts.length - 1; keep >= 1; keep--) {
      line = parts.slice(0, keep).join('  ');
      if (displayWidth(line) <= cols) break;
    }
  }
  return line;
}
