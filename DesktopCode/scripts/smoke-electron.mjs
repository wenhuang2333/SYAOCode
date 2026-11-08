#!/usr/bin/env node
/**
 * 真实 Electron 启动冒烟（`26` §1 的"已验证"必须来自真实进程，不是静态渲染）。
 *
 * 检查的是一条**端到端链路**，每一环都可能独立失败：
 *   1. 主进程能起来；
 *   2. 它能 spawn Host 子进程，Host 在 127.0.0.1 监听（端口由系统分配）；
 *   3. 窗口能创建并渲染完；
 *   4. 渲染层通过 preload 连上 DHP，握手成功（ready）并回报给主进程；
 *   5. 状态目录真的写到了隔离的 HOME 下（不污染真实用户数据）。
 *
 * 这就是"文档说能启动"与"实际能启动"之间的差距所在：`dev-desktop.mjs` 只负责
 * 把进程拉起来，退出码 0 并不能说明窗口连上了 Host（窗口停在"正在连接本地运行时…"
 * 时进程同样活着）。所以这里必须有**正向标记**才算通过。
 *
 * 用法：
 *   node scripts/smoke-electron.mjs
 *   LIWEN_ELECTRON_BIN=/path/to/Electron node scripts/smoke-electron.mjs
 *
 * 没装 Electron 二进制时跳过并以 0 退出，且绝不打印通过。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'apps/desktop');

/** 解析 Electron 可执行文件；在纯 Node 中 `require('electron')` 返回二进制绝对路径。 */
function resolveElectron() {
  if (process.env['LIWEN_ELECTRON_BIN'] !== undefined) return process.env['LIWEN_ELECTRON_BIN'];
  try {
    const req = createRequire(path.join(APP, 'package.json'));
    const bin = req('electron');
    if (typeof bin === 'string') return bin;
  } catch {
    /* 落到下面的候选路径 */
  }
  return undefined;
}

const bin = resolveElectron();
if (bin === undefined) {
  console.log('SKIP: electron binary not found. Install dev deps or set LIWEN_ELECTRON_BIN.');
  process.exit(0);
}

// 冒烟必须跑在**构建产物**上（`dist/main/index.js`），否则测的是 TS 源。
const mainEntry = path.join(APP, 'dist/main/index.js');
try {
  await readFile(mainEntry);
} catch {
  console.log('SKIP: apps/desktop/dist/main/index.js missing. Run `pnpm build` first.');
  process.exit(0);
}

const home = await mkdtemp(path.join(os.tmpdir(), 'liwen-smoke-'));
const env = { ...process.env, HOME: home, LIWEN_HOME: home, ELECTRON_ENABLE_LOGGING: '1' };
// 关键：不清掉会让 Electron 以纯 Node 模式运行，`require('electron')` 返回 undefined。
delete env['ELECTRON_RUN_AS_NODE'];

const child = spawn(bin, ['.', '--headless-smoke'], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (chunk) => { log += String(chunk); });
child.stderr.on('data', (chunk) => { log += String(chunk); });

let exited;
child.on('exit', (code, signal) => { exited = { code, signal }; });

const DEADLINE_MS = 90_000;
const started = Date.now();
let ready = false;
while (Date.now() - started < DEADLINE_MS && exited === undefined) {
  if (log.includes('SMOKE:READY')) { ready = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 400));
}
const elapsed = Date.now() - started;

// 收尾：先礼后兵。
if (exited === undefined) {
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  if (exited === undefined) child.kill('SIGKILL');
}

/** 每一项都从日志里找**正向证据**；缺证据就是失败，不做"大概跑起来了"的推断。 */
const checks = [
  ['主进程启动了 Host 子进程', /\[main\] host ready on port \d+/],
  ['Host 在回环地址监听', /dhp: listening \{"host":"127\.0\.0\.1","port":\d+\}/],
  ['窗口创建并渲染完成', /\[main\] window ready-to-show/],
  ['WebSocket 连接已打开', /dhp: connection open/],
  ['DHP 握手完成并声明能力', /dhp: hello \{"conn":"conn_1","client":"liwencode-desktop","capabilities":\d+\}/],
  ['渲染层连上 Host 并回报 ready', /SMOKE:READY/],
];

let failures = 0;
for (const [label, pattern] of checks) {
  const ok = pattern.test(log);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
}

// 状态目录必须落在隔离的 HOME 下：证明没有污染真实用户数据。
const stateDir = await readdir(path.join(home, '.liwencode')).catch(() => []);
const isolated = stateDir.includes('desktop');
if (!isolated) failures += 1;
console.log(`${isolated ? 'PASS' : 'FAIL'} 状态写入隔离 HOME（${stateDir.join(', ') || '无'}）`);

if (failures > 0) {
  console.log('\n--- 启动日志尾部 ---');
  console.log(log.split('\n').filter(Boolean).slice(-40).join('\n'));
}

await rm(home, { recursive: true, force: true }).catch(() => undefined);

console.log(`\n启动耗时 ${elapsed} ms`);
console.log(failures === 0 ? 'SMOKE: OK (electron → host → dhp → renderer)' : `SMOKE: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
