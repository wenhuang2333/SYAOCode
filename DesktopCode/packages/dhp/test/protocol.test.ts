import { describe, expect, it } from 'vitest';
import {
  DHP_ERROR_CODES,
  codeForKind,
  specForCode,
  isAutoRetryable,
  decodeFrame,
  encodeFrame,
  failure,
  success,
  negotiate,
  DHP_VERSION,
  DHP_CAPABILITIES,
  applySnapshot,
  applyDelta,
  emptySnapshot,
  coalesceEvents,
  NON_DROPPABLE_EVENTS,
  COALESCIBLE_EVENTS,
  IdempotencyStore,
  requestHash,
  newCommandId,
  type SessionSnapshot,
  type SessionEvent,
} from '../src/index.ts';

describe('DHP 错误码', () => {
  it('47 个自定义码连续无空洞', () => {
    const codes = DHP_ERROR_CODES.map((c) => c.code).sort((a, b) => a - b);
    expect(codes).toHaveLength(47);
    for (let i = 1; i < codes.length; i += 1) {
      expect(codes[i]! - codes[i - 1]!).toBe(1);
    }
    expect(codes[0]).toBe(-32046);
    expect(codes[codes.length - 1]).toBe(-32000);
  });

  it('kind 与码一一对应', () => {
    const kinds = new Set(DHP_ERROR_CODES.map((c) => c.kind));
    expect(kinds.size).toBe(47);
    for (const spec of DHP_ERROR_CODES) {
      expect(codeForKind(spec.kind)).toBe(spec.code);
      expect(specForCode(spec.code)?.kind).toBe(spec.kind);
    }
  });

  it('indeterminate 绝不自动重试', () => {
    expect(isAutoRetryable('indeterminate')).toBe(false);
    expect(isAutoRetryable('stale')).toBe(true);
  });
});

describe('JSON-RPC 帧', () => {
  it('接受合法请求', () => {
    const r = decodeFrame(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello' }));
    expect(r.ok).toBe(true);
  });

  it('拒绝非法 JSON → parse_error', () => {
    const r = decodeFrame('{not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(-32700);
  });

  it('拒绝结构错误 → invalid_request', () => {
    const r = decodeFrame(JSON.stringify({ jsonrpc: '2.0', id: 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(-32600);
  });

  it('往返编码', () => {
    const frame = success(7, { ok: true });
    const r = decodeFrame(encodeFrame(frame));
    expect(r.ok).toBe(true);
    if (r.ok && 'result' in r.frame) expect(r.frame.result).toEqual({ ok: true });
  });

  it('错误响应带 syaoCode', () => {
    const f = failure(1, -32006, 'denied', { kind: 'denied', syaoCode: 'SY-PERM-001' });
    expect(f.error.data?.syaoCode).toBe('SY-PERM-001');
  });
});

describe('版本协商', () => {
  it('主版本不同即拒绝', () => {
    const v = negotiate({ major: 2, minor: 0 }, DHP_VERSION, [], DHP_CAPABILITIES);
    expect(v.ok).toBe(false);
  });

  it('能力取交集', () => {
    const v = negotiate(DHP_VERSION, DHP_VERSION, ['session', 'terminal'], ['session', 'governance']);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.capabilities).toEqual(['session']);
  });
});

describe('三条投影铁律', () => {
  const meta = {
    sessionId: 's1',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    permissionMode: 'default',
    model: 'mock:default',
    workspaceRoot: '/w',
  };

  it('铁律 1：snapshot 整体替换，不 merge', () => {
    const a = emptySnapshot(meta);
    const b: SessionSnapshot = { ...a, seq: 42, revision: 7 };
    const out = applySnapshot(a, b);
    expect(out.seq).toBe(42);
    expect(out.revision).toBe(7);
  });

  it('铁律 2：断档的 delta 不被应用，要求重订阅', () => {
    const snap = emptySnapshot(meta);
    const res = applyDelta(snap, {
      sessionId: 's1',
      epoch: snap.epoch,
      fromSeq: 5,
      toSeq: 6,
      events: [{ type: 'text.delta', text: 'x' }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.action).toBe('resubscribe');
  });

  it('铁律 2：epoch 变化直接要求重订阅', () => {
    const snap = emptySnapshot(meta);
    const res = applyDelta(snap, { sessionId: 's1', epoch: 99, fromSeq: 1, toSeq: 1, events: [] });
    expect(res.ok).toBe(false);
  });

  it('衔接的 delta 被应用，水位推进到 toSeq', () => {
    const snap = emptySnapshot(meta);
    const events: SessionEvent[] = [{ type: 'text.delta', text: 'hello' }];
    const res = applyDelta(snap, { sessionId: 's1', epoch: snap.epoch, fromSeq: 1, toSeq: 1, events });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.snapshot.seq).toBe(1);
      expect(res.snapshot.rows).toHaveLength(1);
      expect(res.snapshot.runState).toBe('streaming');
    }
  });

  it('合并帧用 toSeq 推进水位而非 events.length', () => {
    const snap = emptySnapshot(meta);
    const res = applyDelta(snap, {
      sessionId: 's1',
      epoch: snap.epoch,
      fromSeq: 1,
      toSeq: 9,
      coalesced: true,
      events: [{ type: 'text.delta', text: 'a' }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.snapshot.seq).toBe(9);
  });
});

describe('事件分类', () => {
  it('可合并与不可丢互不重叠', () => {
    for (const t of COALESCIBLE_EVENTS) expect(NON_DROPPABLE_EVENTS).not.toContain(t);
  });

  it('内核 19 类事件全部被分类', () => {
    const all = [...COALESCIBLE_EVENTS, ...NON_DROPPABLE_EVENTS, 'usage'];
    expect(new Set(all).size).toBe(19);
  });

  it('文本 delta 被拼接', () => {
    const out = coalesceEvents([
      { type: 'text.delta', text: 'a' },
      { type: 'text.delta', text: 'b' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ type: 'text.delta', text: 'ab' });
  });

  it('不可丢事件不被合并掉', () => {
    const out = coalesceEvents([
      { type: 'text.delta', text: 'a' },
      { type: 'tool.result', callId: 'c1', name: 'read', text: 'r', blocks: 0, isError: false, durationMs: 1 },
      { type: 'text.delta', text: 'b' },
    ]);
    expect(out.map((e) => e.type)).toEqual(['text.delta', 'tool.result', 'text.delta']);
  });
});

describe('命令信封与幂等', () => {
  it('同 commandId 同 hash → 幂等命中', () => {
    const store = new IdempotencyStore();
    const h = requestHash({ a: 1 });
    store.put({ commandId: 'c1', requestHash: h, status: 'accepted', revision: 1, createdAt: Date.now() });
    expect(store.get('c1')).toBeDefined();
  });

  it('过期记录被清理', () => {
    let now = 1000;
    const store = new IdempotencyStore(() => now, 100);
    store.put({ commandId: 'c1', requestHash: 'h', status: 'accepted', revision: 1, createdAt: now });
    now += 200;
    expect(store.get('c1')).toBeUndefined();
  });

  it('requestHash 对键顺序不敏感', () => {
    expect(requestHash({ a: 1, b: 2 })).toBe(requestHash({ b: 2, a: 1 }));
  });

  it('commandId 形态唯一', () => {
    expect(newCommandId()).not.toBe(newCommandId());
  });
});
