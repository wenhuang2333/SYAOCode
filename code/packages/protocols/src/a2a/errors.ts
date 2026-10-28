/**
 * A2A error codes ↔ CanonicalError (01 §5.3 / G10).
 */

import { A2A_ERROR_CODES, CanonicalError, canonicalFromJsonRpcError, type CanonicalErrorShape } from '@syaocode/rpc';

export { A2A_ERROR_CODES };

export const A2A_TASK_NOT_FOUND = A2A_ERROR_CODES.taskNotFound;
export const A2A_TASK_NOT_CANCELABLE = A2A_ERROR_CODES.taskNotCancelable;
export const A2A_PUSH_NOT_SUPPORTED = A2A_ERROR_CODES.pushNotificationNotSupported;
export const A2A_UNSUPPORTED_OPERATION = A2A_ERROR_CODES.unsupportedOperation;
export const A2A_VERSION_NOT_SUPPORTED = A2A_ERROR_CODES.versionNotSupported;

/** Map an A2A JSON-RPC error object onto a CanonicalError. */
export function a2aError(error: unknown): CanonicalError {
  return canonicalFromJsonRpcError('a2a', error);
}

/** The requested task does not exist **or** is not visible to this tenant. */
export function a2aTaskNotFound(taskId: string, tenantId?: string): CanonicalError {
  // Same answer for "missing" and "someone else's": A2A §security forbids
  // leaking the existence of another tenant's task.
  return new CanonicalError({
    kind: 'capability_not_found',
    message: `A2A task not found: ${taskId}`,
    protocol: 'a2a',
    retryable: false,
    wireCode: A2A_TASK_NOT_FOUND,
    protocolError: { code: A2A_TASK_NOT_FOUND, message: 'TaskNotFoundError' },
    ...(tenantId !== undefined ? { details: { tenantId } } : {}),
  });
}

export function a2aTaskNotCancelable(taskId: string, state: string): CanonicalError {
  return new CanonicalError({
    kind: 'invalid_request',
    message: `A2A task ${taskId} is not cancelable in state ${state}`,
    protocol: 'a2a',
    retryable: false,
    wireCode: A2A_TASK_NOT_CANCELABLE,
    protocolError: { code: A2A_TASK_NOT_CANCELABLE, message: 'TaskNotCancelableError' },
  });
}

export function a2aPushUnsupported(): CanonicalError {
  return new CanonicalError({
    kind: 'unsupported_capability',
    message: 'A2A push notifications are not implemented by this agent',
    protocol: 'a2a',
    retryable: false,
    wireCode: A2A_PUSH_NOT_SUPPORTED,
    protocolError: { code: A2A_PUSH_NOT_SUPPORTED, message: 'PushNotificationNotSupportedError' },
  });
}

export function a2aUnsupportedOperation(message: string): CanonicalError {
  return new CanonicalError({
    kind: 'unsupported_capability',
    message,
    protocol: 'a2a',
    retryable: false,
    wireCode: A2A_UNSUPPORTED_OPERATION,
    protocolError: { code: A2A_UNSUPPORTED_OPERATION, message: 'UnsupportedOperationError' },
  });
}

export function a2aVersionNotSupported(requested: string, supported: string): CanonicalError {
  return new CanonicalError({
    kind: 'version_mismatch',
    message: `A2A version ${requested} is not supported (supported: ${supported})`,
    protocol: 'a2a',
    retryable: false,
    wireCode: A2A_VERSION_NOT_SUPPORTED,
    protocolError: { code: A2A_VERSION_NOT_SUPPORTED, message: 'VersionNotSupportedError' },
  });
}

export function a2aErrorShape(error: CanonicalError): CanonicalErrorShape {
  return error.toShape();
}

/**
 * Map a canonical failure onto an A2A JSON-RPC error object.
 *
 * The numeric code comes from the error itself: `CanonicalError` derives it via
 * `defaultWireCode('a2a', kind)` (rpc) and `toShape()` carries it as
 * `wireCode`, which `shared/jsonrpc.ts` emits verbatim. An explicit
 * `wireCode` always wins, so a call site can pin a more specific code.
 *
 * This helper exists for hosts that build the JSON-RPC envelope by hand; the
 * server simply throws the `CanonicalError`/shape and lets the connection
 * convert it.
 */
export function canonicalToA2aError(shape: CanonicalErrorShape): { code: number; message: string; data: unknown } {
  return {
    code: a2aWireCode(shape),
    message: shape.message,
    data: { kind: shape.kind, retryable: shape.retryable, ...(shape.details ?? {}) },
  };
}

/** The numeric code an A2A error shape will carry on the wire. */
export function a2aWireCode(shape: CanonicalErrorShape): number {
  return shape.wireCode ?? A2A_FALLBACK_CODE;
}

/** JSON-RPC internal error: only reached for an unstamped, non-protocol error. */
export const A2A_FALLBACK_CODE = -32603;
