import { describe, expect, it } from 'vitest';
import type { ApprovalRecord, AuditEvent, BudgetAccount, CanonicalEvent, Capability, PolicyDecision, Receipt, Task } from '@syaocode/rpc';
import {
  approvalsPanel,
  auditPanel,
  budgetPanel,
  callResultPanel,
  capabilityListPanel,
  lossyNotes,
  lossyText,
  maxVisibleWidth,
  noticePanel,
  peersPanel,
  policyPanel,
  rpcOverviewPanel,
  servePanel,
  tasksPanel,
  taskDetailPanel,
  PANEL_WIDTH,
  type CallOutcome,
  type PeerRow,
  type ServePlan,
} from '../src/rpc-views';
import { t } from '../src/i18n/index';
import { displayWidth } from '../src/tui/width';

/** Everything the panels claim must be true of the *visible* text. */
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const text = (lines: readonly string[]) => lines.map(strip).join('\n');

function expectSanePanel(lines: readonly string[], label: string): void {
  expect(lines.length, `${label}: empty panel`).toBeGreaterThan(2);
  // 1. fits an 80-column terminal
  for (const line of lines) {
    expect(displayWidth(line), `${label}: line too wide: ${JSON.stringify(strip(line))}`).toBeLessThanOrEqual(PANEL_WIDTH);
  }
  // 2. rounded frame, aligned borders
  const plain = lines.map(strip);
  expect(plain[0]!.startsWith('╭'), `${label}: missing top border`).toBe(true);
  expect(plain[plain.length - 1]!.startsWith('╰'), `${label}: missing bottom border`).toBe(true);
  const width = displayWidth(plain[0]!);
  for (const l of plain) expect(displayWidth(l), `${label}: ragged border`).toBe(width);
  // 3. never a bare header: there is always body text
  expect(text(lines).trim().split('\n').length).toBeGreaterThan(2);
}

// ── fixtures ──────────────────────────────────────────────────────────────

const capability = (id: string, protocol: Capability['protocol'] = 'mcp'): Capability => ({
  id,
  kind: 'tool',
  protocol,
  displayName: id.split('/').pop() ?? id,
  risk: 'read',
  sideEffect: 'none',
  dataClass: 'internal',
  visibility: 'full',
  reversible: true,
  provider: {
    id: `${protocol}-1`,
    protocol,
    endpoint: `${protocol}://${protocol}-1`,
    trust: 'verified',
    health: 'healthy',
    ttlMs: 300_000,
    lastSeenAt: '2026-01-01T00:00:00.000Z',
  },
});

const task: Task = {
  id: 'task_abc123',
  sessionId: 'session_xyz',
  tenantId: 'syaocode-local',
  state: 'completed',
  input: [{ type: 'text', text: 'summarize the governance kernel and its invariants' }],
  artifacts: [],
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:02.000Z',
  lastSeq: 7,
  terminalReason: 'completed',
};

const receipt: Receipt = {
  id: 'rcpt_0123456789abcdef',
  tenantId: 'syaocode-local',
  taskId: task.id,
  invocationId: 'inv_1',
  protocol: 'mcp',
  capabilityId: 'mcp://github/tool/create_issue',
  principalId: 'user:local',
  delegationChain: [],
  outcome: 'succeeded',
  inputHash: 'sha256:aaa',
  artifacts: [],
  approvals: ['apr_1'],
  policy: { revision: 'sha256:deadbeef', decisionId: 'dec_1', effect: 'ask', obligations: ['require_approval'] },
  usage: { costUsd: 0.0042, inputTokens: 1200, outputTokens: 300 },
  timing: { queuedAt: '2026-01-01T10:00:00.000Z', startedAt: '2026-01-01T10:00:00.100Z', endedAt: '2026-01-01T10:00:02.000Z' },
  visibility: 'full',
  lossy: ['a2a-remote-task-opaque'],
  hash: 'sha256:bbb',
};

const approval: ApprovalRecord = {
  id: 'apr_0123456789',
  tenantId: 'syaocode-local',
  taskId: task.id,
  subject: {
    kind: 'tool',
    summary: 'Call local://tools/bash to run `pnpm test`',
    command: { argv: ['pnpm', 'test'], cwd: '/ws' },
  },
  options: [
    { id: 'allow_once', label: 'Allow once', kind: 'allow_once' },
    { id: 'deny_once', label: 'Deny once', kind: 'deny_once' },
  ],
  authority: 'local',
  delegationChain: [],
  policyRevision: 'sha256:deadbeef',
  revision: 1,
  state: 'pending',
  createdAt: '2026-01-01T10:00:00.000Z',
  expiresAt: '2026-01-01T10:05:00.000Z',
  sensitive: true,
};

const budget: BudgetAccount = {
  id: 'default',
  tenantId: 'syaocode-local',
  currency: 'USD',
  limitUsd: 5,
  reservedUsd: 0.25,
  spentUsd: 1.1,
  tokensUsed: 42_000,
  timeUsedMs: 1000,
  toolCallsUsed: 12,
  state: 'active',
};

const auditEvent: AuditEvent = {
  id: 'aud_1',
  ts: '2026-01-01T10:00:00.000Z',
  tenantId: 'syaocode-local',
  actor: { type: 'user', id: 'local' },
  action: 'policy.decide',
  subject: { type: 'capability', id: 'mcp://github/tool/create_issue' },
  outcome: 'success',
  prevHash: 'sha256:000',
  hash: 'sha256:111',
};

const event: CanonicalEvent = {
  schemaVersion: 1,
  eventId: 'evt_1',
  seq: 3,
  taskId: task.id,
  correlationId: 'corr_1',
  ts: '2026-01-01T10:00:01.000Z',
  principalId: 'user:local',
  protocol: 'mcp',
  type: 'invocation.started',
  payload: {},
};

const decision: PolicyDecision = {
  id: 'dec_1',
  effect: 'ask',
  reason: "Rule 'cli-tier-strict' requires approval.",
  policyRevision: 'sha256:deadbeef',
  obligations: [{ type: 'require_approval' }, { type: 'audit_level', level: 'full' }],
  explain: {
    matchedRules: [{ id: 'cli-tier-strict', effect: 'ask', source: 'session' }],
    obligations: [{ type: 'require_approval' }],
    effectiveMode: 'strict',
    revision: 'sha256:deadbeef',
  },
};

const peers: PeerRow[] = [
  { providerId: 'mcp-1', protocol: 'mcp', version: '2026-07-28', capabilities: 12, health: 'healthy', lossy: ['mcp-legacy'], endpoint: 'mcp://mcp-1', trust: 'verified' },
  { providerId: 'a2a-1', protocol: 'a2a', version: '1.0', capabilities: 3, health: 'degraded', lossy: ['a2a-remote-task-opaque'], endpoint: 'https://agent.example/card', trust: 'verified' },
  { providerId: 'gh', protocol: 'mcp', version: '—', capabilities: 0, health: 'down', lossy: [], endpoint: 'npx -y github-mcp', trust: 'unverified', unavailable: true },
];

const servePlanFixture: ServePlan = {
  protocol: 'mcp',
  transport: 'http',
  host: '127.0.0.1',
  port: 8787,
  tokenConfigured: false,
  endpoints: ['http://127.0.0.1:8787/mcp', 'http://127.0.0.1:8787/healthz'],
  errors: [],
  errorCodes: [],
  edgeUnavailable: false,
  notes: [],
};

// ── lossy notes ───────────────────────────────────────────────────────────

describe('lossyNotes — degradation must be visible', () => {
  it('renders one line per unique code, with a warning glyph', () => {
    const lines = lossyNotes(['a2a-remote-task-opaque', 'a2a-remote-task-opaque', 'mcp-legacy']);
    expect(lines).toHaveLength(3); // section + 2 notes (deduped)
    expect(lines[0]).toContain('LOSSY');
    expect(strip(lines[1]!)).toContain('△');
    expect(text(lines)).toContain('One A2A remote task is one opaque invocation');
    expect(text(lines)).toContain('legacy initialize');
  });

  it('never hides an unknown code behind a generic sentence', () => {
    const rendered = text(lossyNotes(['brand-new-gap']));
    expect(rendered).toContain('brand-new-gap');
    expect(lossyText('brand-new-gap')).toContain('brand-new-gap');
  });

  it('returns no lines at all when there is nothing to report', () => {
    expect(lossyNotes([])).toEqual([]);
    expect(lossyNotes(['', ''])).toEqual([]);
  });

  it('every known code has a real sentence (not just the code)', () => {
    for (const code of ['mcp-legacy', 'a2a-remote-task-opaque', 'a2a-weak-session', 'untrusted-content', 'no-streaming', 'summary-only']) {
      expect(lossyText(code)).not.toBe(code);
      expect(lossyText(code).length).toBeGreaterThan(20);
    }
  });
});

// ── overview ──────────────────────────────────────────────────────────────

describe('rpcOverviewPanel', () => {
  const overview = {
    tenantId: 'syaocode-local',
    policyRevision: 'sha256:deadbeefdeadbeef',
    capabilityCount: 15,
    pendingApprovals: 2,
    tasks: { total: 9, unterminated: 1 },
    adapters: peers,
    budget: [budget],
    audit: { ok: true, checked: 128 },
    recent: [receipt],
  };

  it('shows the governance counters, the edge table and the audit verdict', () => {
    const lines = rpcOverviewPanel(overview);
    expectSanePanel(lines, 'overview');
    const rendered = text(lines);
    expect(rendered).toContain('syaocode-local');
    expect(rendered).toContain('15');
    expect(rendered).toContain('9');
    expect(rendered).toContain('intact (128 checked)');
    expect(rendered).toContain('mcp-1');
    expect(rendered).toContain('create_issue');
    expect(rendered).toContain('/rpc tasks');
  });

  it('reports a broken audit chain instead of pretending it is fine', () => {
    const rendered = text(rpcOverviewPanel({ ...overview, audit: { ok: false, checked: 4, brokenAt: 'aud_9', reason: 'hash mismatch' } }));
    expect(rendered).toContain('BROKEN at aud_9');
  });

  it('degrades gracefully when nothing has happened yet', () => {
    const lines = rpcOverviewPanel({
      ...overview,
      capabilityCount: 0,
      pendingApprovals: 0,
      tasks: { total: 0, unterminated: 0 },
      adapters: [],
      budget: [],
      audit: { ok: true, checked: 0 },
      recent: [],
    });
    expectSanePanel(lines, 'overview/empty');
    const rendered = text(lines);
    expect(rendered).toContain('No protocol edge is mounted');
    expect(rendered).toContain('No budget account yet');
    expect(rendered).toContain('No receipt yet');
  });

  it('surfaces the lossy notes of its edges', () => {
    expect(text(rpcOverviewPanel(overview))).toContain('legacy initialize');
  });
});

// ── tasks ─────────────────────────────────────────────────────────────────

describe('tasksPanel / taskDetailPanel', () => {
  it('lists tasks with state, seq and an input preview', () => {
    const lines = tasksPanel([task]);
    expectSanePanel(lines, 'tasks');
    const rendered = text(lines);
    expect(rendered).toContain('task_abc123');
    expect(rendered).toContain('completed');
    expect(rendered).toContain('summarize the governance kernel');
    expect(rendered).toContain('/rpc task <id>');
  });

  it('tells the user how to get a first task instead of showing an empty table', () => {
    const lines = tasksPanel([]);
    expectSanePanel(lines, 'tasks/empty');
    expect(text(lines)).toContain('No task yet');
  });

  it('renders one task with its receipts, events and lossy notes', () => {
    const lines = taskDetailPanel(task, [event], [receipt]);
    expectSanePanel(lines, 'task detail');
    const rendered = text(lines);
    expect(rendered).toContain('task_abc123');
    expect(rendered).toContain('rcpt_0123456789abcdef');
    expect(rendered).toContain('invocation.started');
    expect(rendered).toContain('One A2A remote task is one opaque invocation');
  });

  it('handles a task with no receipts and no events', () => {
    const lines = taskDetailPanel({ ...task, state: 'submitted', lastSeq: 1 }, [], []);
    expectSanePanel(lines, 'task detail/empty');
    const rendered = text(lines);
    expect(rendered).toContain('This task has no receipt yet');
    expect(rendered).toContain('This task has no event yet');
  });
});

// ── approvals ─────────────────────────────────────────────────────────────

describe('approvalsPanel', () => {
  it('shows the subject, the options and the expiry', () => {
    const lines = approvalsPanel([approval]);
    expectSanePanel(lines, 'approvals');
    const rendered = text(lines);
    expect(rendered).toContain('apr_0123456789');
    expect(rendered).toContain('pnpm test');
    expect(rendered).toContain('allow_once');
    expect(rendered).toContain('rev 1');
    expect(rendered).toContain('sensitive — one-shot only');
    expect(rendered).toContain('/approve <id>');
  });

  it('says nothing is waiting instead of showing a bare header', () => {
    const lines = approvalsPanel([]);
    expectSanePanel(lines, 'approvals/empty');
    expect(text(lines)).toContain('No pending approval');
  });
});

// ── budget ────────────────────────────────────────────────────────────────

describe('budgetPanel', () => {
  it('shows spent / held / limit with a progress bar and the token counters', () => {
    const lines = budgetPanel([budget]);
    expectSanePanel(lines, 'budget');
    const rendered = text(lines);
    expect(rendered).toContain('$1.1000');
    expect(rendered).toContain('$0.2500');
    expect(rendered).toContain('$5.0000');
    expect(rendered).toContain('27%'); // (1.1 + 0.25) / 5
    expect(rendered).toContain('42000');
  });

  it('handles an account without a limit', () => {
    // exactOptionalPropertyTypes: build the account without the key at all.
    const { limitUsd: _drop, ...unlimited } = budget;
    void _drop;
    const rendered = text(budgetPanel([unlimited]));
    expect(rendered).toContain('no limit');
  });

  it('explains how an account appears when there is none', () => {
    const lines = budgetPanel([]);
    expectSanePanel(lines, 'budget/empty');
    expect(text(lines)).toContain('No budget account yet');
  });
});

// ── audit ─────────────────────────────────────────────────────────────────

describe('auditPanel', () => {
  it('shows the chain verdict plus the recent events', () => {
    const lines = auditPanel([auditEvent], { ok: true, checked: 3 });
    expectSanePanel(lines, 'audit');
    const rendered = text(lines);
    expect(rendered).toContain('intact (3 checked)');
    expect(rendered).toContain('policy.decide');
    expect(rendered).toContain('user:local');
  });

  it('shows exactly where the chain broke', () => {
    const rendered = text(auditPanel([auditEvent], { ok: false, checked: 2, brokenAt: 'aud_1', reason: 'hash mismatch' }));
    expect(rendered).toContain('BROKEN at aud_1');
    expect(rendered).toContain('hash mismatch');
  });

  it('degrades gracefully on an empty chain', () => {
    const lines = auditPanel([], { ok: true, checked: 0 });
    expectSanePanel(lines, 'audit/empty');
    expect(text(lines)).toContain('The audit chain is empty');
  });
});

// ── policy ────────────────────────────────────────────────────────────────

describe('policyPanel', () => {
  it('explains the effect, obligations and matched rules', () => {
    const lines = policyPanel(decision, 'mcp://github/tool/create_issue');
    expectSanePanel(lines, 'policy');
    const rendered = text(lines);
    expect(rendered).toContain('mcp://github/tool/create_issue');
    expect(rendered).toContain('ask');
    expect(rendered).toContain('require_approval');
    expect(rendered).toContain('cli-tier-strict');
    expect(rendered).toContain('strict');
  });

  it('handles a decision with neither obligations nor trace rules', () => {
    const bare: PolicyDecision = { ...decision, obligations: [], explain: { matchedRules: [], obligations: [], effectiveMode: 'default', revision: 'sha256:x' } };
    const lines = policyPanel(bare, 'local://tools/read');
    expectSanePanel(lines, 'policy/bare');
    const rendered = text(lines);
    expect(rendered).toContain('No obligation attached');
    expect(rendered).toContain('No rule matched');
  });

  it('shows deny in red', () => {
    const rendered = policyPanel({ ...decision, effect: 'deny' }, 'x');
    expect(rendered.some((l) => l.includes('\x1b[31m'))).toBe(true);
  });
});

// ── peers ─────────────────────────────────────────────────────────────────

describe('peersPanel', () => {
  it('shows mounted and registry-only edges, health and lossy notes', () => {
    const lines = peersPanel(peers);
    expectSanePanel(lines, 'peers');
    const rendered = text(lines);
    expect(rendered).toContain('mcp-1');
    expect(rendered).toContain('a2a-1');
    expect(rendered).toContain('gh');
    expect(rendered).toContain('registered, not mounted');
    expect(rendered).toContain('legacy initialize');
    expect(rendered).toContain('/peer add');
  });

  it('degrades gracefully when nothing is configured', () => {
    const lines = peersPanel([]);
    expectSanePanel(lines, 'peers/empty');
    const rendered = text(lines);
    expect(rendered).toContain('No edge configured');
    // The footer hint must appear exactly once (empty state + footer overlap).
    expect(rendered.split('/peer add <id> <command|url> · /peer ping <id>').length - 1).toBe(1);
  });

  it('renders caller notes without breaking the frame', () => {
    const lines = peersPanel(peers.slice(0, 1), ['protocol edge not available in this build']);
    expectSanePanel(lines, 'peers/notes');
    expect(text(lines)).toContain('protocol edge not available');
  });
});

// ── call result ───────────────────────────────────────────────────────────

describe('callResultPanel', () => {
  const success: CallOutcome = {
    capabilityId: 'mcp://github/tool/create_issue',
    outcome: 'succeeded',
    receiptId: 'rcpt_1',
    taskId: task.id,
    invocationId: 'inv_1',
    output: 'created issue #42',
    approvalIds: ['apr_1'],
    approvalTrail: [{ id: 'apr_1', state: 'allowed', optionId: 'allow_once' }],
    lossy: ['a2a-remote-task-opaque'],
    costUsd: 0.0042,
    inputTokens: 1200,
    outputTokens: 300,
  };

  it('shows outcome, receipt, cost, the approval trail and the output', () => {
    const lines = callResultPanel(success);
    expectSanePanel(lines, 'call');
    const rendered = text(lines);
    expect(rendered).toContain('succeeded');
    expect(rendered).toContain('rcpt_1');
    expect(rendered).toContain('$0.0042');
    expect(rendered).toContain('1200 in / 300 out');
    expect(rendered).toContain('allow_once');
    expect(rendered).toContain('created issue #42');
    expect(rendered).toContain('One A2A remote task is one opaque invocation');
  });

  it('shows a denial with its canonical kind and code', () => {
    const denied: CallOutcome = {
      capabilityId: 'local://tools/bash',
      outcome: 'denied',
      error: { kind: 'denied', code: 'SY-POL-001', message: 'The policy engine denied this invocation.' },
      approvalIds: [],
      lossy: [],
    };
    const rendered = text(callResultPanel(denied));
    expect(rendered).toContain('denied');
    expect(rendered).toContain('SY-POL-001');
    expect(rendered).toContain('stopped before the approval step');
    expect(rendered).toContain('(the invocation returned no output)');
  });

  it('does not claim the policy allowed a call that failed before approval', () => {
    const missing: CallOutcome = {
      capabilityId: 'mcp://nope/tool/x',
      outcome: 'failed',
      error: { kind: 'capability_not_found', message: 'capability mcp://nope/tool/x is not registered' },
      approvalIds: [],
      lossy: [],
    };
    const rendered = text(callResultPanel(missing));
    expect(rendered).toContain('stopped before the approval step');
    expect(rendered).not.toContain('the policy allowed it directly');
  });

  it('never prints a secret: the caller-supplied redactor is applied to output', () => {
    const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789';
    const lines = callResultPanel(
      { ...success, output: `token=${secret}` },
      { redact: (s) => s.replace(secret, '[REDACTED:api-key]') },
    );
    const rendered = text(lines);
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain('[REDACTED:api-key]');
  });
});

// ── serve ─────────────────────────────────────────────────────────────────

describe('servePanel', () => {
  it('shows status, protocol, transport, endpoints and token state', () => {
    const lines = servePanel(servePlanFixture);
    expectSanePanel(lines, 'serve');
    const rendered = text(lines);
    expect(rendered).toContain('stopped');
    expect(rendered).toContain('mcp');
    expect(rendered).toContain('http');
    expect(rendered).toContain('127.0.0.1');
    expect(rendered).toContain('8787');
    expect(rendered).toContain('not configured');
    expect(rendered).toContain('/healthz');
  });

  it('renders a listening service', () => {
    const rendered = text(servePanel(servePlanFixture, { listening: true, endpoints: servePlanFixture.endpoints, startedAt: '2026-01-01T00:00:00.000Z' }));
    expect(rendered).toContain('listening');
  });

  it('surfaces a refused bind with its registry code and the fix', () => {
    const refused: ServePlan = {
      ...servePlanFixture,
      host: '0.0.0.0',
      errors: ['Refusing to listen on 0.0.0.0 without a token'],
      errorCodes: ['SY-SRV-002'],
    };
    const lines = servePanel(refused);
    expectSanePanel(lines, 'serve/refused');
    const rendered = text(lines);
    expect(rendered).toContain('refused');
    expect(rendered).toContain('SY-SRV-002');
    expect(rendered).toContain('SYAO_RPC_TOKEN');
  });

  it('says when the protocol edge is not in this build', () => {
    const rendered = text(servePanel({ ...servePlanFixture, edgeUnavailable: true }));
    expect(rendered).toContain('protocol edge not available in this build');
  });

  it('handles a stdio plan (no host/port rows)', () => {
    const lines = servePanel({ ...servePlanFixture, transport: 'stdio', endpoints: ['stdio://mcp'] });
    expectSanePanel(lines, 'serve/stdio');
    expect(text(lines)).toContain('stdio://mcp');
  });

  it('handles a plan with no endpoints', () => {
    const lines = servePanel({ ...servePlanFixture, endpoints: [] });
    expectSanePanel(lines, 'serve/no-endpoints');
    expect(text(lines)).toContain('No endpoint');
  });
});

// ── misc ──────────────────────────────────────────────────────────────────

describe('small panels', () => {
  it('capabilityListPanel shows tools of an edge and handles an empty edge', () => {
    const full = capabilityListPanel('mcp-1', [capability('mcp://mcp-1/tool/list', 'mcp')]);
    expectSanePanel(full, 'tools');
    expect(text(full)).toContain('mcp://mcp-1/tool/list');

    const empty = capabilityListPanel('gh', []);
    expectSanePanel(empty, 'tools/empty');
    expect(text(empty)).toContain('no capability in this build');
  });

  it('noticePanel always renders a framed block', () => {
    expectSanePanel(noticePanel('note', [t('rpc.peer.added', { id: 'x', target: 'cmd' })]), 'notice');
  });

  it('maxVisibleWidth is the helper the tests and callers share', () => {
    expect(maxVisibleWidth(['short', 'ok'])).toBe(true);
    expect(maxVisibleWidth(['x'.repeat(120)], 100)).toBe(false);
  });
});
