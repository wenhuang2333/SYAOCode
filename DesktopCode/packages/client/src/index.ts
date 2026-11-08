/**
 * `@liwencode/client` —— 桌面端客户端 SDK。
 *
 * **不依赖 Electron，也不依赖 `node:`**：它是一个"普通 Web 客户端"。
 * 这正是 D-04（回环 WebSocket 协议）与 ADR-D07（UI 与宿主解耦）的落地形式——
 * 换壳（Tauri / 浏览器 / 远程）时，这个包一行都不用改。
 */

export {
  DhpConnection,
  DhpRequestError,
  type ConnectionState,
  type DhpConnectionOptions,
  type SocketFactory,
  type WebSocketLike,
} from './connection.ts';
export {
  ProjectionStore,
  type ProjectionStoreOptions,
  type ResubscribeRequest,
  type StoreListener,
} from './projection-store.ts';
export { createBrowserSocketFactory, type BrowserSocketFactoryOptions } from './browser-socket.ts';
