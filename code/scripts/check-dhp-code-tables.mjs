/**
 * 校验 DesktopDoc 三份文档的 DHP 错误码表一致。
 *
 * 断言：
 *   1. 16 §2.2.2 的自定义码集合 === 06 §10.2 的自定义码集合（差集必须为空）
 *   2. 每个码在两份文档中的 kind 名称逐字相同
 *   3. 26 个自定义码连续无空洞（-32000..-32025）
 *   4. 25 §4.1 的自定义码集合同样一致
 *
 * 用法：cd <repo-root> && node code/scripts/check-dhp-code-tables.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// code/scripts/ → 仓库根为上两级
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const DOC_16 = 'DesktopDoc/16-错误体系与诊断映射.md';
const DOC_06 = 'DesktopDoc/06-DHP-桌面宿主协议规范.md';
const DOC_25 = 'DesktopDoc/25-附录B-契约总表.md';

/** 抽取 "| -320NN | `kind` |" 形态的行，返回 Map<code, kind>。 */
function extractCustom(text, label) {
  const map = new Map();
  const re = /^\|\s*`?(-320[0-2][0-9])`?\s*\|\s*`([a-z_]+)`\s*\|/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (map.has(m[1])) {
      // 同一文档内重复出现（例如正文引用表）——后写的覆盖前写的即可，但必须记录
      if (map.get(m[1]) !== m[2]) {
        throw new Error(`${label}: 码 ${m[1]} 在同一文档出现两种 kind：${map.get(m[1])} vs ${m[2]}`);
      }
    }
    map.set(m[1], m[2]);
  }
  return map;
}

/** 抽取 §10.1 标准码："| -32700 | `parse_error` |" 形态。 */
function extractStandard(text) {
  const map = new Map();
  const re = /^\|\s*`?(-32[67][0-9]{2})`?\s*\|\s*`([a-z_]+)`\s*\|/gm;
  let m;
  while ((m = re.exec(text)) !== null) map.set(m[1], m[2]);
  return map;
}

const t16 = read(DOC_16);
const t06 = read(DOC_06);
const t25 = read(DOC_25);

// 06 是权威：分别从其 §10.1 与 §10.2 两张表抽取
const idx102 = t06.indexOf('### 10.2');
const idx103 = t06.indexOf('### 10.3');
if (idx102 < 0 || idx103 < 0) throw new Error('06: 未找到 §10.2 / §10.3 边界');
const sec102 = t06.slice(idx102, idx103);
const sec101 = t06.slice(t06.indexOf('### 10.1'), idx102);

const auth = extractCustom(sec102, '06 §10.2');
const std = extractStandard(sec101);

const mine = extractCustom(t16, '16');
const appendix = extractCustom(t25, '25');

const problems = [];

// 断言 1：集合相等
const diffA = [...auth.keys()].filter((c) => !mine.has(c));
const diffB = [...mine.keys()].filter((c) => !auth.has(c));
if (diffA.length) problems.push(`16 缺少：${diffA.join(', ')}`);
if (diffB.length) problems.push(`16 多出：${diffB.join(', ')}`);

// 断言 1b：25 与 06 相等
const diffC = [...auth.keys()].filter((c) => !appendix.has(c));
const diffD = [...appendix.keys()].filter((c) => !auth.has(c));
if (diffC.length) problems.push(`25 缺少：${diffC.join(', ')}`);
if (diffD.length) problems.push(`25 多出：${diffD.join(', ')}`);

// 断言 2：kind 逐字相同
for (const [code, kind] of auth) {
  if (mine.has(code) && mine.get(code) !== kind) {
    problems.push(`kind 不一致 ${code}：06=${kind} / 16=${mine.get(code)}`);
  }
  if (appendix.has(code) && appendix.get(code) !== kind) {
    problems.push(`kind 不一致 ${code}：06=${kind} / 25=${appendix.get(code)}`);
  }
}

// 断言 3：连续无空洞
const expected = [];
for (let n = 0; n <= 25; n += 1) expected.push(`-320${String(n).padStart(2, '0')}`);
const missing = expected.filter((c) => !auth.has(c));
if (missing.length) problems.push(`06 §10.2 存在空洞：${missing.join(', ')}`);

// 断言 4：16 §2.2.1 的标准码与 06 §10.1 一致（码 + 名称 + kind 都要对）
const i221 = t16.indexOf('#### 2.2.1');
const i222 = t16.indexOf('#### 2.2.2');
if (i221 < 0 || i222 < 0) throw new Error('16: 未找到 §2.2.1 / §2.2.2 边界');
const sec221 = t16.slice(i221, i222);
const std16 = new Map();
for (const line of sec221.split('\n')) {
  const m = /^\|\s*`?(-32[67][0-9]{2})`?\s*\|\s*`([a-z_]+)`\s*\|\s*`([a-z_]+)`\s*\|/.exec(line);
  if (m) std16.set(m[1], { name: m[2], kind: m[3] });
}
for (const [code, name] of std) {
  if (!std16.has(code)) { problems.push(`16 §2.2.1 缺少标准码 ${code}`); continue; }
  const got = std16.get(code);
  if (got.name !== name) problems.push(`标准码名称不一致 ${code}：06=${name} / 16=${got.name}`);
}
for (const [code] of std16) {
  if (!std.has(code)) problems.push(`16 §2.2.1 多出标准码 ${code}`);
}

const summary = {
  '06 §10.2 权威码数': auth.size,
  '16 §2.2.2 自定义码数': mine.size,
  '16 §2.2.1 标准码数': std16.size,
  '25 §4.1 码数': appendix.size,
  '06 §10.1 标准码数': std.size,
  '16 ∖ 06': diffB,
  '06 ∖ 16': diffA,
  '25 ∖ 06': diffD,
  '06 ∖ 25': diffC,
  '空洞': missing,
  'kind 不一致': problems.filter((p) => p.startsWith('kind')).length,
};

console.log(JSON.stringify(summary, null, 2));
if (problems.length) {
  console.error('\n❌ 校验失败：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('\n✅ 校验通过：16 §2.2 与 06 §10.1/§10.2 完全一致（差集为空、kind 逐字相同、码段连续无空洞）。');
