/**
 * Registry governance checks (09 §9.10):
 * 1. every code unique, SY-<domain>-<seq> well-formed
 * 2. SY-DEC-007 must NOT exist (sequence gap is intentional)
 * 3. every active code has a zh-CN message
 * 4. retryable / fatal sets match the registered table
 * 5. domain category mapping is total
 * 6. the Agent RPC domains exist and their reserved codes are populated (C7)
 */
import { ALL_ERROR_CODES, DOMAIN_CATEGORY, ERROR_DOMAINS, ERROR_REGISTRY } from '../packages/core/src/errors/registry';
import { MESSAGES_ZH_CN } from '../packages/core/src/errors/messages-zh';

const failures: string[] = [];
const DOMAINS = new Set<string>(ERROR_DOMAINS);

const seen = new Set<string>();
for (const code of ALL_ERROR_CODES) {
  if (seen.has(code)) failures.push(`duplicate code ${code}`);
  seen.add(code);
  // Domains may contain digits (A2A), so the shape check allows them; the
  // closed domain union in registry.ts is the real authority.
  if (!/^SY-[A-Z][A-Z0-9]{1,3}-\d{3}$/.test(code)) failures.push(`malformed code ${code}`);
  const entry = ERROR_REGISTRY.get(code);
  if (entry === undefined) failures.push(`missing registry entry for ${code}`);
  else if (!DOMAINS.has(entry.domain)) failures.push(`${code} has unknown domain ${entry.domain}`);
  else if (entry.category !== DOMAIN_CATEGORY[entry.domain]) failures.push(`${code} category/domain mismatch`);
}
if (seen.has('SY-DEC-007')) failures.push('SY-DEC-007 exists — the gap is intentional and must not be filled');

for (const code of ALL_ERROR_CODES) {
  if (!(code in MESSAGES_ZH_CN)) failures.push(`missing zh-CN message for ${code}`);
}
for (const code of Object.keys(MESSAGES_ZH_CN)) {
  if (!seen.has(code)) failures.push(`zh-CN message references unknown code ${code}`);
}

// C7: the Agent RPC error surface is a fixed set — a removed code breaks a
// shipped protocol mapping, so the check pins the minimum.
for (const code of [
  'SY-MCP-001', 'SY-MCP-002', 'SY-MCP-003', 'SY-MCP-004', 'SY-MCP-005', 'SY-MCP-006',
  'SY-A2A-001', 'SY-A2A-002', 'SY-A2A-003', 'SY-A2A-004', 'SY-A2A-005', 'SY-A2A-006',
  'SY-ACP-001', 'SY-ACP-002',
  'SY-SRV-001', 'SY-SRV-002', 'SY-SRV-003', 'SY-SRV-004',
]) {
  if (!seen.has(code)) failures.push(`reserved Agent RPC code ${code} must exist (03 §4 C7)`);
}
for (const code of ALL_ERROR_CODES) {
  if (code.startsWith('SY-A2A-') && ERROR_REGISTRY.get(code)?.domain !== 'A2A') {
    failures.push(`${code} must resolve to the A2A domain`);
  }
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
// A tampered MRTR requestState and an unsupported capability are never
// retryable: retrying would replay a rejected request or loop on a wall.
for (const mustNotRetry of ['SY-MCP-006', 'SY-SRV-004']) {
  if (expectedRetryable.has(mustNotRetry)) failures.push(`${mustNotRetry} must not be retryable`);
}
const fatalButNotRetryable = [...expectedFatal].filter((c) => expectedRetryable.has(c));
if (fatalButNotRetryable.length > 0) failures.push(`fatal codes cannot be retryable: ${fatalButNotRetryable.join(',')}`);

if (failures.length > 0) {
  console.error(`error registry governance FAILED (${failures.length}):\n${failures.map((f) => ` - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`error registry OK: ${ALL_ERROR_CODES.length} codes, zh-CN complete, retryable=${expectedRetryable.size}, fatal=${expectedFatal.size}`);
