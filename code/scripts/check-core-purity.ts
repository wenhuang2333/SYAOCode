/**
 * CI guard for report E1: the kernel must not import Node builtins. Host
 * capabilities live in @syaocode/node and are injected through Runtime.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../packages/core', import.meta.url).pathname;
const offenders: string[] = [];

function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith('.ts')) {
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(/from\s+['"]node:[^'"]+['"]|import\s*\(\s*['"]node:[^'"]+['"]\s*\)/g)) {
        offenders.push(`${relative(root, path)}: ${match[0]}`);
      }
    }
  }
}

walk(join(root, 'src'));

if (offenders.length > 0) {
  console.error('@syaocode/core must stay host-agnostic (report E1):');
  for (const line of offenders) console.error(`  ${line}`);
  process.exit(1);
}
console.log('core purity OK: no node: imports in packages/core/src');
