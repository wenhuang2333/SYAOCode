import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChannelConfig, ChannelInfo, ChannelModel, ContextInfo, DesktopOverview, SessionInspection, UsageQuery, UsageRecord, WorkspaceInfo } from '@syaocode/dhp';
import { DesktopStateStore, type SavedSession } from './desktop-state.ts';
import { DhpProtocolError } from './dhp-server.ts';
import { SessionRegistry } from './session-registry.ts';
import { channelSchema, modelSpecSchema, parseInput, safeUrlSchema } from './workbench-validation.ts';
import { queryUsage, totals, UNKNOWN_CONTEXT } from './usage.ts';

const BUILTINS = new Set(['mock', 'deepseek', 'openai-compatible', 'anthropic']);
export class WorkbenchService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failure: unknown;
  constructor(readonly store: DesktopStateStore, readonly registry: SessionRegistry, private readonly env: Record<string, string | undefined>, private readonly sessions: () => SavedSession[]) {}

  initializeChannels(): void {
    const url = (name: string, fallback: string): string => {
      const raw = this.env[name];
      if (!raw) return fallback;
      if (!safeUrlSchema.safeParse(raw).success) throw new Error(`Invalid endpoint in ${name}; credentials/query/remote HTTP are not allowed`);
      return raw.replace(/\/$/, '');
    };
    const defaults: ChannelConfig[] = [
      { id: 'mock', name: 'Mock（离线演示）', protocol: 'mock', models: [{ id: 'default', name: 'Offline demo' }] },
      { id: 'deepseek', name: 'DeepSeek', protocol: 'openai-compatible', baseUrl: url('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1'), apiKeyEnv: 'DEEPSEEK_API_KEY', models: [] },
      { id: 'openai-compatible', name: 'OpenAI compatible', protocol: 'openai-compatible', baseUrl: url('OPENAI_BASE_URL', 'https://api.openai.com/v1'), apiKeyEnv: 'OPENAI_API_KEY', models: [] },
      { id: 'anthropic', name: 'Anthropic', protocol: 'anthropic', baseUrl: url('ANTHROPIC_BASE_URL', 'https://api.anthropic.com/v1'), apiKeyEnv: 'ANTHROPIC_API_KEY', models: [] },
    ];
    for (const c of defaults) if (!this.store.data.channels.some((x) => x.id === c.id)) this.store.data.channels.push(c);
  }
  /** Only import an actual configured ID, never fabricate a vendor catalogue. */
  importConfiguredModel(spec: string): void {
    if (!modelSpecSchema.safeParse(spec).success) return;
    const i = spec.indexOf(':'); const id = spec.slice(0, i); const model = spec.slice(i + 1);
    if (id === 'mock' || !BUILTINS.has(id)) return;
    const index = this.store.data.channels.findIndex((c) => c.id === id);
    const c = this.store.data.channels[index];
    if (c && !c.models.some((m) => m.id === model)) this.store.data.channels[index] = { ...c, models: [...c.models, { id: model, name: model }] };
  }
  channels(): ChannelInfo[] {
    return this.store.data.channels.map((c) => ({ ...c, builtin: BUILTINS.has(c.id), reasoningLevels: [], credentialReady: c.protocol === 'mock' || Boolean(c.apiKeyEnv && this.env[c.apiKeyEnv]?.trim()) }));
  }
  model(spec: string, requireCredential = true): { channel: ChannelConfig; model: ChannelModel } {
    parseInput(modelSpecSchema, spec);
    const i = spec.indexOf(':');
    const channel = this.channels().find((c) => c.id === spec.slice(0, i));
    const model = channel?.models.find((m) => m.id === spec.slice(i + 1));
    if (!channel || !model) throw new DhpProtocolError('unsupported_capability', 'Unknown channel/model; configure the channel first');
    if (requireCredential && !channel.credentialReady) throw new DhpProtocolError('unsupported_capability', 'Model credentials are not ready');
    return { channel: this.store.data.channels.find((c) => c.id === channel.id)!, model };
  }
  async saveChannel(value: unknown): Promise<ChannelInfo> {
    const parsed = parseInput(channelSchema, value);
    const c = parsed as ChannelConfig;
    const i = this.store.data.channels.findIndex((x) => x.id === c.id);
    if (i < 0) this.store.data.channels.push(c); else this.store.data.channels[i] = c;
    await this.save();
    return this.channels().find((x) => x.id === c.id)!;
  }
  async openWorkspace(root: string): Promise<WorkspaceInfo> {
    let canonical: string;
    try {
      canonical = await fs.realpath(root);
      if (!(await fs.stat(canonical)).isDirectory()) throw new Error('not a directory');
    } catch { throw new DhpProtocolError('path_rejected', 'Workspace must be an existing directory'); }
    const existing = this.store.data.workspaces.find((w) => w.root === canonical);
    if (existing) return existing;
    const w = { id: `ws_${randomUUID()}`, name: path.basename(canonical) || canonical, root: canonical, addedAt: Date.now() };
    this.store.data.workspaces.push(w);
    await this.save();
    return w;
  }
  requireWorkspace(root: string): WorkspaceInfo {
    const w = this.store.data.workspaces.find((w) => w.root === root);
    if (!w) throw new DhpProtocolError('path_rejected', 'Workspace is not registered');
    return w;
  }
  overview(): DesktopOverview {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return { workspaces: this.store.data.workspaces, sessions: this.registry.list(), channels: this.channels(), today: totals(this.store.data.ledger.filter((r) => r.startedAt >= start.getTime() && r.startedAt <= Date.now())) };
  }
  query(q: UsageQuery) {
    return queryUsage(this.store.data.ledger, q, { projects: new Map(this.store.data.workspaces.map((w) => [w.root, w.name])), channels: new Map(this.channels().map((c) => [c.id, c.name])) });
  }
  inspect(id: string): SessionInspection {
    this.registry.require(id);
    return { sessionId: id, totals: totals(this.store.data.ledger.filter((r) => r.sessionId === id)), context: this.store.data.contexts[id] ?? UNKNOWN_CONTEXT,
      changes: this.store.data.changes[id] ?? [],
      artifacts: this.store.data.artifacts[id] ?? [],
      sources: this.store.data.sources[id] ?? [],
      coverage: this.store.data.coverage[id] ?? { exact: true, bashUsed: false, note: null },
      resources: [
        { id: 'mcp', name: 'MCP', supported: false, detail: 'Only the protocols MCP client exists; trusted registration, execution and permission assembly are not connected.' },
        { id: 'skills', name: 'Skills', supported: false, detail: 'No desktop skill execution adapter is connected.' },
        { id: 'agents', name: 'Agents', supported: false, detail: 'No desktop sub-agent orchestration is connected.' },
        { id: 'checkpoints', name: 'Checkpoints', supported: false, detail: 'Session persistence is not a workspace rollback checkpoint.' },
      ] };
  }
  context(id: string, value: ContextInfo): void { this.store.data.contexts[id] = value; }
  async record(r: UsageRecord): Promise<void> {
    const i = this.store.data.ledger.findIndex((x) => x.id === r.id);
    if (i < 0) this.store.data.ledger.push(r); else this.store.data.ledger[i] = r;
    await this.save();
  }
  scheduleSave(): void {
    if (this.timer || this.failure) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.save().catch((e: unknown) => { this.failure = e; }); }, 250);
    this.timer.unref();
  }
  async save(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.store.data.sessions = this.sessions();
    await this.store.save();
  }
  async close(): Promise<void> {
    try { await this.save(); } finally { await this.store.close(); }
  }
}
