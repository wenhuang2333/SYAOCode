/**
 * ID generation and format constraints.
 *
 * IDs are prefixed so they are self-describing in logs, receipts and audits:
 * `task_`, `inv_`, `apr_`, `rcpt_`, `ses_`, `art_`, `dec_`, `evt_`, `rsv_`.
 * Generation goes through the injected `Runtime.ids` (ADR-03) so tests are
 * deterministic and the kernel stays host-agnostic.
 */

import type { IdGenerator } from '@syaocode/core';

export const ID_PREFIX = {
  tenant: 'ten',
  principal: 'prn',
  session: 'ses',
  task: 'task',
  invocation: 'inv',
  approval: 'apr',
  receipt: 'rcpt',
  artifact: 'art',
  decision: 'dec',
  event: 'evt',
  reservation: 'rsv',
  audit: 'aud',
  bundle: 'evb',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

const ID_PATTERN = /^[a-z]{2,4}_[A-Za-z0-9_-]{1,128}$/;

/** True when `value` looks like an ARF id of the given kind (or any kind). */
export function isId(value: string, kind?: IdKind): boolean {
  if (!ID_PATTERN.test(value)) return false;
  if (kind === undefined) return true;
  return value.startsWith(`${ID_PREFIX[kind]}_`);
}

export function newId(ids: IdGenerator, kind: IdKind): string {
  return ids.next(ID_PREFIX[kind]);
}

/**
 * Deterministic id for tests and fixtures: `<prefix>_<kind>-<index>`.
 * Kept in the kernel (not in @syaocode/testing) so adapters can use it when
 * replaying recorded wire fixtures.
 */
export function deterministicIds(start = 0): IdGenerator {
  const counters = new Map<string, number>();
  let n = start;
  return {
    next(prefix: string): string {
      const c = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, c);
      n += 1;
      return `${prefix}_${c}_${n}`;
    },
  };
}

// ── capability id helpers (01 §4.5.1) ─────────────────────────────────────

/**
 * Build a capability id. `serverId`/`agentId`/`clientId` are assigned by the
 * registry — a remote's self-description must never override them.
 */
export function mcpCapabilityId(serverId: string, kind: 'tool' | 'resource' | 'prompt', name: string): string {
  return `mcp://${serverId}/${kind}/${name}`;
}

export function a2aCapabilityId(agentId: string, skillId: string): string {
  return `a2a://${agentId}/skill/${skillId}`;
}

export function acpCapabilityId(clientId: string, kind: 'tool' | 'fs' | 'terminal', name: string): string {
  return `acp://${clientId}/${kind}/${name}`;
}

export function localCapabilityId(toolName: string): string {
  return `local://tools/${toolName}`;
}

export interface ParsedCapabilityId {
  protocol: 'mcp' | 'a2a' | 'acp' | 'local';
  owner: string;
  kind: string;
  name: string;
}

/**
 * Parse a capability id; returns undefined for malformed ids.
 *
 * `local://` is shaped differently from the protocol edges: a built-in tool is
 * `local://tools/<name>` with no server/agent segment, so it needs its own
 * branch (`owner` is the literal `local`).
 */
export function parseCapabilityId(id: string): ParsedCapabilityId | undefined {
  const local = /^local:\/\/([^/]+)\/(.+)$/.exec(id);
  if (local !== null) {
    const [, kind, name] = local;
    if (kind === undefined || name === undefined) return undefined;
    return { protocol: 'local', owner: 'local', kind, name };
  }
  const m = /^(mcp|a2a|acp):\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(id);
  if (m === null) return undefined;
  const [, protocol, owner, kind, name] = m;
  if (protocol === undefined || owner === undefined || kind === undefined || name === undefined) return undefined;
  return { protocol: protocol as ParsedCapabilityId['protocol'], owner, kind, name };
}

/**
 * MCP tool naming rule from DD-8: `mcp__<server>__<tool>`. Used when exposing
 * remote tools to the model; the canonical id stays `mcp://…`.
 */
export function mcpToolName(serverId: string, toolName: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
  return `mcp__${safe(serverId)}__${safe(toolName)}`;
}

/** Inverse of {@link mcpToolName}; undefined when the name is not an MCP tool. */
export function parseMcpToolName(name: string): { serverId: string; toolName: string } | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m === null) return undefined;
  const [, serverId, toolName] = m;
  if (serverId === undefined || toolName === undefined) return undefined;
  return { serverId, toolName };
}
