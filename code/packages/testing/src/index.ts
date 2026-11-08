/**
 * Root entry of @liwencode/testing.
 *
 * Production code (the CLI) imports from here, so NOTHING reachable from this
 * module may import `vitest`: a test runner must never be loaded by a running
 * agent. The vitest-based suites live behind subpath exports
 * (`@liwencode/testing/contract`, `@liwencode/testing/adapter`).
 */
export { MemoryRuntime, FakeClock } from './memory-runtime.js';
export { MockProvider, mockToolUse, mockText } from './mock-provider.js';
export type { MockProviderOptions } from './mock-provider.js';
export { FakeApprovalChannel, allowAllApprovals, denyAllApprovals } from './approval-channel.js';
export type { ApprovalAnswer, FakeApprovalChannelOptions } from './approval-channel.js';
export { MemoryEventSink } from '@liwencode/core';
export type { AgentEvent, EventSink } from '@liwencode/core';
