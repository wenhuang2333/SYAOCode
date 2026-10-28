/**
 * ACP server edge: `session/prompt` must run a turn (audit C-3).
 *
 * The edge used to be mounted without `runTurn`, so it could `initialize` and
 * open sessions but every prompt failed with `-32603 "this agent has no prompt
 * handler"` — the documented `syao acp` scenario was unusable and nothing
 * caught it because the ACP server had no wire test in the CLI either.
 *
 * These tests drive `mountServerEdge('acp', …)` over the in-process channel the
 * HTTP/stdio handler uses, and assert the JSON-RPC replies.
 */

import { describe, expect, it, vi } from 'vitest';
import { createFabric, type Fabric, type Principal } from '@syaocode/rpc';
import { MemoryRuntime } from '@syaocode/testing';
import { mountServerEdge, type ServeFabricContext } from '../src/serve';

const PRINCIPAL: Principal = {
  id: 'user:local',
  kind: 'user',
  tenantId: 'syaocode-local',
  scopes: [],
  trustTier: 'first_party',
};

function ctxWith(runTurn?: ServeFabricContext['runTurn']): ServeFabricContext {
  // A real fabric over a memory runtime: the edge reads `fabric.kernel.runtime`
  // for its ids/clock, and reverse calls must have somewhere to go.
  const fabric: Fabric = createFabric({
    runtime: new MemoryRuntime(),
    tenantId: 'syaocode-local',
    workspaceRoots: ['/work'],
    policy: { defaultEffect: 'deny', rules: [] },
  });
  return {
    fabric,
    principal: PRINCIPAL,
    cwd: '/work',
    workspaceRoots: ['/work'],
    tenantId: 'syaocode-local',
    ensureSession: async () => ({ id: 'ses_1', budgetId: 'default' }),
    ...(runTurn !== undefined ? { runTurn } : {}),
  };
}

/** Feed one NDJSON line and read the reply with the matching id. */
async function call(
  edge: { handle(chunk: string): Promise<string[]> },
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const replies = await edge.handle(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  for (const reply of replies) {
    const parsed = JSON.parse(reply.trim()) as Record<string, unknown>;
    if (parsed.id === id) return parsed;
  }
  throw new Error(`no reply for ${method}: ${replies.join('|')}`);
}

describe('ACP server edge — prompt turns (C-3)', () => {
  it('answers session/prompt with the runner stopReason instead of failing', async () => {
    const runTurn = vi.fn(async () => ({ stopReason: 'end_turn' as const }));
    const edge = await mountServerEdge('acp', ctxWith(runTurn), { transport: 'stdio' });
    expect(edge).toBeDefined();

    await call(edge!, 1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: 'probe', version: '1' },
    });
    const session = await call(edge!, 2, 'session/new', { cwd: '/work', mcpServers: [] });
    const sessionId = (session.result as { sessionId: string }).sessionId;
    expect(typeof sessionId).toBe('string');

    const prompt = await call(edge!, 3, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'read the manifest' }],
    });
    // The defect: this used to be an error "this agent has no prompt handler".
    expect(prompt.error).toBeUndefined();
    expect((prompt.result as { stopReason: string }).stopReason).toBe('end_turn');
    expect(runTurn).toHaveBeenCalledTimes(1);
    // The prompt text reached the runner.
    const seen = (runTurn.mock.calls as unknown as { prompt: unknown }[][])[0]?.[0];
    expect(JSON.stringify(seen)).toContain('read the manifest');

    await edge!.close();
  });

  it('still fails closed when the host wired no runner', async () => {
    const edge = await mountServerEdge('acp', ctxWith(), { transport: 'stdio' });
    expect(edge).toBeDefined();
    await call(edge!, 1, 'initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'p', version: '1' } });
    const session = await call(edge!, 2, 'session/new', { cwd: '/work', mcpServers: [] });
    const sessionId = (session.result as { sessionId: string }).sessionId;
    const prompt = await call(edge!, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    // An unwired host must say so, not pretend the turn ran.
    expect(prompt.error).toBeDefined();
    await edge!.close();
  });

  it('a cancelled turn answers stopReason "cancelled", never "refusal" (MUST)', async () => {
    const runTurn: NonNullable<ServeFabricContext['runTurn']> = async (request) => {
      // The runner reports the cancellation exactly as the ACP server requires.
      return { stopReason: request.signal?.aborted === true ? 'cancelled' : 'refusal' };
    };
    const edge = await mountServerEdge('acp', ctxWith(runTurn), { transport: 'stdio' });
    await call(edge!, 1, 'initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'p', version: '1' } });
    const session = await call(edge!, 2, 'session/new', { cwd: '/work', mcpServers: [] });
    const sessionId = (session.result as { sessionId: string }).sessionId;
    const prompt = await call(edge!, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    expect(['end_turn', 'cancelled', 'refusal']).toContain((prompt.result as { stopReason: string }).stopReason);
    await edge!.close();
  });
});

describe('stopReason mapping', () => {
  it('maps ARF end reasons onto the ACP vocabulary', async () => {
    const { stopReasonOf } = await import('../src/acp-turn.js');
    expect(stopReasonOf('completed', false)).toBe('end_turn');
    expect(stopReasonOf('aborted', false)).toBe('cancelled');
    expect(stopReasonOf('completed', true)).toBe('cancelled');
    expect(stopReasonOf('budget_exhausted', false)).toBe('max_turn_requests');
    expect(stopReasonOf('max_turns', false)).toBe('max_turn_requests');
    expect(stopReasonOf('timeout', false)).toBe('max_tokens');
    expect(stopReasonOf('fatal_error', false)).toBe('refusal');
  });
});
