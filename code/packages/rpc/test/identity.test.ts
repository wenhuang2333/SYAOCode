/**
 * Identity tests: local principals, bearer tokens, audience-bound delegation
 * with monotonic scope shrinking.
 */

import { describe, expect, it } from 'vitest';
import { fixedClock, sha256Hasher } from './helpers.js';
import { LocalIdentityService } from '../src/governance/identity.js';
import { deterministicIds } from '../src/ir/ids.js';
import { CanonicalError } from '../src/ir/errors.js';
import type { DelegationToken, Principal } from '../src/ir/types.js';

const TENANT = 'ten_a';
const AUDIENCE = 'arf:test';

const alice: Principal = { id: 'prn_alice', kind: 'user', tenantId: TENANT, scopes: ['repo:read', 'repo:write'], trustTier: 'first_party' };
const syao: Principal = { id: 'prn_syao', kind: 'agent', tenantId: TENANT, scopes: ['repo:read'], trustTier: 'verified' };

function service(clock = fixedClock('2026-01-01T00:00:00.000Z')) {
  const identity = new LocalIdentityService({ hash: sha256Hasher(), ids: deterministicIds(), now: clock.now, audience: AUDIENCE, secret: 'test-secret' });
  identity.registerPrincipal(alice);
  identity.registerPrincipal(syao);
  return { identity, clock };
}

function body(overrides: Partial<Omit<DelegationToken, 'signature' | 'id'>> = {}): Omit<DelegationToken, 'signature' | 'id'> {
  return {
    issuer: alice.id,
    subject: syao.id,
    audience: AUDIENCE,
    scopes: ['repo:read'],
    constraints: { tenantId: TENANT, expiresAt: '2027-01-01T00:00:00.000Z', maxHops: 3 },
    ...overrides,
  };
}

async function expectCanonicalError(promise: Promise<unknown>, kind: string, message?: RegExp): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(CanonicalError);
  await promise.catch((error: unknown) => {
    const canonical = error as CanonicalError;
    expect(canonical.kind).toBe(kind);
    if (message !== undefined) expect(canonical.message).toMatch(message);
  });
}

describe('authenticate', () => {
  it('accepts a local principal with an empty chain', async () => {
    const { identity } = service();
    const caller = await identity.authenticate({ kind: 'local', principal: alice });
    expect(caller.principal.id).toBe(alice.id);
    expect(caller.delegationChain).toEqual([]);
  });

  it('rejects a local principal without a tenant', async () => {
    const { identity } = service();
    await expectCanonicalError(identity.authenticate({ kind: 'local', principal: { ...alice, tenantId: '' } }), 'unauthenticated');
  });

  it('accepts a registered bearer token', async () => {
    const { identity } = service();
    identity.registerBearerToken('tok_1', syao);
    const caller = await identity.authenticate({ kind: 'bearer', token: 'tok_1', tenantId: TENANT });
    expect(caller.principal.id).toBe(syao.id);
  });

  it('rejects an unknown bearer token', async () => {
    const { identity } = service();
    await expectCanonicalError(identity.authenticate({ kind: 'bearer', token: 'nope', tenantId: TENANT }), 'unauthenticated');
  });

  it('rejects a bearer token presented for another tenant (I8)', async () => {
    const { identity } = service();
    identity.registerBearerToken('tok_1', syao);
    await expectCanonicalError(identity.authenticate({ kind: 'bearer', token: 'tok_1', tenantId: 'ten_b' }), 'unauthorized');
  });

  it('authenticates a delegation transport credential', async () => {
    const { identity } = service();
    const token = await identity.issueDelegation(body());
    const caller = await identity.authenticate({ kind: 'delegation', token });
    expect(caller.principal.id).toBe(syao.id);
    expect(caller.principal.tenantId).toBe(TENANT);
  });
});

describe('delegation issue/verify', () => {
  it('issues a signed token with a generated id', async () => {
    const { identity } = service();
    const token = await identity.issueDelegation(body());
    expect(token.id).toMatch(/^dgt_/);
    expect(token.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(token.scopes).toEqual(['repo:read']);
  });

  it('verifies a well-formed token and narrows scopes to the token', async () => {
    const { identity } = service();
    const token = await identity.issueDelegation(body({ scopes: ['repo:read'] }));
    const caller = await identity.verifyDelegation(token, AUDIENCE);
    // alice has repo:write, but the token only grants repo:read.
    expect(caller.principal.scopes).toEqual(['repo:read']);
    expect(caller.delegationChain).toEqual([alice.id, syao.id]);
  });

  it('binds the token to its audience', async () => {
    const { identity } = service();
    const token = await identity.issueDelegation(body({ audience: 'arf:other' }));
    await expectCanonicalError(identity.verifyDelegation(token, AUDIENCE), 'unauthorized', /audience/);
    const ok = await identity.verifyDelegation(token, 'arf:other');
    expect(ok.principal.id).toBe(syao.id);
  });

  it('rejects an expired token', async () => {
    const { identity, clock } = service();
    const token = await identity.issueDelegation(body({ constraints: { tenantId: TENANT, expiresAt: '2026-06-01T00:00:00.000Z' } }));
    clock.advance(200 * 24 * 60 * 60 * 1000);
    await expectCanonicalError(identity.verifyDelegation(token, AUDIENCE), 'unauthenticated', /expired/);
  });

  it('rejects a tampered payload and a forged signature', async () => {
    const { identity } = service();
    const token = await identity.issueDelegation(body());
    await expectCanonicalError(identity.verifyDelegation({ ...token, scopes: ['repo:read', 'repo:write'] }, AUDIENCE), 'unauthenticated');
    await expectCanonicalError(identity.verifyDelegation({ ...token, signature: 'deadbeef' }, AUDIENCE), 'unauthenticated');
    await expectCanonicalError(identity.verifyDelegation({ ...token, signature: '' }, AUDIENCE), 'unauthenticated');
  });

  it('rejects a token minted by a different secret', async () => {
    const { identity } = service();
    const other = new LocalIdentityService({ hash: sha256Hasher(), ids: deterministicIds(), now: () => '2026-01-01T00:00:00.000Z', audience: AUDIENCE, secret: 'other-secret' });
    const token = await other.issueDelegation(body());
    await expectCanonicalError(identity.verifyDelegation(token, AUDIENCE), 'unauthenticated');
  });

  it('synthesises an untrusted principal for an unknown subject', async () => {
    const { identity } = service();
    const token = await identity.issueDelegation(body({ subject: 'prn_stranger' }));
    const caller = await identity.verifyDelegation(token, AUDIENCE);
    expect(caller.principal.trustTier).toBe('untrusted');
    expect(caller.principal.kind).toBe('agent');
  });
});

describe('monotonic shrinking', () => {
  it('rejects a child that widens scopes', async () => {
    const { identity } = service();
    const parent = await identity.issueDelegation(body({ scopes: ['repo:read'] }));
    await expectCanonicalError(
      identity.issueDelegation(body({ parentTokenId: parent.id, scopes: ['repo:read', 'repo:write'] })),
      'unauthorized',
      /widens scopes/,
    );
  });

  it('accepts a child that narrows scopes', async () => {
    const { identity } = service();
    const parent = await identity.issueDelegation(body({ scopes: ['repo:read', 'repo:write'] }));
    const child = await identity.issueDelegation(body({ parentTokenId: parent.id, scopes: ['repo:read'] }));
    expect(child.scopes).toEqual(['repo:read']);
    const caller = await identity.verifyDelegation(child, AUDIENCE);
    expect(caller.delegationChain).toEqual([alice.id, syao.id, syao.id]);
  });

  it('rejects a child that outlives its parent', async () => {
    const { identity } = service();
    const parent = await identity.issueDelegation(body({ constraints: { tenantId: TENANT, expiresAt: '2026-06-01T00:00:00.000Z' } }));
    await expectCanonicalError(
      identity.issueDelegation(body({ parentTokenId: parent.id, constraints: { tenantId: TENANT, expiresAt: '2027-01-01T00:00:00.000Z' } })),
      'unauthorized',
      /outlives/,
    );
  });

  it('rejects a child that widens spend, workspaces, approvals or hops', async () => {
    const { identity } = service();
    const parent = await identity.issueDelegation(
      body({ constraints: { tenantId: TENANT, expiresAt: '2027-01-01T00:00:00.000Z', maxSpendUsd: 10, workspaceRoots: ['/work'], approvalsRequired: true, maxHops: 3 } }),
    );
    await expectCanonicalError(
      identity.issueDelegation(body({ parentTokenId: parent.id, constraints: { tenantId: TENANT, expiresAt: '2027-01-01T00:00:00.000Z', maxSpendUsd: 20 } })),
      'unauthorized',
      /spend limit/,
    );
    await expectCanonicalError(
      identity.issueDelegation(body({ parentTokenId: parent.id, constraints: { tenantId: TENANT, expiresAt: '2027-01-01T00:00:00.000Z', maxSpendUsd: 5, workspaceRoots: ['/etc'] } })),
      'unauthorized',
      /workspace roots/,
    );
    await expectCanonicalError(
      identity.issueDelegation(body({ parentTokenId: parent.id, constraints: { tenantId: TENANT, expiresAt: '2027-01-01T00:00:00.000Z', maxSpendUsd: 5, workspaceRoots: ['/work'] } })),
      'unauthorized',
      /approval/,
    );
    await expectCanonicalError(
      identity.issueDelegation(body({ parentTokenId: parent.id, constraints: { tenantId: TENANT, expiresAt: '2027-01-01T00:00:00.000Z', maxSpendUsd: 5, workspaceRoots: ['/work'], approvalsRequired: true, maxHops: 9 } })),
      'unauthorized',
      /maxHops/,
    );
  });

  it('rejects a child in another tenant', async () => {
    const { identity } = service();
    const parent = await identity.issueDelegation(body());
    await expectCanonicalError(
      identity.issueDelegation(body({ parentTokenId: parent.id, constraints: { tenantId: 'ten_b', expiresAt: '2027-01-01T00:00:00.000Z' } })),
      'unauthorized',
      /cross tenants/,
    );
  });

  it('rejects an unknown parent token', async () => {
    const { identity } = service();
    await expectCanonicalError(identity.issueDelegation(body({ parentTokenId: 'dgt_missing' })), 'unauthorized', /unknown parent/);
  });

  it('enforces the hop budget across a chain', async () => {
    const { identity } = service();
    const first = await identity.issueDelegation(body({ constraints: { tenantId: TENANT, expiresAt: '2027-01-01T00:00:00.000Z', maxHops: 3 } }));
    const second = await identity.issueDelegation(body({ parentTokenId: first.id, constraints: { tenantId: TENANT, expiresAt: '2027-01-01T00:00:00.000Z', maxHops: 3 } }));
    const third = await identity.issueDelegation(body({ parentTokenId: second.id, constraints: { tenantId: TENANT, expiresAt: '2027-01-01T00:00:00.000Z', maxHops: 3 } }));
    expect(identity.hopCount(third)).toBe(3);
    await expectCanonicalError(
      identity.issueDelegation(body({ parentTokenId: third.id, constraints: { tenantId: TENANT, expiresAt: '2027-01-01T00:00:00.000Z', maxHops: 3 } })),
      'unauthorized',
      /maxHops/,
    );
  });

  it('builds a multi-hop chain from the issued graph', async () => {
    const { identity } = service();
    const first = await identity.issueDelegation(body());
    const second = await identity.issueDelegation(body({ parentTokenId: first.id, subject: 'prn_third' }));
    const caller = await identity.verifyDelegation(second, AUDIENCE);
    expect(caller.delegationChain).toEqual([alice.id, syao.id, 'prn_third']);
  });

  it('falls back to a two-hop chain for a token with an unknown parent', async () => {
    const { identity } = service();
    const orphan: DelegationToken = { ...(await identity.issueDelegation(body())), parentTokenId: 'dgt_elsewhere' };
    // Signature no longer matches after the edit, so re-sign through a fresh service.
    const fresh = service().identity;
    const token = await fresh.issueDelegation(body());
    const caller = await fresh.verifyDelegation(token, AUDIENCE);
    expect(caller.delegationChain).toEqual([alice.id, syao.id]);
    expect(orphan.parentTokenId).toBe('dgt_elsewhere');
  });
});
