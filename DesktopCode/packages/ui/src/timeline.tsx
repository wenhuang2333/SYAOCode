import type * as React from 'react';
/**
 * 时间线：把投影行渲染成界面（`05` DD-D-302 行模型）。
 *
 * 行类型与渲染器的对应是**封闭**的：四类行各有一个渲染器，
 * 新增行类型会在这里编译失败——这是有意的，避免"新事件悄悄不显示"。
 */

import type { ProjectionRow, SteerRow } from '@liwencode/dhp';
import type { Messages } from './i18n.ts';
import { Markdown } from './markdown.tsx';

export interface TimelineProps {
  readonly rows: readonly ProjectionRow[];
  readonly m: Messages;
}

/**
 * steer 行的状态文案（`28-多轮steer行为契约` §5/§6）。
 *
 * 纯函数：同一行同一文案，便于单测；三种状态必须可区分，
 * `notConsumed` **必须**把原因显示出来（Host 没给原因时也不编造）。
 */
export function steerStateLabel(m: Messages, row: SteerRow): string {
  switch (row.state) {
    case 'queued':
      return m.steerQueued;
    case 'consumed':
      return row.turn === undefined
        ? m.steerConsumed
        : m.steerConsumedTurn.replace('{turn}', String(row.turn));
    case 'notConsumed':
      return row.reason === undefined || row.reason === ''
        ? m.steerNotConsumedUnknown
        : m.steerNotConsumedReason.replace('{reason}', row.reason);
  }
}

export function Timeline({ rows, m }: TimelineProps): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">{m.emptyTitle}</p>
        <p className="empty-hint">{m.emptyHint}</p>
      </div>
    );
  }
  return (
    <div className="timeline">
      {rows.map((row) => (
        <RowView key={row.key} row={row} m={m} />
      ))}
    </div>
  );
}

export function RowView({ row, m }: { row: ProjectionRow; m: Messages }): React.JSX.Element {
  switch (row.kind) {
    case 'message':
      return (
        <article className={`row msg msg-${row.role}`}>
          <span className="role">{row.role === 'user' ? m.you : m.assistant}</span>
          <div className="content">{row.role === 'assistant' ? <Markdown text={row.text} /> : row.text}</div>
          {!row.final && <span className="streaming-dot" aria-label="streaming">•</span>}
        </article>
      );

    case 'thinking':
      if (row.text === '') return <></>;
      return (
        <details className="row thinking" open={!row.collapsed}>
          <summary>{m.thinking}</summary>
          <div className="content">{row.text}</div>
        </details>
      );

    case 'toolCall': {
      const label =
        row.state === 'ok' ? m.toolOk : row.state === 'error' ? m.toolError : m.toolRunning;
      const icon = row.state === 'ok' ? '✔' : row.state === 'error' ? '✖' : '⚙';
      return (
        <div className={`row tool tool-${row.state}`} title={label}>
          <span className="tool-icon">{icon}</span>
          <span className="tool-name">{row.name}</span>
          {row.progress !== undefined && <span className="tool-progress">{row.progress}</span>}
          {row.durationMs !== undefined && <span className="tool-duration">{row.durationMs}ms</span>}
          <details className="tool-input"><summary>输入参数</summary><pre>{JSON.stringify(row.input, null, 2)?.slice(0, 8000) ?? '—'}</pre></details>
          {row.resultText !== undefined && row.resultText !== '' && (
            <details className="tool-result">
              <summary>结果</summary>
              {/* 只渲染文本；超过 4000 字符截断（完整内容在 tool.receipt 的证据里）。 */}
              <pre>{row.resultText.slice(0, 4000)}</pre>
            </details>
          )}
        </div>
      );
    }

    case 'marker':
      return <div className={`row marker marker-${row.tone}`}>{row.text}</div>;

    case 'steer':
      // steer 是"运行中的补充指令"，不是普通用户消息：独立行型 + 独立状态徽标，
      // 三种状态用 `data-steer-state` 暴露给测试与真实窗口取证脚本。
      return (
        <article className={`row steer steer-${row.state}`} data-steer-state={row.state}>
          <span className="role">{m.steerRow}</span>
          <div className="content">{row.text}</div>
          <span className="steer-state">{steerStateLabel(m, row)}</span>
        </article>
      );
  }
}
