import type * as React from 'react';
/**
 * 状态栏：连接状态 + 模型 + 运行态。
 *
 * 一条硬规则（`00-基线` §8.4）：**运行态只由事件流决定，不由 ACK 决定**。
 * 所以这里显示的 `runState` 来自投影，而不是"我刚点了发送"。
 */

import type { RunState, SessionMeta } from '@liwencode/dhp';
import type { Lang, Messages } from './i18n.ts';

export interface StatusBarProps {
  readonly state: 'booting' | 'connecting' | 'ready' | 'error' | 'reconnecting';
  readonly meta: SessionMeta | undefined;
  readonly runState: RunState;
  readonly m: Messages;
  readonly lang: Lang;
  readonly detail?: string;
}

export function StatusBar({ state, meta, runState, m, detail }: StatusBarProps): React.JSX.Element {
  const label =
    state === 'ready'
      ? m.statusReady
      : state === 'reconnecting'
        ? m.statusReconnecting
        : state === 'error'
          ? m.statusError
          : m.statusConnecting;

  return (
    <footer className={`statusbar statusbar-${state}`}>
      <span className="dot" aria-hidden="true" />
      <span className="label">{label}</span>
      {meta !== undefined && (
        <>
          <span className="sep">·</span>
          <span className="model">{meta.model}</span>
          <span className="sep">·</span>
          <span className="mode">{meta.permissionMode}</span>
        </>
      )}
      <span className="sep">·</span>
      <span className={`runstate runstate-${runState}`}>{runState}</span>
      {detail !== undefined && detail !== '' && <span className="detail">{detail}</span>}
    </footer>
  );
}
