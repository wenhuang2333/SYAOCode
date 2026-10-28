/**
 * Purity gate (03 §7.3).
 *
 * `packages/protocols/src` must never import `node:` (all IO goes through the
 * injected `@syaocode/core` Runtime) and must never call `Tool.execute` (the
 * dispatcher is the only path to a side effect).
 *
 * This test only reads files; `node:fs` is fine here because it is test code.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** Strip comments so doc prose about the rule is not flagged as a violation. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('purity', () => {
  const sources = files(SRC);

  it('scans every source file', () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it('imports no `node:` builtins', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const match of text.matchAll(/from\s+['"]node:([^'"]+)['"]/g)) {
        offenders.push(`${file}: node:${match[1] ?? ''}`);
      }
      for (const match of text.matchAll(/require\(\s*['"]node:([^'"]+)['"]\s*\)/g)) {
        offenders.push(`${file}: node:${match[1] ?? ''}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never calls Tool.execute', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const text = stripComments(readFileSync(file, 'utf8'));
      // The injected `McpToolExecutor` is the governance entry point and is
      // allowed; a raw Tool handle is not.
      if (/\bTool\.execute\b/.test(text)) offenders.push(`${file}: Tool.execute`);
      if (/\btool\.execute\s*\(/.test(text)) offenders.push(`${file}: tool.execute`);
      if (/from\s+['"]@syaocode\/tools/.test(text)) offenders.push(`${file}: imports @syaocode/tools`);
      if (/from\s+['"][^'"]*core\/src\/agent\.js/.test(text)) offenders.push(`${file}: imports core/src/agent`);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the edges independent (no cross-protocol imports)', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const text = stripComments(readFileSync(file, 'utf8'));
      if (file.includes('/mcp/') && /from\s+['"][^'"]*\.\.\/a2a\//.test(text)) offenders.push(`${file}: mcp → a2a`);
      if (file.includes('/mcp/') && /from\s+['"][^'"]*\.\.\/acp\//.test(text)) offenders.push(`${file}: mcp → acp`);
      if (file.includes('/a2a/') && /from\s+['"][^'"]*\.\.\/mcp\//.test(text)) offenders.push(`${file}: a2a → mcp`);
      if (file.includes('/a2a/') && /from\s+['"][^'"]*\.\.\/acp\//.test(text)) offenders.push(`${file}: a2a → acp`);
      if (file.includes('/acp/') && /from\s+['"][^'"]*\.\.\/mcp\//.test(text)) offenders.push(`${file}: acp → mcp`);
      if (file.includes('/acp/') && /from\s+['"][^'"]*\.\.\/a2a\//.test(text)) offenders.push(`${file}: acp → a2a`);
    }
    expect(offenders).toEqual([]);
  });
});
