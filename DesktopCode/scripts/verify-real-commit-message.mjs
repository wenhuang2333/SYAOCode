#!/usr/bin/env node
/**
 * 真实模型生成提交信息（`27` §4.3 FR-N-026 / `26` N-15）。
 *
 * 为什么必须用真实模型：这个功能的**全部价值**在于模型能读懂 diff 并写出人话。
 * mock / 单元测试只能验证"输出被清洗成什么形状"，证明不了"模型真的能产出可用的
 * commit message"。而清洗逻辑再严，模型输出不可用也是白搭。
 *
 * 同时验证**降级路径**：模型不可用时必须回退到确定性的兜底文案，
 * 绝不能让界面卡住或显示空串。
 *
 * 用法：
 *   REAL_API_KEY=... REAL_BASE_URL=https://... REAL_MODEL=... \
 *     node --import tsx scripts/verify-real-commit-message.mjs
 *
 * 缺环境变量时**跳过**并 exit 0，绝不打印通过。密钥只经进程环境传递。
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const KEY = process.env['REAL_API_KEY'] ?? '';
const BASE = process.env['REAL_BASE_URL'] ?? '';
const MODEL = process.env['REAL_MODEL'] ?? '';

if (KEY === '' || BASE === '' || MODEL === '') {
  console.log('SKIP: set REAL_API_KEY, REAL_BASE_URL and REAL_MODEL.');
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

const { createHost } = await import(path.join(ROOT, 'packages/host/src/host.ts'));
const { DhpConnection } = await import(path.join(ROOT, 'packages/client/src/index.ts'));
const hostRequire = createRequire(path.join(ROOT, 'packages/host/package.json'));
const WS = hostRequire('ws');

/** 造一个真实的 git 仓库：暂存一个可读懂的改动，供模型生成信息。 */
async function makeRepo() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'syao-commit-')));
  const git = (args) => run('git', args, { cwd: dir });
  await git(['init', '-q']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(dir, 'calc.ts'), 'export function add(a: number, b: number): number {\n  return a - b;\n}\n');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'init']);
  // 一个语义清晰的修复：把减号改成加号（模型应该能看出是 fix）。
  await writeFile(path.join(dir, 'calc.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  await git(['add', '.']);
  return dir;
}

const home = await mkdtemp(path.join(os.tmpdir(), 'syao-commit-home-'));
const repo = await makeRepo();
const env = { ...process.env, SYAOCODE_HOME: home };

let host;
let conn;
try {
  host = await createHost({
    workspaceRoot: repo,
    env: {
      ...env,
      // 密钥只进进程环境，不进状态文件、不进日志。
      OPENAI_API_KEY: KEY,
      OPENAI_BASE_URL: BASE,
    },
    logger: () => {},
  });
  conn = new DhpConnection({
    url: host.server.url,
    token: host.server.token,
    clientName: 'verify-commit-message',
    socketFactory: (url, token) => new WS(url, { headers: { authorization: `Bearer ${token}` } }),
  });
  await conn.connect();

  await conn.request('channel/save', {
    id: 'live', name: 'Live', protocol: 'openai-compatible',
    baseUrl: BASE, apiKeyEnv: 'OPENAI_API_KEY',
    models: [{ id: MODEL, name: MODEL }],
  });
  await conn.request('config/set', { key: 'model', value: `live:${MODEL}` });

  // ── 1) 真实模型生成 ────────────────────────────────────────────────
  const started = Date.now();
  const generated = await conn.request('git/commit-message', { workspaceRoot: repo, scope: 'staged' });
  const elapsed = Date.now() - started;

  const message = String(generated?.message ?? '');
  // 结果里的字段名是 `reason`（`source='fallback'` 时才有值），不是 fallbackReason。
  const reason = generated?.reason ?? null;
  console.log('RAW RESULT =', JSON.stringify(generated).slice(0, 300));
  check('模型返回了提交信息（不是兜底）', reason === null, reason === null ? `${elapsed} ms` : `fallback: ${reason}`);
  check('首行是 Conventional Commits 格式', /^(feat|fix|refactor|perf|test|docs|build|chore|ci|style|revert)(\([\w./-]+\))?: .+/.test(message.split('\n')[0] ?? ''), message.split('\n')[0] ?? '(empty)');
  check('首行不超过 72 字符', (message.split('\n')[0] ?? '').length <= 72, `${(message.split('\n')[0] ?? '').length} 字符`);
  check('没有代码围栏 / git 命令包裹', !message.includes('```') && !message.includes('git commit'), '');
  check('内容确实在描述改动（含 add/加法/修复类语义之一）', /add|addition|fix|bug|correct|加|修复|求和/i.test(message), message.split('\n')[0] ?? '');

  // ── 2) 降级路径：模型不可用必须回退，不能抛错或返回空 ────────────────
  await conn.request('config/set', { key: 'model', value: 'mock:default' });
  const fallback = await conn.request('git/commit-message', { workspaceRoot: repo, scope: 'staged' });
  const fallbackMessage = String(fallback?.message ?? '');
  check('模型不可用时不抛错且给出兜底信息', fallbackMessage.length > 0, fallbackMessage.split('\n')[0] ?? '(empty)');
  check('兜底信息也符合 Conventional Commits', /^(feat|fix|refactor|perf|test|docs|build|chore|ci|style|revert)(\([\w./-]+\))?: .+/.test(fallbackMessage.split('\n')[0] ?? ''), fallbackMessage.split('\n')[0] ?? '');

  console.log(`\n生成耗时 ${elapsed} ms`);
  console.log('生成的信息:\n---8<---');
  console.log(message);
  console.log('---8<---');
  console.log('兜底的信息:', fallbackMessage.split('\n')[0]);
} catch (error) {
  check('真实模型生成提交信息', false, String(error).split('\n')[0]);
} finally {
  await conn?.close?.();
  await host?.close?.();
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
  await rm(repo, { recursive: true, force: true }).catch(() => undefined);
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? '\nCOMMIT MESSAGE: OK' : `\nCOMMIT MESSAGE: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
