/**
 * Electron 主进程：窗口、托盘、单实例、深链接，以及 **Host 进程的守护**。
 *
 * 三条硬规则（`00-基线` §6.3 / §7.3.2）：
 *  1. 主进程**不含业务逻辑**——它只负责拉起并守护 Host。
 *  2. Host 用 `utilityProcess` 以 **`ELECTRON_RUN_AS_NODE=1`** 启动
 *     （用 Electron 自带的 Node，不额外打包 Node）。
 *  3. `electronFuses.runAsNode` **必须保持启用** —— 关掉后 Host 起不来，
 *     且报错极其晦涩。这是 Fuses 里唯一一个不能碰的开关。
 */

import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } from 'electron';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

/**
 * Host 入口。
 *
 * 开发态：`packages/host/dist/main.cjs`（先跑 `pnpm --filter @syaocode/host build`）
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
      stdio: ['ignore', 'pipe', 'pipe'],
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
  // 开发期把 Host 的日志透传到终端 —— 否则"应用起来了但连不上"无从排查。
  if (!app.isPackaged) {
    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[host] ${chunk.toString()}`));
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    // Host 用一行 JSON 回报 ready。
    const line = chunk.toString().trim();
    if (!line.startsWith('{')) return;
    try {
      const msg = JSON.parse(line) as { type?: string; port?: number; token?: string; workspaceRoot?: string };
      if (msg.type === 'ready' && msg.port !== undefined && msg.token !== undefined) {
        console.log(`[main] host ready on port ${msg.port}`);
        resolveHost?.({
          port: msg.port,
          token: msg.token,
          workspaceRoot: msg.workspaceRoot ?? cwd,
        });
      }
    } catch {
      /* 非 JSON 行忽略 */
    }
  });

  child.on('exit', (code, signal) => {
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

// ── 窗口 ────────────────────────────────────────────────────────────────

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'SYAOCode',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      // 沙箱三件套（`13-安全与隐私设计` §4）：
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    console.log('[main] window ready-to-show');
    mainWindow?.show();
  });
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (!app.isPackaged) console.log(`[renderer:${level}] ${message}`);
  });

  // 外链一律走系统浏览器；应用内禁止导航。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
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
  tray.setToolTip('SYAOCode');
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
  // 渲染层拿 Host 的连接信息。**只给端口与令牌**，不给文件系统能力。
  ipcMain.handle('host:info', async () => {
    if (hostReady === undefined) throw new Error('host not started');
    const h = await hostReady;
    return { port: h.port, token: h.token, workspaceRoot: h.workspaceRoot };
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
  }));

  ipcMain.handle('dialog:openDirectory', async () => {
    if (mainWindow === undefined) return undefined;
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return r.canceled ? undefined : r.filePaths[0];
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
});

// 深链接：`syaocode://run?prompt=...`
app.on('open-url', (event, url) => {
  event.preventDefault();
  mainWindow?.webContents.send('app:deeplink', url);
});
