/**
 * 运行阶段跟踪（Claude Code 风格的状态行内容）。
 *
 * 阶段：Explore 探查 → Plan 规划 → Implement 实施 → Validate & Cleanup 验证&收尾。
 * 由事件流启发式推进（纯逻辑，便于单测）：
 * - 起始 = Explore（模型在读/排查）
 * - 已发生工具调用、模型开始输出文字（思考/回答）且尚未写文件 = Plan
 * - 首次 write/edit = Implement
 * - 写文件之后：bash / 读取 / 输出 = Validate & Cleanup
 * - 网络重试回调 = 红色 + 重试文案；成功事件（delta/usage/tool.result）清除
 */

import type { AgentEventBody } from '@syaocode/core';
import { t, type MsgKey } from '../i18n/index.js';
import { spinnerFrame } from './flight.js';
import { asciiMode } from './terminal.js';
import { truncateToWidth } from './width.js';

export type Phase = 'explore' | 'plan' | 'implement' | 'validate';

export type PhaseActivity =
  | { kind: 'idle' }
  | { kind: 'thinking' }
  | { kind: 'responding' }
  | { kind: 'tool'; name: string; target: string }
  | { kind: 'retry'; attempt: number; seconds: number };

export interface PhaseSnapshot {
  phase: Phase;
  activity: PhaseActivity;
  /** 网络拥塞/失效：文字红色、蝴蝶两层（上白下黑） */
  networkError: boolean;
}

export interface RetryInfo {
  attempt: number;
  code: string;
  delayMs: number;
}

function toolTarget(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  const pick = (v: unknown): string => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
      return pick(o.path);
    case 'bash':
      return pick(o.command);
    case 'glob':
    case 'grep':
      return pick(o.pattern) || pick(o.path);
    default:
      return pick(o.path) || pick(o.command) || '';
  }
}

export class PhaseTracker {
  private phase: Phase = 'explore';
  private activity: PhaseActivity = { kind: 'idle' };
  private hasTool = false;
  private hasWritten = false;
  private networkError = false;

  /** 新一轮用户输入开始时重置 */
  start(): void {
    this.phase = 'explore';
    this.activity = { kind: 'thinking' };
    this.hasTool = false;
    this.hasWritten = false;
    this.networkError = false;
  }

  /** provider 重试回调（withRetry.onRetry） */
  onRetry(info: RetryInfo): void {
    this.networkError = true;
    this.activity = { kind: 'retry', attempt: info.attempt, seconds: Math.max(1, Math.ceil(info.delayMs / 1000)) };
  }

  onEvent(ev: AgentEventBody): void {
    switch (ev.type) {
      case 'tool.start': {
        this.hasTool = true;
        if (ev.name === 'write' || ev.name === 'edit') {
          this.hasWritten = true;
          this.phase = 'implement';
        } else {
          // 写文件后的读取/执行用于核验；写之前的都属于探查
          this.phase = this.hasWritten ? 'validate' : 'explore';
        }
        this.activity = { kind: 'tool', name: ev.name, target: toolTarget(ev.name, ev.input) };
        this.networkError = false;
        break;
      }
      case 'thinking.delta':
      case 'text.delta':
        if (this.hasWritten) {
          this.phase = 'validate';
          this.activity = { kind: 'responding' };
        } else if (this.hasTool) {
          this.phase = 'plan';
          this.activity = { kind: 'thinking' };
        } else {
          this.activity = { kind: 'thinking' };
        }
        this.networkError = false;
        break;
      case 'tool.result':
      case 'usage':
        this.networkError = false;
        break;
      case 'message.complete':
        if (!this.hasWritten && this.hasTool) this.phase = 'plan';
        break;
      case 'error':
        if (ev.error.retryable || ev.error.code.startsWith('SY-PRV-')) this.networkError = true;
        break;
      default:
        break;
    }
  }

  snapshot(): PhaseSnapshot {
    return { phase: this.phase, activity: this.activity, networkError: this.networkError };
  }
}

/** 活动描述（按当前语言） */
export function activityText(activity: PhaseActivity): string {
  switch (activity.kind) {
    case 'idle':
      return '';
    case 'thinking':
      return t('phase.thinking');
    case 'responding':
      return t('phase.responding');
    case 'retry':
      return t('phase.retry', { attempt: activity.attempt, secs: activity.seconds });
    case 'tool': {
      const target = activity.target;
      switch (activity.name) {
        case 'read':
          return t('phase.read', { target });
        case 'write':
        case 'edit':
          return t('phase.write', { target });
        case 'bash':
          return t('phase.run', { command: target });
        case 'glob':
        case 'grep':
          return t('phase.search', { target });
        default:
          return t('phase.tool', { name: activity.name, target });
      }
    }
  }
}

/**
 * 阶段行：单行、单字符旋转动画（Claude Code 风格）。
 * 正常 = 蓝色文字 + 星芒旋转；网络问题 = 红色文字。
 */
export function phaseLine(snap: PhaseSnapshot, tMs: number, cols: number): string {
  const glyph = spinnerFrame(tMs, asciiMode());
  const color = snap.networkError ? 196 : 33;
  const label = t(`phase.${snap.phase}` as MsgKey);
  const activity = activityText(snap.activity);
  const text = ` ${glyph} ${label}${activity === '' ? '' : `  ${activity}`}`;
  const [fitted] = truncateToWidth(text, Math.max(8, cols));
  return `\x1b[38;5;${color}m${fitted}\x1b[39m`;
}
