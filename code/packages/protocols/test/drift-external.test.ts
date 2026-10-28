/**
 * Drift against an EXTERNAL baseline.
 *
 * The v0.4 audit (05 §3) found that `drift.test.ts` compared the
 * implementation against the implementation's own constants, so it could only
 * ever detect "we broke it" — never "the pin was wrong from the start". Two
 * wrong pins survived that way (the MCP reserved error-code partition and the
 * A2A version code).
 *
 * This suite compares the implementation against `fixtures/mcp-wire-snapshot.json`,
 * which is generated from the PUBLISHED `@modelcontextprotocol/server` tarball
 * by `scripts/gen-wire-fixture.ts` — an artifact this repository does not
 * control. A wrong pin now fails here.
 *
 * Regenerate the fixture after an upstream release:
 *   corepack pnpm exec tsx scripts/gen-wire-fixture.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MCP_ERROR_CODES } from '@syaocode/rpc';
import { MCP_METHODS, MCP_NOTIFICATIONS } from '../src/mcp/client.js';
import { MCP_SERVER_METHODS } from '../src/mcp/server.js';
import { MCP_RESULT_TYPES, MCP_PROTOCOL_VERSION } from '../src/mcp/mapping.js';

interface KnownGap {
  name: string;
  kind: 'method' | 'notification';
  reason: string;
  trackedIn?: string;
}

interface Snapshot {
  provenance: { package: string; version: string; source: string; verifiedAt: string };
  protocolVersion: string;
  methods: string[];
  notifications: string[];
  resultTypes: string[];
  errorCodes: Record<string, number>;
  /**
   * Divergences from the published SDK that we have REVIEWED and accepted.
   * A new divergence is not in this list, so it fails the suite: the gap must
   * be either closed or declared with a reason.
   */
  knownGaps?: KnownGap[];
}

const fixturePath = fileURLToPath(new URL('../fixtures/mcp-wire-snapshot.json', import.meta.url));
const snapshot = JSON.parse(readFileSync(fixturePath, 'utf8')) as Snapshot;

/** Implementation methods, normalised to the wire names the fixture records. */
function implementationMethods(): string[] {
  const server = new Set<string>(MCP_SERVER_METHODS);
  return [...new Set([...MCP_METHODS, ...server])].sort();
}

describe('MCP drift vs the EXTERNAL SDK snapshot', () => {
  it('the fixture has real provenance (not hand-written)', () => {
    expect(snapshot.provenance.package).toBe('@modelcontextprotocol/server');
    expect(snapshot.provenance.source).toContain('tarball');
    expect(snapshot.provenance.version).toMatch(/^\d+\.\d+\.\d+$/);
    // If this ever becomes empty the baseline is no longer external.
    expect(snapshot.methods.length).toBeGreaterThan(5);
  });

  it('pins the same protocol version as the published SDK', () => {
    expect(MCP_PROTOCOL_VERSION).toBe(snapshot.protocolVersion);
  });

  it('implements every method the published SDK speaks, except declared gaps', () => {
    const ours = new Set(implementationMethods());
    const declared = new Set((snapshot.knownGaps ?? []).filter((g) => g.kind === 'method').map((g) => g.name));
    const missing = snapshot.methods.filter((m) => !ours.has(m) && !declared.has(m));
    // A NEW missing method fails here; the two known ones are declared in the
    // fixture with a reason and a tracking reference.
    expect(missing).toEqual([]);
  });

  it('every declared gap is real (a gap that got fixed must be un-declared)', () => {
    const ours = new Set(implementationMethods());
    for (const gap of (snapshot.knownGaps ?? []).filter((g) => g.kind === 'method')) {
      expect({ name: gap.name, implemented: ours.has(gap.name) }).toEqual({ name: gap.name, implemented: false });
      expect(gap.reason.length).toBeGreaterThan(20);
    }
  });

  it('invents no method the published SDK does not have', () => {
    const upstream = new Set(snapshot.methods);
    // The legacy `initialize` handshake is a deliberate, documented fallback
    // for pre-2026 servers and is not in the modern SDK's method table.
    const allowedExtras = new Set(['initialize', 'notifications/initialized']);
    const extra = implementationMethods().filter((m) => !upstream.has(m) && !allowedExtras.has(m));
    expect(extra).toEqual([]);
  });

  it('agrees with the SDK on the reserved error-code partition (04 M18)', () => {
    for (const [name, code] of Object.entries(snapshot.errorCodes)) {
      const ours = (MCP_ERROR_CODES as Record<string, number | undefined>)[
        name.charAt(0).toLowerCase() + name.slice(1)
      ];
      // `ResourceNotFound`/`UrlElicitationRequired` are not part of our surface.
      if (ours === undefined) continue;
      expect({ name, code: ours }).toEqual({ name, code });
    }
    // The two the audit found wrong: they must be the RESERVED codes, and the
    // MRTR codes must NOT squat on them.
    expect(MCP_ERROR_CODES.headerMismatch).toBe(-32020);
    expect(MCP_ERROR_CODES.missingRequiredClientCapability).toBe(-32021);
    expect(MCP_ERROR_CODES.unsupportedProtocolVersion).toBe(-32022);
    expect(MCP_ERROR_CODES.inputRequired).not.toBe(-32020);
    expect(MCP_ERROR_CODES.requestStateInvalid).not.toBe(-32021);
  });

  it('agrees with the SDK on the resultType vocabulary', () => {
    for (const value of snapshot.resultTypes) {
      expect(MCP_RESULT_TYPES).toContain(value);
    }
  });

  it('carries the modern-era notification surface, except declared gaps', () => {
    const ours = new Set<string>(MCP_NOTIFICATIONS);
    const declared = new Set((snapshot.knownGaps ?? []).filter((g) => g.kind === 'notification').map((g) => g.name));
    // The SDK's set is the authority for the names it publishes; ours may add
    // the tasks extension, but must contain every published one unless declared.
    const missing = snapshot.notifications.filter((n) => !ours.has(n) && !declared.has(n));
    expect(missing).toEqual([]);
  });

  it('the old self-referential baseline would NOT have caught the wrong pins', () => {
    // Demonstrates why this file exists: the pre-fix values were self-consistent.
    const wrongSelfReferentialPin = { inputRequired: -32020, requestStateInvalid: -32021 };
    const externalTruth = { headerMismatch: -32020, missingRequiredClientCapability: -32021 };
    // A test comparing the implementation to itself sees no contradiction...
    expect(wrongSelfReferentialPin.inputRequired).toBe(-32020);
    // ...while the external baseline shows the collision immediately.
    expect(Object.values(wrongSelfReferentialPin)).toContain(externalTruth.headerMismatch);
  });
});
