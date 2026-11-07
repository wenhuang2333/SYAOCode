/**
 * 投影 store：客户端持有的**唯一**会话状态。
 *
 * 三条铁律在这里落地（`00-基线` §8.3）：
 *   1. `applySnapshot` 整体替换
 *   2. `applyDelta` 仅在衔接时应用；否则**不猜**，要求重订阅
 *   3. 重订阅时携当前水位，由服务端裁决
 *
 * 这个类刻意做成"可注入传输"：`subscribe` 回调由 `DhpConnection` 提供，
 * 因此它可以脱离网络单测（见 `test/projection-store.test.ts`）。
 */

import {
  applyDelta,
  applySnapshot,
  emptySnapshot,
  type PendingInteraction,
  type SessionDelta,
  type SessionMeta,
  type SessionSnapshot,
} from '@syaocode/dhp';

export type StoreListener = (snapshot: SessionSnapshot) => void;

export interface ResubscribeRequest {
  readonly sessionId: string;
  /** 当前水位；服务端据此决定回快照还是补洞。 */
  readonly baseSeq: number;
  readonly epoch: number;
  /** 触发重订阅的原因（诊断用）。 */
  readonly reason: string;
}

export interface ProjectionStoreOptions {
  readonly onResubscribe: (req: ResubscribeRequest) => void;
  readonly now?: () => number;
}

export class ProjectionStore {
  private snapshot: SessionSnapshot | undefined;
  private readonly listeners = new Set<StoreListener>();
  /** 重订阅进行中：期间收到的 delta 一律忽略（等快照）。 */
  private resyncing = false;

  constructor(private readonly opts: ProjectionStoreOptions) {}

  get current(): SessionSnapshot | undefined {
    return this.snapshot;
  }

  get isResyncing(): boolean {
    return this.resyncing;
  }

  subscribe(fn: StoreListener): () => void {
    this.listeners.add(fn);
    // 立即回放当前值：避免 UI 首帧空白。同样要隔离异常——
    // 一个坏的订阅者不能在**订阅时**就把订阅流程炸掉。
    if (this.snapshot !== undefined) {
      try {
        fn(this.snapshot);
      } catch {
        // 忽略：该订阅者接下来的更新也会被 set() 隔离。
      }
    }
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** 初始化空会话（新建会话时，先给 UI 一个可渲染的骨架）。 */
  init(meta: SessionMeta): void {
    this.resyncing = false;
    this.set(emptySnapshot(meta));
  }

  /**
   * 铁律 1：整体替换。
   *
   * 注意 `applySnapshot` 的第二个参数（旧值）**被丢弃**——这是设计意图，
   * 不是疏忽：任何"保留旧字段"的合并都会让分叉重新变为可能。
   */
  replacement(next: SessionSnapshot): void {
    this.resyncing = false;
    this.set(applySnapshot(this.snapshot, next));
  }

  /**
   * 铁律 2 + 3：衔接则应用；断档则请求重订阅。
   *
   * 重订阅期间置 `resyncing = true`，后续 delta 直接丢弃——
   * 因为它们的基线已经失效，应用它们只会得到一个更错的状态。
   */
  delta(d: SessionDelta): void {
    if (this.snapshot === undefined) {
      this.opts.onResubscribe({
        sessionId: d.sessionId,
        baseSeq: 0,
        epoch: d.epoch,
        reason: 'no snapshot yet',
      });
      return;
    }
    if (d.sessionId !== this.snapshot.meta.sessionId || this.resyncing) return;

    const result = applyDelta(this.snapshot, d);
    if (result.ok) {
      this.set(result.snapshot);
      return;
    }

    this.resyncing = true;
    this.opts.onResubscribe({
      sessionId: this.snapshot.meta.sessionId,
      baseSeq: this.snapshot.seq,
      epoch: this.snapshot.epoch,
      reason: result.reason,
    });
  }

  /** 交互被结算后，本地立刻移除卡片（不必等事件回流）。 */
  dropInteraction(id: string): void {
    if (this.snapshot === undefined) return;
    const pending = this.snapshot.pendingInteractions.filter((p) => p.id !== id);
    if (pending.length === this.snapshot.pendingInteractions.length) return;
    this.set({ ...this.snapshot, pendingInteractions: pending });
  }

  pending(): readonly PendingInteraction[] {
    return this.snapshot?.pendingInteractions ?? [];
  }

  /** 清空（切会话时调用，避免旧会话的行漏进新会话）。 */
  clear(): void {
    this.snapshot = undefined;
    this.resyncing = false;
  }

  private set(next: SessionSnapshot): void {
    this.snapshot = next;
    for (const fn of this.listeners) {
      try {
        fn(next);
      } catch {
        // 单个订阅者失败不影响其他订阅者。
      }
    }
  }
}
