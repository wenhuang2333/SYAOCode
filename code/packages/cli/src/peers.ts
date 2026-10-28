/**
 * Protocol-edge registry (MCP servers / A2A agents / ACP clients).
 *
 * The registry is *declarative*: it records what the user configured, not
 * what a peer happens to be right now. Whether an edge is actually mounted,
 * healthy, and how many capabilities it exposes is decided by the fabric at
 * runtime — the two are reported side by side so a stale entry is visible
 * instead of silently missing.
 *
 * The store lives in the user config file (`~/.syaocode/config.json`), so it
 * survives restarts and is edited by the same tooling as the model profiles.
 */

import { readUserConfig, writeUserConfig, type PeerConfig, type UserConfigFile } from './model-config.js';

/** The three protocol edges the ARF kernel knows about. */
export type PeerProtocol = 'mcp' | 'a2a' | 'acp';

export type { PeerConfig };

const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Peer ids are file-name safe and short enough for a table column. */
export function validPeerId(id: string): boolean {
  return VALID_ID.test(id) && id.length <= 48;
}

/** Every configured peer, sorted by id. */
export function listPeers(home?: string): Record<string, PeerConfig> {
  const config = readUserConfig(home);
  const peers = config.peers ?? {};
  return Object.fromEntries(Object.entries(peers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function getPeer(id: string, home?: string): PeerConfig | undefined {
  return listPeers(home)[id];
}

/** Add or replace a peer. Returns false when the id is invalid. */
export function savePeer(id: string, peer: PeerConfig, home?: string): boolean {
  if (!validPeerId(id)) return false;
  const config: UserConfigFile = readUserConfig(home);
  config.peers = { ...(config.peers ?? {}), [id]: peer };
  writeUserConfig(config, home);
  return true;
}

/** Remove a peer. Returns false when it was not configured. */
export function removePeer(id: string, home?: string): boolean {
  const config: UserConfigFile = readUserConfig(home);
  const peers = config.peers ?? {};
  if (peers[id] === undefined) return false;
  delete peers[id];
  config.peers = peers;
  writeUserConfig(config, home);
  return true;
}

/** Guess the protocol from a target string (http(s) ⇒ a2a, otherwise mcp). */
export function guessProtocol(target: string): PeerProtocol {
  const t = target.trim();
  if (/^https?:\/\//i.test(t)) return 'a2a';
  if (t.startsWith('acp://')) return 'acp';
  return 'mcp';
}

/** Human summary of a peer target (never the token value). */
export function peerTargetLabel(peer: PeerConfig): string {
  return peer.label !== undefined && peer.label !== '' ? peer.label : peer.target;
}
