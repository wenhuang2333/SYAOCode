/**
 * 会话改动 / 产出 / 来源采集器（`27` §7–§9）。
 *
 * 这是"宿主侧工具装饰器"（§7.2）的**数据侧**：工具执行前后各拍一次"文件像"，
 * 由 Host 算出"本会话到底改了什么"。三条纪律贯穿全文件：
 *
 *  - **不伪造**：算不出行数就写 `null` + `stat: 'unavailable'`，
 *    绝不用 `0` 冒充（二进制、超限、不可读、非普通文件一律如此）。
 *  - **会话口径**：只统计本会话工具执行造成的改动，绝不与工作区口径混算。
 *  - **路径过围栏**：绝对路径、`..` 逃逸、敏感文件、逃出工作区的符号链接一律拒绝。
 *
 * 本文件只产出数据，不做任何展示决策；渲染层拿到的永远是 Host 算出的真实数字。
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  Artifact,
  ArtifactKind,
  ChangesCoverage,
  FileChange,
  FileChangeStatus,
  SourceRef,
} from '@syaocode/dhp';
import { statFile, type FileStat } from './file-stat.ts';
import { diffLines } from './workspace.ts';

/** 每个会话最多保留的来源条数（`27` §9.3：条数必须是真实统计，超出丢弃新条目）。 */
export const MAX_SOURCES_PER_SESSION = 50;

/** 用过 `bash` 后的诚实降级提示（`27` §7.3，文案由 UI 直接展示）。 */
export const BASH_COVERAGE_NOTE = '本会话还执行过命令，命令造成的文件变化未逐文件统计';

/** 单条 URL 的长度上限：超长的一律丢弃，不进列表。 */
const MAX_URL_LENGTH = 2048;

/** 查询串里这些名字视为凭据，展示前剥离（`27` §9.3「凭据泄露」）。 */
const CREDENTIAL_QUERY_KEYS = new Set([
  'token',
  'access_token',
  'accesstoken',
  'api_key',
  'apikey',
  'key',
  'password',
  'passwd',
  'pwd',
  'secret',
  'signature',
  'sig',
  'auth',
]);

/**
 * 敏感文件判定。
 *
 * 与 `workspace.ts` 的同名规则保持一致（那边是文件浏览器的口径，这里是采集器的口径）。
 * 两处都没有导出，所以这里复制一份——宁可重复，也不要让采集器依赖浏览器规则。
 */
function isSensitivePath(value: string): boolean {
  return value
    .split(/[\\/]/)
    .some((part) =>
      /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|id_rsa|id_ed25519|credentials(?:\.json)?|.*\.(?:pem|key|p12))$/i.test(
        part,
      ),
    );
}

/** 把文本切成行：丢掉结尾那个"换行之后的空串"，使行数口径与 `statFile` 一致。 */
function splitLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** 文件像：一次读盘的结果。 */
type ImageKind = 'absent' | 'text' | 'unavailable';

interface Image {
  readonly kind: ImageKind;
  /** 文本行（仅 `kind === 'text'` 时有值）。 */
  readonly lines: readonly string[];
  /** `statFile` 的原始结果，用于取行数与说明"为什么不可统计"。 */
  readonly stat: FileStat | null;
}

const ABSENT_IMAGE: Image = { kind: 'absent', lines: [], stat: null };

/** 前置像/后置像都算不出来时的占位（表示"不知道"，不是"没有变化"）。 */
const UNKNOWN_IMAGE: Image = { kind: 'unavailable', lines: [], stat: null };

/** 一个路径的实时采集状态（前置像 + 产出判定）。 */
interface FileRecord {
  /** **第一次**前置像：同一路径多次写入时不再更新（`27` §7.2「去重」）。 */
  readonly before: Image;
  /** 第一次触碰该路径的工具名。 */
  readonly tool: string;
  /** 是否由 `write` 写入了一个"原本不存在"的路径（产出判定，`27` §8.2）。 */
  readonly createdByWrite: boolean;
  /**
   * 最近一次已知的**文本内容**：文件被删除时用它算"删除前全文行数"（`27` §7.5）。
   * 没有文本内容（二进制 / 超限 / 不可读 / 从未存在）时为 `null`。
   */
  lastText: Image | null;
}

/** 单个会话的采集状态。 */
interface SessionState {
  /** 实时采集：路径 → 前置像。 */
  readonly files: Map<string, FileRecord>;
  /** 当前改动条目：路径 → 条目（同一路径只保留一条，重复写入就地更新）。 */
  readonly changes: Map<string, FileChange>;
  readonly artifacts: Artifact[];
  /** 来源：清洗后的 URL → 条目。 */
  readonly sources: Map<string, SourceRef>;
  coverage: ChangesCoverage;
}

/** 会话改动 / 产出 / 来源的一次性快照（整体替换语义，不做 delta）。 */
export interface ChangesSnapshot {
  changes: FileChange[];
  artifacts: Artifact[];
  sources: SourceRef[];
  coverage: ChangesCoverage;
}

function emptyCoverage(): ChangesCoverage {
  return { exact: true, bashUsed: false, note: null };
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

/** 按扩展名推断产出类型（`27` §8.1 的 `kind` 取值）。 */
export function artifactKindFor(relPath: string): ArtifactKind {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.webp' || ext === '.svg') {
    return 'image';
  }
  if (ext === '.patch' || ext === '.diff') return 'patch';
  if (ext === '.md' || ext === '.txt' || ext === '.pdf' || ext === '.json' || ext === '.csv') return 'report';
  if (ext === '.zip' || ext === '.tar' || ext === '.gz') return 'archive';
  return 'file';
}

/**
 * 从工具输出文本里抽取 URL。
 *
 * 先按"带协议的 URL"抽取（保留协议名），再由调用方按协议放行——
 * 这样 `javascript://…` 这类会**明确被拒绝**，而不是因为正则没匹配上而"碰巧"安全。
 */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  const pattern = /\b([a-zA-Z][a-zA-Z0-9+.-]*):\/\/[^\s<>"'`]+/g;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    // 去掉句末标点与收尾的括号/引号（"见 https://a.com/x." 里的 '.' 不属于 URL）。
    const trimmed = raw.replace(/[.,;:!?)\]}'"]+$/, '');
    if (trimmed.length > MAX_URL_LENGTH) continue;
    out.push(trimmed);
  }
  return out;
}

interface SanitizedUrl {
  readonly url: string;
  readonly domain: string;
  readonly title: string;
}

/**
 * 清洗 URL：只放行 `http` / `https`，剥离内嵌凭据与查询串里的令牌。
 *
 * 返回 `null` 表示"这条不能作为来源"（协议不对 / 不是合法 URL / 太长）。
 */
export function sanitizeSourceUrl(raw: string): SanitizedUrl | null {
  if (raw.length > MAX_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.toLowerCase();
  // 恶意链接：`javascript:` / `data:` / `file:` 等一律丢弃（`27` §9.3）。
  if (scheme !== 'http:' && scheme !== 'https:') return null;

  // 内嵌凭据：`https://user:token@host/x` → `https://host/x`。
  if (parsed.username !== '' || parsed.password !== '') {
    parsed.username = '';
    parsed.password = '';
  }
  // 查询串里的令牌同样剥离（"token=…" 之类）。
  const queryKeys = [...parsed.searchParams.keys()];
  for (const key of queryKeys) {
    if (CREDENTIAL_QUERY_KEYS.has(key.toLowerCase())) parsed.searchParams.delete(key);
  }
  if (parsed.search === '?') parsed.search = '';

  const domain = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  const last = segments[segments.length - 1];
  let title = domain;
  if (last !== undefined && last !== '') {
    try {
      title = decodeURIComponent(last);
    } catch {
      title = last;
    }
  }
  if (title.length > 120) title = title.slice(0, 120);
  return { url: parsed.toString(), domain, title };
}

/**
 * 会话改动 / 产出 / 来源采集器。
 *
 * 生命周期由 Host 持有：一个会话一个采集器实例（或一个实例多会话，按 `sessionId` 分桶）。
 * 采集器是**唯一**的改动集合所有者（`27` §6 P3：会话事实源只有一份）。
 */
export class ChangesCollector {
  private readonly root: string;
  private readonly onChange: ((sessionId: string) => void) | undefined;
  private readonly sessions = new Map<string, SessionState>();
  /** 每个会话一把串行锁：采集是异步读盘，避免同一路径的前后像交叉。 */
  private readonly locks = new Map<string, Promise<void>>();
  private rootReal: string | null = null;

  constructor(opts: { workspaceRoot: string; onChange?: (sessionId: string) => void }) {
    this.root = path.resolve(opts.workspaceRoot);
    this.onChange = opts.onChange;
  }

  /** 工作区根（绝对路径）。 */
  get workspaceRoot(): string {
    return this.root;
  }

  /**
   * 装饰器"执行前"：拍下目标文件的前置像。
   *
   * 同一路径只拍**第一次**：之后再写多少次，都按"首次前置像 → 最后后置像"计算，
   * 不逐次累加（`27` §7.2「去重」）。
   */
  async captureBefore(sessionId: string, tool: string, relPath: string): Promise<void> {
    await this.serialize(sessionId, async () => {
      const target = await this.resolveTarget(relPath);
      if (target === null) return;
      const state = this.state(sessionId);
      if (state.files.has(target.rel)) return;
      const before = await this.readImage(target.abs);
      state.files.set(target.rel, {
        before,
        tool,
        createdByWrite: tool === 'write' && before.kind === 'absent',
        lastText: before.kind === 'text' ? before : null,
      });
    });
  }

  /**
   * 装饰器"执行后"：读回后置像，算出改动条目，必要时登记产出。
   *
   * 工具报错（`isError`）时**不新增条目**（`27` §7.5「写入未发生」）。
   */
  async captureAfter(
    sessionId: string,
    tool: string,
    relPath: string,
    opts?: { isError?: boolean },
  ): Promise<void> {
    await this.serialize(sessionId, async () => {
      const isError = opts?.isError === true;
      const target = await this.resolveTarget(relPath);
      if (target === null) return;
      const state = this.state(sessionId);
      if (isError) return;

      let record = state.files.get(target.rel);
      if (record === undefined) {
        // 没有前置像（例如宿主只调了 after）：不猜"原来存不存在"，
        // 记成"不可统计"，条目仍然保留。
        record = { before: UNKNOWN_IMAGE, tool, createdByWrite: false, lastText: null };
        state.files.set(target.rel, record);
      }

      const after = await this.readImage(target.abs);
      const entry = computeChange(target.rel, record.before, after, record.tool, record.lastText);
      // 记住最近一次文本内容：文件随后被删除时，用它算"删除前全文行数"。
      if (after.kind === 'text') record.lastText = after;
      if (entry === null) {
        // 内容没有变化（例如写入内容与原来完全一致）：不制造噪音条目。
        // 若之前有该路径的条目（多次写入后改回原样），此时净改动为零，应当移除。
        if (state.changes.delete(target.rel)) this.notify(sessionId);
        return;
      }
      state.changes.set(target.rel, entry);

      // 产出：`write` 写入了一个"原本不存在"的路径（`27` §8.2）。
      if (
        record.createdByWrite &&
        tool === 'write' &&
        after.kind !== 'absent' &&
        !state.artifacts.some((artifact) => artifact.path === target.rel)
      ) {
        state.artifacts.push(this.makeArtifact(target.rel, tool, after));
      }

      this.notify(sessionId);
    });
  }

  /** `bash` 被调用过：逐文件统计不再完整，诚实降级（`27` §7.3）。 */
  noteBash(sessionId: string): void {
    const state = this.state(sessionId);
    if (state.coverage.bashUsed) return;
    state.coverage = { exact: false, bashUsed: true, note: BASH_COVERAGE_NOTE };
    this.notify(sessionId);
  }

  /**
   * 从工具输出文本里抽取来源。
   *
   * 只接受 `http` / `https`；`trust` 恒为 `'extracted'`、`verified` 恒为 `false`
   * ——抓不到验证凭据就不许说"已核实"（`27` §9.1 / §9.3）。
   */
  noteOutput(sessionId: string, tool: string, outputText: string): void {
    if (outputText === '') return;
    const state = this.state(sessionId);
    let changed = false;
    for (const raw of extractUrls(outputText)) {
      const sanitized = sanitizeSourceUrl(raw);
      if (sanitized === null) continue;
      const existing = state.sources.get(sanitized.url);
      if (existing !== undefined) {
        // 去重累加：同一条来源出现多次就加计数，不新增条目。
        state.sources.set(sanitized.url, { ...existing, count: existing.count + 1 });
        changed = true;
        continue;
      }
      if (state.sources.size >= MAX_SOURCES_PER_SESSION) continue; // 超出上限：丢弃新条目
      state.sources.set(sanitized.url, {
        id: stableId('src', sanitized.url),
        title: sanitized.title,
        url: sanitized.url,
        domain: sanitized.domain,
        count: 1,
        tool,
        trust: 'extracted',
        verified: false,
      });
      changed = true;
    }
    if (changed) this.notify(sessionId);
  }

  /** 取当前快照（整体替换语义的载荷）。 */
  snapshot(sessionId: string): ChangesSnapshot {
    const state = this.sessions.get(sessionId);
    if (state === undefined) {
      return { changes: [], artifacts: [], sources: [], coverage: emptyCoverage() };
    }
    return {
      changes: [...state.changes.values()],
      artifacts: [...state.artifacts],
      sources: [...state.sources.values()],
      coverage: state.coverage,
    };
  }

  /**
   * 恢复一个已保存的快照（状态持久化 / 会话 fork 场景）。
   *
   * 只恢复"结果"，不恢复"文件像"：恢复后的新写入会重新拍前置像。
   */
  restore(sessionId: string, data: ChangesSnapshot): void {
    const state = this.state(sessionId);
    state.files.clear();
    state.changes.clear();
    for (const change of data.changes) state.changes.set(change.path, change);
    state.artifacts.length = 0;
    state.artifacts.push(...data.artifacts);
    state.sources.clear();
    for (const source of data.sources) state.sources.set(source.url, source);
    state.coverage = data.coverage;
  }

  /** 清空一个会话的采集状态（会话结束 / 重置）。 */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.locks.delete(sessionId);
  }

  // ── 内部实现 ──────────────────────────────────────────────────────────

  private state(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created: SessionState = {
      files: new Map(),
      changes: new Map(),
      artifacts: [],
      sources: new Map(),
      coverage: emptyCoverage(),
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  /** 通知宿主"这个会话的快照变了"（节流由调用方负责，这里不节流）。 */
  private notify(sessionId: string): void {
    if (this.onChange === undefined) return;
    try {
      this.onChange(sessionId);
    } catch {
      // 回调是观测手段，不能反过来打断采集。
    }
  }

  /** 单会话串行：避免同一路径的前置像与后置像交叉。 */
  private async serialize<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const result = previous.then(task, task);
    this.locks.set(
      sessionId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  /**
   * 路径围栏：相对路径、不许 `..` 逃逸、不许敏感文件、不许符号链接逃出工作区。
   *
   * 返回 `null` 表示"拒绝统计"——被拒绝的路径不会进改动集合，也不会进产出列表。
   */
  private async resolveTarget(relPath: string): Promise<{ abs: string; rel: string } | null> {
    if (relPath === '' || relPath.includes('\0')) return null;
    // 绝对路径一律拒绝（采集器只认工作区相对路径）。
    if (path.isAbsolute(relPath)) return null;
    const abs = path.resolve(this.root, relPath);
    const rel = path.relative(this.root, abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (isSensitivePath(rel)) return null;

    // 符号链接：取"最近存在的祖先"的真实路径，必须仍在工作区内。
    // （目标还不存在时，最近的祖先就是工作区根本身——这属于合法情况。）
    const realRoot = await this.realRoot();
    const real = await this.realPathOfNearestExisting(abs);
    if (real === null) return null;
    const relReal = path.relative(realRoot, real);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) return null;
    if (isSensitivePath(relReal)) return null;

    return { abs, rel: rel.split(path.sep).join('/') };
  }

  private async realRoot(): Promise<string> {
    if (this.rootReal !== null) return this.rootReal;
    const real = await fs.realpath(this.root).catch(() => this.root);
    this.rootReal = real;
    return real;
  }

  /** 目标不存在时向上找最近的已存在祖先并取其真实路径（用来挡"父目录是逃逸软链"）。 */
  private async realPathOfNearestExisting(abs: string): Promise<string | null> {
    let current = abs;
    for (;;) {
      const real = await fs.realpath(current).catch(() => null);
      if (real !== null) return real;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

  /** 读一次文件像：缺失 / 文本 / 不可统计，三选一。 */
  private async readImage(abs: string): Promise<Image> {
    const stat = await statFile(abs);
    if (stat.kind === 'missing') return { ...ABSENT_IMAGE, stat };
    if (stat.kind !== 'text') return { kind: 'unavailable', lines: [], stat };
    // `statFile` 已确认是普通文件且不超过 1 MiB，这里可以整块读入。
    const text = await fs.readFile(abs, 'utf8').catch(() => null);
    if (text === null) return { kind: 'unavailable', lines: [], stat };
    return { kind: 'text', lines: splitLines(text), stat };
  }

  /** 产出一个 `Artifact` 条目（大小只取元信息，不读内容）。 */
  private makeArtifact(rel: string, tool: string, after: Image): Artifact {
    const sizeBytes = after.stat?.bytes ?? null;
    return {
      id: stableId('art', rel),
      path: rel,
      name: path.basename(rel),
      kind: artifactKindFor(rel),
      sizeBytes,
      tool,
      createdAt: Date.now(),
    };
  }
}

/**
 * 由前后两像算出改动条目。
 *
 * `lastText` 是"删除前最后一次已知的文本内容"——文件被删除时用它算
 * `removed`（`27` §7.5：「行数为删除前全文行数，`removed` 有效」）。
 *
 * 返回 `null` 表示"没有变化"，不产生条目。
 */
function computeChange(
  rel: string,
  before: Image,
  after: Image,
  tool: string,
  lastText: Image | null,
): FileChange | null {
  const updatedAt = Date.now();
  const unavailable = (status: FileChangeStatus): FileChange => ({
    path: rel,
    status,
    added: null,
    removed: null,
    stat: 'unavailable',
    tool,
    updatedAt,
  });

  if (after.kind === 'absent') {
    // 文件被删除：删除前的全文行数是真实可得的数字，不该标"不可统计"。
    // 只有连"删除前的内容"都拿不到（二进制 / 超限 / 不可读 / 从未存在）才回退。
    if (lastText !== null && lastText.kind === 'text') {
      return {
        path: rel,
        status: 'deleted',
        added: 0,
        removed: lastText.stat?.lines ?? lastText.lines.length,
        stat: 'exact',
        tool,
        updatedAt,
      };
    }
    return unavailable('deleted');
  }
  if (before.kind === 'unavailable' || after.kind === 'unavailable') {
    // 二进制 / 超限 / 不可读 / 非普通文件：条目保留，行数标"不可统计"。
    return unavailable(before.kind === 'absent' ? 'added' : 'modified');
  }
  if (before.kind === 'absent') {
    // 新建文件：新增行数 = 文件行数（口径来自 `statFile`），删除 0 行。
    return {
      path: rel,
      status: 'added',
      added: after.stat?.lines ?? after.lines.length,
      removed: 0,
      stat: 'exact',
      tool,
      updatedAt,
    };
  }

  // 修改：行级 diff（复用 `workspace.ts` 的 LCS 实现，不引入新依赖）。
  const hunks = diffLines(before.lines, after.lines);
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') added += 1;
      else if (line.kind === 'del') removed += 1;
    }
  }
  if (added === 0 && removed === 0) return null;
  return { path: rel, status: 'modified', added, removed, stat: 'exact', tool, updatedAt };
}

/** 工具钩子（宿主侧装饰器的两端）。 */
export interface ChangeToolHooks {
  before(tool: string, input: unknown): Promise<void>;
  after(tool: string, input: unknown, isError: boolean): Promise<void>;
}

/** 从工具入参里取路径（`write` / `edit` 用 `path`，兼容 `file_path`）。 */
export function pathFromToolInput(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  for (const key of ['path', 'file_path', 'filePath']) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/**
 * 把采集器接成工具钩子。
 *
 * `before` 拍前置像，`after` 读后置像；`bash` 只需要"通知用过命令"。
 */
export function createChangeToolHooks(collector: ChangesCollector, sessionId: string): ChangeToolHooks {
  return {
    async before(tool: string, input: unknown): Promise<void> {
      if (tool === 'bash') {
        collector.noteBash(sessionId);
        return;
      }
      const rel = pathFromToolInput(input);
      if (rel === null) return;
      await collector.captureBefore(sessionId, tool, rel);
    },
    async after(tool: string, input: unknown, isError: boolean): Promise<void> {
      if (tool === 'bash') {
        collector.noteBash(sessionId);
        return;
      }
      const rel = pathFromToolInput(input);
      if (rel === null) return;
      await collector.captureAfter(sessionId, tool, rel, { isError });
    },
  };
}
