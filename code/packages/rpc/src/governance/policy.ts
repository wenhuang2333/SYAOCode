/**
 * Policy decision point (02 §5).
 *
 * `RulePolicyEngine` implements the deterministic rule composition of 02 §5.4:
 *
 *   1. collect every matching rule
 *   2. an explicit `deny` vetoes everything, regardless of source or priority
 *   3. `ask` beats `allow`
 *   4. within one effect the lowest `priority` wins for the reason; the
 *      obligations of ALL matching rules are unioned (strictest wins)
 *   5. no match → the bundle's `defaultEffect`
 *   6. the revision is a digest of the bundle
 *   7. only `allow` decisions without time-sensitive obligations are cached
 *
 * `createPermissionPreset` bridges the existing `PermissionEngine` so the v0.2
 * local semantics keep working while the rule engine matures (02 §5.6:
 * "wrap first, replace later").
 */

import { globMatch, type IdGenerator, type PermissionEngine } from '@syaocode/core';
import type {
  Effect,
  Obligation,
  PolicyBundle,
  PolicyDecision,
  PolicyInput,
  PolicyRule,
  PolicyTrace,
  Risk,
} from '../ir/types.js';
import type { Hasher, LocalPolicyPreset, PolicyEngine } from './contracts.js';

/** Fields extracted from an invocation input for path/command/url matching. */
export interface SubjectFields {
  path?: string;
  command?: string;
  url?: string;
}

const PATH_KEYS = ['path', 'file_path', 'filePath', 'target', 'abs_path', 'absolute_path'];
const COMMAND_KEYS = ['command', 'cmd', 'script'];
const URL_KEYS = ['url', 'uri', 'endpoint'];

/**
 * Best-effort extraction of the matchable subject from an opaque input.
 * Only strings are considered; nested structures are not scanned, because a
 * policy must never depend on a value the model controls deeply.
 */
export function subjectFields(input: unknown): SubjectFields {
  if (input === null || typeof input !== 'object') return {};
  const obj = input as Record<string, unknown>;
  const out: SubjectFields = {};
  for (const key of PATH_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v !== '') { out.path = v; break; }
  }
  for (const key of COMMAND_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v !== '') { out.command = v; break; }
  }
  for (const key of URL_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v !== '') { out.url = v; break; }
  }
  return out;
}

/** Map the ARF risk vocabulary onto the kernel's `ToolRisk`. */
export function toToolRisk(risk: Risk): 'read' | 'write' | 'exec' | 'network' | 'meta' {
  switch (risk) {
    case 'read': return 'read';
    case 'write': return 'write';
    case 'execute': return 'exec';
    case 'network': return 'network';
    case 'spend':
    case 'delegate': return 'write';
  }
}

export interface RulePolicyEngineOptions {
  bundle: PolicyBundle;
  ids: IdGenerator;
  /** Injected clock so tests are deterministic. */
  now: () => string;
  /** Optional bridge to the existing local permission engine. */
  preset?: LocalPolicyPreset;
  /** Decision cache TTL in ms (max 30s per 02 §5.4 step 7). */
  cacheTtlMs?: number;
}

const MAX_CACHE_TTL_MS = 30_000;

export class RulePolicyEngine implements PolicyEngine {
  private bundle: PolicyBundle;
  private readonly ids: IdGenerator;
  private readonly now: () => string;
  private readonly preset?: LocalPolicyPreset;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, { decision: PolicyDecision; expiresAt: number }>();

  constructor(opts: RulePolicyEngineOptions) {
    this.bundle = opts.bundle;
    this.ids = opts.ids;
    this.now = opts.now;
    if (opts.preset !== undefined) this.preset = opts.preset;
    this.cacheTtlMs = Math.min(opts.cacheTtlMs ?? 15_000, MAX_CACHE_TTL_MS);
  }

  get revision(): string {
    return this.bundle.revision;
  }

  /** Swap the bundle (hot update); the revision change clears the cache. */
  setBundle(bundle: PolicyBundle): void {
    this.bundle = bundle;
    this.invalidate();
  }

  invalidate(): void {
    this.cache.clear();
  }

  async evaluate(input: PolicyInput): Promise<PolicyDecision> {
    const cached = this.lookup(input);
    if (cached !== undefined) return cached;
    const decision = await this.decide(input);
    if (decision.effect === 'allow' && !hasTimeSensitiveObligation(decision.obligations)) {
      this.cache.set(cacheKey(input), { decision, expiresAt: Date.parse(this.now()) + this.cacheTtlMs });
    }
    return decision;
  }

  async explain(input: PolicyInput): Promise<PolicyDecision> {
    const decision = await this.decide(input);
    return { ...decision, explain: this.traceOf(input, decision) };
  }

  private lookup(input: PolicyInput): PolicyDecision | undefined {
    const hit = this.cache.get(cacheKey(input));
    if (hit === undefined) return undefined;
    if (Date.parse(this.now()) >= hit.expiresAt) {
      this.cache.delete(cacheKey(input));
      return undefined;
    }
    return hit.decision;
  }

  private async decide(input: PolicyInput): Promise<PolicyDecision> {
    const subject = subjectFields(input.input);
    const matched = this.bundle.rules.filter((rule) => matches(rule, input, subject));

    // The local preset participates as an extra rule with the strongest
    // position, so a local deny cannot be relaxed by an org allow.
    const presetVerdict = await this.presetVerdict(input);

    const denied = matched.filter((r) => r.effect === 'deny');
    const asked = matched.filter((r) => r.effect === 'ask');
    const allowed = matched.filter((r) => r.effect === 'allow');

    const obligations = unionObligations(matched.flatMap((r) => r.obligations ?? []));

    let effect: Effect;
    let winner: PolicyRule | undefined;
    let reason: string;

    // Precedence: deny (any source) > ask (any source) > allow > default.
    // The preset participates at the SAME level as a rule, so it can tighten
    // but never be widened by an ARF allow.
    if (denied.length > 0) {
      effect = 'deny';
      winner = byPriority(denied)[0];
      reason = winner?.reason ?? `Denied by rule '${winner?.id ?? 'unknown'}'.`;
    } else if (presetVerdict?.effect === 'deny') {
      effect = 'deny';
      reason = presetVerdict.reason;
    } else if (asked.length > 0) {
      effect = 'ask';
      winner = byPriority(asked)[0];
      reason = winner?.reason ?? `Rule '${winner?.id ?? 'unknown'}' requires approval.`;
    } else if (presetVerdict?.effect === 'ask') {
      effect = 'ask';
      reason = presetVerdict.reason;
    } else if (allowed.length > 0) {
      effect = 'allow';
      winner = byPriority(allowed)[0];
      reason = winner?.reason ?? `Allowed by rule '${winner?.id ?? 'unknown'}'.`;
    } else if (presetVerdict?.effect === 'allow') {
      effect = 'allow';
      reason = presetVerdict.reason;
    } else {
      effect = this.bundle.defaultEffect;
      reason =
        effect === 'deny'
          ? 'No policy rule matched and the bundle default is deny.'
          : 'No policy rule matched; the bundle default allows it.';
    }

    const decision: PolicyDecision = {
      id: this.ids.next('dec'),
      effect,
      reason,
      policyRevision: this.bundle.revision,
      obligations,
    };
    return decision;
  }

  /**
   * The local safety verdict — dangerous-command library (BR-006), workspace
   * path fence (BR-003), sensitive-path rule — for EVERY capability, not only
   * `local://`.
   *
   * This used to run only for local capabilities, which meant a single
   * `mcp://**` allow rule silently disabled all of the v0.2 safety work on
   * every protocol edge: `rm -rf /`, `/etc/passwd` and `~/.ssh/id_rsa` all
   * went through ungoverned. The safety floor is protocol-independent.
   */
  private async presetVerdict(input: PolicyInput): Promise<{ effect: Effect; reason: string } | undefined> {
    if (this.preset === undefined) return undefined;
    return await this.preset.evaluateLocal(input);
  }

  private traceOf(input: PolicyInput, decision: PolicyDecision): PolicyTrace {
    const subject = subjectFields(input.input);
    const matched = this.bundle.rules.filter((rule) => matches(rule, input, subject));
    const denied = byPriority(matched.filter((r) => r.effect === 'deny'))[0];
    const asked = byPriority(matched.filter((r) => r.effect === 'ask'))[0];
    const trace: PolicyTrace = {
      matchedRules: matched.map((r) => ({ id: r.id, effect: r.effect, source: r.source })),
      obligations: decision.obligations,
      effectiveMode: this.preset?.mode ?? this.bundle.defaultEffect,
      revision: this.bundle.revision,
    };
    if (denied !== undefined) trace.deniedBy = denied.id;
    if (asked !== undefined) trace.askedBy = asked.id;
    return trace;
  }
}

function byPriority(rules: PolicyRule[]): PolicyRule[] {
  return [...rules].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function unionObligations(obligations: Obligation[]): Obligation[] {
  const seen = new Map<string, Obligation>();
  for (const o of obligations) {
    const key = obligationKey(o);
    if (!seen.has(key)) seen.set(key, o);
  }
  return [...seen.values()];
}

function obligationKey(o: Obligation): string {
  switch (o.type) {
    case 'require_approval': return `require_approval:${(o.options ?? []).map((x) => x.id).join(',')}`;
    case 'redact': return `redact:${o.classes.join(',')}`;
    case 'max_output_bytes': return `max_output_bytes:${o.bytes}`;
    case 'sandbox': return `sandbox:${o.level}`;
    case 'network_allowlist': return `network_allowlist:${o.hosts.join(',')}`;
    case 'audit_level': return `audit_level:${o.level}`;
    case 'no_retry': return 'no_retry';
    case 'ttl': return `ttl:${o.ms}`;
    case 'delegation_limit': return `delegation_limit:${o.maxHops}:${o.maxSpendUsd ?? ''}`;
  }
}

function hasTimeSensitiveObligation(obligations: Obligation[]): boolean {
  return obligations.some((o) => o.type === 'ttl' || o.type === 'require_approval');
}

function matches(rule: PolicyRule, input: PolicyInput, subject: SubjectFields): boolean {
  const m = rule.match;
  if (m.tenants !== undefined && !m.tenants.some((t) => globMatch(t, input.principal.tenantId))) return false;
  if (m.principals !== undefined && !m.principals.some((p) => globMatch(p, input.principal.id))) return false;
  if (m.capabilities !== undefined && !m.capabilities.some((c) => globMatch(c, input.capability.id))) return false;
  if (m.protocols !== undefined && !m.protocols.includes(input.capability.protocol)) return false;
  if (m.directions !== undefined && !m.directions.includes(input.context.direction)) return false;
  if (m.risk !== undefined && !m.risk.includes(input.capability.risk)) return false;
  if (m.dataClasses !== undefined && !m.dataClasses.includes(input.capability.dataClass)) return false;
  if (m.paths !== undefined) {
    if (subject.path === undefined) return false;
    if (!m.paths.some((p) => globMatch(p, subject.path!))) return false;
  }
  if (m.commands !== undefined) {
    if (subject.command === undefined) return false;
    if (!m.commands.some((c) => globMatch(c, subject.command!))) return false;
  }
  if (m.urls !== undefined) {
    if (subject.url === undefined) return false;
    if (!m.urls.some((u) => globMatch(u, subject.url!))) return false;
  }
  return true;
}

/**
 * Cache identity. Includes every capability attribute the rules can match on,
 * so a capability whose risk or data class changed can never reuse a decision
 * made for its previous shape.
 */
function cacheKey(input: PolicyInput): string {
  return [
    input.capability.id,
    input.capability.risk,
    input.capability.sideEffect,
    input.capability.dataClass,
    input.capability.visibility,
    input.principal.id,
    input.principal.tenantId,
    input.principal.trustTier,
    input.context.direction,
    input.context.protocol,
    input.inputHash,
  ].join('|');
}

// ── bridge to the existing local permission engine ────────────────────────

export interface PermissionPresetOptions {
  /** Tool name used for rule matching; defaults to the capability id. */
  toolNameFor?: (capabilityId: string) => string;
  mode?: string;
}

/**
 * Wrap core's `PermissionEngine` as a `LocalPolicyPreset`.
 *
 * Only the deterministic half is used (`policyVerdict`); the approval handler
 * stays out of the policy engine so `ask` decisions can be routed through the
 * ApprovalBroker instead of an inline prompt (02 §5.6).
 */
export function createPermissionPreset(
  engine: PermissionEngine,
  opts: PermissionPresetOptions = {},
): LocalPolicyPreset {
  const toolNameFor = opts.toolNameFor ?? ((id: string) => id);
  return {
    mode: opts.mode ?? engine.mode,
    async evaluateLocal(input: PolicyInput): Promise<{ effect: Effect; reason: string }> {
      const subject = subjectFields(input.input);
      const verdict = await engine.policyVerdict(
        toolNameFor(input.capability.id),
        toToolRisk(input.capability.risk),
        {
          ...(subject.path !== undefined ? { path: subject.path } : {}),
          ...(subject.command !== undefined ? { command: subject.command } : {}),
          ...(subject.url !== undefined ? { url: subject.url } : {}),
        },
      );
      switch (verdict.outcome) {
        case 'allow':
          return { effect: 'allow', reason: 'Allowed by the local permission engine.' };
        case 'deny':
          return { effect: 'deny', reason: verdict.error.message };
        case 'ask':
          return { effect: 'ask', reason: verdict.reason };
      }
    },
  };
}

/** Convenience: the default effect of a bundle is deny unless stated. */
export function defaultEffectOf(bundle: PolicyBundle): Effect {
  return bundle.defaultEffect;
}
