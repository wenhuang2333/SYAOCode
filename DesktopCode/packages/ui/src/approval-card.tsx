import type * as React from 'react';
/**
 * 审批卡片（`00-基线` §6.4 / `05` DD-D-307）。
 *
 * 设计决定（有意的，不是遗漏）：
 *  - **内联在会话流里**，不是模态框。理由：审批是对话的一部分，用户要能回看
 *    "当时批准了什么"；模态框会遮挡上下文且无法回看。
 *  - **"为什么问我"必须来自策略引擎**（`explain`），不得来自模型自述。
 *  - **敏感项只给"允许一次 / 拒绝"**：`session`/`project` 记忆对敏感路径是危险的。
 *  - 已决卡片**保留在时间线中**（由投影的 marker 行承担），不在这里删除。
 */

import type { PendingInteraction } from '@liwencode/dhp';
import type { Messages } from './i18n.ts';

export interface ApprovalCardProps {
  readonly interaction: PendingInteraction;
  readonly m: Messages;
  readonly onResolve: (interactionId: string, optionId: string) => void;
  readonly disabled?: boolean;
}

const RISK_CLASS: Readonly<Record<PendingInteraction['risk'], string>> = {
  read: 'risk-read',
  write: 'risk-write',
  exec: 'risk-exec',
};

export function ApprovalCard({ interaction, m, onResolve, disabled }: ApprovalCardProps): React.JSX.Element {
  const riskLabel =
    interaction.risk === 'read' ? m.riskRead : interaction.risk === 'write' ? m.riskWrite : m.riskExec;

  return (
    <div className={`approval-card ${RISK_CLASS[interaction.risk]}`} role="group" aria-label={m.approvalTitle}>
      <div className="approval-head">
        <span className={`badge ${RISK_CLASS[interaction.risk]}`}>{riskLabel}</span>
        <span className="approval-subject">{interaction.subject}</span>
      </div>

      {interaction.preview !== undefined && (
        <pre className={`approval-preview preview-${interaction.preview.type}`}>
          {interaction.preview.text}
        </pre>
      )}

      {interaction.sensitive === true && <p className="approval-sensitive">{m.approvalSensitive}</p>}

      {interaction.explain !== undefined && (
        <details className="approval-explain">
          <summary>{m.approvalExplain}</summary>
          <p>{interaction.explain}</p>
        </details>
      )}

      <div className="approval-actions">
        {interaction.options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={opt.scope === 'deny' ? 'btn btn-danger' : 'btn btn-primary'}
            disabled={disabled === true}
            onClick={() => onResolve(interaction.id, opt.id)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
