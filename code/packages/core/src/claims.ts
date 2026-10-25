import type { ToolReceipt, VerificationReport, VerificationResult } from './evidence.js';

/**
 * Deterministic claim linter (report §12.4). The first version uses regex
 * rules only; a low-cost model may later *tighten* (never relax) these checks.
 * Freshness matters: evidence older than the last write is `stale`, treated
 * like unsupported.
 */

export type ClaimKind = 'tests' | 'typecheck' | 'file_change' | 'fixed' | 'no_regressions' | 'git';
export type ClaimStatus = 'supported' | 'unsupported' | 'stale';
export type Verdict = 'verified' | 'unverified' | 'failed' | 'not_run';

export interface ClaimCheck {
  text: string;
  kind: ClaimKind;
  status: ClaimStatus;
  evidence?: string;
}

const NEGATIVE = /\b(?:not|never|no longer|未|没有|尚未|未进行|未运行)\b/i;

const PATTERNS: { kind: ClaimKind; re: RegExp }[] = [
  { kind: 'tests', re: /(?:tests?\s+(?:all\s+)?(?:pass|passed|passing|are green)|all\s+tests\s+(?:pass|passed)|测试(?:全部)?通过|测试已通过|测试跑通)/i },
  { kind: 'typecheck', re: /(?:type[- ]?check(?:ing)?\s+(?:pass|passed|succeeds?)|类型检查(?:通过|已通过)|编译(?:通过|成功)|build\s+(?:pass|passed|succeeded))/i },
  { kind: 'file_change', re: /(?:modified|updated|created|added|wrote|changed|edited|已修改|已创建|已新增|已更新|已编辑)\s*`?([\w./@-]*[./][\w./@-]+)`?/i },
  { kind: 'fixed', re: /(?:fixed|resolved|修复了?|解决了?)/i },
  { kind: 'no_regressions', re: /(?:no regressions?|without breaking|didn'?t break|没有破坏|无回归|未影响其他)/i },
  { kind: 'git', re: /(?:committed|pushed|已提交|已推送)/i },
];

export function lintClaims(
  finalText: string,
  receipts: ToolReceipt[],
  verification: VerificationReport | undefined,
): ClaimCheck[] {
  const writeReceipts = receipts.filter((r) => (r.tool === 'write' || r.tool === 'edit') && !r.isError);
  const lastWrite = writeReceipts.reduce((max, r) => Math.max(max, r.timestamp + r.durationMs), 0);
  const checks: ClaimCheck[] = [];
  for (const sentence of sentences(finalText)) {
    if (sentence.trim() === '') continue;
    for (const { kind, re } of PATTERNS) {
      const match = sentence.match(re);
      if (match === null) continue;
      const negative = NEGATIVE.test(sentence);
      const check = negative
        ? { text: sentence.trim(), kind, status: 'unsupported' as const, evidence: 'negative claim is not evidence' }
        : evaluate(kind, match, sentence, receipts, verification, lastWrite);
      checks.push(check);
    }
  }
  return checks;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[。！？\n])|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function evaluate(
  kind: ClaimKind,
  match: RegExpMatchArray,
  sentence: string,
  receipts: ToolReceipt[],
  verification: VerificationReport | undefined,
  lastWrite: number,
): ClaimCheck {
  const base = { text: sentence.trim(), kind };
  if (kind === 'file_change') {
    const path = match[1]?.replace(/[.,;:]+$/, '');
    if (path === undefined || path === '') return { ...base, status: 'unsupported' };
    const relevant = receipts.filter(
      (r) =>
        (r.tool === 'write' || r.tool === 'edit') &&
        (r.paths ?? []).some((p) => p === path || p.endsWith(`/${path}`) || path.endsWith(`/${p}`)),
    );
    if (relevant.length === 0) return { ...base, status: 'unsupported' };
    const latest = relevant.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b));
    return latest.isError
      ? { ...base, status: 'unsupported', evidence: latest.callId }
      : { ...base, status: 'supported', evidence: latest.callId };
  }

  if (kind === 'fixed') {
    if (verification?.baseline === undefined) return { ...base, status: 'unsupported' };
    const hadFailure = verification.baseline.some((r) => r.exitCode !== 0);
    const nowOk = verification.results.length > 0 && verification.results.every((r) => r.exitCode === 0);
    return hadFailure && nowOk ? { ...base, status: 'supported' } : { ...base, status: 'unsupported' };
  }

  if (kind === 'no_regressions') {
    if (verification === undefined || verification.results.length === 0) return { ...base, status: 'unsupported' };
    const baselineFailures = verification.baseline?.filter((r) => r.exitCode !== 0).length ?? 0;
    const currentFailures = verification.results.filter((r) => r.exitCode !== 0).length;
    return currentFailures === 0 && baselineFailures === 0
      ? { ...base, status: 'supported' }
      : { ...base, status: 'unsupported' };
  }

  const toolRelevant = receipts.filter((r) => receiptMatches(kind, r));
  const verifyRelevant = (verification?.results ?? []).filter((r) => verificationMatches(kind, r));
  const latestTool = toolRelevant.reduce<ToolReceipt | undefined>(
    (latest, r) => (latest === undefined || r.timestamp >= latest.timestamp ? r : latest),
    undefined,
  );
  const latestVerify = verifyRelevant.reduce<VerificationResult | undefined>(
    (latest, r) => (latest === undefined || r.timestamp >= latest.timestamp ? r : latest),
    undefined,
  );
  const toolFresh = latestTool !== undefined && latestTool.timestamp >= lastWrite;
  const verifyFresh = latestVerify !== undefined && latestVerify.timestamp >= lastWrite;

  if (!toolFresh && !verifyFresh) {
    return toolRelevant.length > 0 || verifyRelevant.length > 0
      ? { ...base, status: 'stale' }
      : { ...base, status: 'unsupported' };
  }
  const freshTool = toolFresh ? latestTool : undefined;
  const freshVerify = verifyFresh ? latestVerify : undefined;
  const okTool = freshTool !== undefined && (freshTool.exitCode ?? 0) === 0 && !freshTool.isError;
  const okVerify = freshVerify !== undefined && freshVerify.exitCode === 0;
  const stats = freshVerify?.testStats ?? freshTool?.testStats;
  if (kind === 'tests' && stats !== undefined && stats.total === 0) {
    return { ...base, status: 'unsupported', evidence: '0 tests executed' };
  }
  const evidence = freshVerify?.command ?? freshTool?.callId;
  if (okTool || okVerify) {
    return { ...base, status: 'supported', ...(evidence !== undefined ? { evidence } : {}) };
  }
  return { ...base, status: 'unsupported', ...(evidence !== undefined ? { evidence } : {}) };
}

function receiptMatches(kind: ClaimKind, r: ToolReceipt): boolean {
  const cmd = r.command ?? '';
  if (kind === 'tests') return r.tool === 'bash' && /\b(test|pytest|vitest|jest|mocha|go test|cargo test)\b/i.test(cmd);
  if (kind === 'typecheck') return r.tool === 'bash' && /\b(tsc|typecheck|lint|build)\b/i.test(cmd);
  if (kind === 'git') return r.tool === 'bash' && /\bgit\s+(commit|push)\b/i.test(cmd);
  if (kind === 'file_change') return r.tool === 'write' || r.tool === 'edit';
  return false;
}

function verificationMatches(kind: ClaimKind, r: VerificationResult): boolean {
  if (kind === 'tests') return /\b(test|pytest|vitest|jest|mocha|go test|cargo test)\b/i.test(r.command);
  if (kind === 'typecheck') return /\b(tsc|typecheck|lint|build)\b/i.test(r.command);
  if (kind === 'git') return /\bgit\s+(commit|push)\b/i.test(r.command);
  return false;
}

export function verdictOf(
  verification: VerificationReport | undefined,
  claims: ClaimCheck[],
): Verdict {
  if (verification === undefined) return 'unverified';
  if (verification.results.length === 0) return 'unverified';
  if (verification.results.some((r) => r.exitCode !== 0)) return 'failed';
  return claims.some((c) => c.status !== 'supported') ? 'unverified' : 'verified';
}
