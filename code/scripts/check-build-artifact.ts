/**
 * Build smoke test (audit C-5).
 *
 * `pnpm build` exiting 0 does NOT mean the output runs: the workspace
 * `exports` point at `./src/index.ts` during development, so a built
 * `dist/main.js` can still fail with `ERR_MODULE_NOT_FOUND` when the published
 * entry points at a `.ts` file. This script exercises the built artifact the
 * way a user would and fails CI if it cannot start.
 *
 * Run after `pnpm build`:
 *   corepack pnpm exec tsx scripts/check-build-artifact.ts
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = new URL('..', import.meta.url).pathname;
const failures: string[] = [];

function fail(message: string): void {
  failures.push(message);
  console.error(`  FAIL ${message}`);
}

function ok(message: string): void {
  console.log(`  ok   ${message}`);
}

// ── 1. every publishable package has a dist with a JS entry ──────────────
const PACKAGES = ['core', 'node', 'rpc', 'protocols', 'providers', 'tools', 'testing', 'cli'];
for (const name of PACKAGES) {
  const dir = join(root, 'packages', name);
  const distDir = join(dir, 'dist');
  if (!existsSync(distDir)) {
    fail(`packages/${name}: no dist/ (run pnpm build)`);
    continue;
  }
  if (!existsSync(join(distDir, 'index.js')) && !existsSync(join(distDir, 'main.js'))) {
    fail(`packages/${name}: dist has no index.js/main.js`);
    continue;
  }
  ok(`packages/${name}: dist entry present`);
}

// ── 2. no built file imports a `.ts` specifier (the ERR_MODULE_NOT_FOUND trap)
function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}
for (const name of PACKAGES) {
  for (const file of walk(join(root, 'packages', name, 'dist'))) {
    const text = readFileSync(file, 'utf8');
    // `from './x.ts'` / `import('./x.ts')` — a runtime import of TypeScript.
    const match = /(?:from\s*|import\s*\(\s*)['"](\.{1,2}\/[^'"]+\.ts)['"]/.exec(text);
    if (match !== null) {
      fail(`${file.replace(root, '')} imports a .ts specifier at runtime: ${match[1]}`);
    }
  }
}
if (failures.length === 0) ok('no dist file imports a .ts specifier');

// ── 3. the CLI entry actually runs, resolved AS PUBLISHED ────────────────
//
// In the workspace the `exports` point at `./src/index.ts`, so a built
// `dist/main.js` resolves `@syaocode/core` to a TypeScript source and dies with
// ERR_MODULE_NOT_FOUND. The published package uses `publishConfig.exports`,
// so the smoke test reproduces THAT resolution: a shadow node_modules whose
// package.json files carry the publishConfig exports and whose dist/ is the
// built output.
const shadow = join(tmpdir(), `syaocode-build-check-${process.pid}`);
rmSync(shadow, { recursive: true, force: true });

interface PkgInfo {
  name: string;
  dir: string;
  dist: string;
  exports?: unknown;
  publishExports?: unknown;
  bin?: Record<string, string>;
}

function publishManifest(dirName: string, dir: string): PkgInfo | undefined {
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    name: string;
    bin?: Record<string, string>;
    exports?: unknown;
    publishConfig?: { exports?: unknown };
  };
  // Use the PUBLISHED name (`syaocode`, `@syaocode/core`), not the directory.
  const name = manifest.name ?? dirName;
  return {
    name,
    dir,
    dist: join(dir, 'dist'),
    ...(manifest.exports !== undefined ? { exports: manifest.exports } : {}),
    ...(manifest.publishConfig?.exports !== undefined ? { publishExports: manifest.publishConfig.exports } : {}),
    ...(manifest.bin !== undefined ? { bin: manifest.bin } : {}),
  };
}

const infos: PkgInfo[] = [];
for (const name of PACKAGES) {
  const info = publishManifest(name, join(root, 'packages', name));
  if (info !== undefined) infos.push(info);
}

try {
  for (const info of infos) {
    const target = join(shadow, 'node_modules', ...info.name.split('/'));
    mkdirSync(target, { recursive: true });
    // The published manifest: publishConfig.exports replaces exports.
    const manifest = {
      name: info.name,
      version: '0.0.0-build-check',
      type: 'module',
      ...(info.publishExports !== undefined
        ? { exports: info.publishExports }
        : info.exports !== undefined
          ? { exports: info.exports }
          : {}),
      ...(info.bin !== undefined ? { bin: info.bin } : {}),
    };
    writeFileSync(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (existsSync(info.dist)) {
      // COPY, not symlink: a symlink resolves to its realpath, so Node would
      // walk back into the workspace and hit the dev `exports` -> src/*.ts.
      cpSync(info.dist, join(target, 'dist'), { recursive: true });
    }
  }

  // External runtime dependencies (zod, …) must be resolvable from the shadow
  // install too; link them from the workspace's own node_modules.
  // pnpm does not hoist: a dependency lives in the consuming package's own
  // node_modules, so resolve each external from where it actually is.
  const externals = new Map<string, string>();
  for (const dirName of PACKAGES) {
    const pkgDir = join(root, 'packages', dirName);
    const manifestPath = join(pkgDir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> };
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (dep.startsWith('@syaocode/') || externals.has(dep)) continue;
      for (const candidate of [join(pkgDir, 'node_modules', ...dep.split('/')), join(root, 'node_modules', ...dep.split('/'))]) {
        if (existsSync(candidate)) {
          externals.set(dep, candidate);
          break;
        }
      }
    }
  }
  for (const [dep, from] of externals) {
    const to = join(shadow, 'node_modules', ...dep.split('/'));
    mkdirSync(join(to, '..'), { recursive: true });
    symlinkSync(from, to, 'dir');
  }

  const cliEntry = join(shadow, 'node_modules', 'syaocode', 'dist', 'main.js');
  if (!existsSync(cliEntry)) {
    fail('built CLI entry missing in the shadow install');
  } else {
    try {
      const out = execFileSync(process.execPath, [cliEntry, '--version'], {
        encoding: 'utf8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: root,
      });
      if (!/syao v\d/.test(out)) fail(`built CLI printed an unexpected version line: ${out.trim().slice(0, 120)}`);
      else ok(`built CLI starts as published: ${out.trim().slice(0, 60)}`);
    } catch (e) {
      const err = e as { message?: string; stderr?: string };
      fail(`built CLI failed to start as published: ${(err.stderr ?? err.message ?? '').trim().slice(0, 400)}`);
    }
  }
} finally {
  rmSync(shadow, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nbuild artifact check FAILED (${failures.length} problem(s))`);
  process.exit(1);
}
console.log('\nbuild artifact check OK: dist entries present, no .ts specifiers, CLI starts');
