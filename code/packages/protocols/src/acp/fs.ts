/**
 * ACP reverse `fs/read_text_file` / `fs/write_text_file` bridge (G6).
 *
 * The client owns the filesystem. The agent therefore never touches a local fs
 * on the client's behalf — it goes through, in this order:
 *
 *   1. **client capability gate** — the editor declares
 *      `clientCapabilities.fs.{readTextFile,writeTextFile}` at `initialize`.
 *      A missing capability answers `unsupported_capability`; it NEVER falls
 *      back to the agent's own filesystem (01 §6 G6);
 *   2. **path fence** — `path` must resolve inside the client-declared roots
 *      (`cwd` + `additionalDirectories`). Outside ⇒ `denied`, no dispatch;
 *   3. **governance** — the {@link ReverseInvokeGateway} (the kernel's ten-step
 *      dispatcher) decides; only an `allowed` decision reaches the wire.
 */

import { acpCapabilityId, CanonicalError } from '@syaocode/rpc';
import type { ReverseInvokeGateway } from '../shared/gateway.js';
import { ACP_LOSSY } from './content.js';

export interface AcpFsClientCapabilities {
  readTextFile?: boolean;
  writeTextFile?: boolean;
}

export interface AcpFsBridgeOptions {
  /** Registry-assigned client id (never the peer's self-description). */
  clientId: string;
  sessionId: string;
  capabilities: AcpFsClientCapabilities;
  /** Roots the client declared: `cwd` + `additionalDirectories`. */
  workspaceRoots: readonly string[];
  gateway: ReverseInvokeGateway;
  tenantId?: string;
  taskId?: string;
}

export interface AcpFsReadResult {
  content: string;
}

/**
 * Normalize a path for the fence: collapse `.`/`..` and duplicate separators
 * without touching the real filesystem (the kernel stays host-agnostic).
 */
export function normalizePath(path: string): string {
  const absolute = path.startsWith('/');
  const segments = path.split('/');
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  const joined = stack.join('/');
  return absolute ? `/${joined}` : joined;
}

/** True when `path` is inside (or equal to) one of `roots`. */
export function isPathInsideRoots(path: string, roots: readonly string[]): boolean {
  const target = normalizePath(path);
  return roots.some((root) => {
    const normalizedRoot = normalizePath(root);
    if (normalizedRoot.length === 0) return false;
    if (target === normalizedRoot) return true;
    return target.startsWith(normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`);
  });
}

/** Throws `denied` when the path escapes every declared root. */
export function assertPathInsideRoots(path: string, roots: readonly string[]): void {
  if (isPathInsideRoots(path, roots)) return;
  throw new CanonicalError({
    kind: 'denied',
    message: `ACP reverse fs call rejected: ${path} is outside the declared roots`,
    protocol: 'acp',
    retryable: false,
    details: { path, roots: [...roots] },
  });
}

function capabilityMissing(method: string): CanonicalError {
  return new CanonicalError({
    kind: 'unsupported_capability',
    message: `the ACP client did not declare fs capability for ${method}`,
    protocol: 'acp',
    retryable: false,
    details: { lossy: [ACP_LOSSY.clientCapabilityMissing, ACP_LOSSY.clientOwnedFs] },
  });
}

/** Reverse filesystem bridge. All side effects go through the gateway. */
export class AcpFsBridge {
  private readonly readCapabilityId: string;
  private readonly writeCapabilityId: string;

  constructor(private readonly options: AcpFsBridgeOptions) {
    this.readCapabilityId = acpCapabilityId(options.clientId, 'fs', 'read_text_file');
    this.writeCapabilityId = acpCapabilityId(options.clientId, 'fs', 'write_text_file');
  }

  get readId(): string {
    return this.readCapabilityId;
  }

  get writeId(): string {
    return this.writeCapabilityId;
  }

  /** `fs/read_text_file` through the governance gateway. */
  async readTextFile(path: string): Promise<AcpFsReadResult> {
    if (this.options.capabilities.readTextFile !== true) throw capabilityMissing('fs/read_text_file');
    assertPathInsideRoots(path, this.options.workspaceRoots);
    const payload = await this.options.gateway.invoke({
      capabilityId: this.readCapabilityId,
      input: { sessionId: this.options.sessionId, path },
      ...(this.options.taskId !== undefined ? { taskId: this.options.taskId } : {}),
      sessionId: this.options.sessionId,
    });
    if (payload.outcome !== 'succeeded') throw failure(payload, 'fs/read_text_file');
    const output = payload.output as { content?: unknown } | string | undefined;
    if (typeof output === 'string') return { content: output };
    if (output !== null && typeof output === 'object' && typeof output.content === 'string') return { content: output.content };
    throw new CanonicalError({ kind: 'indeterminate', message: 'ACP client returned no readable content', protocol: 'acp', retryable: false });
  }

  /** `fs/write_text_file` through the governance gateway. */
  async writeTextFile(path: string, content: string): Promise<void> {
    if (this.options.capabilities.writeTextFile !== true) throw capabilityMissing('fs/write_text_file');
    assertPathInsideRoots(path, this.options.workspaceRoots);
    const payload = await this.options.gateway.invoke({
      capabilityId: this.writeCapabilityId,
      input: { sessionId: this.options.sessionId, path, content },
      ...(this.options.taskId !== undefined ? { taskId: this.options.taskId } : {}),
      sessionId: this.options.sessionId,
    });
    if (payload.outcome !== 'succeeded') throw failure(payload, 'fs/write_text_file');
  }
}

function failure(payload: { outcome: string; error?: { kind: string; message: string } }, method: string): CanonicalError {
  const kind = payload.error?.kind;
  const mapped = kind === 'denied' || kind === 'unauthorized' ? 'denied' : kind === 'cancelled' ? 'cancelled' : kind === 'timed_out' ? 'timed_out' : kind === 'indeterminate' ? 'indeterminate' : 'remote_error';
  return new CanonicalError({
    kind: mapped,
    message: payload.error?.message ?? `ACP reverse ${method} failed with outcome ${payload.outcome}`,
    protocol: 'acp',
    retryable: false,
    details: { outcome: payload.outcome, method },
  });
}
