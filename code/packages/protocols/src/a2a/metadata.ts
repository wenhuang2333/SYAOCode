/**
 * A2A reserved metadata keys (WP-6 / 06 §13).
 *
 * `metadata` on an A2A request carries transport-level facts: which tenant the
 * call acts in, and which protocol version the caller speaks. Those are
 * **reserved**: a caller must never be able to set them by accident, and a peer
 * must never accept a body that contradicts what the transport established.
 *
 * Before this module the client built its metadata as
 * `{ tenantId, 'A2A-Version', ...extra }` — the spread came *after* the
 * reserved keys, so an `extra` silently overrode both. The server then read
 * whatever arrived, with no conflict check at all.
 *
 * The rule now:
 *   - the client puts the reserved keys **last**, so they always win, and it
 *     rejects a conflicting `extra` locally (the request is never sent);
 *   - the server rejects an inbound body whose reserved key contradicts the
 *     authoritative context (the transport's header, or the resolved caller)
 *     with JSON-RPC `-32602` and `data.reason: 'reserved_metadata_key'`.
 *
 * A value that merely *repeats* the authoritative one is allowed: it confirms
 * rather than overrides.
 */

/** Metadata key carrying the acting tenant. */
export const A2A_METADATA_TENANT_KEY = 'tenantId';

/** Metadata key carrying the protocol version (`Major.Minor`). */
export const A2A_METADATA_VERSION_KEY = 'A2A-Version';

/**
 * The metadata keys the transport owns.
 *
 * **Every new transport-level metadata key must be registered here**, otherwise
 * it can still be silently overridden by a caller-supplied `extra`.
 */
export const A2A_RESERVED_METADATA_KEYS: ReadonlySet<string> = new Set<string>([
  A2A_METADATA_TENANT_KEY,
  A2A_METADATA_VERSION_KEY,
]);

/** The authoritative values a transport (or the resolver) established. */
export interface A2aAuthoritativeMetadata {
  tenantId?: string | undefined;
  version?: string | undefined;
}

/** A reserved key whose inbound value contradicts the authoritative one. */
export interface ReservedMetadataConflict {
  /** The reserved key that was contradicted. */
  key: string;
  /** The authoritative value. */
  expected: string;
  /** The value the caller tried to install. */
  received: unknown;
}

/**
 * Find the first reserved key that contradicts the authoritative context.
 *
 * A missing inbound key is not a conflict (the transport value simply wins);
 * an inbound value equal to the authoritative one is not a conflict either.
 */
export function findReservedMetadataConflict(
  metadata: Record<string, unknown> | undefined,
  authoritative: A2aAuthoritativeMetadata,
): ReservedMetadataConflict | undefined {
  if (metadata === undefined) return undefined;

  const tenant = metadata[A2A_METADATA_TENANT_KEY];
  if (tenant !== undefined && authoritative.tenantId !== undefined && tenant !== authoritative.tenantId) {
    return { key: A2A_METADATA_TENANT_KEY, expected: authoritative.tenantId, received: tenant };
  }

  const version = metadata[A2A_METADATA_VERSION_KEY];
  if (version !== undefined && authoritative.version !== undefined && version !== authoritative.version) {
    return { key: A2A_METADATA_VERSION_KEY, expected: authoritative.version, received: version };
  }

  return undefined;
}

/** Read the reserved keys out of an inbound metadata record. */
export function readReservedMetadata(metadata: Record<string, unknown> | undefined): A2aAuthoritativeMetadata {
  if (metadata === undefined) return {};
  const tenant = metadata[A2A_METADATA_TENANT_KEY];
  const version = metadata[A2A_METADATA_VERSION_KEY];
  return {
    ...(typeof tenant === 'string' ? { tenantId: tenant } : {}),
    ...(typeof version === 'string' ? { version } : {}),
  };
}
