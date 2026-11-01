/**
 * 把 Host 打成单文件 CJS。
 *
 * 为什么必须打包：打包后的 app 里没有 `node_modules`（只有 asar），
 * 所以 Host 入口必须是一个自包含的 JS 文件。
 *
 * 外部化：Node 内置模块（`node:*`）与原生模块（`node-pty`）
 * —— 后者由 electron-builder 的 `asarUnpack` 提供。
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, 'src/main.ts')],
  outfile: path.join(here, 'dist/main.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  // node 内置模块不打包；原生模块也不打包。
  external: ['node:*', 'node-pty', 'electron'],
  logLevel: 'info',
});
