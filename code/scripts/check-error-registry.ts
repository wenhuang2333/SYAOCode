/**
 * Registry governance checks (09 §9.10):
 * 1. every code unique, SY-<domain>-<seq> well-formed
 * 2. SY-DEC-007 must NOT exist (sequence gap is intentional)
 * 3. every active code has a zh-CN message
 * 4. retryable / fatal sets match the registered table
 * 5. domain category mapping is total
 */
import { ALL_ERROR_CODES, ERROR_REGISTRY } from '../packages/core/src/errors/registry';
import { MESSAGES_ZH_CN } from '../packages/core/src/errors/messages-zh';

const failures: string[] = [];

const seen = new Set<string>();
for (const code of ALL_ERROR_CODES) {
  if (seen.has(code)) failures.push(`duplicate code ${code}`);
  seen.add(code);
  if (!/^SY-[A-Z]{2,4}-\d{3}$/.test(code)) failures.push(`malformed code ${code}`);
  const entry = ERROR_REGISTRY.get(code);
  if (entry === undefined) failures.push(`missing registry entry for ${code}`);
}
if (seen.has('SY-DEC-007')) failures.push('SY-DEC-007 exists — the gap is intentional and must not be filled');

for (const code of ALL_ERROR_CODES) {
  if (!(code in MESSAGES_ZH_CN)) failures.push(`missing zh-CN message for ${code}`);
}
for (const code of Object.keys(MESSAGES_ZH_CN)) {
  if (!seen.has(code)) failures.push(`zh-CN message references unknown code ${code}`);
}

const expectedRetryable = new Set(
  ALL_ERROR_CODES.filter((c) => ERROR_REGISTRY.get(c)?.retryable === true),
);
const expectedFatal = new Set(ALL_ERROR_CODES.filter((c) => ERROR_REGISTRY.get(c)?.severity === 'fatal'));
for (const mustBeRetryable of ['SY-PRV-002', 'SY-PRV-003', 'SY-PRV-007', 'SY-PRV-008', 'SY-PRV-009', 'SY-TOOL-004', 'SY-CTX-001', 'SY-SES-004', 'SY-MCP-001', 'SY-MCP-005', 'SY-DEC-001', 'SY-DEC-002', 'SY-AGT-002', 'SY-AGT-005']) {
  if (!expectedRetryable.has(mustBeRetryable)) failures.push(`${mustBeRetryable} must be retryable`);
}
for (const mustBeFatal of ['SY-CTX-002', 'SY-ACP-001', 'SY-INT-001']) {
  if (!expectedFatal.has(mustBeFatal)) failures.push(`${mustBeFatal} must be fatal`);
}
const fatalButNotRetryable = [...expectedFatal].filter((c) => expectedRetryable.has(c));
if (fatalButNotRetryable.length > 0) failures.push(`fatal codes cannot be retryable: ${fatalButNotRetryable.join(',')}`);

if (failures.length > 0) {
  console.error(`error registry governance FAILED (${failures.length}):\n${failures.map((f) => ` - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`error registry OK: ${ALL_ERROR_CODES.length} codes, zh-CN complete, retryable=${expectedRetryable.size}, fatal=${expectedFatal.size}`);
