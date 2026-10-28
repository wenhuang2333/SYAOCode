/**
 * ACP reverse `terminal/*` bridge (G6).
 *
 * Same governance rule as {@link AcpFsBridge}: every terminal operation is a
 * capability invocation through the kernel's dispatcher, gated on the client's
 * declared `terminal` capability. The agent never spawns a local process on the
 * client's behalf, and a missing capability answers `unsupported_capability`
 * instead of degrading to a local shell.
 */

import { acpCapabilityId, CanonicalError } from '@syaocode/rpc';
import type { ReverseInvokeGateway } from '../shared/gateway.js';
import { ACP_LOSSY } from './content.js';

export interface AcpTerminalClientCapabilities {
  terminal?: boolean;
}

export interface AcpTerminalBridgeOptions {
  clientId: string;
  sessionId: string;
  capabilities: AcpTerminalClientCapabilities;
  gateway: ReverseInvokeGateway;
  tenantId?: string;
  taskId?: string;
}

export interface AcpTerminalCreateRequest {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  outputByteLimit?: number;
}

export interface AcpTerminalCreateResult {
  terminalId: string;
}

export interface AcpTerminalOutput {
  output: string;
  truncated: boolean;
  exitStatus?: { exitCode?: number; signal?: string };
}

export interface AcpTerminalExitStatus {
  exitCode?: number;
  signal?: string;
}

/** Reverse terminal bridge. Every method is one governed invocation. */
export class AcpTerminalBridge {
  constructor(private readonly options: AcpTerminalBridgeOptions) {}

  private assertCapability(method: string): void {
    if (this.options.capabilities.terminal === true) return;
    throw new CanonicalError({
      kind: 'unsupported_capability',
      message: `the ACP client did not declare the terminal capability for ${method}`,
      protocol: 'acp',
      retryable: false,
      details: { lossy: [ACP_LOSSY.clientCapabilityMissing] },
    });
  }

  private capabilityId(method: string): string {
    return acpCapabilityId(this.options.clientId, 'terminal', method);
  }

  private async call(method: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertCapability(method);
    const payload = await this.options.gateway.invoke({
      capabilityId: this.capabilityId(method),
      input,
      ...(this.options.taskId !== undefined ? { taskId: this.options.taskId } : {}),
      sessionId: this.options.sessionId,
    });
    if (payload.outcome !== 'succeeded') {
      throw new CanonicalError({
        kind: payload.error?.kind === 'denied' ? 'denied' : payload.error?.kind === 'cancelled' ? 'cancelled' : 'remote_error',
        message: payload.error?.message ?? `ACP terminal/${method} failed with outcome ${payload.outcome}`,
        protocol: 'acp',
        retryable: false,
        details: { outcome: payload.outcome, method: `terminal/${method}` },
      });
    }
    return (payload.output ?? {}) as Record<string, unknown>;
  }

  async create(request: AcpTerminalCreateRequest): Promise<AcpTerminalCreateResult> {
    const output = await this.call('create', {
      sessionId: this.options.sessionId,
      command: request.command,
      ...(request.args !== undefined ? { args: request.args } : {}),
      ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
      ...(request.outputByteLimit !== undefined ? { outputByteLimit: request.outputByteLimit } : {}),
    });
    const terminalId = output['terminalId'];
    if (typeof terminalId !== 'string') {
      throw new CanonicalError({ kind: 'remote_error', message: 'ACP terminal/create returned no terminalId', protocol: 'acp', retryable: false, protocolError: output });
    }
    return { terminalId };
  }

  async output(terminalId: string): Promise<AcpTerminalOutput> {
    const output = await this.call('output', { sessionId: this.options.sessionId, terminalId });
    return {
      output: typeof output['output'] === 'string' ? output['output'] : '',
      truncated: output['truncated'] === true,
      ...(output['exitStatus'] !== undefined ? { exitStatus: output['exitStatus'] as AcpTerminalExitStatus } : {}),
    };
  }

  async waitForExit(terminalId: string): Promise<AcpTerminalExitStatus> {
    const output = await this.call('wait_for_exit', { sessionId: this.options.sessionId, terminalId });
    return {
      ...(typeof output['exitCode'] === 'number' ? { exitCode: output['exitCode'] } : {}),
      ...(typeof output['signal'] === 'string' ? { signal: output['signal'] } : {}),
    };
  }

  async kill(terminalId: string): Promise<void> {
    await this.call('kill', { sessionId: this.options.sessionId, terminalId });
  }

  async release(terminalId: string): Promise<void> {
    await this.call('release', { sessionId: this.options.sessionId, terminalId });
  }

  /** Capability ids this bridge will invoke, for registry pre-registration. */
  capabilityIds(): string[] {
    return ['create', 'output', 'wait_for_exit', 'kill', 'release'].map((method) => this.capabilityId(method));
  }
}
