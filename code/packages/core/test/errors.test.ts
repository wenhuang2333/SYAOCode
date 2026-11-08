import { describe, expect, it } from 'vitest';
import { ALL_ERROR_CODES, DOMAIN_CATEGORY, ERROR_DOMAINS, ERROR_REGISTRY, LIWENError, MESSAGES_ZH_CN } from '../src';

describe('error registry governance (09 §9.10)', () => {
  it('has unique, well-formed codes', () => {
    const set = new Set(ALL_ERROR_CODES);
    expect(set.size).toBe(ALL_ERROR_CODES.length);
    for (const code of ALL_ERROR_CODES) {
      // Domains may contain digits (A2A); registry.ts holds the closed union.
      expect(code).toMatch(/^SY-[A-Z][A-Z0-9]{1,3}-\d{3}$/);
      const entry = ERROR_REGISTRY.get(code);
      expect(ERROR_DOMAINS).toContain(entry?.domain);
      expect(entry?.category).toBe(DOMAIN_CATEGORY[entry!.domain]);
    }
  });

  it("carries the A2A domain and the Agent RPC reserved codes (03 §4 C7)", () => {
    expect(ERROR_DOMAINS).toContain('A2A');
    for (const code of ['SY-A2A-001', 'SY-A2A-006', 'SY-MCP-006', 'SY-SRV-004']) {
      expect(ERROR_REGISTRY.get(code)?.domain, code).toBe(code.startsWith('SY-A2A') ? 'A2A' : ERROR_REGISTRY.get(code)?.domain);
      expect(MESSAGES_ZH_CN[code], code).toBeDefined();
    }
  });

  it('SY-DEC-007 gap is intentional and preserved', () => {
    expect(ALL_ERROR_CODES).not.toContain('SY-DEC-007');
    expect(ALL_ERROR_CODES).toContain('SY-DEC-006');
    expect(ALL_ERROR_CODES).toContain('SY-DEC-008');
  });

  it('store-lock codes are resolvable with their contract shape (06 §14)', () => {
    // W8: a lock wait that exceeds lockTimeoutMs is retryable by the caller.
    const locked = ERROR_REGISTRY.get('SY-SRV-005');
    expect(locked).toMatchObject({
      name: 'StoreLocked',
      domain: 'SRV',
      category: 'server',
      severity: 'error',
      retryable: true,
      recovery: 'retry',
    });
    // W4: beyond a torn tail the store is fail-closed and needs a human.
    const corrupt = ERROR_REGISTRY.get('SY-SRV-006');
    expect(corrupt).toMatchObject({
      name: 'StoreCorrupt',
      domain: 'SRV',
      category: 'server',
      severity: 'error',
      retryable: false,
      recovery: 'ask_user',
    });
    // W6: a taken-over lease invalidates the writer; re-run the whole flow.
    const lost = ERROR_REGISTRY.get('SY-SRV-007');
    expect(lost).toMatchObject({
      name: 'LeaseLost',
      domain: 'SRV',
      category: 'server',
      severity: 'error',
      retryable: true,
      recovery: 'retry',
    });
    for (const code of ['SY-SRV-005', 'SY-SRV-006', 'SY-SRV-007']) {
      expect(MESSAGES_ZH_CN[code], code).toBeDefined();
      // Constructing a LIWENError proves the code is registered end to end.
      expect(new LIWENError({ code }).code).toBe(code);
    }
  });

  it('every active code has a zh-CN message and vice versa', () => {
    for (const code of ALL_ERROR_CODES) {
      expect(MESSAGES_ZH_CN[code], code).toBeDefined();
    }
    for (const code of Object.keys(MESSAGES_ZH_CN)) {
      expect(ALL_ERROR_CODES).toContain(code);
    }
  });

  it('fatal set is exactly {CTX-002, ACP-001, INT-001} and none retryable', () => {
    const fatal = ALL_ERROR_CODES.filter((c) => ERROR_REGISTRY.get(c)?.severity === 'fatal');
    expect(fatal.sort()).toEqual(['SY-ACP-001', 'SY-CTX-002', 'SY-INT-001']);
    for (const c of fatal) expect(ERROR_REGISTRY.get(c)?.retryable).toBe(false);
  });

  it('retryable set matches the registered table (BR-014)', () => {
    const retryable = new Set(ALL_ERROR_CODES.filter((c) => ERROR_REGISTRY.get(c)?.retryable));
    for (const c of [
      'SY-PRV-002', 'SY-PRV-003', 'SY-PRV-007', 'SY-PRV-008', 'SY-PRV-009',
      'SY-TOOL-004', 'SY-CTX-001', 'SY-SES-004', 'SY-MCP-001', 'SY-MCP-005',
      'SY-DEC-001', 'SY-DEC-002', 'SY-AGT-002', 'SY-AGT-005',
    ]) {
      expect(retryable.has(c), c).toBe(true);
    }
    expect(retryable.has('SY-PRV-001')).toBe(false);
    expect(retryable.has('SY-PERM-001')).toBe(false);
    // Store lease codes: a lock timeout and a lost lease are retryable, a
    // corrupt store is not (retrying cannot repair the file).
    expect(retryable.has('SY-SRV-005')).toBe(true);
    expect(retryable.has('SY-SRV-007')).toBe(true);
    expect(retryable.has('SY-SRV-006')).toBe(false);
  });
});

describe('LIWENError', () => {
  it('serializes to the fixed 7-field shape', () => {
    const e = new LIWENError({ code: 'SY-FS-003', modelMessage: 'match twice' });
    const json = e.toJSON();
    expect(json.code).toBe('SY-FS-003');
    expect(json.category).toBe('fs');
    expect(json.severity).toBe('error');
    expect(json.retryable).toBe(false);
    expect(json.recovery).toBe('fix_input');
    expect(typeof json.message).toBe('string');
    expect(Object.keys(json).sort()).toEqual(['category', 'code', 'message', 'recovery', 'retryable', 'severity']);
  });

  it('is identified by LIWENError.is, not instanceof (cross-copy safety)', () => {
    const e = new LIWENError({ code: 'SY-INT-001' });
    expect(LIWENError.is(e)).toBe(true);
    expect(LIWENError.is(new Error('plain'))).toBe(false);
    expect(LIWENError.is('string')).toBe(false);
    expect(LIWENError.is(null)).toBe(false);
  });

  it('wrap passes LIWENError through and boxes everything else as SY-INT-001', () => {
    const le = new LIWENError({ code: 'SY-PRV-002' });
    expect(LIWENError.wrap(le)).toBe(le);
    const wrapped = LIWENError.wrap(new Error('boom'));
    expect(wrapped.code).toBe('SY-INT-001');
    expect(wrapped.fatal).toBe(true);
  });

  it('rejects unregistered codes at construction', () => {
    expect(() => new LIWENError({ code: 'SY-XXX-999' })).toThrow(/not in registry/);
  });
});
