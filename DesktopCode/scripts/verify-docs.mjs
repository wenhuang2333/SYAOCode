#!/usr/bin/env node
/**
 * 文档与代码的**数字与引用**核对（`doc/DesktopDoc/26`、`27`）。
 *
 * 为什么需要它：这些登记册里有大量「✅ 已实现 + 引用某测试文件 + 某个数量」的断言。
 * 数字一旦漂移，读文档的人对系统的判断就是错的——而这个仓库已经发生过两次：
 *   - 测试数还写着 671，实际早已 714；
 *   - 错误码还写着 47 个（到 -32046），实际加了 `command_denied` 后是 48 个（到 -32047）。
 * 人工核对每轮都要重做一遍，还容易漏。所以把它变成可复跑的检查。
 *
 * 检查三类：
 *   1. **引用真实存在**：文档里反引号引用的 `.ts/.tsx/.mjs` 文件必须找得到；
 *   2. **数字与代码一致**：错误码数、事件类型数、语义令牌数、视口组合数、
 *      主题样点数、KPI 数、详情分区数、权限档位数；
 *   3. **不留过时措辞**：当前状态表里不得再出现"尚未抽取"这类已完成事项的说法。
 *
 * 文档是**本地文件**（`doc/` 被 .gitignore 拦截，不进公开仓库），
 * 所以文档不存在时**跳过**并 exit 0——脚本要能在干净克隆里跑。
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC_DIR = path.resolve(ROOT, '..', 'doc', 'DesktopDoc');
const DOC26 = path.join(DOC_DIR, '26-实施状态与差距登记册.md');
const DOC27 = path.join(DOC_DIR, '27-功能增补需求与实施清单.md');

if (!existsSync(DOC26) || !existsSync(DOC27)) {
  console.log('SKIP: doc/DesktopDoc not present (it is local-only and not published).');
  process.exit(0);
}

const DESKTOP = ROOT;
const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
};

const [doc26, doc27] = await Promise.all([readFile(DOC26, 'utf8'), readFile(DOC27, 'utf8')]);

/** 建立文件名 → 路径索引（跳过 node_modules / dist）。 */
async function buildIndex(dir, index = new Map()) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await buildIndex(full, index);
    else if (!index.has(entry.name)) index.set(entry.name, full);
  }
  return index;
}
const index = await buildIndex(DESKTOP);
// 文档也会引用内核（`code/`）里的文件——那是只读的另一个仓库，但同样是证据。
const KERNEL = path.resolve(ROOT, '..', 'code');
if (existsSync(KERNEL)) await buildIndex(KERNEL, index);

// ── 1) 引用必须真实存在 ────────────────────────────────────────────────
const cited = new Set();
for (const doc of [doc26, doc27]) {
  for (const m of doc.matchAll(/`([^`]+\.(?:ts|tsx|mjs))`/g)) {
    const token = m[1];
    // 跳过通配符（`*.mjs`）与泛指（`.ts` / `.tsx`）——它们不是具体引用。
    if (token.includes('*') || token === '.ts' || token === '.tsx') continue;
    cited.add(token);
  }
}
const WORKSPACE = path.resolve(ROOT, '..');
const missing = [...cited].filter((token) => {
  if (!token.includes('/')) return !index.has(token);
  const candidates = [
    // 相对工作区根（`reference/...`）
    path.join(WORKSPACE, token),
    // 相对 DesktopCode 根（`scripts/...`）
    path.join(ROOT, token),
    // 相对某个包（`dhp/test/x.test.ts` → packages/dhp/test/x.test.ts）
    ...['dhp', 'host', 'client', 'ui'].map((pkg) => path.join(ROOT, 'packages', pkg, token.replace(/^[^/]+\//, ''))),
    path.join(ROOT, 'apps', 'desktop', token),
  ];
  return !candidates.some((candidate) => existsSync(candidate)) && !index.has(path.basename(token));
});
check('文档引用的文件都真实存在', missing.length === 0, missing.slice(0, 5).join(', '));

// ── 2) 数字与代码一致 ──────────────────────────────────────────────────
const read = async (rel) => readFile(path.join(DESKTOP, rel), 'utf8');

const countErrorCodes = (await read('packages/dhp/src/errors.ts')).match(/\{ code: -32\d{3}, kind:/g)?.length ?? 0;
const errorSpec = await read('packages/dhp/src/errors.ts');
// 错误码是负的：`-32000` 是**下限**（绝对值最小），`-32047` 是最大值。
// 文档写的是"（-32047…-32000）"，所以要比的是**绝对值最大**的那个。
const codeAbs = [...errorSpec.matchAll(/code: (-32\d{3})/g)].map((m) => Math.abs(Number(m[1])));
const maxCode = Math.max(...codeAbs);

// 只数 `SessionDelta` 这个联合类型里的 `type:`，不要把 preview / row 的 type 也算进来。
const projectionSrc = await read('packages/dhp/src/projection.ts');
// 19 类"事件"指的是 `SessionEvent` 这个联合类型的成员
// （`SessionDelta` 只是包了一层 events 数组）。
const eventBlock = projectionSrc.match(/export type SessionEvent =([\s\S]*?\n\s*\};)/)?.[1] ?? '';
const eventKinds = new Set(eventBlock.match(/type: '[a-z.]+'/g) ?? []).size;

const tokens = new Set((await read('apps/desktop/src/renderer/theme-tokens.css')).match(/--sy-[a-z0-9-]+\s*:/g) ?? []).size;

const layoutSrc = await read('scripts/verify-layout.mjs');
const widths = layoutSrc.match(/for \(const width of \[([^\]]+)\]/)?.[1].split(',').length ?? 0;
const rails = layoutSrc.match(/for \(const rail of \[([\s\S]*?)\]\]\)/)?.[1].match(/\['[a-z]+'/g)?.length ?? 0;

const themeSrc = await read('scripts/verify-theme.mjs');
const samples = themeSrc.match(/const SAMPLES = \[([\s\S]*?)\n\];/)?.[1].match(/'.*?'/g)?.length ?? 0;

const usageSrc = await read('apps/desktop/src/renderer/usage-page.tsx');
// `stats` 是一个数组字面量，每项有一个 `label:`；数到数组结束（`\n  ];`）。
const statsBlock = usageSrc.match(/const stats[^=]*=\s*\[([\s\S]*?)\n\s*\];/)?.[1] ?? '';
const kpis = (statsBlock.match(/label:/g) ?? []).length;

const detailSrc = await read('apps/desktop/src/renderer/detail-panel.tsx');
const sections = detailSrc.match(/SECTION_IDS[^=]*=\s*\[([\s\S]*?)\]/)?.[1].match(/'/g)?.length ?? 0;
const sectionCount = sections / 2;

const modes = new Set((await read('packages/dhp/src/workbench.ts')).match(/'(plan|strict|default|acceptEdits|bypass)'/g) ?? []).size;

const claims = [
  ['错误码数', /\*\*(\d+) 个错误码\*\*/  , countErrorCodes],
  ['错误码上限', /（`-(\d{5})…-32000`）/, Math.abs(maxCode)],
  ['事件类型数', /(\d+) 类事件穷尽性/, eventKinds],
  ['语义令牌数', /语义令牌层 (\d+) 个/, tokens],
  ['视口组合数', /(\d+) 组视口/, widths * rails],
  ['主题样点数', /(\d+) 样点达/, samples],
  ['用量 KPI 数', /用量页 (\d+) 项 KPI/, kpis],
  ['详情分区数', /会话详情 (\d+) 分区/, sectionCount],
  ['视口档数', /(\d+) 档视口/, widths],
  ['右栏状态数', /(\d+) 种右栏状态/, rails],
];
for (const [label, pattern, actual] of claims) {
  const found = doc26.match(pattern) ?? doc27.match(pattern);
  if (found === null) {
    check(`${label}：文档里有该声明`, false, '未找到匹配的声明');
    continue;
  }
  const claimed = Number(found[1]);
  check(`${label} 与代码一致`, claimed === actual, `文档 ${claimed} / 代码 ${actual}`);
}

// ── 3) 当前状态表里不得留过时措辞 ──────────────────────────────────────
// 已完成的事项若在**现状表**里还写着"尚未/未抽取"，读者会误判进度。
const staleWording = [
  [/剩余：\d+ 条中文文案尚未抽取/, '文案抽取已完成的过时描述'],
  [/未启用自动压缩（?未实现）/, '上下文压缩的过时描述'],
];
for (const [pattern, label] of staleWording) {
  check(`无过时措辞：${label}`, !pattern.test(doc26), '');
}

// ── 4) 两个文档的测试数必须一致（历史上漂移过）─────────────────────────
const counts26 = [...doc26.matchAll(/\*\*(\d+) (?:例|测试)?全绿|\*\*(\d+) 个，全部通过/g)].map((m) => Number(m[1] ?? m[2]));
const counts27 = [...doc27.matchAll(/\*\*(\d+) 测试全绿/g)].map((m) => Number(m[1]));
const uniq26 = [...new Set(counts26)];
const uniq27 = [...new Set(counts27)];
if (uniq26.length > 0 && uniq27.length > 0) {
  check('两份文档的测试数一致', JSON.stringify(uniq26) === JSON.stringify(uniq27), `26: ${uniq26} / 27: ${uniq27}`);
  // 诚实说明边界：这里只保证两份文档**互相一致**，不保证等于**实际运行数**——
  // 那需要跑一遍 `pnpm test`，属于测试套件自己的事（它的输出就是权威）。
  console.log(`NOTE: 两份文档都写 ${uniq26.join('/')}；与真实运行数的核对由 \`pnpm test\` 的输出负责。`);
} else {
  console.log('NOTE: 未从两份文档中解析出测试数，跳过一致性检查。');
}


// ── 5) 缺口清单不得与代码现状矛盾（双向）────────────────────────────────
//
// 登记册写错方向同样误导人：把**已完成**的事写成未完成，会让读者以为还有工作，
// 也会让我自己在汇报时低估进度（N-9 OAuth 界面、N-15 提交信息联调都曾如此）。
//
// 这里用**代码谓词**做双向核对：
//   谓词成立 → 该条必须是**已关闭**（标题划掉）
//   谓词不成立 → 该条必须是**未关闭**（否则就是虚报完成）
// 每条都写明"凭什么"，不用关键词模糊匹配（那会把 N-1 误报成矛盾）。
const gapRow = (id) => doc26.split('\n').find((line) => line.startsWith(`| ${id} |`)) ?? '';
const isClosed = (id) => gapRow(id).includes('~~');
const hasText = async (rel, needle) => {
  try { return (await read(rel)).includes(needle); } catch { return false; }
};

const GAP_EVIDENCE = [
  ['N-9', 'OAuth 设备码界面已接线', async () =>
    (await hasText('apps/desktop/src/renderer/git-sidebar.tsx', 'onOauthStart'))
    && (await hasText('apps/desktop/src/renderer/use-workbench.ts', 'gitOauthStart'))],
  ['N-15', '提交信息已用真实模型联调', async () => index.has('verify-real-commit-message.mjs')],
  ['N-19', '真实窗口 + 真实模型已验证', async () => index.has('verify-real-window.mjs')],
  ['N-22', '真实用量口径已验证', async () => index.has('verify-real-usage.mjs')],
  ['N-20', '界面文案已抽取到目录', async () => index.has('i18n-views.ts')],
];

for (const [id, label, predicate] of GAP_EVIDENCE) {
  if (gapRow(id) === '') {
    check(`缺口 ${id} 仍在清单里（或已删除）`, false, '找不到该行——删条目时请同步删除本核对');
    continue;
  }
  const evidence = await predicate();
  const closed = isClosed(id);
  const agree = evidence === closed;
  check(
    `缺口 ${id} 的状态与代码一致（${label}）`,
    agree,
    // 只有不一致时才解释，否则"通过"却打印失败措辞会误导读者。
    agree ? '' : evidence ? '代码已具备，登记册却仍标未完成' : '代码不具备，登记册却已标完成',
  );
}

console.log(failures.length === 0 ? '\nDOCS: OK' : `\nDOCS: ${failures.length} check(s) failed`);
process.exit(failures.length === 0 ? 0 : 1);
