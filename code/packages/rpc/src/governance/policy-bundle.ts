/**
 * Policy bundle loading, revisioning and layering (02 §5.4 step 6, §5.5).
 *
 * A bundle is the immutable input of a policy revision. Its revision is a
 * SHA-256 over the canonical JSON of everything except the revision field
 * itself, so any edit — including rule order — produces a new revision and
 * invalidates caches plus pending approvals.
 *
 * Layering rule (BR-002 / BR-024): `org` < `project` < `user` < `session`.
 * A lower layer may only ADD rules; the composition algorithm in ./policy.ts
 * makes any explicit deny veto everything else, so a project or session bundle
 * can never relax an org deny.
 */

import { canonicalJson, parseCanonical, policyBundleSchema } from '../ir/schemas.js';
import type { PolicyBundle, PolicyRule } from '../ir/types.js';
import type { Hasher } from './contracts.js';

export const POLICY_BUNDLE_SCHEMA_VERSION = 1;

/** Source precedence, weakest first. */
export const POLICY_LAYER_ORDER: readonly PolicyRule['source'][] = ['org', 'project', 'user', 'session', 'code'];

export function emptyBundle(hasher: Hasher, tenantId: string, defaultEffect: PolicyBundle['defaultEffect'] = 'deny'): PolicyBundle {
  const body = { schemaVersion: 1 as const, tenantId, defaultEffect, rules: [] as PolicyRule[] };
  return { ...body, revision: computeRevision(hasher, body) };
}

/**
 * Compute the bundle revision. The `revision` field is excluded, so
 * `withRevision()` is idempotent and callers cannot forge a stale revision.
 */
export function computeRevision(
  hasher: Hasher,
  bundle: Omit<PolicyBundle, 'revision'> & { revision?: string | undefined },
): string {
  const { revision: _drop, ...rest } = bundle;
  void _drop;
  // `undefined` optional fields must not participate in the digest.
  const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  return `sha256:${hasher.sha256(canonicalJson(clean))}`;
}

/** Re-stamp a bundle with its true revision. */
export function withRevision(
  hasher: Hasher,
  bundle: Omit<PolicyBundle, 'revision'> & { revision?: string | undefined },
): PolicyBundle {
  const clean = Object.fromEntries(Object.entries(bundle).filter(([, v]) => v !== undefined));
  return { ...(clean as Omit<PolicyBundle, 'revision'>), revision: computeRevision(hasher, bundle) };
}

/** Parse and validate a policy bundle document (JSON text or object). */
export function loadBundle(hasher: Hasher, raw: unknown): PolicyBundle {
  const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  const bundle = parseCanonical<PolicyBundle>(policyBundleSchema, parsed, 'policy bundle');
  const actual = computeRevision(hasher, bundle);
  if (bundle.revision !== actual) {
    // Trust the content, not the claim: a mismatched revision means the file
    // was edited by hand or is stale (02 §5.4 step 6).
    return { ...bundle, revision: actual };
  }
  return bundle;
}

/** True when the bundle is past its expiry (offline / last-known-good handling). */
export function isBundleExpired(bundle: PolicyBundle, nowIso: string): boolean {
  if (bundle.expiresAt === undefined) return false;
  return Date.parse(bundle.expiresAt) <= Date.parse(nowIso);
}

export interface LayerBundleInput {
  hasher: Hasher;
  tenantId: string;
  defaultEffect?: PolicyBundle['defaultEffect'];
  org?: PolicyBundle;
  project?: PolicyBundle;
  user?: PolicyBundle;
  session?: PolicyBundle;
}

/**
 * Merge layered bundles into one effective bundle.
 *
 * Rules are concatenated in layer order; priorities decide the winning reason
 * while deny/ask precedence is applied by the rule engine. Only the base
 * layer may set `defaultEffect` — a lower layer cannot widen the default.
 */
export function layerBundles(input: LayerBundleInput): PolicyBundle {
  const layers = [input.org, input.project, input.user, input.session].filter(
    (b): b is PolicyBundle => b !== undefined,
  );
  const rules: PolicyRule[] = [];
  for (const layer of layers) rules.push(...layer.rules);
  const base = input.org;
  const defaultEffect = base?.defaultEffect ?? input.defaultEffect ?? 'deny';
  const expiresAt = layers
    .map((l) => l.expiresAt)
    .filter((e): e is string => e !== undefined)
    .sort()[0];
  return withRevision(input.hasher, {
    schemaVersion: 1,
    tenantId: input.tenantId,
    defaultEffect,
    rules,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });
}

/** Stable hash of the rule set alone — used by EvidenceBundle policy snapshots. */
export function rulesHash(hasher: Hasher, bundle: PolicyBundle): string {
  return hasher.sha256(canonicalJson(bundle.rules));
}
