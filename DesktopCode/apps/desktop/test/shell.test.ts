/**
 * Electron 壳的**静态**校验。
 *
 * 这里不启动 Electron（那需要真实显示器与签名环境），而是断言那些
 * "错了会在打包后才炸"的配置项：
 *  - `electronFuses.runAsNode` 必须启用（否则 Host 起不来）
 *  - preload 必须是 CJS（sandbox: true 不支持 ESM preload）
 *  - sandbox / contextIsolation 必须为 true
 *  - asarUnpack 必须包含原生模块
 *
 * 这些断言的价值：它们在 CI 里几秒就能跑，而对应的故障在打包后极难定位。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('Electron 壳配置', () => {
  it('webPreferences 三件套正确（sandbox / contextIsolation / nodeIntegration）', () => {
    const main = read('src/main/index.ts');
    expect(main).toMatch(/contextIsolation:\s*true/);
    expect(main).toMatch(/nodeIntegration:\s*false/);
    expect(main).toMatch(/sandbox:\s*true/);
  });

  it('Host 用 ELECTRON_RUN_AS_NODE 启动（不打包第二份 Node）', () => {
    const main = read('src/main/index.ts');
    expect(main).toContain('ELECTRON_RUN_AS_NODE');
  });

  it('preload 构建为 CJS（sandbox 下 ESM preload 不可用）', () => {
    const cfg = read('electron.vite.config.ts');
    expect(cfg).toMatch(/formats:\s*\['cjs'\]/);
    expect(cfg).toContain('index.cjs');
  });

  it('preload 只暴露窄接口，不暴露 ipcRenderer 本身', () => {
    const preload = read('src/preload/index.ts');
    expect(preload).toContain('contextBridge.exposeInMainWorld');
    expect(preload).not.toMatch(/exposeInMainWorld\(\s*'[^']+'\s*,\s*ipcRenderer\s*\)/);
  });

  it('asarUnpack 包含原生模块（否则运行时 dlopen 失败）', () => {
    const yml = read('electron-builder.yml');
    expect(yml).toContain('asarUnpack');
    expect(yml).toContain('node-pty');
  });

  it('渲染层 CSP 禁止 eval 且只允许连回环', () => {
    const html = read('src/renderer/index.html');
    expect(html).toContain('Content-Security-Policy');
    expect(html).not.toContain("'unsafe-eval'");
    expect(html).toContain('ws://127.0.0.1:');
  });

  it('单实例锁存在（防双开抢同一数据目录）', () => {
    const main = read('src/main/index.ts');
    expect(main).toContain('requestSingleInstanceLock');
  });

  it('退出前终止 Host（防孤儿进程）', () => {
    const main = read('src/main/index.ts');
    expect(main).toMatch(/before-quit/);
    expect(main).toContain('SIGTERM');
  });
});

describe('Host 打包产物', () => {
  it('build.mjs 外部化 node 内置与原生模块', () => {
    const b = fs.readFileSync(path.resolve(ROOT, '../../packages/host/build.mjs'), 'utf8');
    expect(b).toContain("external: ['node:*', 'node-pty', 'electron']");
    expect(b).toContain("format: 'cjs'");
  });
});
