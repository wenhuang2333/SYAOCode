/**
 * `!` 前缀的本地命令行（FR-N-036 / `27` §4.4）。
 *
 * 纪律（“诚实边界”）：
 *  - `!` 走 `session/run-command`，**绝不**走 `send`——命令不会被当成消息发给模型；
 *  - 结果只作为**渲染层视图**存在，不进 `session.history`、不进模型上下文；
 *  - 视觉上必须是“本地命令”块（等宽 + 明确标签），不能看起来像模型的工具调用或会话消息；
 *  - `truncated` / `timedOut` / `command_denied` 各有不同的人话文案，被拒**不显示为成功**；
 *  - 与模型的 `bash` 工具共用同一个内核权限闸门：危险命令会被直接拒绝，写类命令会弹审批卡。
 */

import type { ReactNode } from 'react';
import type { SessionRunCommandResult } from '@liwencode/dhp';
import { t, type Lang } from './i18n';

// ── 纯函数（可被测试直接断言）────────────────────────────────────────────

/** 草稿是否以 `!` 开头（允许前导空白）。 */
export function isShellCommand(text: string): boolean {
  return /^\s*!/.test(text);
}

/** 剥掉前导空白与第一个 `!`，返回真正的命令文本（可能为空串）。 */
export function shellCommandOf(text: string): string {
  return text.replace(/^\s*!/, '').trim();
}

/** 拒绝原因的错误形状（`command_denied` 由 Host 抛出）。 */
export interface ShellDenial {
  readonly kind?: unknown;
  readonly message?: string;
}

export interface ShellOutcome {
  /** 成功返回的结果；被拒 / 失败时为 undefined。 */
  readonly result?: SessionRunCommandResult | undefined;
  /** 被权限闸门拒绝时的信息；其它失败为 undefined。 */
  readonly denial?: ShellDenial | undefined;
  /** 非拒绝类错误（网络、协议、进程启动失败）的人话信息。 */
  readonly error?: string | undefined;
}

export type ShellResultTone = 'ok' | 'failed' | 'denied' | 'timeout';

/** 结果色调：成功 / 非零退出 / 被拒 / 超时（四态互斥，顺序固定）。 */
export function shellResultTone(outcome: ShellOutcome): ShellResultTone {
  if (outcome.denial !== undefined) return 'denied';
  const result = outcome.result;
  if (!result) return 'failed';
  if (result.timedOut) return 'timeout';
  return result.exitCode === 0 ? 'ok' : 'failed';
}

/** 四种结果各自的一句话摘要（互不相同；被拒不出现“成功”）。 */
export function shellResultSummary(outcome: ShellOutcome, lang: Lang = 'zh'): string {
  switch (shellResultTone(outcome)) {
    case 'ok':
      return t(lang, 'shell.ok');
    case 'failed': {
      const result = outcome.result;
      if (!result) {
        return outcome.error === undefined || outcome.error === ''
          ? t(lang, 'shell.failed')
          : t(lang, 'shell.failedWith', { reason: outcome.error });
      }
      return t(lang, 'shell.failedExit', { code: result.exitCode });
    }
    case 'timeout':
      return t(lang, 'shell.timeout');
    case 'denied': {
      const reason = denialReason(outcome.denial);
      return reason === '' ? t(lang, 'shell.denied') : t(lang, 'shell.deniedWith', { reason });
    }
  }
}

/** 从拒绝错误里取原因（去掉重复前缀，避免“拒绝：命令被拒绝”）。 */
export function denialReason(denial: ShellDenial | undefined): string {
  const message = typeof denial?.message === 'string' ? denial.message.trim() : '';
  if (message === '') return '';
  return message.replace(/^命令被权限规则拒绝[：:]\s*/, '').replace(/^-32047\s*/, '');
}

/**
 * stdout / stderr 的合并展示规则。
 *
 * stdout 在前；stderr 非空时用 `--- stderr ---` 分隔；两者都空时给明确占位
 * （绝不留空块，让人误以为“没有输出”就是“没执行”）。
 */
export function shellOutputText(result: SessionRunCommandResult, lang: Lang = 'zh'): string {
  const stdout = result.stdout;
  const stderr = result.stderr;
  const hasStdout = stdout !== '';
  const hasStderr = stderr !== '';
  const separator = t(lang, 'shell.stderrSeparator');
  if (!hasStdout && !hasStderr) return t(lang, 'shell.emptyOutput');
  if (!hasStderr) return stdout;
  if (!hasStdout) return `${separator}\n${stderr}`;
  return `${stdout}\n${separator}\n${stderr}`;
}

/** 结果行的补充说明：截断必须明说（§8.4 的同一套口径）。 */
export function shellTruncatedNote(result: SessionRunCommandResult, lang: Lang = 'zh'): string {
  return result.truncated ? t(lang, 'shell.truncated') : '';
}

/** 失败时草稿是否应当保留（只有成功才清空，方便修改重试）。 */
export function shouldKeepDraft(outcome: ShellOutcome): boolean {
  return shellResultTone(outcome) !== 'ok';
}

// ── 组件 ────────────────────────────────────────────────────────────────

export interface ShellResultBlockProps {
  /** 原始命令（不含前导 `!`）。 */
  readonly command: string;
  /** 执行结果；`pending` 时显示“执行中”。 */
  readonly outcome?: ShellOutcome | undefined;
  /** 是否仍在执行（含等待审批卡）。 */
  readonly pending?: boolean | undefined;
  /** 界面语言（默认中文，与桌面端默认一致）。 */
  readonly lang?: Lang | undefined;
}

/**
 * 本地命令结果块（纯 props，可直接静态渲染）。
 *
 * 与 Timeline 的会话消息刻意不同：`.shell-line` 自带“本地命令”标签、等宽正文，
 * 并明确写“未发送给模型”，避免用户误以为模型执行了它。
 */
export function ShellResultBlock({ command, outcome, pending = false, lang = 'zh' }: ShellResultBlockProps): ReactNode {
  const tone = pending || !outcome ? undefined : shellResultTone(outcome);
  return (
    <section className={`shell-line${tone === undefined ? '' : ` shell-line-${tone}`}`} aria-label={t(lang, 'shell.ariaLabel')}>
      <header className="shell-line-head">
        <span className="shell-line-tag">{t(lang, 'shell.tag')}</span>
        <span className="shell-line-hint">{t(lang, 'shell.hint')}</span>
      </header>
      <pre className="shell-line-command"><span aria-hidden="true">! </span>{command}</pre>
      {pending || !outcome
        ? <p className="shell-line-status" role="status">{t(lang, 'shell.running')}</p>
        : <>
          <p className={`shell-line-status shell-line-status-${tone}`}>{shellResultSummary(outcome, lang)}</p>
          {tone !== 'denied' && outcome.result && (
            <>
              {shellTruncatedNote(outcome.result, lang) !== '' && <p className="shell-line-note">{shellTruncatedNote(outcome.result, lang)}</p>}
              <pre className="shell-line-output">{shellOutputText(outcome.result, lang)}</pre>
              <p className="shell-line-meta">
                {t(lang, 'shell.meta', { code: outcome.result.exitCode, ms: outcome.result.durationMs })}
              </p>
            </>
          )}
          {tone === 'denied' && <p className="shell-line-note">{t(lang, 'shell.deniedNote')}</p>}
        </>}
    </section>
  );
}
