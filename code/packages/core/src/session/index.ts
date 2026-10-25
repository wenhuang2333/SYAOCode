import type { Runtime } from '../runtime/index.js';
import { SessionError } from '../errors/syao-error.js';

/**
 * Append-only event log as the source of truth (ADR-05, DD-7, BR-016).
 * Entries are never modified; forks point at a parent entry. Single-writer
 * per file is enforced by a lock file (SY-SES-004).
 */

export interface LogEntry {
  v: 1;
  id: string;
  ts: number;
  sessionId: string;
  parentId?: string;
  type: 'message' | 'usage' | 'compaction' | 'meta' | 'checkpoint' | 'fork' | 'permission';
  data: unknown;
}

export interface SessionInfo {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  entryCount: number;
}

export interface SessionFilter {
  limit?: number;
}

export interface SessionStore {
  append(sessionId: string, entries: LogEntry[]): Promise<void>;
  load(sessionId: string): Promise<LogEntry[]>;
  list(filter?: SessionFilter): Promise<SessionInfo[]>;
  fork(sessionId: string, atEntryId?: string): Promise<string>;
  delete(sessionId: string): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, LogEntry[]>();

  async append(sessionId: string, entries: LogEntry[]): Promise<void> {
    const list = this.sessions.get(sessionId) ?? [];
    list.push(...entries);
    this.sessions.set(sessionId, list);
  }

  async load(sessionId: string): Promise<LogEntry[]> {
    const list = this.sessions.get(sessionId);
    if (list === undefined) {
      throw new SessionError({ code: 'SY-SES-001', details: { sessionId } });
    }
    return [...list];
  }

  async list(filter?: SessionFilter): Promise<SessionInfo[]> {
    const infos = [...this.sessions.entries()].map(([sessionId, entries]) => ({
      sessionId,
      createdAt: entries[0]?.ts ?? 0,
      updatedAt: entries[entries.length - 1]?.ts ?? 0,
      entryCount: entries.length,
    }));
    infos.sort((a, b) => b.updatedAt - a.updatedAt);
    return filter?.limit !== undefined ? infos.slice(0, filter.limit) : infos;
  }

  async fork(sessionId: string, atEntryId?: string): Promise<string> {
    const list = this.sessions.get(sessionId);
    if (list === undefined) {
      throw new SessionError({ code: 'SY-SES-001', details: { sessionId } });
    }
    const cut = atEntryId === undefined ? list.length : list.findIndex((e) => e.id === atEntryId) + 1;
    if (cut <= 0) {
      throw new SessionError({ code: 'SY-SES-002', message: `fork point ${atEntryId} not found`, details: { atEntryId } });
    }
    const forkId = `fork_${sessionId}_${cut}`;
    const forked = list.slice(0, cut).map((e, i) => ({ ...e, id: `${forkId}_e${i}`, sessionId: forkId, parentId: e.id }));
    this.sessions.set(forkId, forked);
    return forkId;
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}

/** JSONL file store: ~/.syaocode/sessions/<projectHash>/<sessionId>.jsonl */
export class FileSessionStore implements SessionStore {
  constructor(
    private readonly runtime: Runtime,
    private readonly baseDir: string,
    private readonly projectHash: string,
    private readonly opts: { corruptRatioThreshold?: number } = {},
  ) {}

  private dir(): string {
    return `${this.baseDir}/${this.projectHash}`;
  }

  private path(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${this.dir()}/${safe}.jsonl`;
  }

  async append(sessionId: string, entries: LogEntry[]): Promise<void> {
    await this.runtime.fs.mkdir(this.dir(), { recursive: true });
    const line = entries.map((e) => JSON.stringify(e)).join('\n');
    const file = this.path(sessionId);
    await this.withLock(file, async () => {
      await this.runtime.fs.appendFile(file, `${line}\n`);
    });
  }

  /** Serialize writers with an atomic lock directory (SY-SES-004 on timeout). */
  private async withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const lock = `${file}.lock`;
    const started = this.runtime.clock.now();
    for (;;) {
      try {
        await this.runtime.fs.mkdir(lock);
        break;
      } catch {
        if (this.runtime.clock.now() - started > 5_000) {
          throw new SessionError({
            code: 'SY-SES-004',
            message: `Session log is locked by another writer: ${lock}`,
            details: { file },
          });
        }
        await this.runtime.clock.sleep(20).catch(() => undefined);
      }
    }
    try {
      return await fn();
    } finally {
      try {
        await this.runtime.fs.rmdir(lock);
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  async load(sessionId: string): Promise<LogEntry[]> {
    const file = this.path(sessionId);
    if (!(await this.runtime.fs.exists(file))) {
      throw new SessionError({ code: 'SY-SES-001', details: { sessionId, file } });
    }
    const raw = await this.runtime.fs.readFile(file);
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const entries: LogEntry[] = [];
    let corrupt = 0;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as LogEntry;
        if (parsed.v !== 1) {
          if (parsed.v > 1) {
            throw new SessionError({ code: 'SY-SES-003', details: { sessionId, found: parsed.v } });
          }
          corrupt += 1;
          continue;
        }
        entries.push(parsed);
      } catch (e) {
        if (SessionError.is(e)) throw e;
        corrupt += 1;
        this.runtime.logger.log('warn', 'session: skipped corrupt line', { sessionId });
      }
    }
    const threshold = this.opts.corruptRatioThreshold ?? 0.2;
    if (lines.length > 0 && corrupt / lines.length > threshold) {
      throw new SessionError({
        code: 'SY-SES-002',
        details: { sessionId, corrupt, total: lines.length },
      });
    }
    return entries;
  }

  async list(filter?: SessionFilter): Promise<SessionInfo[]> {
    if (!(await this.runtime.fs.exists(this.dir()))) return [];
    const files = (await this.runtime.fs.readdir(this.dir())).filter((e) => e.name.endsWith('.jsonl'));
    const infos: SessionInfo[] = [];
    for (const f of files) {
      const sessionId = f.name.replace(/\.jsonl$/, '');
      const entries = await this.load(sessionId).catch(() => []);
      const first = entries[0];
      const last = entries[entries.length - 1];
      infos.push({
        sessionId,
        createdAt: first?.ts ?? 0,
        updatedAt: last?.ts ?? 0,
        entryCount: entries.length,
      });
    }
    infos.sort((a, b) => b.updatedAt - a.updatedAt);
    return filter?.limit !== undefined ? infos.slice(0, filter.limit) : infos;
  }

  async fork(sessionId: string, atEntryId?: string): Promise<string> {
    const entries = await this.load(sessionId);
    const cut = atEntryId === undefined ? entries.length : entries.findIndex((e) => e.id === atEntryId) + 1;
    if (cut <= 0) {
      throw new SessionError({ code: 'SY-SES-002', message: `fork point ${atEntryId} not found`, details: { atEntryId } });
    }
    const forkId = `fork_${sessionId}_${cut}_${Date.now().toString(36)}`;
    const forked = entries.slice(0, cut).map((e, i) => ({ ...e, id: `${forkId}_e${i}`, sessionId: forkId, parentId: e.id }));
    await this.append(forkId, forked);
    return forkId;
  }

  async delete(sessionId: string): Promise<void> {
    const file = this.path(sessionId);
    if (await this.runtime.fs.exists(file)) await this.runtime.fs.unlink(file);
  }
}

export function projectHashOf(cwd: string): number {
  let h = 0;
  for (let i = 0; i < cwd.length; i += 1) {
    h = (Math.imul(31, h) + cwd.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
