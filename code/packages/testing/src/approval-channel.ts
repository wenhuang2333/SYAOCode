import type { PermissionDecision, PermissionRequest } from '@syaocode/core';

/**
 * Fake approval channel (03 §3.5).
 *
 * Protocol adapters must be tested as *governance participants*: an approval
 * that arrives over MCP `input_required`, ACP `session/request_permission` or
 * A2A `input_required` has to settle deterministically without a TUI.
 *
 * The channel records every request and answers from a queue, so a test can
 * assert both what was asked and what the adapter did with the answer.
 */

export type ApprovalAnswer =
  | PermissionDecision
  | { decision: 'allow' | 'deny'; remember?: 'once' | 'session' | 'project'; message?: string };

export interface FakeApprovalChannelOptions {
  /** Default answer when the queue is empty; omit to hang (timeout tests). */
  defaultAnswer?: ApprovalAnswer;
  /** Answer for sensitive requests; defaults to the queue like any other. */
  sensitiveAnswer?: ApprovalAnswer;
}

export class FakeApprovalChannel {
  /** Every request the adapter presented, in order. */
  readonly requests: PermissionRequest[] = [];
  private readonly answers: ApprovalAnswer[] = [];
  private readonly opts: FakeApprovalChannelOptions;

  constructor(opts: FakeApprovalChannelOptions = {}) {
    this.opts = opts;
  }

  /** Queue answers for the next requests (FIFO). */
  enqueue(...answers: ApprovalAnswer[]): this {
    this.answers.push(...answers);
    return this;
  }

  /** The handler to inject as `permissionHandler`. */
  readonly handler = async (req: PermissionRequest): Promise<PermissionDecision> => {
    this.requests.push(req);
    const answer =
      (req.sensitive === true ? this.opts.sensitiveAnswer : undefined) ??
      this.answers.shift() ??
      this.opts.defaultAnswer;
    if (answer === undefined) {
      // Mirror the SDKs' behaviour: an unanswered request stays pending.
      return new Promise<PermissionDecision>(() => undefined);
    }
    return answer as PermissionDecision;
  };

  /** Last request, for single-approval assertions. */
  get last(): PermissionRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  get count(): number {
    return this.requests.length;
  }
}

/** Convenience: a channel that allows everything, remembering nothing. */
export function allowAllApprovals(): FakeApprovalChannel {
  return new FakeApprovalChannel({ defaultAnswer: { decision: 'allow', remember: 'once' } });
}

/** Convenience: a channel that denies everything (fail-closed tests). */
export function denyAllApprovals(): FakeApprovalChannel {
  return new FakeApprovalChannel({ defaultAnswer: { decision: 'deny', message: 'denied by fake channel' } });
}
