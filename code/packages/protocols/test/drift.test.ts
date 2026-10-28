/**
 * Protocol drift control (03 §7.3 / §7.4).
 *
 * The pinned inventory in `src/shared/drift.ts` is compared against the
 * constants the adapters actually use, so an upstream spec bump — or an
 * accidental local rename — fails CI instead of silently changing the wire.
 */

import { describe, expect, it } from 'vitest';
import { A2A_ERROR_CODES, ACP_ERROR_CODES, MCP_ERROR_CODES, TASK_STATES, TASK_TO_A2A, TASK_TO_ACP_STOP, TASK_TO_MCP } from '@syaocode/rpc';
import {
  A2A_INVENTORY,
  A2A_TASK_STATES,
  ACP_INVENTORY,
  ACP_STOP_REASONS,
  ACP_UPDATE_VARIANTS,
  MCP_INVENTORY,
  MCP_META_KEYS,
  MCP_RESULT_TYPES,
  assertNoDrift,
  compareErrorCodes,
  compareFields,
  compareMethods,
  compareNotifications,
} from '../src/shared/drift.js';
import { MCP_METHODS, MCP_NOTIFICATIONS } from '../src/mcp/client.js';
import { MCP_SERVER_METHODS } from '../src/mcp/server.js';
import { MCP_META_KEYS as MCP_META_KEYS_IMPL, MCP_RESULT_TYPES as MCP_RESULT_TYPES_IMPL, MCP_TASK_STATES } from '../src/mcp/mapping.js';
import { A2A_METHODS } from '../src/a2a/client.js';
import { A2A_SERVER_METHODS } from '../src/a2a/server.js';
import { ACP_METHODS, ACP_NOTIFICATIONS } from '../src/acp/server.js';
import { ACP_SESSION_UPDATE_VARIANTS } from '../src/acp/content.js';

describe('protocol drift', () => {
  it('MCP methods match the pinned inventory', () => {
    const implemented = new Set<string>([...MCP_METHODS, ...MCP_SERVER_METHODS]);
    assertNoDrift(compareMethods('mcp', MCP_INVENTORY.methods.map((entry) => entry.method), [...implemented]));
  });

  it('MCP notifications match the pinned inventory', () => {
    assertNoDrift(compareNotifications('mcp', MCP_INVENTORY.notifications, MCP_NOTIFICATIONS));
  });

  it('MCP error codes match the kernel table', () => {
    assertNoDrift(compareErrorCodes('mcp', MCP_INVENTORY.errorCodes, MCP_ERROR_CODES));
  });

  it('MCP `_meta` keys and `resultType` values are the pinned ones', () => {
    expect([...MCP_META_KEYS_IMPL].sort()).toEqual([...MCP_META_KEYS].sort());
    expect([...MCP_RESULT_TYPES_IMPL].sort()).toEqual([...MCP_RESULT_TYPES].sort());
  });

  it('MCP task states stay inside the Tasks extension vocabulary', () => {
    expect([...MCP_TASK_STATES].sort()).toEqual(['cancelled', 'completed', 'failed', 'input_required', 'working']);
  });

  it('A2A methods match the pinned inventory', () => {
    const implemented = new Set<string>([...A2A_METHODS, ...A2A_SERVER_METHODS]);
    assertNoDrift(compareMethods('a2a', A2A_INVENTORY.methods.map((entry) => entry.method), [...implemented]));
  });

  it('A2A error codes match the kernel table', () => {
    assertNoDrift(compareErrorCodes('a2a', A2A_INVENTORY.errorCodes, A2A_ERROR_CODES));
  });

  it('A2A task states are exactly the values TASK_TO_A2A produces', () => {
    const produced = new Set(TASK_STATES.map((state) => TASK_TO_A2A[state]));
    for (const state of produced) expect(A2A_TASK_STATES).toContain(state);
    // `expired` degrades to TASK_STATE_FAILED, so the enum has one fewer value.
    expect(produced.size).toBe(A2A_TASK_STATES.length);
  });

  it('ACP methods match the pinned inventory', () => {
    assertNoDrift(compareMethods('acp', ACP_INVENTORY.methods.map((entry) => entry.method), ACP_METHODS));
  });

  it('ACP notifications match the pinned inventory', () => {
    assertNoDrift(compareNotifications('acp', ACP_INVENTORY.notifications, ACP_NOTIFICATIONS));
  });

  it('ACP error codes match the kernel table', () => {
    assertNoDrift(compareErrorCodes('acp', ACP_INVENTORY.errorCodes, ACP_ERROR_CODES));
  });

  it('ACP session/update variants match the pinned list (01 §5.5)', () => {
    expect([...ACP_SESSION_UPDATE_VARIANTS].sort()).toEqual([...ACP_UPDATE_VARIANTS].sort());
  });

  it('ACP stop reasons stay inside the pinned vocabulary', () => {
    const produced = new Set(TASK_STATES.map((state) => TASK_TO_ACP_STOP[state]).filter((value): value is string => value !== undefined));
    for (const reason of produced) expect(ACP_STOP_REASONS).toContain(reason);
    // Four are reachable from a terminal task state; `max_tokens` comes from the
    // provider's own limit, not from the ARF state machine.
    expect([...produced].sort()).toEqual(['cancelled', 'end_turn', 'max_turn_requests', 'refusal']);
    expect(ACP_STOP_REASONS).toContain('max_tokens');
  });

  it('MCP task states are exactly the values TASK_TO_MCP produces', () => {
    const produced = new Set(TASK_STATES.map((state) => TASK_TO_MCP[state]));
    for (const state of produced) expect(MCP_TASK_STATES).toContain(state);
    expect(produced.size).toBe(MCP_TASK_STATES.length);
  });

  it('pinned method specs keep their required fields', () => {
    // A tiny guard so a spec edit cannot silently drop a required field.
    const discover = MCP_INVENTORY.methods.find((entry) => entry.method === 'server/discover');
    expect(discover).toBeDefined();
    assertNoDrift(compareFields('mcp', 'server/discover', discover?.requiredResult ?? [], { supportedVersions: [], capabilities: {}, ttlMs: 1, cacheScope: 'private' }));

    const send = A2A_INVENTORY.methods.find((entry) => entry.method === 'SendMessage');
    expect(send?.requiredParams).toEqual(['message']);

    const prompt = ACP_INVENTORY.methods.find((entry) => entry.method === 'session/prompt');
    expect(prompt?.requiredResult).toEqual(['stopReason']);
  });

  it('detects drift when the implementation moves (self-test)', () => {
    const drifts = compareMethods('mcp', ['server/discover', 'tools/list'], ['server/discover', 'tools/call']);
    expect(drifts.map((entry) => entry.kind).sort()).toEqual(['missing-method', 'unexpected-method']);
    expect(() => assertNoDrift(drifts)).toThrow(/protocol drift detected/);
  });
});
