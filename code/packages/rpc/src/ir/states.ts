/**
 * State machines and transition tables (01 §4.4).
 *
 * The transition tables are data, not code: the dispatcher consults them and
 * the property tests in test/states.test.ts fuzz them for illegal edges.
 */

export type TaskState =
  | 'submitted'
  | 'working'
  | 'input_required'
  | 'auth_required'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'expired';

export type InvocationState =
  | 'proposed'
  | 'authorized'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'cancelled'
  | 'timed_out'
  | 'indeterminate';

export type ApprovalState = 'pending' | 'allowed' | 'denied' | 'expired' | 'cancelled';

export type ApprovalOptionKind =
  | 'allow_once'
  | 'allow_session'
  | 'allow_always'
  | 'deny_once'
  | 'deny_always';

export const TASK_STATES: readonly TaskState[] = [
  'submitted', 'working', 'input_required', 'auth_required',
  'completed', 'failed', 'cancelled', 'rejected', 'expired',
];

export const INVOCATION_STATES: readonly InvocationState[] = [
  'proposed', 'authorized', 'running',
  'succeeded', 'failed', 'denied', 'cancelled', 'timed_out', 'indeterminate',
];

export const APPROVAL_STATES: readonly ApprovalState[] = [
  'pending', 'allowed', 'denied', 'expired', 'cancelled',
];

/** Terminal task states: no further transition is legal. */
export const TASK_TERMINAL: readonly TaskState[] = ['completed', 'failed', 'cancelled', 'rejected', 'expired'];

/** Terminal invocation states. */
export const INVOCATION_TERMINAL: readonly InvocationState[] = [
  'succeeded', 'failed', 'denied', 'cancelled', 'timed_out', 'indeterminate',
];

/** States in which a task is waiting on a human/authority. */
export const TASK_WAITING: readonly TaskState[] = ['input_required', 'auth_required'];

const TASK_EDGES: Record<TaskState, readonly TaskState[]> = {
  submitted: ['working', 'rejected', 'expired', 'cancelled'],
  working: ['input_required', 'auth_required', 'completed', 'failed', 'cancelled', 'rejected', 'expired'],
  input_required: ['working', 'cancelled', 'expired', 'failed', 'rejected'],
  auth_required: ['working', 'cancelled', 'expired', 'failed', 'rejected'],
  completed: [],
  failed: [],
  cancelled: [],
  rejected: [],
  expired: [],
};

const INVOCATION_EDGES: Record<InvocationState, readonly InvocationState[]> = {
  proposed: ['authorized', 'denied', 'cancelled', 'timed_out'],
  authorized: ['running', 'cancelled', 'timed_out', 'failed'],
  running: ['succeeded', 'failed', 'cancelled', 'timed_out', 'indeterminate'],
  succeeded: [],
  failed: [],
  denied: [],
  cancelled: [],
  timed_out: [],
  indeterminate: [],
};

const APPROVAL_EDGES: Record<ApprovalState, readonly ApprovalState[]> = {
  pending: ['allowed', 'denied', 'expired', 'cancelled'],
  allowed: [],
  denied: [],
  expired: [],
  cancelled: [],
};

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return TASK_EDGES[from].includes(to);
}

export function canTransitionInvocation(from: InvocationState, to: InvocationState): boolean {
  return INVOCATION_EDGES[from].includes(to);
}

export function canTransitionApproval(from: ApprovalState, to: ApprovalState): boolean {
  return APPROVAL_EDGES[from].includes(to);
}

export function isTaskTerminal(state: TaskState): boolean {
  return TASK_TERMINAL.includes(state);
}

export function isInvocationTerminal(state: InvocationState): boolean {
  return INVOCATION_TERMINAL.includes(state);
}

export function isApprovalTerminal(state: ApprovalState): boolean {
  return state !== 'pending';
}

/** Legal next states — used by the dispatcher and by property tests. */
export function nextTaskStates(from: TaskState): readonly TaskState[] {
  return TASK_EDGES[from];
}

export function nextInvocationStates(from: InvocationState): readonly InvocationState[] {
  return INVOCATION_EDGES[from];
}

/**
 * Assert a transition; throws on an illegal edge so a bug fails loudly instead
 * of corrupting the projection.
 */
export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`illegal task transition ${from} → ${to}`);
  }
}

export function assertInvocationTransition(from: InvocationState, to: InvocationState): void {
  if (!canTransitionInvocation(from, to)) {
    throw new Error(`illegal invocation transition ${from} → ${to}`);
  }
}

export function assertApprovalTransition(from: ApprovalState, to: ApprovalState): void {
  if (!canTransitionApproval(from, to)) {
    throw new Error(`illegal approval transition ${from} → ${to}`);
  }
}

// ── protocol state mapping (01 §5.2) ──────────────────────────────────────

/** ARF → A2A `TASK_STATE_*` (ProtoJSON enum names, not kebab-case). */
export const TASK_TO_A2A: Record<TaskState, string> = {
  submitted: 'TASK_STATE_SUBMITTED',
  working: 'TASK_STATE_WORKING',
  input_required: 'TASK_STATE_INPUT_REQUIRED',
  auth_required: 'TASK_STATE_AUTH_REQUIRED',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  cancelled: 'TASK_STATE_CANCELED',
  rejected: 'TASK_STATE_REJECTED',
  // ARF extension: A2A has no `expired`; it degrades to FAILED(reason=timeout).
  expired: 'TASK_STATE_FAILED',
};

/** ARF → MCP Tasks-extension state. */
export const TASK_TO_MCP: Record<TaskState, string> = {
  submitted: 'working',
  working: 'working',
  input_required: 'input_required',
  // MCP has no native auth_required: it degrades to input_required.
  auth_required: 'input_required',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  rejected: 'failed',
  expired: 'failed',
};

/** ARF → ACP `stopReason` for a finished prompt turn. */
export const TASK_TO_ACP_STOP: Record<TaskState, string | undefined> = {
  submitted: undefined,
  working: undefined,
  input_required: undefined,
  auth_required: undefined,
  completed: 'end_turn',
  failed: 'refusal',
  cancelled: 'cancelled',
  rejected: 'refusal',
  expired: 'max_turn_requests',
};
