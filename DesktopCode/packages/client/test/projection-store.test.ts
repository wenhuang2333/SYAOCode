/**
 * 客户端投影 store 的测试：三条铁律的**客户端半边**。
 *
 * 与 `packages/dhp/test` 的纯函数测试互补：那里测 fold 语义，
 * 这里测"store 在断档/重订阅时到底做了什么"（含 resyncing 抑制）。
 */

import { describe, expect, it, vi } from 'vitest';
import { ProjectionStore, type ResubscribeRequest } from '../src/projection-store.ts';
import { emptySnapshot, type SessionSnapshot } from '@syaocode/dhp';

const META = {
  sessionId: 's1',
  title: 't',
  createdAt: 0,
  updatedAt: 0,
  permissionMode: 'default',
  model: 'mock:default',
  workspaceRoot: '/w',
};

function makeStore(): { store: ProjectionStore; requests: ResubscribeRequest[] } {
  const requests: ResubscribeRequest[] = [];
  const store = new ProjectionStore({ onResubscribe: (r) => requests.push(r) });
  return { store, requests };
}

describe('ProjectionStore', () => {
  it('铁律 1：replacement 整体替换（旧字段不残留）', () => {
    const { store } = makeStore();
    store.replacement({ ...emptySnapshot(META), seq: 5 });
    const next: SessionSnapshot = { ...emptySnapshot(META), seq: 99, revision: 7 };
    store.replacement(next);
    expect(store.current?.seq).toBe(99);
    expect(store.current?.revision).toBe(7);
  });

  it('铁律 2：衔接的 delta 被应用', () => {
    const { store, requests } = makeStore();
    store.replacement(emptySnapshot(META));
    store.delta({ sessionId: 's1', epoch: 1, fromSeq: 1, toSeq: 1, events: [{ type: 'text.delta', text: 'hi' }] });
    expect(store.current?.seq).toBe(1);
    expect(requests).toHaveLength(0);
  });

  it('铁律 2：断档 → 发起重订阅，且不应用该 delta', () => {
    const { store, requests } = makeStore();
    store.replacement({ ...emptySnapshot(META), seq: 5 });
    store.delta({ sessionId: 's1', epoch: 1, fromSeq: 9, toSeq: 9, events: [{ type: 'text.delta', text: 'x' }] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.baseSeq).toBe(5);
    // 水位不变：断档期间**绝不**推进。
    expect(store.current?.seq).toBe(5);
    expect(store.current?.rows).toHaveLength(0);
  });

  it('重订阅期间后续 delta 被抑制（避免在错误基线上叠加）', () => {
    const { store, requests } = makeStore();
    store.replacement({ ...emptySnapshot(META), seq: 5 });
    store.delta({ sessionId: 's1', epoch: 1, fromSeq: 99, toSeq: 99, events: [] });
    expect(requests).toHaveLength(1);
    // 再来一条"看起来衔接"的，也不该应用（基线已失效）。
    store.delta({ sessionId: 's1', epoch: 1, fromSeq: 6, toSeq: 6, events: [{ type: 'text.delta', text: 'y' }] });
    expect(store.current?.seq).toBe(5);
    expect(requests).toHaveLength(1);
  });

  it('快照到达后解除抑制', () => {
    const { store } = makeStore();
    store.replacement({ ...emptySnapshot(META), seq: 5 });
    store.delta({ sessionId: 's1', epoch: 1, fromSeq: 99, toSeq: 99, events: [] });
    expect(store.isResyncing).toBe(true);
    store.replacement({ ...emptySnapshot(META), seq: 50 });
    expect(store.isResyncing).toBe(false);
    store.delta({ sessionId: 's1', epoch: 1, fromSeq: 51, toSeq: 51, events: [{ type: 'text.delta', text: 'z' }] });
    expect(store.current?.seq).toBe(51);
  });

  it('无快照时收到 delta → 请求从 0 重订阅', () => {
    const { store, requests } = makeStore();
    store.delta({ sessionId: 's1', epoch: 1, fromSeq: 1, toSeq: 1, events: [] });
    expect(requests[0]?.baseSeq).toBe(0);
  });

  it('订阅者立刻收到当前值（避免 UI 首帧空白）', () => {
    const { store } = makeStore();
    store.replacement({ ...emptySnapshot(META), seq: 3 });
    const seen: number[] = [];
    store.subscribe((s) => seen.push(s.seq));
    expect(seen).toEqual([3]);
  });

  it('单个订阅者抛错不影响其他订阅者', () => {
    const { store } = makeStore();
    store.replacement(emptySnapshot(META));
    const good = vi.fn();
    store.subscribe(() => {
      throw new Error('boom');
    });
    store.subscribe(good);
    store.replacement({ ...emptySnapshot(META), seq: 2 });
    expect(good).toHaveBeenCalled();
  });

  it('dropInteraction 本地移除卡片（不必等事件回流）', () => {
    const { store } = makeStore();
    const pending = [
      {
        id: 'p1',
        kind: 'permission' as const,
        createdAt: 0,
        sessionId: 's1',
        subject: 'x',
        risk: 'exec' as const,
        options: [{ id: 'once', label: 'a', scope: 'once' as const }],
      },
    ];
    store.replacement({ ...emptySnapshot(META), pendingInteractions: pending });
    store.dropInteraction('p1');
    expect(store.pending()).toHaveLength(0);
  });

  it('clear 后不再接受 delta', () => {
    const { store, requests } = makeStore();
    store.replacement(emptySnapshot(META));
    store.clear();
    store.delta({ sessionId: 's1', epoch: 1, fromSeq: 1, toSeq: 1, events: [] });
    expect(requests).toHaveLength(1);
  });
});
