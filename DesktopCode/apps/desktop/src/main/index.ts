/**
 * Electron 主进程：窗口、托盘、单实例、深链接，以及 **Host 进程的守护**。
 *
 * 三条硬规则（`00-基线` §6.3 / §7.3.2）：
 *  1. 主进程**不含业务逻辑**——它只负责拉起并守护 Host。
 *  2. Host 以 **`ELECTRON_RUN_AS_NODE=1`** 用 Electron 自带的 Node 启动
 *     （`child_process.spawn` + `ipc` 通道，不额外打包 Node）。
 *  3. `electronFuses.runAsNode` **必须保持启用** —— 关掉后 Host 起不来，
 *     且报错极其晦涩。这是 Fuses 里唯一一个不能碰的开关。
 */

import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  session,
  shell,
} from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  KeychainStore,
  disposeSshKeyFile,
  generateEd25519,
  materializeSshKeyFile,
  publicKeyFromPrivate,
  redactKeyMaterial,
} from './credentials.ts';
import { credentialEntry, remoteHost, type CredentialMethod } from './credential-entries.ts';

/**
 * Host 入口。
 *
 * 开发态：`packages/host/dist/main.cjs`（先跑 `pnpm --filter @liwencode/host build`）
 * 打包态：`process.resourcesPath/host/main.cjs`（见 electron-builder.yml 的 extraResources）
 */
const HOST_ENTRY = app.isPackaged
  ? path.join(process.resourcesPath, 'host', 'main.cjs')
  : path.join(__dirname, '../../../../packages/host/dist/main.cjs');

interface HostHandle {
  readonly port: number;
  readonly token: string;
  readonly workspaceRoot: string;
}

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let host: HostHandle | undefined;
let hostProcess: ReturnType<typeof spawn> | undefined;
/** 冒烟模式下渲染层是否已回报 ready（只用于避免重复打印）。 */
let smokeReady = false;
/** 主进程侧的凭据存储（钥匙串 / safeStorage）。**只有主进程能碰**。 */
const keychain = new KeychainStore();
/** 已物化的 SSH 临时密钥文件（Host 用完会请求删除；退出时兜底清理）。 */
const materializedKeys = new Set<string>();
/** 渲染层等待 Host 就绪的 Promise。 */
let hostReady: Promise<HostHandle> | undefined;
let resolveHost: ((h: HostHandle) => void) | undefined;
let rejectHost: ((e: Error) => void) | undefined;

hostReady = new Promise<HostHandle>((res, rej) => {
  resolveHost = res;
  rejectHost = rej;
});

// ── 单实例 ──────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

// ── Host 守护 ───────────────────────────────────────────────────────────

/**
 * 拉起 Host 进程。
 *
 * 用 `ELECTRON_RUN_AS_NODE=1` 让 `process.execPath`（Electron 二进制）
 * 以纯 Node 模式运行 Host 入口 —— 这样**不用**打包第二份 Node runtime，
 * 也天然保证内核的 Node 版本与 Electron 一致。
 */
function startHost(cwd: string): void {
  const child = spawn(
    process.execPath,
    [HOST_ENTRY, '--cwd', cwd, '--port', '0'],
    {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      // 第 4 个 'ipc' 槽是**必需的**：Host 用 `process.send({type:'ready'})`
      // 回报端口与令牌（`packages/host/src/main.ts`）。缺了它 `process.send`
      // 是 undefined，ready 帧被静默丢弃 → 窗口永远停在"正在连接本地运行时…"。
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  hostProcess = child;

  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    // 只保留尾部 64KB：崩溃诊断要够用，但不能无限占内存。
    const text = chunk.toString();
    stderrTail = (stderrTail + text).slice(-64 * 1024);
    if (!app.isPackaged) process.stderr.write(`[host:err] ${text}`);
  });

  const settle = (msg: unknown): void => {
    const m = msg as { type?: string; port?: number; token?: string; workspaceRoot?: string };
    if (m?.type === 'ready' && m.port !== undefined && m.token !== undefined) {
      if (host !== undefined) return; // 只接受第一帧 ready
      const handle: HostHandle = {
        port: m.port,
        token: m.token,
        workspaceRoot: m.workspaceRoot ?? cwd,
      };
      host = handle;
      console.log(`[main] host ready on port ${handle.port}`);
      installHostAuthHeader(handle);
      resolveHost?.(handle);
    }
  };

  // 首选通道：IPC（Host 的 ready 帧）。
  child.on('message', settle);

  // 凭据私有通道：Host 在执行 git 前按需取一次凭据。
  // **凭据不进 DHP**——只在这条父子进程 IPC 上单向传递，主进程负责脱敏与清理。
  child.on('message', (message: unknown) => {
    const request = message as {
      type?: string;
      id?: string;
      op?: string;
      entry?: string;
      value?: string;
      privateKey?: string;
      passphrase?: string;
      comment?: string;
      filePath?: string;
    };
    if (request?.type !== 'cred:request' || typeof request.id !== 'string') return;
    const respond = (ok: boolean, payload: { value?: unknown; error?: string } = {}): void => {
      try {
        child.send({ type: 'cred:response', id: request.id, ok, ...payload });
      } catch {
        /* 父进程正在退出时发送失败可忽略 */
      }
    };
    try {
      switch (request.op) {
        case 'available':
          respond(true, { value: keychain.available() });
          break;
        case 'get': {
          if (typeof request.entry !== 'string') throw new Error('missing entry');
          respond(true, { value: keychain.get(request.entry) ?? null });
          break;
        }
        case 'set': {
          if (typeof request.entry !== 'string' || typeof request.value !== 'string') throw new Error('missing entry/value');
          keychain.set(request.entry, request.value);
          respond(true, { value: true });
          break;
        }
        case 'delete': {
          if (typeof request.entry !== 'string') throw new Error('missing entry');
          keychain.delete(request.entry);
          respond(true, { value: true });
          break;
        }
        case 'import-ssh': {
          if (typeof request.entry !== 'string' || typeof request.privateKey !== 'string') throw new Error('missing key');
          const derived = publicKeyFromPrivate(request.privateKey, request.passphrase);
          keychain.set(request.entry, request.privateKey);
          keychain.setPublicKey(request.entry, derived.publicKey);
          respond(true, { value: { fingerprint: derived.fingerprint, keyType: 'ed25519' } });
          break;
        }
        case 'generate-ssh': {
          if (typeof request.entry !== 'string') throw new Error('missing entry');
          const generated = generateEd25519(request.comment ?? 'liwencode');
          keychain.set(request.entry, generated.privateKeyPem);
          keychain.setPublicKey(request.entry, generated.publicKey);
          respond(true, {
            value: { publicKey: generated.publicKey, fingerprint: generated.fingerprint, keyType: 'ed25519' },
          });
          break;
        }
        case 'materialize-ssh': {
          if (typeof request.entry !== 'string') throw new Error('missing entry');
          const pem = keychain.get(request.entry);
          if (pem === undefined) throw new Error('ssh key is not configured');
          const file = materializeSshKeyFile(pem);
          materializedKeys.add(file);
          respond(true, { value: file });
          break;
        }
        case 'dispose-ssh': {
          if (typeof request.filePath === 'string') {
            disposeSshKeyFile(request.filePath);
            materializedKeys.delete(request.filePath);
          }
          respond(true, { value: true });
          break;
        }
        default:
          respond(false, { error: `unknown credential operation: ${String(request.op)}` });
      }
    } catch (error) {
      // 只回错误类别，不回显任何密钥材料。
      respond(false, { error: redactKeyMaterial((error as Error).message) });
    }
  });

  // 开发期把 Host 的日志透传到终端 —— 否则"应用起来了但连不上"无从排查。
  // 顺带兼容"stdout 上一行裸 JSON"的旧握手方式（端口/令牌不经日志行泄露）。
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    if (!app.isPackaged) process.stdout.write(`[host] ${text}`);
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        settle(JSON.parse(trimmed));
      } catch {
        /* 非 JSON 行忽略 */
      }
    }
  });

  // Host 起不来时必须**大声失败**，不能让 UI 无限等待。
  const readyTimer = setTimeout(() => {
    if (host !== undefined) return;
    rejectHost?.(
      new Error(`Host 在 30s 内未报告 ready。stderr 尾部：\n${stderrTail.slice(-2000)}`),
    );
  }, 30_000);
  readyTimer.unref?.();

  child.on('exit', (code, signal) => {
    clearTimeout(readyTimer);
    hostProcess = undefined;
    host = undefined;
    const err = new Error(
      `Host exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}).\n${stderrTail}`,
    );
    rejectHost?.(err);
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('host:crashed', { code, signal, stderrTail });
    }
  });
}

/**
 * 给渲染层发往本地 Host 的 WebSocket 握手补上 `Authorization: Bearer`。
 *
 * 为什么必须在这里做：浏览器/渲染层的 `WebSocket` 构造器**不支持自定义请求头**
 * （`new WebSocket(url, { headers })` 在 Chromium 里直接抛 TypeError，第二个参数
 * 只接受子协议）。DHP 又硬性要求令牌走 header、不进 query string（`06` §3）。
 * 桥就在主进程的 session 层：请求头在发出前被注入，令牌既不出现在 URL 里，
 * 也不进渲染层的 JS 堆。
 */
function installHostAuthHeader(handle: HostHandle): void {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const target = new URL(details.url);
    if (target.protocol === 'ws:' && target.hostname === '127.0.0.1' && target.port === String(handle.port)) {
      callback({
        requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${handle.token}` },
      });
      return;
    }
    callback({});
  });
}


// ── 窗口 ────────────────────────────────────────────────────────────────

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'LIWENCode',
    backgroundColor: '#f7f8fc',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      // 沙箱三件套（`13-安全与隐私设计` §4）：
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  /**
   * 冒烟标记（仅当 `--headless-smoke` 传入时）。
   *
   * 用途：让 `scripts/smoke-electron.mjs` 能判定"窗口真的渲染完、渲染层真的连上了
   * Host"，而不是靠 sleep 猜。渲染层 ready 后经 preload 回报一次，主进程打标记。
   * 正常启动时完全不触发。
   */
  if (process.argv.includes('--headless-smoke')) {
    ipcMain.handle('smoke:renderer-ready', () => {
      if (!smokeReady) {
        smokeReady = true;
        console.log('SMOKE:READY');
      }
      return { ok: true };
    });
  }

  mainWindow.once('ready-to-show', () => {
    console.log('[main] window ready-to-show');
    mainWindow?.show();
  });
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (!app.isPackaged) console.log(`[renderer:${level}] ${message}`);
  });

  // 外链一律走系统浏览器；应用内禁止导航。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const protocol = new URL(url).protocol;
    if (protocol === 'https:' || protocol === 'http:') void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const dev = process.env['VITE_DEV_SERVER_URL'];
    if (dev !== undefined && url.startsWith(dev)) return;
    event.preventDefault();
  });

  const dev = process.env['VITE_DEV_SERVER_URL'];
  if (dev !== undefined) {
    await mainWindow.loadURL(dev);
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
}

// ── 托盘 ────────────────────────────────────────────────────────────────

function createTray(): void {
  // 没有图标资源时用空图标（macOS 上会显示为占位）。
  const image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip('LIWENCode');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示窗口',
        click: () => {
          if (mainWindow === undefined) void createWindow();
          else {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => {
    if (mainWindow !== undefined) mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}

// ── IPC（只暴露最小面）─────────────────────────────────────────────────

function registerIpc(): void {
  // 令牌仅由主进程注入，不进入 renderer。
  ipcMain.handle('host:info', async () => {
    if (hostReady === undefined) throw new Error('host not started');
    const h = await hostReady;
    return { port: h.port, workspaceRoot: h.workspaceRoot };
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
  }));

  /**
   * 在文件管理器中显示一个**工作区内的**文件（`27` §8.3 的产出操作之一）。
   *
   * 为什么要在主进程做：渲染层拿不到 `shell`。安全边界有两条：
   *  1. 只接受**相对路径**，并且在主进程里用 realpath 复核它确实落在工作区内
   *     （渲染层传什么都不能越界；Host 的围栏在这里再确认一次）；
   *  2. 不打开、不执行、不预览内容，只做"在文件夹里显示"。
   */
  ipcMain.handle('workspace:reveal', async (_event, payload: unknown) => {
    const request = payload as { path?: string; workspaceRoot?: string };
    const raw = typeof request?.path === 'string' ? request.path : '';
    if (raw === '' || path.isAbsolute(raw) || raw.split(/[\\/]/).includes('..')) {
      throw new Error('only workspace-relative paths can be revealed');
    }
    const root = host?.workspaceRoot;
    if (root === undefined) throw new Error('host is not ready');
    const absolute = path.resolve(root, raw);
    const [realRoot, realTarget] = await Promise.all([
      fs.realpath(root).catch(() => root),
      fs.realpath(absolute).catch(() => absolute),
    ]);
    if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error('path escapes the workspace');
    }
    try {
      await fs.access(realTarget);
    } catch {
      throw new Error('file no longer exists');
    }
    shell.showItemInFolder(realTarget);
    return { revealed: true };
  });

  /**
   * 用系统浏览器打开 http(s) 链接（只给白名单协议）。
   *
   * 唯一用途：Git 登录的浏览器授权（`27` §10.7.6 设备码流程）需要在浏览器里
   * 输入用户码。渲染层**不能**自己开窗口，也不能把任意协议交过来。
   */
  ipcMain.handle('app:openExternal', async (_event, payload: unknown) => {
    const request = payload as { url?: string };
    const raw = typeof request?.url === 'string' ? request.url : '';
    if (raw === '') throw new Error('missing url');
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error('invalid url');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('only http(s) links can be opened');
    }
    await shell.openExternal(parsed.toString());
    return { opened: true };
  });

  ipcMain.handle('dialog:openDirectory', async () => {
    if (mainWindow === undefined) return undefined;
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return r.canceled ? undefined : r.filePaths[0];
  });

  // ── 凭据（渲染层 → 主进程 → 钥匙串）──────────────────────────────────
  //
  // 渲染层**只能写、不能读**：令牌/私钥提交后立即离开渲染层，
  // 之后只能通过 Host 的私有 IPC 在执行 git 前取一次（`27` §10.7.4）。

  ipcMain.handle('credential:available', () => keychain.available());

  ipcMain.handle('credential:set', async (_event, payload: unknown) => {
    const request = payload as { remoteUrl?: string; method?: CredentialMethod; value?: string };
    if (typeof request?.value !== 'string' || request.value === '') throw new Error('missing credential value');
    const host_ = remoteHost(String(request.remoteUrl ?? '')) || 'local';
    keychain.set(credentialEntry(host_, request.method ?? 'token'), request.value);
    return { stored: true };
  });

  ipcMain.handle('credential:delete', async (_event, payload: unknown) => {
    const request = payload as { remoteUrl?: string; method?: CredentialMethod };
    const host_ = remoteHost(String(request.remoteUrl ?? '')) || 'local';
    keychain.delete(credentialEntry(host_, request.method ?? 'token'));
    return { cleared: true };
  });

  ipcMain.handle('credential:generate-ssh', async (_event, payload: unknown) => {
    const request = payload as { remoteUrl?: string; comment?: string };
    const host_ = remoteHost(String(request.remoteUrl ?? '')) || 'local';
    const entry = credentialEntry(host_, 'ssh-key');
    const generated = generateEd25519(request.comment ?? 'liwencode');
    keychain.set(entry, generated.privateKeyPem);
    keychain.setPublicKey(entry, generated.publicKey);
    // 只回公开值：私钥永远不离开主进程。
    return { publicKey: generated.publicKey, fingerprint: generated.fingerprint };
  });

  // ── Git 凭据窄桥（渲染层 → 主进程 → 钥匙串 → Host 私有 IPC）──────────
  //
  // 三条纪律（`27` §10.7 / §12）：
  //  1. 秘密**只进**钥匙串，返回值只有公开值（公钥 / 指纹 / 已保存）；
  //  2. 秘密**不进** DHP：渲染层根本不需要 DHP 的凭据写方法；
  //  3. 主进程只把"状态变了"这件事告诉 Host（`cred:changed`），
  //     Host 自己重新问一次 `git/auth/status`，元信息不靠消息携带。

  /** 告诉 Host：某个远端/方式的凭据状态变了（不带任何秘密）。 */
  const notifyCredentialChanged = (payload: {
    workspaceRoot?: string;
    remote?: string;
    url?: string;
    method: CredentialMethod | 'none';
  }): void => {
    try {
      hostProcess?.send({ type: 'cred:changed', ...payload });
    } catch {
      /* Host 正在退出时发送失败可忽略 */
    }
  };

  ipcMain.handle('git:credential:set-token', async (_event, payload: unknown) => {
    const request = payload as { workspaceRoot?: string; remote?: string; url?: string; token?: string };
    const token = typeof request?.token === 'string' ? request.token : '';
    // 空串与换行会污染钥匙串条目，必须拒绝（错误消息不回显令牌）。
    if (token.trim() === '' || /[\0\r\n]/.test(token)) throw new Error('invalid access token');
    const host_ = remoteHost(String(request?.url ?? '')) || 'local';
    keychain.set(credentialEntry(host_, 'token'), token);
    notifyCredentialChanged({
      method: 'token',
      ...(typeof request?.workspaceRoot === 'string' ? { workspaceRoot: request.workspaceRoot } : {}),
      ...(typeof request?.remote === 'string' ? { remote: request.remote } : {}),
      ...(typeof request?.url === 'string' ? { url: request.url } : {}),
    });
    return { stored: true };
  });

  ipcMain.handle('git:credential:clear', async (_event, payload: unknown) => {
    const request = payload as { workspaceRoot?: string; remote?: string; url?: string; method?: CredentialMethod };
    const host_ = remoteHost(String(request?.url ?? '')) || 'local';
    const methods: CredentialMethod[] = request?.method !== undefined
      ? [request.method]
      : ['token', 'ssh-key', 'oauth'];
    for (const method of methods) keychain.delete(credentialEntry(host_, method));
    notifyCredentialChanged({
      method: request?.method ?? 'none',
      ...(typeof request?.workspaceRoot === 'string' ? { workspaceRoot: request.workspaceRoot } : {}),
      ...(typeof request?.remote === 'string' ? { remote: request.remote } : {}),
      ...(typeof request?.url === 'string' ? { url: request.url } : {}),
    });
    return { cleared: true };
  });

  ipcMain.handle('git:credential:import-ssh', async (_event, payload: unknown) => {
    const request = payload as { workspaceRoot?: string; remote?: string; url?: string; privateKey?: string; passphrase?: string };
    if (typeof request?.privateKey !== 'string' || request.privateKey.trim() === '') throw new Error('missing private key');
    const host_ = remoteHost(String(request?.url ?? '')) || 'local';
    const entry = credentialEntry(host_, 'ssh-key');
    // 解析失败/口令错时抛错，**不**回显私钥或口令。
    const derived = publicKeyFromPrivate(request.privateKey, request.passphrase);
    keychain.set(entry, request.privateKey);
    keychain.setPublicKey(entry, derived.publicKey);
    notifyCredentialChanged({
      method: 'ssh-key',
      ...(typeof request?.workspaceRoot === 'string' ? { workspaceRoot: request.workspaceRoot } : {}),
      ...(typeof request?.remote === 'string' ? { remote: request.remote } : {}),
      ...(typeof request?.url === 'string' ? { url: request.url } : {}),
    });
    return { fingerprint: derived.fingerprint };
  });

  ipcMain.handle('git:credential:use-ssh-agent', async (_event, payload: unknown) => {
    const request = payload as { workspaceRoot?: string; remote?: string; url?: string };
    // 只探测系统 agent 里的公钥；私钥从头到尾没离开过 agent。
    const publicKey = await new Promise<string>((resolve, reject) => {
      execFile('ssh-add', ['-L'], { timeout: 5_000 }, (error, stdout) => {
        if (error !== null) reject(new Error('no SSH agent identity is available'));
        else resolve(String(stdout).trim());
      });
    });
    if (publicKey === '') throw new Error('no SSH agent identity is available');
    const first = publicKey.split('\n')[0] ?? '';
    const fingerprint = `SHA256:${createHash('sha256').update(first).digest('base64').replace(/=+$/, '')}`;
    notifyCredentialChanged({
      method: 'ssh-agent',
      ...(typeof request?.workspaceRoot === 'string' ? { workspaceRoot: request.workspaceRoot } : {}),
      ...(typeof request?.remote === 'string' ? { remote: request.remote } : {}),
      ...(typeof request?.url === 'string' ? { url: request.url } : {}),
    });
    return { publicKey, fingerprint };
  });

  ipcMain.handle('credential:import-ssh', async (_event, payload: unknown) => {
    const request = payload as { remoteUrl?: string; privateKey?: string; passphrase?: string };
    if (typeof request?.privateKey !== 'string' || request.privateKey === '') throw new Error('missing private key');
    const host_ = remoteHost(String(request.remoteUrl ?? '')) || 'local';
    const entry = credentialEntry(host_, 'ssh-key');
    const derived = publicKeyFromPrivate(request.privateKey, request.passphrase);
    keychain.set(entry, request.privateKey);
    keychain.setPublicKey(entry, derived.publicKey);
    return { fingerprint: derived.fingerprint };
  });
}

// ── 生命周期 ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  registerIpc();
  createTray();
  startHost(process.cwd());
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS 惯例：关窗口不退出。但**必须**停掉 Host，否则留下孤儿进程。
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // 先让 Host 干净退出（落盘会话、flush 审计链），再退。
  hostProcess?.kill('SIGTERM');
  // 兜底清理推送期间物化的 SSH 临时私钥（正常路径 Host 用完即删）。
  for (const file of materializedKeys) disposeSshKeyFile(file);
  materializedKeys.clear();
});

// 深链接：`liwencode://run?prompt=...`
app.on('open-url', (event, url) => {
  event.preventDefault();
  mainWindow?.webContents.send('app:deeplink', url);
});
