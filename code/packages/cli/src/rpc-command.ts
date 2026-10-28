/**
 * The `syao rpc` / `syao call` / `syao mcp` / `syao serve` command surface,
 * plus the shared handlers behind the `/rpc` `/peer` `/call` `/serve`
 * `/approve` slash commands.
 *
 * Everything that can be decided without touching a terminal lives in the pure
 * parsers at the top (`parseRpcCommand`, `parseCallCommand`, `parseMcpCommand`,
 * `parseServeArgv`, `rpcJsonEnvelope`), which is what the unit tests exercise.
 * The runners below are thin: they fetch data from the fabric, hand it to a
 * pure panel from `rpc-views.ts`, and print either the panel or JSON.
 */

import type {
  ApprovalRecord,
  AuditEvent,
  BudgetAccount,
  Capability,
  CanonicalEvent,
  FabricStatus,
  Receipt,
  Task,
} from '@syaocode/rpc';
import { CanonicalError, EXIT } from '@syaocode/rpc';
import { UsageError, type CliArgs } from './args.js';
import { errorText, exitCodeForError, type CliFabric } from './arf.js';
import { t } from './i18n/index.js';
import {
  guessProtocol,
  listPeers,
  removePeer,
  savePeer,
  validPeerId,
  type PeerConfig,
  type PeerProtocol,
} from './peers.js';
import {
  approvalsPanel,
  approvalDecisionPanel,
  auditPanel,
  budgetPanel,
  callResultPanel,
  capabilityListPanel,
  maxVisibleWidth,
  noticePanel,
  peerPingPanel,
  peersPanel,
  policyPanel,
  rpcOverviewPanel,
  servePanel,
  taskDetailPanel,
  tasksPanel,
  type CallOutcome,
  type PeerRow,
  type ServePlan,
} from './rpc-views.js';
import { DEFAULT_PORTS, probeProtocolEdge, resolveServeToken, servePlan, type ServeProtocol, type ServeTransport } from './serve.js';
import { readFileSync } from 'node:fs';

// ── argv parsing (pure) ───────────────────────────────────────────────────

export type RpcView = 'overview' | 'tasks' | 'task' | 'approvals' | 'budget' | 'audit' | 'policy' | 'status';

export type RpcCommand =
  | { kind: 'view'; view: RpcView; id?: string; capabilityId?: string; json: boolean }
  | { kind: 'decide'; approvalId: string; optionId: string; json: boolean };

export interface CallCommand {
  capabilityId: string;
  /** Raw `--input` value: inline JSON or `@file`. */
  input?: string;
  json: boolean;
}

export type McpCommand =
  | { kind: 'list' }
  | { kind: 'add'; name: string; command: string }
  | { kind: 'remove'; name: string }
  | { kind: 'tools'; name: string };

export interface ServeCommand {
  protocol: ServeProtocol;
  transport: ServeTransport;
  host?: string;
  port?: number;
  json: boolean;
}

const RPC_VIEWS: Readonly<Record<string, RpcView>> = {
  tasks: 'tasks',
  approvals: 'approvals',
  budget: 'budget',
  audit: 'audit',
  status: 'status',
};

/** Map the short user-facing option word onto the kernel's option id. */
export function normalizeApprovalOption(raw: string): string | undefined {
  switch (raw.trim().toLowerCase()) {
    case 'once':
    case 'allow':
    case 'allow_once':
    case 'y':
    case 'yes':
      return 'allow_once';
    case 'session':
    case 'allow_session':
    case 's':
      return 'allow_session';
    case 'always':
    case 'allow_always':
    case 'a':
      return 'allow_always';
    case 'deny':
    case 'deny_once':
    case 'n':
    case 'no':
      return 'deny_once';
    case 'deny_always':
    case 'never':
      return 'deny_always';
    default:
      return undefined;
  }
}

/** Split `--flag value`, `--flag=value` and bare tokens apart. */
function takeFlag(argv: readonly string[], flag: string): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === flag) {
      value = argv[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith(`${flag}=`)) {
      value = a.slice(flag.length + 1);
      continue;
    }
    rest.push(a);
  }
  return { ...(value !== undefined ? { value } : {}), rest };
}

function takeBool(argv: readonly string[], flag: string): { found: boolean; rest: string[] } {
  return { found: argv.includes(flag), rest: argv.filter((a) => a !== flag) };
}

/** Parse `syao rpc <sub> [...] [--json]` (throws UsageError on bad input). */
export function parseRpcCommand(argv: readonly string[]): RpcCommand {
  const json = takeBool(argv, '--json');
  const rest = json.rest;
  const sub = rest[0];
  if (sub === undefined) return { kind: 'view', view: 'overview', json: json.found };

  const view = RPC_VIEWS[sub];
  if (view !== undefined) {
    if (rest.length > 1) throw new UsageError(t('rpc.usage'));
    return { kind: 'view', view, json: json.found };
  }

  if (sub === 'task') {
    const id = rest[1];
    if (id === undefined || rest.length > 2) throw new UsageError(t('rpc.taskRequired'));
    return { kind: 'view', view: 'task', id, json: json.found };
  }

  if (sub === 'policy') {
    const capabilityId = rest[1];
    if (capabilityId === undefined || rest.length > 2) throw new UsageError(t('rpc.policyRequired'));
    return { kind: 'view', view: 'policy', capabilityId, json: json.found };
  }

  if (sub === 'approve') {
    const id = rest[1];
    if (id === undefined) throw new UsageError(t('rpc.approvalRequired'));
    const option = normalizeApprovalOption(rest[2] ?? 'allow_once');
    if (option === undefined) throw new UsageError(t('rpc.badOption', { option: rest[2] ?? '' }));
    if (rest.length > 3) throw new UsageError(t('rpc.usage'));
    return { kind: 'decide', approvalId: id, optionId: option, json: json.found };
  }

  if (sub === 'deny') {
    const id = rest[1];
    if (id === undefined || rest.length > 2) throw new UsageError(t('rpc.approvalRequired'));
    return { kind: 'decide', approvalId: id, optionId: 'deny_once', json: json.found };
  }

  throw new UsageError(t('rpc.unknownSub', { sub }));
}

/** Parse `syao call <capabilityId> [--input <json|@file>] [--json]`. */
export function parseCallCommand(argv: readonly string[]): CallCommand {
  const json = takeBool(argv, '--json');
  const input = takeFlag(json.rest, '--input');
  const positional = input.rest;
  const capabilityId = positional[0];
  if (capabilityId === undefined) throw new UsageError(t('rpc.capabilityRequired'));
  const inline = input.value ?? positional[1];
  if (positional.length > 2) throw new UsageError(t('rpc.callUsage'));
  return {
    capabilityId,
    ...(inline !== undefined ? { input: inline } : {}),
    json: json.found,
  };
}

/** Parse `syao mcp <list|add <name> <command...>|remove <name>|tools <name>>`. */
export function parseMcpCommand(argv: readonly string[]): McpCommand {
  const sub = argv[0] ?? 'list';
  if (sub === 'list') {
    if (argv.length > 1) throw new UsageError(t('rpc.mcpUsage'));
    return { kind: 'list' };
  }
  if (sub === 'add') {
    const name = argv[1];
    const command = argv.slice(2).filter((a) => a !== '--');
    if (name === undefined || command.length === 0) throw new UsageError(t('rpc.mcpAddUsage'));
    if (!validPeerId(name)) throw new UsageError(t('rpc.badPeerId', { id: name }));
    return { kind: 'add', name, command: command.join(' ') };
  }
  if (sub === 'remove') {
    const name = argv[1];
    if (name === undefined || argv.length > 2) throw new UsageError(t('rpc.mcpRemoveUsage'));
    return { kind: 'remove', name };
  }
  if (sub === 'tools') {
    const name = argv[1];
    if (name === undefined || argv.length > 2) throw new UsageError(t('rpc.mcpToolsUsage'));
    return { kind: 'tools', name };
  }
  throw new UsageError(t('rpc.mcpUsage'));
}

/** Parse `syao serve [--mcp|--acp|--a2a] [--stdio|--http] [--port N] [--host H]`. */
export function parseServeArgv(argv: readonly string[]): ServeCommand {
  const json = takeBool(argv, '--json');
  const portFlag = takeFlag(json.rest, '--port');
  const hostFlag = takeFlag(portFlag.rest, '--host');
  let rest = hostFlag.rest;

  let protocol: ServeProtocol | undefined;
  let transport: ServeTransport | undefined;
  const remaining: string[] = [];
  for (const a of rest) {
    if (a === '--mcp') protocol = 'mcp';
    else if (a === '--acp') protocol = 'acp';
    else if (a === '--a2a') protocol = 'a2a';
    else if (a === '--stdio') transport = 'stdio';
    else if (a === '--http') transport = 'http';
    else if (a === 'mcp' || a === 'acp' || a === 'a2a') protocol = a;
    else if (a === 'stdio' || a === 'http') transport = a;
    else remaining.push(a);
  }
  rest = remaining;
  if (rest.length > 0) throw new UsageError(t('serve.usage'));

  let port: number | undefined;
  if (portFlag.value !== undefined) {
    port = Number(portFlag.value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new UsageError(t('serve.badPort', { port: portFlag.value }));
    }
  }
  return {
    protocol: protocol ?? 'mcp',
    transport: transport ?? 'http',
    ...(hostFlag.value !== undefined ? { host: hostFlag.value } : {}),
    ...(port !== undefined ? { port } : {}),
    json: json.found,
  };
}

// ── JSON envelope (pure) ──────────────────────────────────────────────────

export interface RpcJsonEnvelope {
  ok: boolean;
  view: string;
  data?: unknown;
  error?: { kind: string; code?: string; message: string; exitCode: number };
}

export function rpcJsonEnvelope(view: string, data: unknown): RpcJsonEnvelope {
  return { ok: true, view, data };
}

/** Exit code for a finished invocation outcome (03 §5.5 mapping). */
export function exitCodeForOutcome(outcome: CallOutcome): number {
  if (outcome.error === undefined) return EXIT.OK;
  switch (outcome.error.kind) {
    case 'denied':
    case 'unauthorized':
    case 'unauthenticated':
      return EXIT.DENIED;
    case 'budget_exceeded':
    case 'in_flight':
      return EXIT.LIMIT;
    case 'capability_not_found':
    case 'unsupported_capability':
    case 'unsupported_obligation':
    case 'version_mismatch':
      return EXIT.UNAVAILABLE;
    case 'invalid_request':
    case 'idempotency_conflict':
      return EXIT.USAGE;
    case 'indeterminate':
      return EXIT.UNVERIFIED;
    case 'cancelled':
      return EXIT.INTERRUPTED;
    default:
      return EXIT.ERROR;
  }
}

/**
 * JSON envelope for one governed invocation.
 *
 * `ok` follows the invocation, not the transport: a failed call is `ok: false`
 * and carries the canonical kind plus the exit code a shell caller would see.
 */
export function callJsonEnvelope(outcome: CallOutcome): RpcJsonEnvelope {
  if (outcome.error === undefined) return { ok: true, view: 'call', data: outcome };
  return {
    ok: false,
    view: 'call',
    data: outcome,
    error: {
      kind: outcome.error.kind,
      ...(outcome.error.code !== undefined ? { code: outcome.error.code } : {}),
      message: outcome.error.message,
      exitCode: exitCodeForOutcome(outcome),
    },
  };
}

export function rpcErrorEnvelope(view: string, e: unknown): RpcJsonEnvelope {
  if (CanonicalError.is(e)) {
    return {
      ok: false,
      view,
      error: {
        kind: e.kind,
        ...(e.code !== undefined ? { code: e.code } : {}),
        message: e.message,
        exitCode: e.exitCode,
      },
    };
  }
  return {
    ok: false,
    view,
    error: {
      kind: 'internal',
      message: e instanceof Error ? e.message : String(e),
      exitCode: EXIT.ERROR,
    },
  };
}

// ── fabric data access ────────────────────────────────────────────────────

/** Capabilities exposed by one provider id (mounts registered peers first). */
export async function capabilitiesOf(cli: CliFabric, providerId: string): Promise<Capability[]> {
  await cli.mountRegisteredPeers();
  await cli.fabric.discover();
  const caps = await cli.fabric.capabilities();
  return caps.filter((c) => c.provider.id === providerId);
}

/** Newest receipts across tasks (receipts are stored per task). */
export async function recentReceipts(cli: CliFabric, limit = 6): Promise<Receipt[]> {
  const tasks = await cli.fabric.tasks.list({ limit: 25 });
  const all: Receipt[] = [];
  for (const task of tasks) {
    const receipts = await cli.fabric.stores.receipts.listByTask(task.id);
    all.push(...receipts);
  }
  return all.sort((a, b) => (a.timing.endedAt < b.timing.endedAt ? 1 : -1)).slice(0, limit);
}

/** Fabric status → peer rows (mounted edges). */
export function mountedPeerRows(status: FabricStatus): PeerRow[] {
  return status.adapters.map((a) => ({
    providerId: a.providerId,
    protocol: a.protocol,
    version: a.version,
    capabilities: a.capabilities,
    health: a.health,
    lossy: a.lossy,
    endpoint: `${a.protocol}://${a.providerId}`,
    trust: 'verified',
  }));
}

/**
 * Peers panel data = mounted edges (from the fabric) + configured-but-unmounted
 * edges (from the user config). The second group is what makes a stale or
 * unavailable entry visible instead of silently absent.
 */
export async function peerRows(cli: CliFabric, home?: string): Promise<PeerRow[]> {
  // Registered peers are mounted on demand: a peer added seconds ago must be
  // visible in the same session.
  await cli.mountRegisteredPeers();
  await cli.fabric.discover();
  const status = await cli.fabric.status();
  const rows = mountedPeerRows(status);
  const mounted = new Set(rows.map((r) => r.providerId));
  const declared = listPeers(home);
  for (const [id, peer] of Object.entries(declared)) {
    if (mounted.has(id)) continue;
    rows.push({
      providerId: id,
      protocol: peer.protocol,
      version: '—',
      capabilities: 0,
      health: 'down',
      lossy: [],
      endpoint: peer.target,
      trust: 'unverified',
      unavailable: true,
    });
  }
  return rows;
}

async function overviewOf(cli: CliFabric): Promise<{
  status: FabricStatus;
  budget: BudgetAccount[];
  audit: Awaited<ReturnType<CliFabric['fabric']['audit']['verify']>>;
  recent: Receipt[];
}> {
  // `discover()` flushes the asynchronous local-tool registration, so the
  // counters never show a half-populated catalogue.
  await cli.fabric.discover();
  const status = await cli.fabric.status();
  const budget = await cli.fabric.budget.list();
  const audit = await cli.fabric.audit.verify();
  const recent = await recentReceipts(cli, 6);
  return { status, budget, audit, recent };
}

function overviewPanelOf(data: Awaited<ReturnType<typeof overviewOf>>): string[] {
  return rpcOverviewPanel({
    tenantId: data.status.tenantId,
    policyRevision: data.status.policyRevision,
    capabilityCount: data.status.capabilityCount,
    pendingApprovals: data.status.pendingApprovals,
    tasks: data.status.tasks,
    adapters: mountedPeerRows(data.status),
    budget: data.budget,
    audit: data.audit,
    recent: data.recent,
  });
}

// ── view rendering ────────────────────────────────────────────────────────

export interface PanelResult {
  lines: string[];
  json: unknown;
}

/** Fetch + render one governance view. Throws CanonicalError for bad ids. */
export async function rpcView(cmd: Extract<RpcCommand, { kind: 'view' }>, cli: CliFabric): Promise<PanelResult> {
  switch (cmd.view) {
    case 'overview':
    case 'status': {
      const data = await overviewOf(cli);
      return {
        lines: overviewPanelOf(data),
        json: {
          tenantId: data.status.tenantId,
          policyRevision: data.status.policyRevision,
          capabilityCount: data.status.capabilityCount,
          pendingApprovals: data.status.pendingApprovals,
          tasks: data.status.tasks,
          adapters: data.status.adapters,
          budget: data.budget,
          audit: data.audit,
        },
      };
    }
    case 'tasks': {
      const tasks = await cli.fabric.tasks.list({ limit: 50 });
      return { lines: tasksPanel(tasks), json: { tasks } };
    }
    case 'task': {
      const id = cmd.id ?? '';
      const task = await cli.fabric.tasks.get(id);
      if (task === undefined) {
        throw new CanonicalError({ kind: 'invalid_request', code: 'SY-RPC-001', message: t('rpc.taskNotFound', { id }) });
      }
      const events: CanonicalEvent[] = await cli.fabric.tasks.events(id);
      const receipts = await cli.fabric.stores.receipts.listByTask(id);
      return { lines: taskDetailPanel(task, events, receipts), json: { task, events, receipts } };
    }
    case 'approvals': {
      const pending = await cli.fabric.approvals.listPending();
      return { lines: approvalsPanel(pending), json: { approvals: pending } };
    }
    case 'budget': {
      const accounts = await cli.fabric.budget.list();
      return { lines: budgetPanel(accounts), json: { budget: accounts } };
    }
    case 'audit': {
      const events: AuditEvent[] = await cli.fabric.audit.list({ limit: 50 });
      const verify = await cli.fabric.audit.verify();
      return { lines: auditPanel(events, verify), json: { verify, events } };
    }
    case 'policy': {
      const capabilityId = cmd.capabilityId ?? '';
      // A peer's capabilities only exist once the edge is mounted; `/call` does
      // this lazily, so the explainer must too or it reports a registered
      // capability as unknown.
      await cli.mountRegisteredPeers();
      await cli.fabric.discover();
      const decision = await cli.fabric.policyExplain({ capabilityId });
      return { lines: policyPanel(decision, capabilityId), json: { capabilityId, decision } };
    }
  }
}

/** Resolve a pending approval; never throws for a stale id. */
export async function rpcDecide(
  cmd: Extract<RpcCommand, { kind: 'decide' }>,
  cli: CliFabric,
): Promise<PanelResult> {
  const record: ApprovalRecord | undefined = await cli.fabric.approvals.get(cmd.approvalId);
  const ok = await cli.decideApproval(cmd.approvalId, cmd.optionId);
  const state = record?.state === 'pending' ? (ok ? 'allowed' : 'decided') : (record?.state ?? 'unknown');
  return {
    lines: approvalDecisionPanel(cmd.approvalId, cmd.optionId, ok, ok ? 'allowed' : state),
    json: { approvalId: cmd.approvalId, optionId: cmd.optionId, decided: ok, state: ok ? 'allowed' : state },
  };
}

// ── call ──────────────────────────────────────────────────────────────────

/** Turn `@file` / inline JSON into a value. Throws UsageError on bad JSON. */
export function resolveCallInput(raw: string | undefined): unknown {
  if (raw === undefined || raw === '') return {};
  if (raw.startsWith('@')) {
    const file = raw.slice(1);
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as unknown;
    } catch (e) {
      throw new UsageError(t('rpc.inputFileFailed', { file, detail: e instanceof Error ? e.message : String(e) }));
    }
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new UsageError(t('rpc.inputNotJson'));
  }
}

/** Redact + flatten an invocation output for the panel. */
export function outputText(output: unknown, redact: (text: string) => string): string | undefined {
  if (output === undefined) return undefined;
  const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  return redact(text);
}

/** Governed invocation → panel data. Never throws: errors become the panel. */
export async function callOnce(
  cli: CliFabric,
  capabilityId: string,
  input: unknown,
  redact: (text: string) => string = (s) => s,
): Promise<CallOutcome> {
  const before = new Set(cli.approvalHistory.map((r) => r.id));
  try {
    const result = await cli.call({ capabilityId, input });
    const trail: { id: string; state: string; optionId?: string | undefined }[] = cli.approvalHistory
      .filter((r) => result.approvalIds.includes(r.id))
      .map((r) => ({ id: r.id, state: r.state, ...(r.decisionOptionId !== undefined ? { optionId: r.decisionOptionId } : {}) }));
    const decidedTrail: { id: string; state: string; optionId?: string | undefined }[] = result.approvalIds
      .filter((id) => !before.has(id) && !trail.some((x) => x.id === id))
      .map((id) => ({ id, state: 'allowed' }));
    const output = result.output !== undefined ? outputText(result.output, redact) : undefined;
    return {
      capabilityId,
      outcome: result.outcome,
      receiptId: result.receiptId,
      taskId: result.taskId,
      invocationId: result.invocationId,
      ...(output !== undefined ? { output } : {}),
      approvalIds: result.approvalIds,
      approvalTrail: [...trail, ...decidedTrail],
      lossy: result.lossy ?? [],
      ...(result.replayed !== true ? {} : { replayed: true }),
    };
  } catch (e) {
    const shape = CanonicalError.is(e) ? e.toShape() : undefined;
    // Approvals raised during THIS call are part of the trail even when the
    // call ended in a denial: that is the user's answer, not a missing step.
    const raised = cli.approvalHistory.filter((r) => !before.has(r.id));
    const trail: { id: string; state: string; optionId?: string | undefined }[] = raised.map((r) => ({
      id: r.id,
      state: r.state,
      ...(r.decisionOptionId !== undefined ? { optionId: r.decisionOptionId } : {}),
    }));
    return {
      capabilityId,
      outcome: shape?.kind === 'denied' ? 'denied' : 'failed',
      ...(shape !== undefined
        ? { error: { kind: shape.kind, ...(shape.code !== undefined ? { code: shape.code } : {}), message: shape.message } }
        : { error: { kind: 'internal', message: e instanceof Error ? e.message : String(e) } }),
      approvalIds: raised.map((r) => r.id),
      ...(trail.length > 0 ? { approvalTrail: trail } : {}),
      lossy: [],
    };
  }
}

// ── argv runners ──────────────────────────────────────────────────────────

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

/**
 * Approval presenter for the argv path.
 *
 * The broker calls this *before* it starts waiting, so deciding inside the hook
 * resolves the parked invocation. Interactive terminals get a real prompt;
 * a piped/headless run fails closed immediately (BR-042) instead of hanging for
 * the full approval timeout.
 */
export function createArgvApprovalPresenter(
  cliRef: () => CliFabric | undefined,
  io: CliIo,
): (record: ApprovalRecord) => Promise<void> {
  return async (record: ApprovalRecord): Promise<void> => {
    io.err(`${approvalsPanel([record]).join('\n')}\n`);
    const cli = cliRef();
    if (cli === undefined) return;
    if (process.stdin.isTTY !== true) {
      io.err(`${t('rpc.approve.nonInteractive')}\n`);
      await cli.decideApproval(record.id, 'deny_once', 'user:local', 'non-interactive session');
      return;
    }
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = (await rl.question(t('rpc.approve.prompt'))).trim().toLowerCase();
      const option = normalizeApprovalOption(answer === '' ? 'deny' : answer) ?? 'deny_once';
      await cli.decideApproval(record.id, option, 'user:local');
    } finally {
      rl.close();
    }
  };
}

/** `syao rpc ...` */
export async function runRpcArgv(args: CliArgs, cli: CliFabric, io: CliIo): Promise<number> {
  let cmd: RpcCommand;
  try {
    cmd = parseRpcCommand(args.subArgv);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n`);
      return EXIT.USAGE;
    }
    throw e;
  }
  const view = cmd.kind === 'view' ? cmd.view : 'approve';
  try {
    const result = cmd.kind === 'view' ? await rpcView(cmd, cli) : await rpcDecide(cmd, cli);
    if (cmd.json) io.out(`${JSON.stringify(rpcJsonEnvelope(view, result.json))}\n`);
    else io.out(`${result.lines.join('\n')}\n`);
    return EXIT.OK;
  } catch (e) {
    if (cmd.json) io.out(`${JSON.stringify(rpcErrorEnvelope(view, e))}\n`);
    else io.err(`${errorText(e)}\n`);
    return exitCodeForError(e);
  }
}

/** `syao call <capabilityId> [--input ...] [--json]` */
export async function runCallArgv(args: CliArgs, cli: CliFabric, io: CliIo): Promise<number> {
  let cmd: CallCommand;
  let input: unknown;
  try {
    cmd = parseCallCommand(args.subArgv);
    input = resolveCallInput(cmd.input);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n`);
      return EXIT.USAGE;
    }
    throw e;
  }
  // Registered peers are mounted on demand, so `syao call mcp://<peer>/...`
  // works right after `syao mcp add` without restarting the CLI.
  await cli.mountRegisteredPeers();
  const outcome = await callOnce(cli, cmd.capabilityId, input, (text) => text);
  if (cmd.json) {
    io.out(`${JSON.stringify(callJsonEnvelope(outcome))}\n`);
  } else {
    io.out(`${callResultPanel(outcome).join('\n')}\n`);
  }
  return exitCodeForOutcome(outcome);
}

/** `syao mcp <list|add|remove|tools>` */
export async function runMcpArgv(args: CliArgs, cli: CliFabric, io: CliIo, home?: string): Promise<number> {
  let cmd: McpCommand;
  try {
    cmd = parseMcpCommand(args.subArgv);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n`);
      return EXIT.USAGE;
    }
    throw e;
  }
  switch (cmd.kind) {
    case 'list': {
      const rows = await peerRows(cli, home);
      io.out(`${peersPanel(rows).join('\n')}\n`);
      return EXIT.OK;
    }
    case 'add': {
      const peer: PeerConfig = { protocol: 'mcp', target: cmd.command, addedAt: Date.now() };
      if (!savePeer(cmd.name, peer, home)) {
        io.err(`${t('rpc.badPeerId', { id: cmd.name })}\n`);
        return EXIT.USAGE;
      }
      const report = await cli.mountPeer(cmd.name, peer);
      io.out(
        `${noticePanel(t('rpc.panel.peer'), [
          `${report.ok ? C_OK : C_WARN} ${t('rpc.peer.added', { id: cmd.name, target: cmd.command })}`,
          report.ok
            ? t('rpc.peer.mounted', { id: cmd.name, n: report.capabilities })
            : t('rpc.peer.mountFailed', { id: cmd.name, reason: report.reason ?? '?' }),
          '',
          report.ok ? t('rpc.peer.mcpHint') : t('rpc.peer.edgeUnavailable'),
        ]).join('\n')}\n`,
      );
      return EXIT.OK;
    }
    case 'remove': {
      const removed = removePeer(cmd.name, home);
      io.out(
        `${noticePanel(t('rpc.panel.peer'), [
          `${removed ? C_OK : C_WARN} ${removed ? t('rpc.peer.removed', { id: cmd.name }) : t('rpc.peer.notFound', { id: cmd.name })}`,
        ]).join('\n')}\n`,
      );
      return removed ? EXIT.OK : EXIT.USAGE;
    }
    case 'tools': {
      const caps = await capabilitiesOf(cli, cmd.name);
      io.out(`${capabilityListPanel(cmd.name, caps).join('\n')}\n`);
      return EXIT.OK;
    }
  }
}

const C_OK = '\x1b[32m✔\x1b[39m';
const C_WARN = '\x1b[33m!\x1b[39m';

/** `syao serve ...` — the only entry point that binds a socket. */
export async function runServeArgv(args: CliArgs, cli: CliFabric, io: CliIo): Promise<number> {
  let cmd: ServeCommand;
  try {
    cmd = parseServeArgv(args.subArgv);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n`);
      return EXIT.USAGE;
    }
    throw e;
  }
  const token = resolveServeToken();
  const plan = servePlan({
    protocol: cmd.protocol,
    transport: cmd.transport,
    ...(cmd.host !== undefined ? { host: cmd.host } : {}),
    ...(cmd.port !== undefined ? { port: cmd.port } : {}),
    ...(token !== undefined ? { token } : {}),
  });
  if (cmd.json) {
    io.out(`${JSON.stringify(rpcJsonEnvelope('serve', plan))}\n`);
    return plan.errors.length > 0 ? EXIT.USAGE : EXIT.OK;
  }
  // Imported lazily so the view tests never touch `node:http`.
  const { runServe } = await import('./serve.js');
  return runServe(plan, {
    ctx: {
      fabric: cli.fabric,
      principal: cli.principal,
      cwd: cli.cwd,
      workspaceRoots: cli.workspaceRoots,
      tenantId: cli.tenantId,
      ensureSession: async () => {
        const session = await cli.ensureSession();
        return { id: session.id, budgetId: session.budgetId };
      },
    },
    io,
    ...(token !== undefined ? { token } : {}),
  });
}

// ── slash-command handlers (shared by REPL and TUI) ───────────────────────

export interface SlashConsole {
  cli: CliFabric;
  /** Print panel lines (already ANSI) or plain text. */
  print(lines: string[] | string): void;
  /** Print an error / usage line. */
  printError(text: string): void;
  /**
   * Run a long task in the background and print its panel when it settles.
   * The REPL/TUI pass this so `/call` never freezes the input loop while an
   * approval is pending; when absent the call is awaited inline.
   */
  background?: (task: () => Promise<string[]>) => void;
  /** Home override for the peer registry (tests). */
  home?: string;
}

function emit(c: SlashConsole, lines: string[]): void {
  c.print(lines);
}

/** `/rpc [tasks|task <id>|approvals|approve <id> [opt]|deny <id>|budget|audit|policy <cap>|status]` */
export async function handleRpcSlash(args: string[], c: SlashConsole): Promise<void> {
  let cmd: RpcCommand;
  try {
    cmd = parseRpcCommand(args);
  } catch (e) {
    if (e instanceof UsageError) {
      c.printError(e.message);
      return;
    }
    throw e;
  }
  try {
    const result = cmd.kind === 'view' ? await rpcView(cmd, c.cli) : await rpcDecide(cmd, c.cli);
    emit(c, result.lines);
  } catch (e) {
    c.printError(errorText(e));
  }
}

/** `/approve <id> [once|session|always|deny]` — shortcut for `/rpc approve`. */
export async function handleApproveSlash(args: string[], c: SlashConsole): Promise<void> {
  const id = args[0];
  if (id === undefined) {
    c.printError(t('rpc.approvalRequired'));
    return;
  }
  const raw = args[1] ?? 'allow_once';
  const optionId = normalizeApprovalOption(raw);
  if (optionId === undefined) {
    c.printError(t('rpc.badOption', { option: raw }));
    return;
  }
  await handleRpcSlash(['approve', id, optionId], c);
}

/** `/call <capabilityId> [json input]` — one governed invocation. */
export async function handleCallSlash(args: string[], c: SlashConsole): Promise<void> {
  const capabilityId = args[0];
  if (capabilityId === undefined) {
    c.printError(t('rpc.capabilityRequired'));
    return;
  }
  let input: unknown;
  try {
    input = args.length > 1 ? resolveCallInput(args.slice(1).join(' ')) : {};
  } catch (e) {
    c.printError(e instanceof Error ? e.message : String(e));
    return;
  }
  const task = async (): Promise<string[]> => {
    // A peer registered in this session must be reachable right away.
    await c.cli.mountRegisteredPeers();
    const outcome = await callOnce(c.cli, capabilityId, input);
    return callResultPanel(outcome);
  };
  if (c.background !== undefined) {
    c.print(t('rpc.call.running', { id: capabilityId }));
    c.background(task);
    return;
  }
  emit(c, await task());
}

/** `/serve [mcp|acp|a2a] [--stdio|--http] [--port N]` — plan only, never binds. */
export async function handleServeSlash(args: string[], c: SlashConsole): Promise<void> {
  let cmd: ServeCommand;
  try {
    cmd = parseServeArgv(args);
  } catch (e) {
    if (e instanceof UsageError) {
      c.printError(e.message);
      return;
    }
    throw e;
  }
  const token = resolveServeToken();
  const plan = servePlan({
    protocol: cmd.protocol,
    transport: cmd.transport,
    ...(cmd.host !== undefined ? { host: cmd.host } : {}),
    ...(cmd.port !== undefined ? { port: cmd.port } : {}),
    ...(token !== undefined ? { token } : {}),
  });
  const edgeAvailable = await probeProtocolEdge(plan.protocol);
  const effective: ServePlan = edgeAvailable
    ? { ...plan, notes: [...plan.notes, t('serve.slashHint')] }
    : { ...plan, edgeUnavailable: true, notes: [...plan.notes, t('serve.slashHint')] };
  emit(c, servePanel(effective));
}

/** `/peer [list|add <id> <url|command>|remove <id>|ping <id>]` and `/mcp` alias. */
export async function handlePeerSlash(
  args: string[],
  c: SlashConsole,
  opts: { forceProtocol?: PeerProtocol } = {},
): Promise<void> {
  const sub = args[0] ?? 'list';
  if (sub === 'list') {
    emit(c, peersPanel(await peerRows(c.cli, c.home)));
    return;
  }
  if (sub === 'add') {
    const id = args[1];
    const target = args.slice(2).join(' ');
    if (id === undefined || target === '') {
      c.printError(t('rpc.peer.addUsage'));
      return;
    }
    if (!validPeerId(id)) {
      c.printError(t('rpc.badPeerId', { id }));
      return;
    }
    const protocol = opts.forceProtocol ?? guessProtocol(target);
    const peer: PeerConfig = { protocol, target, addedAt: Date.now() };
    savePeer(id, peer, c.home);
    // Mount right away so the peer is usable without a restart.
    const report = await c.cli.mountPeer(id, peer);
    emit(c, noticePanel(t('rpc.panel.peer'), [
      `${report.ok ? C_OK : C_WARN} ${t('rpc.peer.added', { id, target })}`,
      `${t('rpc.tbl.protocol')}: ${protocol}`,
      report.ok
        ? t('rpc.peer.mounted', { id, n: report.capabilities })
        : t('rpc.peer.mountFailed', { id, reason: report.reason ?? '?' }),
      '',
      report.ok ? t('rpc.peer.addHint') : t('rpc.peer.edgeUnavailable'),
    ]));
    return;
  }
  if (sub === 'remove') {
    const id = args[1];
    if (id === undefined) {
      c.printError(t('rpc.peer.removeUsage'));
      return;
    }
    const removed = removePeer(id, c.home);
    emit(c, noticePanel(t('rpc.panel.peer'), [
      `${removed ? C_OK : C_WARN} ${removed ? t('rpc.peer.removed', { id }) : t('rpc.peer.notFound', { id })}`,
    ]));
    return;
  }
  if (sub === 'ping') {
    const id = args[1];
    if (id === undefined) {
      c.printError(t('rpc.peer.pingUsage'));
      return;
    }
    const peer = listPeers(c.home)[id];
    const protocol: PeerProtocol = opts.forceProtocol ?? peer?.protocol ?? 'mcp';
    const available = await probeProtocolEdge(protocol);
    emit(c, peerPingPanel(
      id,
      protocol,
      available,
      available ? t('rpc.peer.edgeReady') : t('rpc.peer.edgeUnavailable'),
    ));
    return;
  }
  c.printError(t('rpc.peer.usage'));
}

// ── argument plumbing ─────────────────────────────────────────────────────

/** True when a rendered panel stays inside the terminal budget. */
export function panelFits(lines: readonly string[], cols = 100): boolean {
  return maxVisibleWidth(lines, cols);
}

export { DEFAULT_PORTS };
export type { ServePlan, Task };
