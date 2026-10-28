/**
 * Governance console panels (`/rpc`, `/peer`, `/call`, `/serve`).
 *
 * PURE functions returning `string[]` panel lines built from `tui/panel.ts`
 * helpers. No IO, no terminal access, no fabric instance — the callers (REPL /
 * TUI / argv runners) fetch the data and hand it over, which is what makes
 * these panels unit-testable without a TTY.
 *
 * Two hard rules:
 *   1. every panel stays legible in an 80-column terminal (width ≤ 78);
 *   2. an empty list never renders as a bare header — it renders a next step.
 */

import type {
  ApprovalRecord,
  AuditEvent,
  AuditVerifyResult,
  BudgetAccount,
  CanonicalEvent,
  Capability,
  PolicyDecision,
  Receipt,
  Task,
} from '@syaocode/rpc';
import { t, type MsgKey } from './i18n/index.js';
import { C, badge, bar, kv, panel, section, table } from './tui/panel.js';
import { displayWidth, truncateToWidth } from './tui/width.js';

/** Outer panel width: 78 columns fits an 80-column terminal with 2 to spare. */
export const PANEL_WIDTH = 78;

/** One row of the protocol-edge table. */
export interface PeerRow {
  providerId: string;
  protocol: string;
  version: string;
  capabilities: number;
  health: string;
  lossy: string[];
  endpoint?: string;
  trust?: string;
  /** Registered in the local peer registry but not mounted in this build. */
  unavailable?: boolean;
}

export interface RpcOverview {
  tenantId: string;
  policyRevision: string;
  capabilityCount: number;
  pendingApprovals: number;
  tasks: { total: number; unterminated: number };
  adapters: readonly PeerRow[];
  budget: readonly BudgetAccount[];
  audit: AuditVerifyResult;
  recent: readonly Receipt[];
}

export interface CallOutcome {
  capabilityId: string;
  outcome: string;
  receiptId?: string;
  taskId?: string;
  invocationId?: string;
  /** Already redacted by the caller when it came from tool output. */
  output?: string;
  error?: { kind: string; code?: string; message: string };
  approvalIds: readonly string[];
  /** Approval trail: id → decision, when known. */
  approvalTrail?: readonly { id: string; state: string; optionId?: string | undefined }[];
  lossy: readonly string[];
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  replayed?: boolean;
}

export interface ServePlan {
  protocol: 'mcp' | 'acp' | 'a2a';
  transport: 'stdio' | 'http';
  host: string;
  port: number;
  /** True when a bearer token is configured (required for non-loopback). */
  tokenConfigured: boolean;
  /** Endpoints that will be exposed once the listener is up. */
  endpoints: readonly string[];
  /** Validation failures; non-empty means runServe() must refuse to listen. */
  errors: readonly string[];
  /** Codes for the errors above (stable, e.g. SY-SRV-002). */
  errorCodes: readonly string[];
  /** True when the protocol edge cannot be constructed in this build. */
  edgeUnavailable: boolean;
  notes: readonly string[];
}

export interface ServeState {
  listening: boolean;
  endpoints: readonly string[];
  startedAt?: string;
  detail?: string;
}

// ── small helpers ─────────────────────────────────────────────────────────

function panelOf(title: string, body: string[]): string[] {
  return panel(title, body, { maxWidth: PANEL_WIDTH });
}

function clip(text: string, cols: number): string {
  return truncateToWidth(text, cols)[0];
}

function oneLine(value: unknown, cols = 40): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return clip((text ?? '').replace(/\s+/g, ' ').trim(), cols);
}

/** Readable preview of a task's first input block (never raw JSON for text). */
function taskInputText(task: Task, cols = 48): string {
  const block = task.input[0];
  if (block === undefined) return '—';
  if (block.type === 'text') return clip(block.text.replace(/\s+/g, ' ').trim(), cols);
  if (block.type === 'data') return clip(`${block.mediaType} ${block.ref}`, cols);
  return clip(`${block.protocol} ${oneLine(block.native, 24)}`, cols);
}

function stateColor(state: string): string {
  switch (state) {
    case 'completed':
    case 'succeeded':
    case 'allowed':
    case 'healthy':
    case 'active':
      return C.green(state);
    case 'failed':
    case 'rejected':
    case 'denied':
    case 'expired':
    case 'down':
    case 'frozen':
      return C.red(state);
    case 'working':
    case 'working ':
    case 'submitted':
    case 'pending':
    case 'input_required':
    case 'degraded':
      return C.yellow(state);
    default:
      return C.dim(state);
  }
}

function healthBadge(health: string): string {
  const color = health === 'healthy' ? 46 : health === 'degraded' ? 214 : 196;
  return badge(health, color);
}

function shortId(id: string, cols = 14): string {
  return clip(id, cols);
}

/** ISO timestamp → `MM-DD HH:mm` (data value, not UI copy). */
function stamp(iso: string | undefined): string {
  if (iso === undefined || iso === '') return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return clip(iso, 16);
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function usd(n: number | undefined): string {
  return n === undefined ? '—' : `$${n.toFixed(4)}`;
}

function emptyState(key: MsgKey): string {
  return C.dim(t(key));
}

// ── lossy notes ───────────────────────────────────────────────────────────

/**
 * Known lossy codes → catalogue keys. Unknown codes still render (with the raw
 * code) so a new adapter can never hide a degradation by inventing a string.
 */
const LOSSY_KEYS: Readonly<Record<string, MsgKey>> = {
  // ── real codes emitted by @syaocode/protocols ─────────────────────────
  'mcp-legacy': 'lossy.mcpLegacy',
  'mcp-no-session': 'lossy.mcpNoSession',
  'mcp-no-server-initiated-request': 'lossy.mcpNoServerInitiatedRequest',
  'mcp-task-extension-optional': 'lossy.mcpTaskExtensionOptional',
  'mcp-annotations-untrusted': 'lossy.mcpAnnotationsUntrusted',
  'mcp-mrtr-unsupported': 'lossy.mcpMrtrUnsupported',
  'a2a-remote-task-opaque': 'lossy.a2aRemoteTaskOpaque',
  'a2a-no-approval-options': 'lossy.a2aNoApprovalOptions',
  'a2a-weak-session': 'lossy.a2aWeakSession',
  'a2a-agent-card-untrusted': 'lossy.a2aAgentCardUntrusted',
  'a2a-expired-maps-to-failed': 'lossy.a2aExpiredMapsToFailed',
  'acp-no-task-state': 'lossy.acpNoTaskState',
  'acp-no-artifacts': 'lossy.acpNoArtifacts',
  'acp-no-denied-outcome': 'lossy.acpNoDeniedOutcome',
  'acp-fs-client-owned': 'lossy.acpFsClientOwned',
  'acp-client-capability-missing': 'lossy.acpClientCapabilityMissing',
  // ── kernel / generic markers ──────────────────────────────────────────
  'untrusted-content': 'lossy.untrustedContent',
  'no-streaming': 'lossy.noStreaming',
  'summary-only': 'lossy.summaryOnly',
  'opaque-output': 'lossy.opaqueOutput',
};

/** Human sentence for one lossy code (never empty, never the raw code alone). */
export function lossyText(code: string): string {
  const key = LOSSY_KEYS[code];
  return key !== undefined ? t(key) : t('rpc.lossyUnknown', { code });
}

/** Degradation must be visible: one line per code, with a warning glyph. */
export function lossyNotes(entries: readonly string[]): string[] {
  const unique = [...new Set(entries.filter((e) => e !== ''))];
  if (unique.length === 0) return [];
  return [
    section(t('rpc.sect.lossy')),
    ...unique.map((code) => `${C.yellow('△')} ${C.dim(lossyText(code))}`),
  ];
}

// ── overview dashboard (/rpc with no args) ────────────────────────────────

export function rpcOverviewPanel(o: RpcOverview): string[] {
  const body: string[] = [
    section(t('rpc.sect.governance')),
    kv(t('rpc.tbl.tenant'), C.cyan(o.tenantId), 12),
    kv(t('rpc.tbl.policyRev'), C.dim(shortId(o.policyRevision, 44)), 12),
    kv(t('rpc.tbl.capabilities'), C.bold(String(o.capabilityCount)), 12),
    kv(
      t('rpc.tbl.tasks'),
      `${C.bold(String(o.tasks.total))} ${C.dim(t('rpc.val.tasksOpen', { n: o.tasks.unterminated }))}`,
      12,
    ),
    kv(
      t('rpc.tbl.approvals'),
      o.pendingApprovals > 0 ? C.yellow(String(o.pendingApprovals)) : C.dim('0'),
      12,
    ),
    kv(
      t('rpc.tbl.audit'),
      o.audit.ok
        ? `${C.green('✔')} ${C.dim(t('rpc.val.auditOk', { n: o.audit.checked }))}`
        : `${C.red('✘')} ${C.dim(t('rpc.val.auditBroken', { at: o.audit.brokenAt ?? '?' }))}`,
      12,
    ),
    '',
    section(t('rpc.sect.edges', { n: o.adapters.length })),
    ...(o.adapters.length > 0
      ? table(
          [t('rpc.tbl.edge'), t('rpc.tbl.protocol'), t('rpc.tbl.caps'), t('rpc.tbl.health')],
          o.adapters.map((a) => [
            C.cyan(clip(a.providerId, 22)),
            C.dim(a.protocol),
            String(a.capabilities),
            healthBadge(a.health),
          ]),
        )
      : [emptyState('rpc.empty.edges')]),
  ];

  const spend = o.budget[0];
  body.push('', section(t('rpc.sect.budget')));
  if (spend === undefined) {
    body.push(emptyState('rpc.empty.budget'));
  } else {
    const ratio = spend.limitUsd !== undefined && spend.limitUsd > 0 ? (spend.spentUsd + spend.reservedUsd) / spend.limitUsd : 0;
    body.push(
      kv(
        t('rpc.tbl.account'),
        `${C.cyan(clip(spend.id, 18))}  ${bar(ratio, 18, ratio > 0.85 ? 196 : 45)} ${C.dim(
          spend.limitUsd === undefined ? t('rpc.val.noLimit') : `${usd(spend.spentUsd + spend.reservedUsd)} / ${usd(spend.limitUsd)}`,
        )}`,
        12,
      ),
    );
  }

  body.push('', section(t('rpc.sect.recent')));
  if (o.recent.length === 0) {
    body.push(emptyState('rpc.empty.recent'));
  } else {
    body.push(
      ...table(
        [t('rpc.tbl.receipt'), t('rpc.tbl.capability'), t('rpc.tbl.outcome')],
        o.recent.slice(0, 6).map((r) => [
          C.dim(shortId(r.id, 22)),
          C.cyan(clip(r.capabilityId, 34)),
          `${stateColor(r.outcome)} ${C.dim(stamp(r.timing.endedAt))}`,
        ]),
        { divider: false },
      ),
    );
  }

  const lossy = o.adapters.flatMap((a) => a.lossy);
  const notes = lossyNotes(lossy);
  if (notes.length > 0) body.push('', ...notes);
  body.push('', C.dim(t('rpc.hint.overview')));
  return panelOf(t('rpc.panel.overview'), body);
}

// ── tasks ─────────────────────────────────────────────────────────────────

export function tasksPanel(tasks: readonly Task[]): string[] {
  const body: string[] = [section(t('rpc.sect.tasks', { n: tasks.length }))];
  if (tasks.length === 0) {
    body.push(emptyState('rpc.empty.tasks'), '', C.dim(t('rpc.hint.tasks')));
  } else {
    body.push(
      ...table(
        [t('rpc.tbl.id'), t('rpc.tbl.state'), t('rpc.tbl.seq'), t('rpc.tbl.updated')],
        tasks.map((task) => [
          C.cyan(shortId(task.id, 22)),
          stateColor(task.state),
          String(task.lastSeq),
          C.dim(stamp(task.updatedAt)),
        ]),
        { divider: false },
      ),
      '',
      section(t('rpc.tbl.input')),
      // The input preview gets its own line so a long prompt is not squeezed
      // out of the table by the id/state columns.
      ...tasks.slice(0, 8).map(
        (task) => `${C.dim('·')} ${C.cyan(clip(task.id, 20))} ${C.dim(taskInputText(task, 46))}`,
      ),
      '',
      C.dim(t('rpc.hint.taskDetail')),
    );
  }
  return panelOf(t('rpc.panel.tasks'), body);
}

export function taskDetailPanel(task: Task, events: readonly CanonicalEvent[], receipts: readonly Receipt[]): string[] {
  const body: string[] = [
    section(t('rpc.sect.task')),
    kv(t('rpc.tbl.id'), C.cyan(task.id), 12),
    kv(t('rpc.tbl.state'), stateColor(task.state), 12),
    kv(t('rpc.tbl.session'), C.dim(task.sessionId), 12),
    kv(t('rpc.tbl.seq'), String(task.lastSeq), 12),
    kv(t('rpc.tbl.created'), C.dim(stamp(task.createdAt)), 12),
    kv(t('rpc.tbl.updated'), C.dim(stamp(task.updatedAt)), 12),
    ...(task.terminalReason !== undefined ? [kv(t('rpc.tbl.reason'), C.dim(task.terminalReason), 12)] : []),
    kv(t('rpc.tbl.input'), C.dim(taskInputText(task, 54)), 12),
    '',
    section(t('rpc.sect.receipts', { n: receipts.length })),
  ];
  if (receipts.length === 0) {
    body.push(emptyState('rpc.empty.receipts'));
  } else {
    body.push(
      ...table(
        [t('rpc.tbl.receipt'), t('rpc.tbl.capability'), t('rpc.tbl.outcome'), t('rpc.tbl.cost')],
        receipts.map((r) => [
          C.dim(shortId(r.id, 22)),
          C.cyan(clip(r.capabilityId, 26)),
          stateColor(r.outcome),
          C.dim(usd(r.usage?.costUsd)),
        ]),
        { divider: false },
      ),
    );
  }
  body.push('', section(t('rpc.sect.events', { n: events.length })));
  if (events.length === 0) {
    body.push(emptyState('rpc.empty.events'));
  } else {
    body.push(
      ...events.slice(-8).map((e) => `${C.dim(String(e.seq).padStart(3))} ${C.c256(45, clip(e.type, 26))} ${C.dim(stamp(e.ts))}`),
    );
  }
  const lossy = receipts.flatMap((r) => r.lossy ?? []);
  const notes = lossyNotes(lossy);
  if (notes.length > 0) body.push('', ...notes);
  body.push('', C.dim(t('rpc.hint.evidence')));
  return panelOf(t('rpc.panel.task'), body);
}

// ── approvals ─────────────────────────────────────────────────────────────

export function approvalsPanel(records: readonly ApprovalRecord[]): string[] {
  const body: string[] = [section(t('rpc.sect.approvals', { n: records.length }))];
  if (records.length === 0) {
    body.push(emptyState('rpc.empty.approvals'), '', C.dim(t('rpc.hint.approvals')));
    return panelOf(t('rpc.panel.approvals'), body);
  }
  for (const r of records) {
    const options = r.options.map((o) => C.cyan(o.id)).join(C.dim(' · '));
    body.push(
      `${C.yellow('●')} ${C.bold(shortId(r.id, 22))}  ${stateColor(r.state)}  ${C.dim(t('rpc.val.rev', { n: r.revision }))}`,
      `  ${C.dim(t('rpc.tbl.subject'))} ${clip(r.subject.summary, 60)}`,
      `  ${C.dim(t('rpc.tbl.kind'))} ${r.subject.kind}${r.sensitive ? `  ${C.red(t('rpc.val.sensitive'))}` : ''}`,
      `  ${C.dim(t('rpc.tbl.options'))} ${options}`,
      `  ${C.dim(t('rpc.tbl.expires'))} ${stamp(r.expiresAt)}`,
      '',
    );
  }
  body.push(C.dim(t('rpc.hint.approveCmd')));
  return panelOf(t('rpc.panel.approvals'), body);
}

// ── budget ────────────────────────────────────────────────────────────────

export function budgetPanel(accounts: readonly BudgetAccount[]): string[] {
  const body: string[] = [section(t('rpc.sect.budgetN', { n: accounts.length }))];
  if (accounts.length === 0) {
    body.push(emptyState('rpc.empty.budget'), '', C.dim(t('rpc.hint.budget')));
    return panelOf(t('rpc.panel.budget'), body);
  }
  for (const a of accounts) {
    const committed = a.spentUsd + a.reservedUsd;
    const ratio = a.limitUsd !== undefined && a.limitUsd > 0 ? committed / a.limitUsd : 0;
    const pct = a.limitUsd !== undefined && a.limitUsd > 0 ? `${Math.round(ratio * 100)}%` : t('rpc.val.noLimit');
    body.push(
      `${C.bold(clip(a.id, 20))}  ${stateColor(a.state)}`,
      `  ${C.dim(t('rpc.tbl.spend'))} ${usd(a.spentUsd)}  ${C.dim(t('rpc.tbl.held'))} ${usd(a.reservedUsd)}  ${C.dim(t('rpc.tbl.limit'))} ${
        a.limitUsd === undefined ? C.dim(t('rpc.val.noLimit')) : usd(a.limitUsd)
      }`,
      `  ${bar(ratio, 24, ratio > 0.85 ? 196 : ratio > 0.6 ? 214 : 45)} ${C.dim(pct)}`,
      `  ${C.dim(t('rpc.tbl.tokens'))} ${a.tokensUsed}${a.tokenLimit !== undefined ? ` / ${a.tokenLimit}` : ''}  ${C.dim(
        t('rpc.tbl.toolCalls'),
      )} ${a.toolCallsUsed}${a.toolCallLimit !== undefined ? ` / ${a.toolCallLimit}` : ''}`,
      '',
    );
  }
  body.push(C.dim(t('rpc.hint.budget')));
  return panelOf(t('rpc.panel.budget'), body);
}

// ── audit ─────────────────────────────────────────────────────────────────

export function auditPanel(events: readonly AuditEvent[], verify: AuditVerifyResult): string[] {
  const verdict = verify.ok
    ? `${C.green('✔')} ${C.dim(t('rpc.val.auditOk', { n: verify.checked }))}`
    : `${C.red('✘')} ${C.dim(t('rpc.val.auditBroken', { at: verify.brokenAt ?? '?' }))}`;
  const body: string[] = [
    section(t('rpc.sect.audit')),
    kv(t('rpc.tbl.chain'), verdict, 12),
    ...(verify.reason !== undefined ? [kv(t('rpc.tbl.reason'), C.dim(verify.reason), 12)] : []),
    '',
    section(t('rpc.sect.auditEvents', { n: events.length })),
  ];
  if (events.length === 0) {
    body.push(emptyState('rpc.empty.audit'), '', C.dim(t('rpc.hint.audit')));
  } else {
    body.push(
      ...table(
        [t('rpc.tbl.when'), t('rpc.tbl.action'), t('rpc.tbl.actor'), t('rpc.tbl.outcome')],
        events.slice(-10).map((e) => [
          C.dim(stamp(e.ts)),
          C.c256(45, clip(e.action, 22)),
          C.dim(clip(`${e.actor.type}:${e.actor.id}`, 18)),
          stateColor(e.outcome),
        ]),
        { divider: false },
      ),
    );
  }
  return panelOf(t('rpc.panel.audit'), body);
}

// ── policy ────────────────────────────────────────────────────────────────

export function policyPanel(decision: PolicyDecision, capabilityId: string): string[] {
  const effect = decision.effect === 'allow' ? C.green('allow') : decision.effect === 'deny' ? C.red('deny') : C.yellow('ask');
  const body: string[] = [
    section(t('rpc.sect.policy')),
    kv(t('rpc.tbl.capability'), C.cyan(clip(capabilityId, 52)), 12),
    kv(t('rpc.tbl.effect'), effect, 12),
    kv(t('rpc.tbl.policyRev'), C.dim(shortId(decision.policyRevision, 44)), 12),
    kv(t('rpc.tbl.reason'), C.dim(clip(decision.reason, 52)), 12),
    '',
    section(t('rpc.sect.obligations', { n: decision.obligations.length })),
    ...(decision.obligations.length > 0
      ? decision.obligations.map((o) => `${C.yellow('•')} ${clip(JSON.stringify(o), 66)}`)
      : [emptyState('rpc.empty.obligations')]),
  ];
  if (decision.explain !== undefined) {
    body.push(
      '',
      section(t('rpc.sect.rules', { n: decision.explain.matchedRules.length })),
      ...(decision.explain.matchedRules.length > 0
        ? table(
            [t('rpc.tbl.rule'), t('rpc.tbl.effect'), t('rpc.tbl.source')],
            decision.explain.matchedRules.map((r) => [C.cyan(clip(r.id, 28)), r.effect, C.dim(r.source)]),
            { divider: false },
          )
        : [emptyState('rpc.empty.rules')]),
      '',
      kv(t('rpc.tbl.mode'), C.dim(decision.explain.effectiveMode), 12),
    );
  }
  return panelOf(t('rpc.panel.policy'), body);
}

// ── peers / protocol edges ────────────────────────────────────────────────

export function peersPanel(peers: readonly PeerRow[], notes: readonly string[] = []): string[] {
  const body: string[] = [section(t('rpc.sect.peers', { n: peers.length }))];
  if (peers.length === 0) {
    body.push(emptyState('rpc.empty.peers'));
  } else {
    body.push(
      ...table(
        [t('rpc.tbl.edge'), t('rpc.tbl.protocol'), t('rpc.tbl.caps'), t('rpc.tbl.health'), t('rpc.tbl.trust')],
        peers.map((p) => [
          `${p.unavailable === true ? C.dim('○') : C.green('●')} ${C.cyan(clip(p.providerId, 20))}`,
          C.dim(p.protocol),
          String(p.capabilities),
          healthBadge(p.health),
          C.dim(p.trust ?? '—'),
        ]),
      ),
      '',
      ...peers.map((p) =>
        `${C.dim('·')} ${C.cyan(clip(p.providerId, 18))} ${C.dim(clip(p.endpoint ?? '—', 46))}${
          p.unavailable === true ? ` ${C.yellow(t('rpc.val.registryOnly'))}` : ''
        }`,
      ),
    );
    const lossy = peers.flatMap((p) => p.lossy);
    if (lossy.length > 0) body.push('', ...lossyNotes(lossy));
  }
  if (notes.length > 0) body.push('', ...notes.map((n) => C.dim(n)));
  body.push('', C.dim(t('rpc.hint.peers')));
  return panelOf(t('rpc.panel.peers'), body);
}

// ── one governed invocation ───────────────────────────────────────────────

export function callResultPanel(result: CallOutcome, opts: { redact?: (text: string) => string } = {}): string[] {
  const redact = opts.redact ?? ((text: string) => text);
  const outcome = stateColor(result.outcome);
  const body: string[] = [
    section(t('rpc.sect.invocation')),
    kv(t('rpc.tbl.capability'), C.cyan(clip(result.capabilityId, 52)), 12),
    kv(t('rpc.tbl.outcome'), outcome, 12),
    ...(result.receiptId !== undefined ? [kv(t('rpc.tbl.receipt'), C.dim(result.receiptId), 12)] : []),
    ...(result.taskId !== undefined ? [kv(t('rpc.tbl.task'), C.dim(result.taskId), 12)] : []),
    ...(result.invocationId !== undefined ? [kv(t('rpc.tbl.invocation'), C.dim(result.invocationId), 12)] : []),
    ...(result.replayed === true ? [kv(t('rpc.tbl.replayed'), C.yellow(t('rpc.val.yes')), 12)] : []),
    kv(
      t('rpc.tbl.cost'),
      usd(result.costUsd) +
        (result.inputTokens !== undefined || result.outputTokens !== undefined
          ? `  ${C.dim(t('rpc.val.tokens', { input: result.inputTokens ?? 0, output: result.outputTokens ?? 0 }))}`
          : ''),
      12,
    ),
  ];

  if (result.error !== undefined) {
    body.push(
      '',
      section(t('rpc.sect.error')),
      `${C.red('✖')} ${C.bold(result.error.kind)}${result.error.code !== undefined ? ` ${C.dim(`[${result.error.code}]`)}` : ''}`,
      `  ${C.dim(redact(clip(result.error.message, 68)))}`,
    );
  }

  body.push('', section(t('rpc.sect.approvalTrail')));
  const trail: readonly { id: string; state: string; optionId?: string | undefined }[] =
    result.approvalTrail ?? result.approvalIds.map((id) => ({ id, state: 'requested' }));
  if (trail.length === 0) {
    // A call that failed must never claim "the policy allowed it directly".
    body.push(emptyState(result.error !== undefined ? 'rpc.empty.approvalTrailSkipped' : 'rpc.empty.approvalTrail'));
  } else {
    body.push(
      ...table(
        [t('rpc.tbl.approval'), t('rpc.tbl.state'), t('rpc.tbl.option')],
        trail.map((a) => [C.dim(shortId(a.id, 24)), stateColor(a.state), C.dim(a.optionId ?? '—')]),
        { divider: false },
      ),
    );
  }

  body.push('', section(t('rpc.sect.output')));
  if (result.output === undefined || result.output === '') {
    body.push(emptyState('rpc.empty.output'));
  } else {
    const lines = redact(result.output).split('\n').slice(0, 12);
    body.push(...lines.map((l) => C.dim(clip(l, 70))));
  }

  const notes = lossyNotes(result.lossy);
  if (notes.length > 0) body.push('', ...notes);
  return panelOf(t('rpc.panel.call'), body);
}

// ── serve ─────────────────────────────────────────────────────────────────

export function servePanel(plan: ServePlan, state?: ServeState): string[] {
  const status = state?.listening === true
    ? badge(t('rpc.serve.listening'), 46)
    : plan.errors.length > 0
      ? badge(t('rpc.serve.refused'), 196)
      : badge(t('rpc.serve.stopped'), 245);
  const body: string[] = [
    section(t('rpc.sect.service')),
    kv(t('rpc.tbl.status'), status, 12),
    kv(t('rpc.tbl.protocol'), C.cyan(plan.protocol), 12),
    kv(t('rpc.tbl.transport'), C.cyan(plan.transport), 12),
    ...(plan.transport === 'http'
      ? [kv(t('rpc.tbl.host'), C.dim(plan.host), 12), kv(t('rpc.tbl.port'), C.bold(String(plan.port)), 12)]
      : []),
    kv(
      t('rpc.tbl.token'),
      plan.tokenConfigured ? C.green(t('rpc.serve.tokenSet')) : C.yellow(t('rpc.serve.tokenUnset')),
      12,
    ),
    ...(state?.startedAt !== undefined ? [kv(t('rpc.tbl.started'), C.dim(stamp(state.startedAt)), 12)] : []),
    ...(state?.detail !== undefined ? [kv(t('rpc.tbl.detail'), C.dim(clip(state.detail, 52)), 12)] : []),
    '',
    section(t('rpc.sect.endpoints', { n: (state?.endpoints ?? plan.endpoints).length })),
    ...((state?.endpoints ?? plan.endpoints).length > 0
      ? (state?.endpoints ?? plan.endpoints).map((e) => `${C.green('→')} ${C.cyan(clip(e, 68))}`)
      : [emptyState('rpc.empty.endpoints')]),
  ];

  if (plan.errors.length > 0) {
    body.push(
      '',
      section(t('rpc.sect.errors')),
      ...plan.errors.map((e, i) => `${C.red('✖')} ${C.bold(plan.errorCodes[i] ?? 'SY-SRV-002')} ${C.dim(clip(e, 58))}`),
      '',
      C.dim(t('rpc.serve.bindHint')),
    );
  }

  if (plan.edgeUnavailable) {
    body.push('', section(t('rpc.sect.notes')), `${C.yellow('△')} ${C.dim(t('rpc.serve.edgeUnavailable'))}`);
  } else if (plan.notes.length > 0) {
    body.push('', section(t('rpc.sect.notes')), ...plan.notes.map((n) => C.dim(`· ${clip(n, 68)}`)));
  }

  return panelOf(t('rpc.panel.serve'), body);
}

// ── capability catalogue helper (used by /rpc policy and /peer tools) ─────

export function capabilityLabel(c: Capability): string {
  return `${c.protocol}://${c.displayName}`;
}

// ── small result panels (approve / ping / tools) ──────────────────────────

/** Generic result panel: a title plus already-localized rows. */
export function noticePanel(title: string, rows: readonly string[]): string[] {
  return panelOf(title, [...rows]);
}

/** Result of answering one approval. */
export function approvalDecisionPanel(id: string, optionId: string, ok: boolean, state = 'decided'): string[] {
  const glyph = ok ? C.green('✔') : C.yellow('!');
  return panelOf(t('rpc.panel.approve'), [
    `${glyph} ${ok ? C.bold(t('rpc.approve.done')) : C.bold(t('rpc.approve.stale'))}`,
    kv(t('rpc.tbl.approval'), C.cyan(id), 12),
    kv(t('rpc.tbl.option'), C.cyan(optionId), 12),
    kv(t('rpc.tbl.state'), stateColor(state), 12),
    '',
    C.dim(ok ? t('rpc.hint.approveDone') : t('rpc.hint.approveStale')),
  ]);
}

/** Result of `ping`ing one protocol edge. */
export function peerPingPanel(id: string, protocol: string, reachable: boolean, detail: string): string[] {
  return panelOf(t('rpc.panel.ping'), [
    `${reachable ? C.green('✔') : C.red('✘')} ${C.bold(reachable ? t('rpc.peer.reachable') : t('rpc.peer.unreachable'))}`,
    kv(t('rpc.tbl.edge'), C.cyan(id), 12),
    kv(t('rpc.tbl.protocol'), C.dim(protocol), 12),
    kv(t('rpc.tbl.detail'), C.dim(clip(detail, 52)), 12),
  ]);
}

/** Tools exposed by one edge, read from the capability registry. */
export function capabilityListPanel(providerId: string, caps: readonly Capability[]): string[] {
  const body: string[] = [section(t('rpc.sect.tools', { n: caps.length }))];
  if (caps.length === 0) {
    body.push(emptyState('rpc.empty.tools'), '', C.dim(t('rpc.hint.tools')));
  } else {
    body.push(
      ...table(
        [t('rpc.tbl.capability'), t('rpc.tbl.risk'), t('rpc.tbl.sideEffect'), t('rpc.tbl.visibility')],
        caps.map((c) => [
          C.cyan(clip(c.id, 34)),
          c.risk === 'read' ? C.green(c.risk) : c.risk === 'write' ? C.magenta(c.risk) : C.yellow(c.risk),
          C.dim(c.sideEffect),
          C.dim(c.visibility),
        ]),
        { divider: false },
      ),
    );
  }
  return panelOf(t('rpc.panel.tools', { id: providerId }), body);
}

/** True when no visible line exceeds `cols` (used by the view tests). */
export function maxVisibleWidth(lines: readonly string[], cols = 100): boolean {
  return lines.every((l) => displayWidth(l) <= cols);
}
