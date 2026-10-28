/**
 * Capability registry and routing (01 §4.5, 02 §7, invariant I4).
 *
 * I4 — the effective risk/side-effect/data-class of a capability come from the
 * registry's own configuration or from an explicit registration. A peer's
 * `declaredRisk`/annotations are advisory wire data and are NEVER trusted: they
 * are recorded as `peer.declaredRisk` labels for the audit trail only.
 *
 * Routing is `trust → health → cost` and never falls back across trust tiers:
 * a `requireTrust` constraint is applied first and is never relaxed, so a
 * `verified` requirement can never silently degrade to `untrusted`.
 *
 * Tenant scoping (I8) uses the `tenantId` label: an entry carrying one is
 * visible only to that tenant; an entry without one is global (built-ins).
 */

import { CanonicalError } from '../ir/errors.js';
import type {
  Capability,
  CapabilityProvider,
  DataClass,
  DiscoveredCapability,
  HealthStatus,
  RegistryEntry,
  ResolvedCapability,
  Risk,
  SideEffect,
  TrustTier,
  Visibility,
} from '../ir/types.js';
import type { CapabilityRegistry, RouteConstraints } from './contracts.js';
import { deepClone } from '../runtime/projection.js';

/** Registry-level policy for discovered capabilities (I4). */
export interface RegistryDefaults {
  risk?: Risk;
  sideEffect?: SideEffect;
  dataClass?: DataClass;
  visibility?: Visibility;
  reversible?: boolean;
}

/** Conservative fallback when neither an override nor a registry default exists. */
export const REGISTRY_FALLBACK: Required<RegistryDefaults> = {
  risk: 'execute',
  sideEffect: 'non_idempotent',
  dataClass: 'internal',
  visibility: 'full',
  reversible: false,
};

export interface CapabilityRegistryOptions {
  now?: () => string;
  /** Registry-level risk policy; `registerDiscovered` falls back to this. */
  defaults?: RegistryDefaults;
}

const TRUST_RANK: Record<TrustTier, number> = { first_party: 2, verified: 1, untrusted: 0 };
const HEALTH_RANK: Record<HealthStatus, number> = { healthy: 2, degraded: 1, down: 0 };

/** Label key carrying a per-call cost estimate used by `maxCostUsd` routing. */
export const COST_LABEL = 'cost.usd';
/** Label key that turns several entries into one routable logical capability. */
export const LOGICAL_ID_LABEL = 'logicalId';
/** Label key that scopes an entry to a single tenant (I8). */
export const TENANT_LABEL = 'tenantId';

/** In-memory capability registry. Hosts may swap in a durable one. */
export class InMemoryCapabilityRegistry implements CapabilityRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly providers = new Map<string, CapabilityProvider>();
  private readonly byLogicalId = new Map<string, Set<string>>();
  private readonly now: () => string;
  private readonly defaults: RegistryDefaults;

  constructor(opts: CapabilityRegistryOptions = {}) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.defaults = opts.defaults ?? {};
  }

  // ── registration ────────────────────────────────────────────────────────

  async register(entry: RegistryEntry): Promise<void> {
    const capability = deepClone(entry.capability);
    const known = this.providers.get(capability.provider.id);
    this.providers.set(capability.provider.id, known === undefined ? deepClone(capability.provider) : { ...deepClone(capability.provider), health: known.health });
    this.entries.set(capability.id, { capability, labels: deepClone(entry.labels) });
    this.indexLogicalId(capability.id, entry.labels[LOGICAL_ID_LABEL]);
  }

  /**
   * Register adapter discovery output. The peer's `declaredRisk` is recorded
   * for audit only; the effective risk is `defaults.risk` (explicit override),
   * else the registry default, else {@link REGISTRY_FALLBACK}.
   */
  async registerDiscovered(
    provider: { id: string; protocol: 'mcp' | 'a2a' | 'acp' | 'local'; endpoint: string; version?: string; trust: TrustTier; ttlMs: number },
    discovered: DiscoveredCapability[],
    defaults?: RegistryDefaults,
  ): Promise<Capability[]> {
    const now = this.now();
    const known = this.providers.get(provider.id);
    const state: CapabilityProvider = {
      id: provider.id,
      protocol: provider.protocol,
      endpoint: provider.endpoint,
      ...(provider.version !== undefined ? { version: provider.version } : {}),
      trust: provider.trust,
      health: known?.health ?? 'healthy',
      ttlMs: provider.ttlMs,
      lastSeenAt: now,
    };
    this.providers.set(provider.id, state);

    const explicit = definedOnly(defaults ?? {});
    const effective: Required<RegistryDefaults> = {
      risk: explicit.risk ?? this.defaults.risk ?? REGISTRY_FALLBACK.risk,
      sideEffect: explicit.sideEffect ?? this.defaults.sideEffect ?? REGISTRY_FALLBACK.sideEffect,
      dataClass: explicit.dataClass ?? this.defaults.dataClass ?? REGISTRY_FALLBACK.dataClass,
      visibility: explicit.visibility ?? this.defaults.visibility ?? REGISTRY_FALLBACK.visibility,
      reversible: explicit.reversible ?? this.defaults.reversible ?? REGISTRY_FALLBACK.reversible,
    };
    const source = explicit.risk !== undefined
      ? 'explicit'
      : this.defaults.risk !== undefined
        ? 'registry-default'
        : 'registry-fallback';

    const out: Capability[] = [];
    for (const item of discovered) {
      const capability: Capability = {
        id: item.id,
        kind: item.kind,
        protocol: provider.protocol,
        displayName: item.displayName,
        ...(item.description !== undefined ? { description: item.description } : {}),
        ...(item.inputJsonSchema !== undefined ? { inputSchemaRef: `${item.id}#input` } : {}),
        ...(item.outputJsonSchema !== undefined ? { outputSchemaRef: `${item.id}#output` } : {}),
        risk: effective.risk,
        sideEffect: effective.sideEffect,
        dataClass: effective.dataClass,
        visibility: effective.visibility,
        reversible: effective.reversible,
        provider: deepClone(state),
      };
      const labels: Record<string, string> = {
        'provider.id': provider.id,
        'registry.riskSource': source,
        'registry.protocol': provider.protocol,
      };
      // Advisory wire data: recorded, never used to derive the effective risk.
      if (item.declaredRisk !== undefined) labels['peer.declaredRisk'] = item.declaredRisk;
      await this.register({ capability, labels });
      const stored = await this.get(capability.id);
      if (stored !== undefined) out.push(deepClone(stored.capability));
    }
    return out;
  }

  async remove(capabilityId: string): Promise<void> {
    const entry = this.entries.get(capabilityId);
    if (entry === undefined) return;
    this.entries.delete(capabilityId);
    const logical = entry.labels[LOGICAL_ID_LABEL];
    if (logical !== undefined) {
      const group = this.byLogicalId.get(logical);
      group?.delete(capabilityId);
      if (group !== undefined && group.size === 0) this.byLogicalId.delete(logical);
    }
  }

  // ── reads ───────────────────────────────────────────────────────────────

  async get(capabilityId: string, tenantId?: string): Promise<RegistryEntry | undefined> {
    const entry = this.entries.get(capabilityId);
    if (entry === undefined) return undefined;
    // I8: an entry scoped to another tenant is invisible, not merely absent.
    if (tenantId !== undefined && !visibleTo(entry, tenantId)) return undefined;
    return this.materialize(entry);
  }

  async list(filter?: { kind?: Capability['kind']; protocol?: string; q?: string; tenantId?: string }): Promise<Capability[]> {
    const q = filter?.q?.toLowerCase();
    const out: Capability[] = [];
    for (const entry of this.entries.values()) {
      const capability = this.materialize(entry).capability;
      if (filter?.kind !== undefined && capability.kind !== filter.kind) continue;
      if (filter?.protocol !== undefined && capability.protocol !== filter.protocol) continue;
      if (filter?.tenantId !== undefined && !visibleTo(entry, filter.tenantId)) continue;
      if (q !== undefined && q !== '') {
        const haystack = `${capability.id} ${capability.displayName} ${capability.description ?? ''}`.toLowerCase();
        if (!haystack.includes(q)) continue;
      }
      out.push(capability);
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * Route a logical capability id to a concrete provider.
   *
   * Candidates are the exact entry plus every entry sharing its `logicalId`
   * label (multi-provider routing). Constraints are applied as a hard filter —
   * trust first and never relaxed — then the best candidate is chosen by
   * trust → health → cost → provider id (deterministic).
   */
  async resolve(capabilityId: string, constraints: RouteConstraints): Promise<ResolvedCapability> {
    const ids = new Set<string>([capabilityId]);
    for (const id of this.byLogicalId.get(capabilityId) ?? []) ids.add(id);

    const candidates: { entry: RegistryEntry; capability: Capability; health: HealthStatus; cost: number }[] = [];
    let visible = 0;
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry === undefined) continue;
      if (!visibleTo(entry, constraints.tenantId)) continue;
      visible += 1;
      const materialized = this.materialize(entry);
      const capability = materialized.capability;
      const health = effectiveHealth(capability.provider, this.now());
      if (health === 'down') continue;
      if (constraints.requireTrust !== undefined && TRUST_RANK[capability.provider.trust] < TRUST_RANK[constraints.requireTrust]) continue;
      if (constraints.excludeProviders?.includes(capability.provider.id) === true) continue;
      if (constraints.requireVersion !== undefined && !versionSatisfies(capability.provider.version, constraints.requireVersion)) continue;
      const cost = costOf(entry);
      if (constraints.maxCostUsd !== undefined && cost > constraints.maxCostUsd) continue;
      candidates.push({ entry, capability, health, cost });
    }

    if (candidates.length === 0) {
      throw new CanonicalError({
        kind: visible > 0 ? 'unsupported_capability' : 'capability_not_found',
        message: visible > 0
          ? `no provider for ${capabilityId} satisfies the route constraints`
          : `capability ${capabilityId} is not registered`,
        details: { capabilityId, tenantId: constraints.tenantId },
      });
    }

    const preference = constraints.protocolPreference;
    let pool = candidates;
    if (preference !== undefined && preference.length > 0) {
      const preferred = candidates.filter((candidate) => preference.includes(candidate.capability.protocol));
      if (preferred.length > 0) pool = preferred;
    }

    const chosen = [...pool].sort((a, b) => {
      const trust = TRUST_RANK[b.capability.provider.trust] - TRUST_RANK[a.capability.provider.trust];
      if (trust !== 0) return trust;
      const health = HEALTH_RANK[b.health] - HEALTH_RANK[a.health];
      if (health !== 0) return health;
      if (a.cost !== b.cost) return a.cost - b.cost;
      return a.capability.provider.id < b.capability.provider.id ? -1 : a.capability.provider.id > b.capability.provider.id ? 1 : 0;
    })[0]!;

    return {
      capability: deepClone(chosen.capability),
      provider: deepClone(chosen.capability.provider),
      endpoint: chosen.capability.provider.endpoint,
    };
  }

  async markHealth(providerId: string, health: HealthStatus): Promise<void> {
    const known = this.providers.get(providerId);
    if (known === undefined) return;
    this.providers.set(providerId, { ...known, health, lastSeenAt: this.now() });
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** Attach the live provider state (health/ttl/lastSeenAt) to a stored entry. */
  private materialize(entry: RegistryEntry): RegistryEntry {
    const provider = this.providers.get(entry.capability.provider.id);
    if (provider === undefined) return deepClone(entry);
    return { capability: { ...deepClone(entry.capability), provider: deepClone(provider) }, labels: deepClone(entry.labels) };
  }

  private indexLogicalId(capabilityId: string, logicalId: string | undefined): void {
    if (logicalId === undefined || logicalId === '') return;
    const group = this.byLogicalId.get(logicalId) ?? new Set<string>();
    group.add(capabilityId);
    this.byLogicalId.set(logicalId, group);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

/** I8: an entry with a tenant label is visible only to that tenant. */
export function visibleTo(entry: RegistryEntry, tenantId: string): boolean {
  const scoped = entry.labels[TENANT_LABEL];
  return scoped === undefined || scoped === '' || scoped === tenantId;
}

/** TTL expiry degrades a provider to `down` without mutating the entry. */
export function effectiveHealth(provider: CapabilityProvider, nowIso: string): HealthStatus {
  if (provider.ttlMs > 0 && provider.lastSeenAt !== '') {
    const seen = Date.parse(provider.lastSeenAt);
    const now = Date.parse(nowIso);
    if (!Number.isNaN(seen) && !Number.isNaN(now) && now > seen + provider.ttlMs) return 'down';
  }
  return provider.health;
}

export function costOf(entry: RegistryEntry): number {
  const raw = entry.labels[COST_LABEL];
  if (raw === undefined) return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** `1.2` accepts `1.2` and `1.2.x`; `undefined` never satisfies a requirement. */
export function versionSatisfies(version: string | undefined, required: string): boolean {
  if (version === undefined) return false;
  return version === required || version.startsWith(`${required}.`);
}

function definedOnly<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = item;
  return out as T;
}
