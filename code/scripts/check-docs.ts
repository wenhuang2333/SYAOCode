#!/usr/bin/env tsx
/**
 * DesktopDoc 文档集校验（`lint:docs`）
 *
 * 把 `24-需求评审与变更控制流程.md` §4.1 的通用检查项 U3/U4/U6/U7/U8/U1/U2
 * 变成可执行断言。本脚本**只读** DesktopDoc/ 与工作区，不修改任何文件。
 *
 * 用法：
 *   corepack pnpm exec tsx scripts/check-docs.ts            # 人类可读输出
 *   corepack pnpm exec tsx scripts/check-docs.ts --json     # 机器可读
 *
 * 退出码：0 = 全部通过；1 = 有 error；2 = 用法错误。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const DOC_DIR = path.resolve(process.cwd(), 'DesktopDoc');
const REPO_ROOT = path.resolve(process.cwd());

/**
 * DesktopDoc 在工作区根目录，而本脚本在 `code/scripts/` 下。
 * 从 `code/` 运行时向上找一层；也可显式用 `LIWENCODE_DOCS_DIR` 覆盖。
 */
function resolveDocDir(): string | undefined {
  const fromEnv = process.env['LIWENCODE_DOCS_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') {
    const abs = path.resolve(process.cwd(), fromEnv);
    return fs.existsSync(abs) ? abs : undefined;
  }
  for (const base of [process.cwd(), path.resolve(process.cwd(), '..')]) {
    const abs = path.join(base, 'DesktopDoc');
    if (fs.existsSync(abs)) return abs;
  }
  return undefined;
}

const resolvedDocDir = resolveDocDir();
if (resolvedDocDir === undefined) {
  process.stderr.write('docs: directory not found (looked in ./DesktopDoc and ../DesktopDoc)\n');
  process.stderr.write('docs: set LIWENCODE_DOCS_DIR to point at the document directory\n');
  process.exit(2);
}
const DOC_DIR_FINAL = resolvedDocDir;
const REPO_ROOT_FINAL = path.dirname(DOC_DIR_FINAL);

// ── 编号族定义：编号 → { 定义文档, 正则 } ──────────────────────────────
// 与 00-基线 §10.1 的编号体系一一对应；号段归属见 00 §13 与 24 §5.3。
interface Family {
  readonly label: string;
  readonly home: string;
  readonly pattern: RegExp;
}

const FAMILIES: readonly Family[] = [
  { label: 'FR-D', home: '02-桌面端需求规格说明书.md', pattern: /FR-D-\d{3,4}/g },
  { label: 'NFR-D', home: '02-桌面端需求规格说明书.md', pattern: /NFR-D-\d{3,4}/g },
  { label: 'DD-D', home: '05-详细设计说明书.md', pattern: /DD-D-\d{3}/g },
  { label: 'TC-D', home: '11-测试计划与验收标准.md', pattern: /TC-D-\d{3}/g },
  { label: 'E2E-D', home: '11-测试计划与验收标准.md', pattern: /E2E-D-\d{2}/g },
  { label: 'ADR-D', home: '10-技术文档-架构决策记录ADR.md', pattern: /ADR-D\d{2}/g },
  { label: 'RISK-D', home: '18-风险登记册.md', pattern: /RISK-D-\d{2}/g },
  { label: 'OI-D', home: '00-基线-技术栈与架构决策.md', pattern: /OI-D-\d{2}/g },
  { label: 'UI', home: '03-产品规格说明书.md', pattern: /UI-\d{2}/g },
  { label: 'DIFF-D', home: '19-需求追踪矩阵RTM.md', pattern: /DIFF-D-\d{2}/g },
];

/** 占位符：这些出现在正文里说明"还没写"，是 error。 */
const PLACEHOLDER = /(待补充|待填写|TODO|FIXME|XXX待定)/g;

/**
 * 允许出现"待回填"的位置：
 * - 19-RTM 的回填说明与差异登记（历史上确实存在过待回填，现已归零，但说明文字保留）
 * - 24 流程文档里的示例
 */
const BACKFILL_ALLOWED_FILES = new Set([
  '19-需求追踪矩阵RTM.md',
  '24-需求评审与变更控制流程.md',
]);

/** 允许出现"待实现""待核验"等非占位语义的上下文。 */
const NON_PLACEHOLDER_CONTEXT = /(待实现|待核验|待评审|待决|待定|待拍板|待确认|待回填清单|待回填口径)/;

interface Issue {
  readonly severity: 'error' | 'warn';
  readonly rule: string;
  readonly file: string;
  readonly detail: string;
}

const issues: Issue[] = [];
const add = (severity: Issue['severity'], rule: string, file: string, detail: string): void => {
  issues.push({ severity, rule, file, detail });
};

// ── 读取文档 ────────────────────────────────────────────────────────────
const docFiles = fs
  .readdirSync(DOC_DIR_FINAL)
  .filter((f) => f.endsWith('.md'))
  .sort();
const texts = new Map<string, string>();
for (const f of docFiles) texts.set(f, fs.readFileSync(path.join(DOC_DIR_FINAL, f), 'utf8'));

/** 去掉代码围栏内容，避免把 TS 类型里的 `|` 当成表格管道。 */
function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '));
}

// ── U1/U2：文档信息表与变更记录 ─────────────────────────────────────────
for (const [file, text] of texts) {
  if (file === 'README.md') continue;
  const hasInfo = text.includes('文档信息') || text.includes('| 项 | 内容 |');
  if (!hasInfo) add('error', 'U1', file, '缺少「文档信息」表');
  if (!text.includes('变更记录')) add('error', 'U2', file, '缺少「变更记录」表');
}

// ── U3：引用的文档名必须存在 ────────────────────────────────────────────
/**
 * 本套文档的命名风格：两位数字前缀 + 中文/英文 + `.md`。
 * 引用可能是「本套文档」也可能是「document/ 下的既有文档」。
 * 只有当前者在 DesktopDoc/ 里找不到、且在 document/ 里也找不到时，才算悬空。
 */
function existsAnywhere(name: string): boolean {
  if (docFiles.includes(name)) return true;
  const docRoot = path.join(REPO_ROOT_FINAL, 'document');
  if (!fs.existsSync(docRoot)) return false;
  const stack: string[] = [docRoot];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) return true;
    }
  }
  return false;
}

for (const [file, text] of texts) {
  for (const m of text.matchAll(/(\d{2}-[^\s)\]|`，。、]+?\.md)/g)) {
    const name = m[1];
    if (existsAnywhere(name)) continue;
    add('error', 'U3', file, `引用的文档不存在（DesktopDoc/ 与 document/ 均未找到）：${name}`);
  }
}

// ── U4：编号必须在定义文档中存在 ────────────────────────────────────────
for (const fam of FAMILIES) {
  const homeText = texts.get(fam.home);
  if (homeText === undefined) {
    add('error', 'U4', fam.home, `编号族 ${fam.label} 的定义文档缺失`);
    continue;
  }
  const defined = new Set(homeText.match(fam.pattern) ?? []);
  const used = new Set<string>();
  for (const text of texts.values()) {
    for (const m of text.matchAll(fam.pattern)) used.add(m[0]);
  }
  for (const id of used) {
    if (!defined.has(id)) add('error', 'U4', fam.home, `${fam.label} 编号悬空：${id}`);
  }
}

// ── U6：引用的仓库内路径必须存在 ────────────────────────────────────────
/**
 * 例外：描述「将要新建」的文件允许不存在——但该行必须明确标注
 * 新增 / 待建 / 规划 / 建议 / 将建 / 由 … 生成，否则就是真的写错了路径。
 */
const PLANNED_CONTEXT = /(新增|待建|规划|建议|将建|由 .{0,20}生成|计划新增|应新建)/;

const PATH_RE = /(?:\bcode\/|\bdocument\/)[A-Za-z0-9_\-./]+\.(?:ts|md|json|yaml|yml|yml)\b/g;
for (const [file, text] of texts) {
  for (const [i, line] of text.split('\n').entries()) {
    for (const m of line.matchAll(PATH_RE)) {
      const rel = m[0];
      if (fs.existsSync(path.join(REPO_ROOT_FINAL, rel))) continue;
      if (PLANNED_CONTEXT.test(line)) continue;
      add('error', 'U6', file, `第 ${i + 1} 行引用的路径不存在且未标注"待建/新增"：${rel}`);
    }
  }
}

// ── U7：占位符 ──────────────────────────────────────────────────────────
/**
 * 占位符只有在「被当作待写内容」时才是错误。
 * 若出现在引号内、或同句含「不是/禁止/避免/不要/而不是」，属于反面举例，放行。
 */
const META_CONTEXT = /(不是|禁止|避免|不要|而不是|不得|不许|排除)/;

for (const [file, text] of texts) {
  if (BACKFILL_ALLOWED_FILES.has(file)) continue;
  for (const [i, line] of text.split('\n').entries()) {
    const quoted = /[「"'`][^」"'`]*(待补充|待填写|TODO|FIXME)[^」"'`]*[」"'`]/.test(line);
    if (quoted || META_CONTEXT.test(line)) continue;
    const hit = PLACEHOLDER.exec(line);
    if (hit !== null) add('error', 'U7', file, `第 ${i + 1} 行存在占位符「${hit[1]}」`);
    if (line.includes('待回填') && !NON_PLACEHOLDER_CONTEXT.test(line)) {
      add('error', 'U7', file, `第 ${i + 1} 行存在未回填的「待回填」`);
    }
  }
}

// ── U8：表格列数一致 ────────────────────────────────────────────────────
for (const [file, text] of texts) {
  const lines = stripFences(text).split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trimStart().startsWith('|')) {
      i += 1;
      continue;
    }
    const block: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trimStart().startsWith('|')) {
      block.push(lines[i] ?? '');
      i += 1;
    }
    if (block.length < 3) continue;
    const counts = block.map((r) => (r.match(/(?<!\\)\|/g) ?? []).length);
    const mode = [...new Set(counts)].sort((a, b) => counts.filter((c) => c === b).length - counts.filter((c) => c === a).length)[0] ?? 0;
    block.forEach((r, idx) => {
      if (counts[idx] !== mode) {
        add('error', 'U8', file, `表格列数不一致（第 ${block.length} 行块内）：${r.slice(0, 70)}`);
      }
    });
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────
const errors = issues.filter((i) => i.severity === 'error');
const warns = issues.filter((i) => i.severity === 'warn');

if (process.argv.includes('--json')) {
  process.stdout.write(
    `${JSON.stringify({ ok: errors.length === 0, files: docFiles.length, errors, warns }, null, 2)}\n`,
  );
} else {
  const cjk = [...texts.values()].reduce((n, t) => n + (t.match(/[一-鿿]/g)?.length ?? 0), 0);
  process.stdout.write(`docs: ${docFiles.length} 份 / ${cjk.toLocaleString('en-US')} 中文字\n`);
  if (errors.length === 0) {
    process.stdout.write('docs: ✅ 全部检查通过\n');
  } else {
    process.stdout.write(`docs: ❌ ${errors.length} 个 error / ${warns.length} 个 warn\n`);
    for (const e of errors) process.stdout.write(`  [${e.rule}] ${e.file}: ${e.detail}\n`);
    for (const w of warns) process.stdout.write(`  [${w.rule}] ${w.file}: ${w.detail}\n`);
  }
}

process.exit(errors.length === 0 ? 0 : 1);
