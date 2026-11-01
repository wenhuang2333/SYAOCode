/**
 * Preload：渲染层与主进程之间**唯一**的桥。
 *
 * 安全姿态（`13-安全与隐私设计` §4）：
 *  - `contextIsolation: true` + `sandbox: true`：渲染层碰不到 Node
 *  - 只暴露 `window.syao` 这一个对象，且每个方法都是**窄接口**
 *  - 令牌只交给渲染层的 DHP 客户端用于建连，不落 localStorage、不进 URL
 *
 * 这里**不**提供任何文件系统 / 子进程能力。
 * 渲染层想读文件，必须走 DHP 的 `workspace/readFile`（由 Host 校验围栏）。
 */

import { contextBridge, ipcRenderer } from 'electron';

export interface SyaoBridge {
  readonly host: {
    /** Host 的连接信息（端口 + 一次性令牌）。 */
    info(): Promise<{ port: number; token: string; workspaceRoot: string }>;
  };
  readonly app: {
    info(): Promise<{
      version: string;
      platform: string;
      arch: string;
      electron: string;
    }>;
    openDirectory(): Promise<string | undefined>;
  };
  readonly events: {
    onHostCrashed(cb: (payload: { code: number | null; signal: string | null; stderrTail: string }) => void): () => void;
    onDeepLink(cb: (url: string) => void): () => void;
  };
}

const bridge: SyaoBridge = {
  host: {
    info: () => ipcRenderer.invoke('host:info') as Promise<{ port: number; token: string; workspaceRoot: string }>,
  },
  app: {
    info: () => ipcRenderer.invoke('app:info') as Promise<{
      version: string;
      platform: string;
      arch: string;
      electron: string;
    }>,
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory') as Promise<string | undefined>,
  },
  events: {
    onHostCrashed(cb) {
      const handler = (_e: unknown, payload: { code: number | null; signal: string | null; stderrTail: string }): void =>
        cb(payload);
      ipcRenderer.on('host:crashed', handler);
      return () => ipcRenderer.removeListener('host:crashed', handler);
    },
    onDeepLink(cb) {
      const handler = (_e: unknown, url: string): void => cb(url);
      ipcRenderer.on('app:deeplink', handler);
      return () => ipcRenderer.removeListener('app:deeplink', handler);
    },
  },
};

contextBridge.exposeInMainWorld('syao', bridge);
