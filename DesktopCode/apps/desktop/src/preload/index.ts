/**
 * Preload：渲染层与主进程之间**唯一**的桥。
 *
 * 安全姿态（`13-安全与隐私设计` §4）：
 *  - `contextIsolation: true` + `sandbox: true`：渲染层碰不到 Node
 *  - 只暴露 `window.syao` 这一个对象，且每个方法都是**窄接口**
 *  - 令牌不进入渲染层，由主进程注入本地 WebSocket 请求头
 *
 * 这里**不**提供任何文件系统 / 子进程能力。
 * 渲染层想读文件，必须走 DHP 的 `workspace/readFile`（由 Host 校验围栏）。
 */

import { contextBridge, ipcRenderer } from 'electron';

export interface SyaoBridge {
  readonly host: {
    /** Host 的公开连接信息，不含令牌。 */
    info(): Promise<{ port: number; workspaceRoot: string }>;
  };
  readonly app: {
    info(): Promise<{
      version: string;
      platform: string;
      arch: string;
      electron: string;
    }>;
    openDirectory(): Promise<string | undefined>;
    /** 用系统浏览器打开 http(s) 链接（Git 设备码授权用）；其它协议会被主进程拒绝。 */
    openExternal(url: string): Promise<{ opened: boolean }>;
  };
  /**
   * 凭据（只写不读）。
   *
   * 这里**没有**"读取凭据"的方法：令牌与私钥提交后立即离开渲染层，
   * 之后只由 Host 在执行 git 前经私有 IPC 取一次（`27` §10.7.4）。
   * 渲染层拿到的只有公钥与指纹这类公开值。
   */
  readonly credentials: {
    available(): Promise<boolean>;
    setSecret(remoteUrl: string, method: 'oauth' | 'ssh-agent' | 'ssh-key' | 'token', value: string): Promise<{ stored: boolean }>;
    clearSecret(remoteUrl: string, method: 'oauth' | 'ssh-agent' | 'ssh-key' | 'token'): Promise<{ cleared: boolean }>;
    generateSshKey(remoteUrl: string, comment?: string): Promise<{ publicKey: string; fingerprint: string }>;
    importSshKey(remoteUrl: string, privateKey: string, passphrase?: string): Promise<{ fingerprint: string }>;
  };
  /**
   * Git 凭据窄桥（渲染层按"工作区 + 远端名"发起，**不传令牌以外的秘密形态**）。
   *
   * 与 `credentials` 的区别：这里的入参是用户视角的 `workspaceRoot` + `remote`，
   * 主进程据此解析远端 URL 并决定钥匙串条目；`credentials` 是更底层的 URL 直连。
   * 两者最终走同一条 IPC，渲染层只会拿到 `{stored|cleared|publicKey|fingerprint}`。
   */
  readonly git: {
    setToken(payload: { workspaceRoot: string; remote: string; url: string; token: string }): Promise<{ stored: boolean }>;
    clear(payload: { workspaceRoot: string; remote: string; url: string; method?: 'oauth' | 'ssh-agent' | 'ssh-key' | 'token' }): Promise<{ cleared: boolean }>;
    importSshKey(payload: { workspaceRoot: string; remote: string; url: string; privateKey: string; passphrase?: string }): Promise<{ fingerprint: string }>;
    useSshAgent(payload: { workspaceRoot: string; remote: string; url: string }): Promise<{ publicKey: string; fingerprint: string }>;
  };
  readonly events: {
    onHostCrashed(cb: (payload: { code: number | null; signal: string | null; stderrTail: string }) => void): () => void;
    onDeepLink(cb: (url: string) => void): () => void;
  };
}

const bridge: SyaoBridge = {
  host: {
    info: () => ipcRenderer.invoke('host:info') as Promise<{ port: number; workspaceRoot: string }>,
  },
  app: {
    info: () => ipcRenderer.invoke('app:info') as Promise<{
      version: string;
      platform: string;
      arch: string;
      electron: string;
    }>,
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory') as Promise<string | undefined>,
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', { url }) as Promise<{ opened: boolean }>,
  },
  credentials: {
    available: () => ipcRenderer.invoke('credential:available') as Promise<boolean>,
    setSecret: (remoteUrl, method, value) =>
      ipcRenderer.invoke('credential:set', { remoteUrl, method, value }) as Promise<{ stored: boolean }>,
    clearSecret: (remoteUrl, method) =>
      ipcRenderer.invoke('credential:delete', { remoteUrl, method }) as Promise<{ cleared: boolean }>,
    generateSshKey: (remoteUrl, comment) =>
      ipcRenderer.invoke('credential:generate-ssh', { remoteUrl, comment }) as Promise<{ publicKey: string; fingerprint: string }>,
    importSshKey: (remoteUrl, privateKey, passphrase) =>
      ipcRenderer.invoke('credential:import-ssh', { remoteUrl, privateKey, passphrase }) as Promise<{ fingerprint: string }>,
  },
  git: {
    setToken: (payload) => ipcRenderer.invoke('git:credential:set-token', payload) as Promise<{ stored: boolean }>,
    clear: (payload) => ipcRenderer.invoke('git:credential:clear', payload) as Promise<{ cleared: boolean }>,
    importSshKey: (payload) => ipcRenderer.invoke('git:credential:import-ssh', payload) as Promise<{ fingerprint: string }>,
    useSshAgent: (payload) => ipcRenderer.invoke('git:credential:use-ssh-agent', payload) as Promise<{ publicKey: string; fingerprint: string }>,
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
