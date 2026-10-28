/**
 * CI guard for report E1 / 03 §7.3: the kernel and the Agent RPC kernel must
 * not import Node builtins. Host capabilities live in @syaocode/node and are
 * injected through Runtime.
 *
 * Scanned packages:
 *   @syaocode/core       — the kernel (host-agnostic by ADR-03)
 *   @syaocode/rpc        — the governance kernel (03 §3.1: depends on core only)
 *   @syaocode/protocols  — protocol edges; Node IO must go through
 *                          @syaocode/node helpers, never `node:` directly
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const packagesRoot = new URL('../packages', import.meta.url).pathname;
const SCANNED = ['core', 'rpc', 'protocols'] as const;

const NODE_IMPORT = /from\s+['"]node:[^'"]+['"]|import\s*\(\s*['"]node:[^'"]+['"]\s*\)|require\s*\(\s*['"]node:[^'"]+['"]\s*\)/g;

const offenders: string[] = [];
let scanned = 0;

function walk(dir: string, pkg: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '__pycache__') continue;
      walk(path, pkg);
    } else if (path.endsWith('.ts')) {
      scanned += 1;
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(NODE_IMPORT)) {
        offenders.push(`packages/${pkg}/${relative(join(packagesRoot, pkg), path)}: ${match[0]}`);
      }
    }
  }
}

for (const pkg of SCANNED) walk(join(packagesRoot, pkg, 'src'), pkg);

if (offenders.length > 0) {
  console.error(`host-agnostic packages must not import node: builtins (report E1):`);
  for (const line of offenders) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`core purity OK: no node: imports in ${SCANNED.map((p) => `packages/${p}/src`).join(', ')} (${scanned} files)`);
