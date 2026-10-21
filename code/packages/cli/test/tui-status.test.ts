import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, Usage } from '@syaocode/core';
import { StatusTracker, estimateTokensOfText, formatStatusLine, formatTokens } from '../src/tui/status';
import { setLanguage } from '../src/i18n/index';
import { displayWidth } from '../src/tui/width';

function usageEv(u: Partial<Usage>): AgentEvent {
  return { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, ...u } };
}

describe('tui/status 状态指标', () => {
  beforeEach(() => setLanguage('en'));
  it('formatTokens 分级缩写', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(2_500_000)).toBe('2.50M');
  });

  it('estimateTokensOfText：CJK 1:1、ASCII 4:1', () => {
    expect(estimateTokensOfText('中文字')).toBe(3);
    expect(estimateTokensOfText('abcdefgh')).toBe(2);
  });

  it('轮次（累计用户轮次）/步数计数', () => {
    const t = new StatusTracker({ model: 'mock:default', contextWindow: 128_000 });
    t.onEvent({ type: 'turn.start', turn: 1 }, 0); // 第 1 轮用户消息
    t.onEvent({ type: 'tool.start', callId: 'c1', name: 'read', input: {} }, 0);
    t.onEvent({ type: 'tool.start', callId: 'c2', name: 'write', input: {} }, 0);
    t.onEvent({ type: 'turn.start', turn: 2 }, 0); // 同一轮的第二次循环：轮次不变
    expect(t.snapshot(0).turn).toBe(1);
    t.onEvent({ type: 'turn.start', turn: 1 }, 0); // 第 2 轮用户消息
    const snap = t.snapshot(0);
    expect(snap.turn).toBe(2);
    expect(snap.step).toBe(2);
  });

  it('token 累计与缓存命中率', () => {
    const t = new StatusTracker({ model: 'mock:default', contextWindow: 1000 });
    t.onEvent(usageEv({ inputTokens: 300, cacheReadTokens: 700, outputTokens: 100 }), 0);
    t.onEvent(usageEv({ inputTokens: 100, cacheReadTokens: 0, outputTokens: 50 }), 0);
    const snap = t.snapshot(0);
    // cacheHit = 700 / (700 + 300 + 100) = 0.636…
    expect(snap.cacheHitRate).toBeCloseTo(700 / 1100, 5);
    expect(snap.totalTokens).toBe(300 + 700 + 100 + 100 + 0 + 50);
    // 上下文占用 = 最近一次请求（100 in + 50 out），不是累计计费量
    expect(snap.contextUsed).toBe(150);
  });

  it('上下文占用不随多轮请求累加（状态栏不会虚报爆表）', () => {
    const t = new StatusTracker({ model: 'deepseek:deepseek-chat', contextWindow: 128_000 });
    for (let i = 0; i < 7; i++) t.onEvent(usageEv({ inputTokens: 4800, cacheReadTokens: 3600, outputTokens: 1800 }), 0);
    const snap = t.snapshot(0);
    expect(snap.contextUsed).toBe(4800 + 1800);
    expect(snap.totalTokens).toBe(7 * (4800 + 3600 + 1800));
    expect(formatStatusLine(snap, 200)).toContain('6.6k/128.0k');
  });

  it('无缓存数据时命中率为 null', () => {
    const t = new StatusTracker({ model: 'mock:default', contextWindow: 1000 });
    t.onEvent(usageEv({ inputTokens: 10, outputTokens: 5 }), 0);
    expect(t.snapshot(0).cacheHitRate).toBeNull();
  });

  it('流式实时速度 → 结束后保留末次速度', () => {
    const t = new StatusTracker({ model: 'mock:default', contextWindow: 1000 });
    // 流式：100ms 内收到 400 字符 ≈ 100 tokens → 1000 tok/s
    t.onEvent({ type: 'text.delta', text: 'a'.repeat(400) }, 0);
    expect(t.speed(100)).toBe(1000);
    // message.complete：快照含 400 字符文本 → 100 tokens / 0.1s = 1000 tok/s
    t.onEvent(
      {
        type: 'message.complete',
        message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(400) }], meta: { createdAt: 0 } },
        stopReason: 'end_turn',
      },
      100,
    );
    expect(t.speed(5000)).toBe(1000); // 空闲保留末次
    expect(t.speed(100)).not.toBeNull();
  });

  it('状态行包含全部字段且按宽度截断', () => {
    const t = new StatusTracker({ model: 'deepseek:deepseek-chat', contextWindow: 128_000 });
    t.onEvent(usageEv({ inputTokens: 3200, cacheReadTokens: 6800, outputTokens: 1200 }), 0);
    t.onEvent({ type: 'turn.start', turn: 1 }, 0);
    t.onEvent({ type: 'tool.start', callId: 'c', name: 'read', input: {} }, 0);
    const line = formatStatusLine(t.snapshot(0), 200);
    expect(line).toContain('deepseek:deepseek-chat');
    expect(line).toContain('context');
    expect(line).toContain('turn 1:1');
    expect(line).toContain('cache');
    expect(line).toContain('total tokens');

    const narrow = formatStatusLine(t.snapshot(0), 30);
    expect(displayWidth(narrow)).toBeLessThanOrEqual(30);
  });

  it('中文模式状态行（/language zh）', () => {
    setLanguage('zh');
    const t = new StatusTracker({ model: 'mock:default', contextWindow: 1000 });
    t.onEvent(usageEv({ inputTokens: 10, outputTokens: 5 }), 0);
    const line = formatStatusLine(t.snapshot(0), 200);
    expect(line).toContain('模型 mock:default');
    expect(line).toContain('上下文');
    expect(line).toContain('轮次');
    expect(line).toContain('速度');
    expect(line).toContain('缓存');
    expect(line).toContain('总 token');
    setLanguage('en');
  });

  it('速度字段：null → 破折号', () => {
    const t = new StatusTracker({ model: 'mock:default', contextWindow: 1000 });
    const line = formatStatusLine(t.snapshot(0), 200);
    expect(line).toContain('speed —');
    expect(line).toContain('cache —');
  });
});
