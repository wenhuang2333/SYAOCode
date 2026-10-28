import { createHash } from 'node:crypto';
import { sha256Hex, type Hasher } from '@syaocode/core';

/**
 * SHA-256 backed hasher adapter (report C6 / 03 §3.5).
 *
 * The kernel ships a dependency-free SHA-256 so `@syaocode/core` stays
 * host-agnostic; this adapter gives the host the platform implementation,
 * which is faster and shares the audit chain's digest with every other Node
 * tool. It is structurally identical to `@syaocode/rpc`'s `Hasher`, so a host
 * can inject the same object into both kernels.
 */
export function createNodeHasher(): Hasher {
  return {
    sha256(text: string): string {
      return createHash('sha256').update(text, 'utf8').digest('hex');
    },
  };
}

/** Shared instance — the hasher is stateless. */
export const nodeHasher: Hasher = createNodeHasher();

/**
 * Guard for hosts that must agree with the kernel's own digest: returns the
 * adapter when it produces the same value, otherwise falls back to core's
 * implementation (defensive against a mis-configured native crypto module).
 */
export function createVerifiedHasher(): Hasher {
  const hasher = createNodeHasher();
  const probe = 'syaocode-hash-probe';
  return hasher.sha256(probe) === sha256Hex(probe) ? hasher : { sha256: sha256Hex };
}
