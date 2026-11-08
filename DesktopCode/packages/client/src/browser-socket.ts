/**
 * 浏览器端 WebSocket 工厂。
 *
 * 浏览器**不能**设置自定义请求头（`WebSocket` 构造器没有 headers 参数），
 * 因此令牌只能走 query string —— 这与 DHP 的"令牌不进 query string"规则冲突。
 *
 * 处置（`06` §3）：
 *  - 桌面端（Electron 渲染层）**不用**这个工厂：preload 注入令牌，
 *    由 `DhpConnection` 的 `socketFactory` 直接用带 header 的实现。
 *  - 浏览器模式（`liwen web`）才用这个工厂，且**只在回环地址**下允许。
 *
 * 这里的实现因此显式要求调用方确认"回环 + 一次性令牌"。
 */

import type { SocketFactory, WebSocketLike } from './connection.ts';

export interface BrowserSocketFactoryOptions {
  /** 是否允许把令牌放进 query string。只有回环模式才应为 true。 */
  readonly allowTokenInQuery?: boolean;
}

/**
 * 构造一个浏览器 socket 工厂。
 *
 * `allowTokenInQuery` 为 false 时，工厂会拒绝建立连接 —— 这不是"降级"，
 * 而是**明确失败**：把令牌放进 URL 意味着它会进服务器日志、Referer 与剪贴板。
 */
export function createBrowserSocketFactory(opts: BrowserSocketFactoryOptions = {}): SocketFactory {
  return (url: string, token: string): WebSocketLike => {
    if (opts.allowTokenInQuery !== true) {
      throw new Error(
        'browser socket factory: token in query string is disabled. ' +
          'Use the desktop preload path (headers) or explicitly opt in for loopback-only use.',
      );
    }
    const sep = url.includes('?') ? '&' : '?';
    const socket = new WebSocket(`${url}${sep}token=${encodeURIComponent(token)}`);
    return socket as unknown as WebSocketLike;
  };
}
