/**
 * CI gate for the Agent RPC package boundaries (03 §7.3).
 *
 * Rules enforced:
 *   (a) packages/rpc must not import @syaocode/node — the governance kernel
 *       is host-agnostic; Node capabilities arrive through Runtime.
 *   (b) packages/protocols must not import `node:` — protocol edges must use
 *       the @syaocode/node helpers, so the SDK boundary stays in one place.
 *   (c) adapters must not import core/src/agent.ts and must not call
 *       Tool.execute directly — the only path to a side effect is the
 *       governance dispatcher (02 §4, invariant I13).
 *
 * The scan is textual but conservative: it looks at every import/export
 * specifier and every member access, so a renamed import cannot slip through.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const packagesRoot = new URL('../packages', import.meta.url).pathname;

const failures: string[] = [];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      out.push(...tsFiles(path));
    } else if (path.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}

function rel(path: string): string {
  return relative(packagesRoot, path);
}

/** Every module specifier mentioned by an import/export statement. */
function importSpecifiers(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(re)) {
    const spec = m[1];
    if (spec !== undefined) out.push(spec);
  }
  const sideEffect = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(sideEffect)) {
    const spec = m[1];
    if (spec !== undefined) out.push(spec);
  }
  return out;
}

// ── (a) rpc must not import @syaocode/node ────────────────────────────────
for (const file of tsFiles(join(packagesRoot, 'rpc', 'src'))) {
  const text = readFileSync(file, 'utf8');
  for (const spec of importSpecifiers(text)) {
    if (spec === '@syaocode/node' || spec.startsWith('@syaocode/node/')) {
      failures.push(`${rel(file)}: imports '${spec}' — @syaocode/rpc must stay host-agnostic (03 §3.1)`);
    }
  }
}

// ── (b) protocols must not import node: ───────────────────────────────────
for (const file of tsFiles(join(packagesRoot, 'protocols', 'src'))) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/from\s+['"](node:[^'"]+)['"]|import\s*\(\s*['"](node:[^'"]+)['"]\s*\)/g)) {
    failures.push(`${rel(file)}: imports '${m[1] ?? m[2]}' — protocol edges must use @syaocode/node helpers`);
  }
}

// ── (c) adapters must not import core/src/agent.ts nor call Tool.execute ───
const ADAPTER_DIRS = [
  join(packagesRoot, 'protocols', 'src', 'mcp'),
  join(packagesRoot, 'protocols', 'src', 'a2a'),
  join(packagesRoot, 'protocols', 'src', 'acp'),
  join(packagesRoot, 'protocols', 'src', 'shared'),
  join(packagesRoot, 'rpc', 'src', 'adapters'),
];

for (const dir of ADAPTER_DIRS) {
  for (const file of tsFiles(dir)) {
    const text = readFileSync(file, 'utf8');
    for (const spec of importSpecifiers(text)) {
      if (/core\/src\/agent(\.js)?$/.test(spec) || spec.endsWith('/agent.js') || spec.endsWith('/agent.ts')) {
        failures.push(`${rel(file)}: imports '${spec}' — an adapter must not reach into the agent loop (03 §7.3)`);
      }
    }
    // Direct tool execution bypasses the governance pipeline.
    for (const m of text.matchAll(/\.execute\s*\(/g)) {
      const line = text.slice(0, m.index).split('\n').pop() ?? '';
      if (/\btool\b/i.test(line) && !/\/\//.test(line.trimStart())) {
        failures.push(`${rel(file)}: calls '.execute(' on a tool — the dispatcher is the only path to a side effect (I13)`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`rpc boundary governance FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('rpc boundaries OK: rpc is host-agnostic, protocols avoid node:, adapters never execute tools directly');
