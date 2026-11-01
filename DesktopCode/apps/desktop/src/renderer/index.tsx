/**
 * 渲染层入口（桌面端）。
 *
 * 数据流是**单向**的：
 *   DHP 通知 → ProjectionStore → React 订阅 → 组件
 *   用户操作 → 命令信封 → DHP 请求
 *
 * 渲染层**不持业务状态**：会话内容全部来自投影。
 * 本地只保留 UI 偏好（滚动位置、面板折叠）——那些不是事实。
 */

import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DhpConnection, ProjectionStore, type WebSocketLike } from '@syaocode/client';
import { Method, type PendingInteraction, type SessionSnapshot } from '@syaocode/dhp';
import { ApprovalCard, Composer, StatusBar, Timeline, messages, type Lang } from '@syaocode/ui';
import '@syaocode/ui/styles.css';

interface Bridge {
  readonly host: { info(): Promise<{ port: number; token: string; workspaceRoot: string }> };
  readonly app: {
    info(): Promise<{ version: string; platform: string; arch: string; electron: string }>;
    openDirectory(): Promise<string | undefined>;
  };
  readonly events: {
    onHostCrashed(cb: (p: { stderrTail: string }) => void): () => void;
    onDeepLink(cb: (url: string) => void): () => void;
  };
}

declare global {
  interface Window {
    readonly syao?: Bridge;
  }
}

type ConnState = 'booting' | 'connecting' | 'ready' | 'error' | 'reconnecting';

function App(): React.JSX.Element {
  const bridge = window.syao;
  const [connState, setConnState] = useState<ConnState>('booting');
  const [detail, setDetail] = useState('正在启动本地运行时…');
  const [snapshot, setSnapshot] = useState<SessionSnapshot | undefined>(undefined);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<readonly PendingInteraction[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [lang] = useState<Lang>('zh');
  const m = messages(lang);
  const connRef = useRef<DhpConnection | undefined>(undefined);
  const storeRef = useRef<ProjectionStore | undefined>(undefined);

  const resubscribe = useCallback((req: { sessionId: string; baseSeq: number; epoch: number }): void => {
    void connRef.current
      ?.request(Method.SessionSubscribe, {
        sessionId: req.sessionId,
        baseSeq: req.baseSeq,
        epoch: req.epoch,
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (bridge === undefined) {
      setConnState('error');
      setDetail('preload 未就绪');
      return;
    }
    let disposed = false;

    const boot = async (): Promise<void> => {
      try {
        const info = await bridge.host.info();
        if (disposed) return;
        setConnState('connecting');
        setDetail(`127.0.0.1:${info.port}`);

        const store = new ProjectionStore({ onResubscribe: resubscribe });
        storeRef.current = store;
        store.subscribe((s) => setSnapshot(s));

        const conn = new DhpConnection({
          url: `ws://127.0.0.1:${info.port}`,
          token: info.token,
          // 桌面端由 preload 注入令牌 → 用请求头，不进 URL。
          socketFactory: (url, token): WebSocketLike => {
            const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as never);
            return ws as unknown as WebSocketLike;
          },
          onStateChange: (state) => {
            if (state === 'ready') {
              setConnState('ready');
              setDetail('');
            } else if (state === 'reconnecting') {
              setConnState('reconnecting');
              setDetail(m.statusReconnecting);
            } else if (state === 'closed') {
              setConnState('error');
              setDetail(m.statusError);
            }
          },
          onSnapshot: (sid, s) => {
            store.replacement(s);
            setSessionId(sid);
          },
          onDelta: (sid, d) => {
            store.delta(d);
            setSessionId(sid);
          },
          onInteraction: (i) => setPending((prev) => [...prev.filter((p) => p.id !== i.id), i]),
          onError: (e) => setDetail(e.message),
        });
        connRef.current = conn;
        await conn.connect();
        if (disposed) return;

        const created = (await conn.request(Method.SessionCreate, { title: m.newSession })) as {
          snapshot: SessionSnapshot;
        };
        store.replacement(created.snapshot);
        setSessionId(created.snapshot.meta.sessionId);
        await conn.request(Method.SessionSubscribe, { sessionId: created.snapshot.meta.sessionId });
      } catch (err) {
        if (!disposed) {
          setConnState('error');
          setDetail(err instanceof Error ? err.message : String(err));
        }
      }
    };

    void boot();
    const offCrash = bridge.events.onHostCrashed((p) => {
      setConnState('error');
      setDetail(`本地运行时已退出：${p.stderrTail.slice(-500)}`);
    });
    return () => {
      disposed = true;
      offCrash();
      connRef.current?.close();
    };
  }, [m.statusError, m.statusReconnecting, m.newSession, resubscribe]);

  const send = useCallback(async (): Promise<void> => {
    const conn = connRef.current;
    const sid = sessionId;
    const text = input.trim();
    if (conn === undefined || sid === undefined || text === '') return;
    setBusy(true);
    try {
      const snap = storeRef.current?.current;
      await conn.request(Method.TurnSend, {
        commandId: `cmd_ui_${Date.now()}`,
        baseRevision: snap?.revision ?? 1,
        sessionId: sid,
        text,
      });
      setInput('');
    } catch (err) {
      setDetail(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [input, sessionId]);

  const resolve = useCallback(
    async (interactionId: string, optionId: string): Promise<void> => {
      const conn = connRef.current;
      const sid = sessionId;
      if (conn === undefined || sid === undefined) return;
      try {
        const snap = storeRef.current?.current;
        await conn.request(Method.InteractionResolve, {
          commandId: `cmd_ui_resolve_${Date.now()}_${interactionId}`,
          baseRevision: snap?.revision ?? 1,
          sessionId: sid,
          interactionId,
          optionId,
        });
        setPending((prev) => prev.filter((p) => p.id !== interactionId));
      } catch (err) {
        setDetail(err instanceof Error ? err.message : String(err));
      }
    },
    [sessionId],
  );

  const rows = snapshot?.rows ?? [];

  return (
    <div className="app">
      <header className="titlebar">
        <span className="brand">{m.appName}</span>
        <span className="model">{snapshot?.meta.model ?? '—'}</span>
        <span className="status">{connState === 'ready' ? m.statusReady : detail}</span>
      </header>

      <main className="body">
        <section className="timeline" aria-live="polite">
          <Timeline rows={rows} m={m} />
          {pending.map((p) => (
            <ApprovalCard key={p.id} interaction={p} m={m} onResolve={(id, opt) => void resolve(id, opt)} />
          ))}
          {pending.length > 0 && <div className="dock">{m.approvalPending} {pending.length}</div>}
        </section>

        <Composer
          value={input}
          onChange={setInput}
          onSubmit={(t) => {
            setInput(t);
            void send();
          }}
          m={m}
          disabled={connState !== 'ready'}
          awaitingApproval={pending.length > 0}
          busy={busy}
        />
      </main>

      <StatusBar
        state={connState === 'reconnecting' ? 'reconnecting' : connState}
        meta={snapshot?.meta}
        runState={snapshot?.runState ?? 'idle'}
        m={m}
        lang={lang}
        detail={detail}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
