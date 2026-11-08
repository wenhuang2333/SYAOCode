import type * as React from 'react';
/**
 * 时间线：把投影行渲染成界面（`05` DD-D-302 行模型）。
 *
 * 行类型与渲染器的对应是**封闭**的：四类行各有一个渲染器，
 * 新增行类型会在这里编译失败——这是有意的，避免"新事件悄悄不显示"。
 */

import type { ProjectionRow } from '@liwencode/dhp';
import type { Messages } from './i18n.ts';
import { Markdown } from './markdown.tsx';

export interface TimelineProps {
  readonly rows: readonly ProjectionRow[];
  readonly m: Messages;
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
  }
}
