/**
 * Regenerate the external wire snapshot for the MCP edge.
 *
 * WHY THIS EXISTS
 * ---------------
 * The v0.4 audit (document/Agent-RPC/05 §3) found that `drift.test.ts`
 * compared the implementation against **the implementation's own constants**.
 * That can only detect "we broke it" — never "the pin was wrong all along",
 * which is exactly how two wrong error codes survived. Two wrong pins were
 * found that way: the MCP reserved-code partition and the A2A version code.
 *
 * This script generates the baseline from an EXTERNAL artifact — the
 * published `@modelcontextprotocol/server` tarball — so the baseline is
 * anchored to the upstream reality instead of to ourselves.
 *
 * USAGE
 * -----
 *   # fetches the tarball from the npm registry (needs network)
 *   corepack pnpm exec tsx scripts/gen-wire-fixture.ts
 *
 *   # or regenerate from a tarball you already have
 *   corepack pnpm exec tsx scripts/gen-wire-fixture.ts --tarball ./server-2.4.0.tgz
 *
 *   # offline: extract the package first and point at the directory
 *   corepack pnpm exec tsx scripts/gen-wire-fixture.ts --extracted ./package
 *
 * OUTPUT: packages/protocols/fixtures/mcp-wire-snapshot.json
 *
 * The A2A and ACP snapshots are transcribed from document/Agent-RPC/04
 * (the external fact record) because those SDKs do not ship a machine-readable
 * method table; their provenance is recorded in the file itself.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PACKAGE = '@modelcontextprotocol/server';
const VERSION = '2.4.0';
const TARBALL = `https://registry.npmjs.org/${PACKAGE.replace('@', '%40').replace('/', '%2F')}/-/${PACKAGE.split('/')[1]}-${VERSION}.tgz`;
const OUT = new URL('../packages/protocols/fixtures/mcp-wire-snapshot.json', import.meta.url).pathname;

interface Args {
  tarball?: string;
  extracted?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--tarball') out.tarball = argv[++i];
    else if (argv[i] === '--extracted') out.extracted = argv[++i];
  }
  return out;
}

function fetchAndExtract(tarballUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-fixture-'));
  const tgz = join(dir, 'pkg.tgz');
  execFileSync('curl', ['-sSL', '-o', tgz, tarballUrl], { stdio: 'inherit' });
  execFileSync('tar', ['xzf', tgz, '-C', dir], { stdio: 'inherit' });
  return join(dir, 'package');
}

/** Every .mjs/.cjs file in the package's dist tree. */
function distFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(mjs|cjs)$/.test(entry.name)) out.push(path);
    }
  };
  walk(join(root, 'dist'));
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  let root: string;
  let cleanup: (() => void) | undefined;

  if (args.extracted !== undefined) {
    root = args.extracted;
  } else if (args.tarball !== undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-fixture-'));
    execFileSync('tar', ['xzf', args.tarball, '-C', dir], { stdio: 'inherit' });
    root = join(dir, 'package');
    cleanup = () => rmSync(dir, { recursive: true, force: true });
  } else {
    root = fetchAndExtract(TARBALL);
    cleanup = () => rmSync(root, { recursive: true, force: true });
  }

  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; version: string };
    const source = distFiles(root).map((f) => readFileSync(f, 'utf8')).join('\n');

    const methods = [...new Set(
      source.match(/"(server\/discover|tools\/list|tools\/call|resources\/list|resources\/read|prompts\/list|prompts\/get|tasks\/get|tasks\/update|tasks\/cancel|subscriptions\/listen)"/g) ?? [],
    )].map((m) => m.slice(1, -1)).sort();

    const notifications = [...new Set(
      source.match(/"(notifications\/[a-z]+)"/g) ?? [],
    )].map((m) => m.slice(1, -1)).sort();

    const resultTypes = [...new Set(source.match(/"(complete|input_required|task)"/g) ?? [])]
      .map((m) => m.slice(1, -1)).sort();

    const metaKeys = [...new Set(source.match(/"(io\.modelcontextprotocol\/[a-z-]+)"/g) ?? [])]
      .map((m) => m.slice(1, -1)).sort();

    const versions = [...new Set(source.match(/"(20\d\d-\d\d-\d\d)"/g) ?? [])]
      .map((m) => m.slice(1, -1)).sort();

    const errorCodes: Record<string, number> = {};
    for (const [, name, value] of source.matchAll(/ProtocolErrorCode\$1\["([A-Za-z]+)"\] = (-?\d+)/g)) {
      errorCodes[name] = Number(value);
    }
    // HeaderMismatch is emitted by the inbound header classifier rather than
    // the enum, but it is a reserved MCP code (04 M18).
    if (errorCodes.MissingRequiredClientCapability !== undefined) {
      errorCodes.HeaderMismatch = -32020;
    }

    // Preserve the reviewed divergence list: regenerating the baseline must
    // not silently drop decisions a human made about known gaps.
    let knownGaps: unknown = undefined;
    try {
      const previous = JSON.parse(readFileSync(OUT, 'utf8')) as { knownGaps?: unknown };
      knownGaps = previous.knownGaps;
    } catch {
      // First generation: there is nothing to preserve.
    }

    const snapshot = {
      schemaVersion: 1,
      generatedBy: 'scripts/gen-wire-fixture.ts',
      provenance: {
        protocol: 'mcp',
        source: 'official SDK tarball',
        package: pkg.name,
        version: pkg.version,
        tarball: `https://registry.npmjs.org/${PACKAGE}/-/server-${VERSION}.tgz`,
        verifiedAt: new Date().toISOString().slice(0, 10),
        note: 'Generated from the published artifact, NOT from this repository\'s own constants, so a wrong pin in the implementation is detectable.',
      },
      protocolVersion: '2026-07-28',
      supportedVersionsSeen: versions,
      methods,
      notifications,
      resultTypes,
      metaKeys,
      errorCodes,
      ...(knownGaps !== undefined ? { knownGaps } : {}),
    };

    writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`wrote ${OUT}`);
    console.log(`  methods: ${methods.length}, notifications: ${notifications.length}, errorCodes: ${Object.keys(errorCodes).length}`);
  } finally {
    cleanup?.();
  }
}

if (existsSync(OUT) || process.argv.length > 1) main();
