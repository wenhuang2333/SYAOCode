import { SyaoError, MESSAGES_ZH_CN } from '@syaocode/core';
import { getLanguage, t } from './i18n/index.js';

/**
 * 面向用户的错误文案：英语模式用 SyaoError 自带的（英语）消息，
 * 中文模式优先用错误码对应的中文表（09 §9.10），未知错误保留原始消息。
 * 工具/模型返回的数据文本不在此翻译（它们是数据，不是 CLI 文案）。
 */

export function userErrorMessage(e: unknown): string {
  if (SyaoError.is(e)) {
    if (getLanguage() === 'zh') return MESSAGES_ZH_CN[e.code] ?? e.message;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export function userErrorText(e: unknown): string {
  if (SyaoError.is(e)) {
    return t('error.withCode', { code: e.code, message: userErrorMessage(e) });
  }
  return t('error.generic', { message: userErrorMessage(e) });
}

/** 事件流里的 SerializedError（没有 SyaoError 实例） */
export function userEventErrorText(code: string, message: string): string {
  return getLanguage() === 'zh' ? (MESSAGES_ZH_CN[code] ?? message) : message;
}
