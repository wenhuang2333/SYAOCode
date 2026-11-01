#!/usr/bin/env node
/**
 * 只启动 Host（不启动窗口）。
 *
 * 这是调试 DHP 协议最方便的方式：EventListener 少、日志直接可见、
 * 可以用任意 WebSocket 客户端（curl/脚本/测试）连上来。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const child = spawn(
  process.execPath,
  [path.join(root, 'packages/host/dist/main.cjs'), '--cwd', process.cwd(), '--port', '0'],
  // 显式清掉 ELECTRON_RUN_AS_NODE：本脚本用的是真 Node，
  // 但开发机上该变量常被全局设置，会干扰判断。
  { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } },
);
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
