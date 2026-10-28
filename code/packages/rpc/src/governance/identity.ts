/**
 * Identity — local principals and audience-bound delegation tokens (02 §8).
 *
 * A delegation token says: "principal A may act for principal B, within these
 * scopes, for this audience, until this instant, and only for this tenant".
 * The kernel signs it with the injected `Hasher` (host-provided SHA-256) over
 * a canonical JSON body, so no secret material and no `node:crypto` is needed
 * to be host-agnostic. The signature is HMAC-ish: `H(domain ∥ secret ∥ body)`.
 *
 * Monotonic shrinking (02 §8.2): a child token can never widen its parent —
 *   scopes ⊆ parent scopes
 *   tenant identical
 *   workspaceRoots ⊆ parent workspaceRoots
 *   maxSpendUsd ≤ parent maxSpendUsd
 *   expiresAt ≤ parent expiresAt
 *   approvalsRequired can only be tightened
 *   hop budget decreases with every hop
 *
 * Verification binds the audience: a token minted for peer A is useless for
 * peer B.
 */

import type { IdGenerator } from '@syaocode/core';
import { canonicalJson } from '../ir/schemas.js';
import { CanonicalError } from '../ir/errors.js';
import type { DelegationToken, Principal, TrustTier } from '../ir/types.js';
import type { AuthenticatedCaller, Hasher, IdentityService, TransportCredential } from './contracts.js';
import { deepClone } from '../runtime/projection.js';

/** Domain separator for the delegation signature. */
export const DELEGATION_DOMAIN = 'syaocode/arf/delegation/v1';

export interface IdentityServiceOptions {
  hash: Hasher;
  ids: IdGenerator;
  /** ISO clock. */
  now: () => string;
  /**
   * Signature secret. Hosts SHOULD inject a per-tenant secret; the default is
   * a domain-separated constant so the kernel stays usable out of the box.
   */
  secret?: string;
  /** Audience used when a transport credential carries a delegation token. */
  audience?: string;
}

/** In-memory identity service. Hosts may swap in a durable one. */
export class LocalIdentityService implements IdentityService {
  private readonly hash: Hasher;
  private readonly ids: IdGenerator;
  private readonly now: () => string;
  private readonly secret: string;
  private readonly audience: string;
  /** token id → issued token (needed for hop counting and chain building). */
  private readonly issued = new Map<string, DelegationToken>();
  /** bearer token → principal. */
  private readonly bearer = new Map<string, Principal>();
  /** principal id → principal (local directory). */
  private readonly directory = new Map<string, Principal>();

  constructor(opts: IdentityServiceOptions) {
    this.hash = opts.hash;
    this.ids = opts.ids;
    this.now = opts.now;
    this.secret = opts.secret ?? DELEGATION_DOMAIN;
    this.audience = opts.audience ?? DELEGATION_DOMAIN;
  }

  // ── directory ───────────────────────────────────────────────────────────

  /** Register a local principal so delegation can resolve it. */
  registerPrincipal(principal: Principal): void {
    this.directory.set(principal.id, deepClone(principal));
  }

  /** Register a bearer token for a principal (transport credential). */
  registerBearerToken(token: string, principal: Principal): void {
    this.bearer.set(token, deepClone(principal));
    this.registerPrincipal(principal);
  }

  // ── authentication ──────────────────────────────────────────────────────

  async authenticate(credential: TransportCredential): Promise<AuthenticatedCaller> {
    switch (credential.kind) {
      case 'local': {
        const principal = credential.principal;
        if (principal.tenantId === '') {
          throw new CanonicalError({ kind: 'unauthenticated', message: 'local principal has no tenant' });
        }
        return { principal: deepClone(principal), delegationChain: [] };
      }
      case 'bearer': {
        const principal = this.bearer.get(credential.token);
        if (principal === undefined) {
          throw new CanonicalError({ kind: 'unauthenticated', message: 'unknown bearer token' });
        }
        if (principal.tenantId !== credential.tenantId) {
          throw new CanonicalError({
            kind: 'unauthorized',
            message: 'bearer token belongs to another tenant (I8)',
            details: { tenantId: credential.tenantId },
          });
        }
        return { principal: deepClone(principal), delegationChain: [] };
      }
      case 'delegation': {
        return this.verifyDelegation(credential.token, this.audience);
      }
      default: {
        throw new CanonicalError({ kind: 'unauthenticated', message: 'unsupported credential' });
      }
    }
  }

  // ── delegation ──────────────────────────────────────────────────────────

  async issueDelegation(token: Omit<DelegationToken, 'signature' | 'id'>): Promise<DelegationToken> {
    const id = this.ids.next('dgt');
    const parent = token.parentTokenId !== undefined ? this.issued.get(token.parentTokenId) : undefined;
    if (token.parentTokenId !== undefined && parent === undefined) {
      throw new CanonicalError({ kind: 'unauthorized', message: `unknown parent token ${token.parentTokenId}` });
    }
    if (parent !== undefined) this.assertShrinks(parent, token);

    const body: Omit<DelegationToken, 'signature'> = {
      id,
      issuer: token.issuer,
      subject: token.subject,
      audience: token.audience,
      scopes: [...token.scopes],
      constraints: {
        tenantId: token.constraints.tenantId,
        expiresAt: token.constraints.expiresAt,
        ...(token.constraints.workspaceRoots !== undefined ? { workspaceRoots: [...token.constraints.workspaceRoots] } : {}),
        ...(token.constraints.maxSpendUsd !== undefined ? { maxSpendUsd: token.constraints.maxSpendUsd } : {}),
        ...(token.constraints.maxHops !== undefined ? { maxHops: token.constraints.maxHops } : {}),
        ...(token.constraints.approvalsRequired !== undefined ? { approvalsRequired: token.constraints.approvalsRequired } : {}),
      },
      ...(token.budgetAccountId !== undefined ? { budgetAccountId: token.budgetAccountId } : {}),
      ...(token.parentTokenId !== undefined ? { parentTokenId: token.parentTokenId } : {}),
    };
    const signed: DelegationToken = { ...body, signature: this.sign(body) };
    this.issued.set(id, signed);
    return deepClone(signed);
  }

  async verifyDelegation(token: DelegationToken, audience: string): Promise<AuthenticatedCaller> {
    const { signature, ...body } = token;
    const expected = this.sign(body);
    if (signature.length === 0 || expected !== signature) {
      throw new CanonicalError({ kind: 'unauthenticated', message: 'delegation signature does not verify' });
    }
    if (audience !== token.audience) {
      throw new CanonicalError({
        kind: 'unauthorized',
        message: `delegation token is bound to audience ${token.audience}`,
        details: { audience },
      });
    }
    const expiresAt = Date.parse(token.constraints.expiresAt);
    if (Number.isNaN(expiresAt) || expiresAt <= Date.parse(this.now())) {
      throw new CanonicalError({ kind: 'unauthenticated', message: 'delegation token has expired' });
    }
    if (token.constraints.tenantId === '') {
      throw new CanonicalError({ kind: 'unauthorized', message: 'delegation token has no tenant' });
    }
    return { principal: this.principalOf(token), delegationChain: this.chainOf(token) };
  }

  // ── internals ───────────────────────────────────────────────────────────

  private sign(body: Omit<DelegationToken, 'signature'>): string {
    return this.hash.sha256(`${DELEGATION_DOMAIN}\u0000${this.secret}\u0000${canonicalJson(body)}`);
  }

  /** The principal a token acts as; scopes are narrowed to the token's. */
  private principalOf(token: DelegationToken): Principal {
    const known = this.directory.get(token.subject);
    if (known !== undefined) {
      return {
        ...deepClone(known),
        tenantId: token.constraints.tenantId,
        scopes: [...token.scopes],
      };
    }
    return {
      id: token.subject,
      kind: 'agent',
      tenantId: token.constraints.tenantId,
      scopes: [...token.scopes],
      trustTier: 'untrusted',
    };
  }

  /** [issuer, subject, …] — every principal that passed the delegation on. */
  private chainOf(token: DelegationToken): string[] {
    const parent = token.parentTokenId !== undefined ? this.issued.get(token.parentTokenId) : undefined;
    if (parent === undefined) return [token.issuer, token.subject];
    return [...this.chainOf(parent), token.subject];
  }

  /** Hop count of a token (first hop = 1). */
  hopCount(token: DelegationToken): number {
    const parent = token.parentTokenId !== undefined ? this.issued.get(token.parentTokenId) : undefined;
    return parent === undefined ? 1 : this.hopCount(parent) + 1;
  }

  /**
   * A child token may only narrow its parent. Every violation is a hard error:
   * the kernel must never hand out a capability the parent did not have.
   */
  private assertShrinks(parent: DelegationToken, child: Omit<DelegationToken, 'signature' | 'id'>): void {
    const p = parent.constraints;
    const c = child.constraints;

    if (c.tenantId !== p.tenantId) {
      throw new CanonicalError({ kind: 'unauthorized', message: 'delegation may not cross tenants (I8)' });
    }
    const missing = child.scopes.filter((scope) => !parent.scopes.includes(scope));
    if (missing.length > 0) {
      throw new CanonicalError({
        kind: 'unauthorized',
        message: `delegation widens scopes: ${missing.join(', ')}`,
        details: { missing },
      });
    }
    if (p.workspaceRoots !== undefined) {
      const roots = c.workspaceRoots ?? [];
      const outside = roots.filter((root) => !p.workspaceRoots!.includes(root));
      if (outside.length > 0) {
        throw new CanonicalError({ kind: 'unauthorized', message: `delegation widens workspace roots: ${outside.join(', ')}` });
      }
    }
    if (p.maxSpendUsd !== undefined && (c.maxSpendUsd === undefined || c.maxSpendUsd > p.maxSpendUsd)) {
      throw new CanonicalError({ kind: 'unauthorized', message: 'delegation widens the spend limit' });
    }
    if (Date.parse(c.expiresAt) > Date.parse(p.expiresAt)) {
      throw new CanonicalError({ kind: 'unauthorized', message: 'delegation outlives its parent' });
    }
    if (p.approvalsRequired === true && c.approvalsRequired !== true) {
      throw new CanonicalError({ kind: 'unauthorized', message: 'delegation may not drop the approval requirement' });
    }
    const maxHops = p.maxHops;
    if (maxHops !== undefined) {
      // `maxHops` is the maximum 1-based depth the chain may reach, so the
      // child (depth+1) must still fit inside the parent's budget and may
      // never raise that budget again.
      const depth = this.hopCount(parent) + 1;
      if (depth > maxHops) {
        throw new CanonicalError({
          kind: 'unauthorized',
          message: `delegation exceeds maxHops (${maxHops})`,
          details: { depth, maxHops },
        });
      }
      if (c.maxHops !== undefined && c.maxHops > maxHops) {
        throw new CanonicalError({ kind: 'unauthorized', message: 'delegation may not widen maxHops' });
      }
    }
  }
}

/** Trust tier ordering helper (first_party > verified > untrusted). */
export function trustRank(trust: TrustTier): number {
  return trust === 'first_party' ? 2 : trust === 'verified' ? 1 : 0;
}
