/**
 * A2A 1.0.0 — AgentCard build / parse / capability projection (01 §2.2).
 *
 * The AgentCard is a *self-description*, never an authorization credential
 * (G7). The registry assigns the trust tier; this module only projects the
 * card's skills into canonical `DiscoveredCapability` records.
 */

import { a2aCapabilityId, CanonicalError, type DiscoveredCapability } from '@syaocode/rpc';

export interface A2aAgentInterface {
  url: string;
  /** `JSONRPC` | `GRPC` | `HTTP+JSON`. */
  protocolBinding: string;
  protocolVersion: string;
}

export interface A2aAgentExtension {
  uri: string;
  description?: string;
  required?: boolean;
}

export interface A2aAgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
  extendedAgentCard?: boolean;
  extensions?: A2aAgentExtension[];
}

export interface A2aAgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  securityRequirements?: unknown[];
}

export interface A2aSecurityScheme {
  type: string;
  scheme?: string;
  bearerFormat?: string;
  description?: string;
  [key: string]: unknown;
}

export interface A2aAgentCard {
  name: string;
  description: string;
  version: string;
  supportedInterfaces: A2aAgentInterface[];
  capabilities: A2aAgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2aAgentSkill[];
  provider?: { organization: string; url?: string };
  documentationUrl?: string;
  securitySchemes?: Record<string, A2aSecurityScheme>;
  securityRequirements?: Record<string, string[]>[];
  signatures?: { protected: string; signature: string }[];
  metadata?: Record<string, unknown>;
}

export interface BuildAgentCardInput {
  name: string;
  description: string;
  version: string;
  url: string;
  protocolBinding?: string;
  protocolVersion?: string;
  streaming?: boolean;
  pushNotifications?: boolean;
  extendedAgentCard?: boolean;
  skills: A2aAgentSkill[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  securitySchemes?: Record<string, A2aSecurityScheme>;
  securityRequirements?: Record<string, string[]>[];
  extensions?: A2aAgentExtension[];
}

/** Build a well-formed AgentCard with the spec's required fields filled in. */
export function buildAgentCard(input: BuildAgentCardInput): A2aAgentCard {
  const capabilities: A2aAgentCapabilities = {
    streaming: input.streaming ?? true,
    pushNotifications: input.pushNotifications ?? false,
    ...(input.extendedAgentCard !== undefined ? { extendedAgentCard: input.extendedAgentCard } : {}),
    ...(input.extensions !== undefined ? { extensions: input.extensions } : {}),
  };
  return {
    name: input.name,
    description: input.description,
    version: input.version,
    supportedInterfaces: [
      {
        url: input.url,
        protocolBinding: input.protocolBinding ?? 'JSONRPC',
        protocolVersion: input.protocolVersion ?? '1.0',
      },
    ],
    capabilities,
    defaultInputModes: input.defaultInputModes ?? ['text/plain'],
    defaultOutputModes: input.defaultOutputModes ?? ['text/plain'],
    skills: input.skills,
    ...(input.securitySchemes !== undefined ? { securitySchemes: input.securitySchemes } : {}),
    ...(input.securityRequirements !== undefined ? { securityRequirements: input.securityRequirements } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse an untrusted AgentCard payload; throws `invalid_request` when broken. */
export function parseAgentCard(raw: unknown): A2aAgentCard {
  if (!isRecord(raw)) throw invalidCard('AgentCard must be an object');
  const name = raw['name'];
  const description = raw['description'];
  const version = raw['version'];
  if (typeof name !== 'string') throw invalidCard('AgentCard.name is required');
  if (typeof description !== 'string') throw invalidCard('AgentCard.description is required');
  if (typeof version !== 'string') throw invalidCard('AgentCard.version is required');

  const interfaces = raw['supportedInterfaces'];
  const supportedInterfaces: A2aAgentInterface[] = [];
  if (Array.isArray(interfaces)) {
    for (const entry of interfaces) {
      if (!isRecord(entry)) continue;
      const url = entry['url'];
      const binding = entry['protocolBinding'];
      const protocolVersion = entry['protocolVersion'];
      if (typeof url !== 'string') continue;
      supportedInterfaces.push({
        url,
        protocolBinding: typeof binding === 'string' ? binding : 'JSONRPC',
        protocolVersion: typeof protocolVersion === 'string' ? protocolVersion : '1.0',
      });
    }
  }

  const rawSkills = raw['skills'];
  const skills: A2aAgentSkill[] = [];
  if (Array.isArray(rawSkills)) {
    for (const entry of rawSkills) {
      if (!isRecord(entry)) continue;
      const id = entry['id'];
      const skillName = entry['name'];
      if (typeof id !== 'string' || typeof skillName !== 'string') continue;
      skills.push({
        id,
        name: skillName,
        ...(typeof entry['description'] === 'string' ? { description: entry['description'] } : {}),
        ...(Array.isArray(entry['tags']) ? { tags: entry['tags'].filter((t): t is string => typeof t === 'string') } : {}),
        ...(Array.isArray(entry['examples']) ? { examples: entry['examples'].filter((t): t is string => typeof t === 'string') } : {}),
      });
    }
  }

  const capabilities = isRecord(raw['capabilities']) ? (raw['capabilities'] as A2aAgentCapabilities) : {};
  const card: A2aAgentCard = {
    name,
    description,
    version,
    supportedInterfaces,
    capabilities,
    defaultInputModes: stringArray(raw['defaultInputModes'], ['text/plain']),
    defaultOutputModes: stringArray(raw['defaultOutputModes'], ['text/plain']),
    skills,
  };
  if (isRecord(raw['securitySchemes'])) card.securitySchemes = raw['securitySchemes'] as Record<string, A2aSecurityScheme>;
  if (Array.isArray(raw['securityRequirements'])) card.securityRequirements = raw['securityRequirements'] as Record<string, string[]>[];
  if (Array.isArray(raw['signatures'])) card.signatures = raw['signatures'] as { protected: string; signature: string }[];
  if (isRecord(raw['metadata'])) card.metadata = raw['metadata'];
  return card;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out = value.filter((entry): entry is string => typeof entry === 'string');
  return out.length > 0 ? out : fallback;
}

function invalidCard(message: string): CanonicalError {
  return new CanonicalError({ kind: 'invalid_request', message, protocol: 'a2a', retryable: false });
}

/** Protocol version declared by the card's primary interface. */
export function agentCardVersion(card: A2aAgentCard): string {
  return card.supportedInterfaces[0]?.protocolVersion ?? '1.0';
}

/**
 * Project a card's skills into canonical capabilities.
 *
 * G7: the card is untrusted self-description — the projection carries the raw
 * skill metadata as advisory annotations only, and the registry owns the
 * effective risk/trust.
 */
export function agentCardCapabilities(card: A2aAgentCard, agentId: string): DiscoveredCapability[] {
  return card.skills.map((skill) => ({
    id: a2aCapabilityId(agentId, skill.id),
    kind: 'agent_skill',
    displayName: skill.name,
    ...(skill.description !== undefined ? { description: skill.description } : {}),
    // Invoking a remote agent is a delegation; the registry still decides the
    // effective risk (I4 / G7).
    declaredRisk: 'delegate',
    annotations: {
      trust: 'untrusted',
      source: 'agent-card',
      ...(skill.tags !== undefined ? { tags: skill.tags } : {}),
      ...(skill.examples !== undefined ? { examples: skill.examples } : {}),
      ...(skill.inputModes !== undefined ? { inputModes: skill.inputModes } : {}),
      ...(skill.outputModes !== undefined ? { outputModes: skill.outputModes } : {}),
      agentVersion: card.version,
      protocolVersion: agentCardVersion(card),
      /** A2A never exposes the remote agent's internal tool calls (G3). */
      visibility: 'opaque',
    },
  }));
}
