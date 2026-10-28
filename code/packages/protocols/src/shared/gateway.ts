/**
 * The governance gateway.
 *
 * A protocol edge must never perform a side effect on its own. When an edge
 * needs to act on the peer (MCP `tools/call`, A2A `SendMessage`, ACP reverse
 * `fs/write_text_file` / `terminal/create`), it hands the *capability id* plus
 * the raw input to this gateway, which is the kernel's ten-step dispatcher.
 *
 * The kernel resolves the capability from the registry, evaluates policy,
 * collects approvals, reserves budget, dispatches and issues the receipt — so
 * the edge cannot widen its own authority (I1 / I4 / I13).
 */

import type { InvokeResultPayload } from '@syaocode/rpc';

export interface ReverseInvokeRequest {
  /** Canonical capability id, e.g. `acp://editor/fs/write_text_file`. */
  capabilityId: string;
  input: unknown;
  taskId?: string;
  sessionId?: string;
  /** Correlation only; authorization always re-derives the tenant. */
  correlationId?: string;
}

/**
 * Implemented by the host on top of `Dispatcher.invoke` (rpc §dispatcher):
 *
 * ```ts
 * const gateway: ReverseInvokeGateway = {
 *   async invoke(req) {
 *     const r = await dispatcher.invoke(
 *       { principal, capabilityId: req.capabilityId, input: req.input, protocol: 'acp', direction: 'reverse',
 *         ...(req.taskId ? { taskId: req.taskId } : {}), ...(req.sessionId ? { sessionId: req.sessionId } : {}) },
 *       { cwd, workspaceRoots },
 *     );
 *     return { outcome: r.outcome, ...(r.output !== undefined ? { output: r.output } : {}),
 *              ...(r.error !== undefined ? { error: r.error } : {}), ...(r.lossy ? { lossy: r.lossy } : {}) };
 *   },
 * };
 * ```
 */
export interface ReverseInvokeGateway {
  invoke(request: ReverseInvokeRequest): Promise<InvokeResultPayload>;
}
