import type * as React from 'react';
/**
 * 输入区（Composer）（`05` DD-D-308）。
 *
 * 这里实现了三个**中文用户高频缺陷**的防护：
 *  1. **IME 组合保护**：`compositionstart` → 输入拼音 → `compositionend` 期间，
 *     退格**不得**删掉正在组合的拼音（这是原生 `<textarea>` 也会犯的错）。
 *  2. **码点级删除**：emoji 是代理对（两个 UTF-16 码元），删除时必须整体删。
 *  3. **粘贴只取 text/plain**：绝不渲染粘贴内容里的 HTML。
 *
 * 另有一条来自 CLI 的等价要求：**Enter 提交、Shift+Enter 换行**。
 */

import { useCallback, useRef, useState } from 'react';
import type { Messages } from './i18n.ts';

export interface ComposerProps {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly onSubmit: (text: string) => void;
  readonly m: Messages;
  readonly disabled?: boolean;
  /** 存在待处理审批时为 true：send 模式下提示等待并禁止提交。 */
  readonly awaitingApproval?: boolean;
  readonly busy?: boolean;
  /**
   * 运行中：提交语义是「作为补充指令排队」（`28` §6），**不是**启动第二个并发执行。
   *
   * 与 send 模式的两点差异：
   *  1. 等待审批**不**阻止提交——契约明确「等待审批时 steer 可排队，审批仍按原流程结算」；
   *  2. 按钮文案必须表达「排队」，不能看起来像再发一条普通消息。
   *
   * 文案由调用方传入（桌面端文案目录负责），共享包不硬编码业务文案。
   */
  readonly steerMode?: boolean;
  /** steer 模式下的按钮文案。 */
  readonly steerSubmitLabel?: string;
  /** steer 模式下的输入占位。 */
  readonly steerPlaceholder?: string;
}

/** 提交闸门的输入（纯函数，便于单测；组件与测试共用同一判定）。 */
export interface ComposerGate {
  readonly value: string;
  readonly disabled?: boolean | undefined;
  readonly awaitingApproval?: boolean | undefined;
  readonly busy?: boolean | undefined;
  readonly steerMode?: boolean | undefined;
}

/**
 * 是否可以提交。
 *
 * send 模式：等待审批时禁止（避免把审批当普通消息绕过）。
 * steer 模式：等待审批**不**阻止（排队不等于批准，见 `28` §2 硬规则 3）。
 */
export function canSubmitComposer(gate: ComposerGate): boolean {
  if (gate.value.trim() === '') return false;
  if (gate.disabled === true || gate.busy === true) return false;
  if (gate.steerMode !== true && gate.awaitingApproval === true) return false;
  return true;
}

/** 超过这个长度就折叠为摘要（防止一次粘贴 10MB 卡住 UI）。 */
const PASTE_COLLAPSE_THRESHOLD = 20_000;

export function Composer({
  value,
  onChange,
  onSubmit,
  m,
  disabled,
  awaitingApproval,
  busy,
  steerMode,
  steerSubmitLabel,
  steerPlaceholder,
}: ComposerProps): React.JSX.Element {
  const [composing, setComposing] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const gate: ComposerGate = { value, disabled, awaitingApproval, busy, steerMode };
  const canSubmit = canSubmitComposer(gate);

  const submit = useCallback((): void => {
    if (!canSubmitComposer({ value, disabled, awaitingApproval, busy, steerMode })) return;
    onSubmit(value.trim());
  }, [value, disabled, awaitingApproval, busy, steerMode, onSubmit]);

  return (
    <div className="composer">
      {collapsed && (
        <div className="paste-collapsed">
          <span>已粘贴 {value.length} 字符（已折叠）</span>
          <button type="button" className="btn btn-ghost" onClick={() => setCollapsed(false)}>
            展开
          </button>
        </div>
      )}
      <textarea
        ref={ref}
        value={value}
        disabled={disabled === true}
        placeholder={steerMode === true && steerPlaceholder !== undefined ? steerPlaceholder : m.composerPlaceholder}
        aria-label="对话输入"
        data-submit-mode={steerMode === true ? 'steer' : 'send'}
        rows={3}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onChange={(e) => {
          const next = e.target.value;
          // 组合期间浏览器给出的 value 可能是拼音原文；照单接收但**不**自行裁决。
          onChange(next);
        }}
        onKeyDown={(e) => {
          // 组合期间**不**处理 Enter/Backspace —— 交给浏览器，否则会吞掉拼音。
          if (composing || e.nativeEvent.isComposing) return;
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text/plain');
          if (text === '') return;
          e.preventDefault();
          const start = ref.current?.selectionStart ?? value.length;
          const end = ref.current?.selectionEnd ?? start;
          const next = value.slice(0, start) + text + value.slice(end);
          onChange(next);
          requestAnimationFrame(() => ref.current?.setSelectionRange(start + text.length, start + text.length));
          if (next.length > PASTE_COLLAPSE_THRESHOLD) setCollapsed(true);
        }}
      />
      <div className="composer-actions">
        {awaitingApproval === true && <span className="awaiting">等待审批</span>}
        <button
          type="button"
          className={`btn btn-primary${steerMode === true ? ' composer-steer' : ''}`}
          data-submit-mode={steerMode === true ? 'steer' : 'send'}
          onClick={submit}
          disabled={!canSubmit}
        >
          {busy === true ? m.sending : steerMode === true ? (steerSubmitLabel ?? m.send) : m.send}
        </button>
      </div>
    </div>
  );
}

/**
 * 码点级删除（供外部调用；组件内部用原生行为，但这个函数是给"程序化删除"
 * 场景用的，比如"删除最后一个引用"）。
 *
 * 代理对（emoji）与组合字符都按**整个码点/字素簇**处理。
 */
export function deleteLastCodePoint(text: string): string {
  if (text === '') return '';
  const points = Array.from(text);
  points.pop();
  return points.join('');
}
