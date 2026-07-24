import type { AgentClientId, AgentExecutionTransport } from "./agentClients";

/** The first protocol version whose delivery side effects require a server permit. */
export const FENCED_EXECUTION_PROTOCOL_VERSION = 1 as const;

export const FENCED_RUNTIME_CAPABILITIES = [
  "single-flight-binding",
  "delivery-permit-v1",
  "strict-agent-routing",
  "runtime-inspection-v1",
] as const;

export type RuntimeCapability = (typeof FENCED_RUNTIME_CAPABILITIES)[number];
export type RuntimeTransport = AgentExecutionTransport;

export interface IsolationSpec {
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  isolated?: boolean;
  worktreeName?: string;
}

/** Immutable delivery target. Changing any field requires a successor epoch. */
export interface ExecutionTargetSpec {
  conversationId: string;
  epoch: number;
  requestedAgent: AgentClientId;
  transport: RuntimeTransport;
  projectPath: string;
  isolation?: IsolationSpec;
}

/** Immutable within an epoch in protocol v1. */
export interface RuntimeConfiguration {
  revision: number;
  model?: string;
  effort?: string;
}

export interface StructuredFailure {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, string | number | boolean | null>;
}

export interface PendingSuccessor {
  state: "waiting-for-drain";
  target: ExecutionTargetSpec;
  configuration: RuntimeConfiguration;
  ownerDeviceId: string;
  daemonBootId: string;
  requiredCapabilities: readonly RuntimeCapability[];
  policy: "drain-current" | "cancel-unstarted";
  requestedAtConversationSequence: string;
}

export interface ReadyBinding {
  conversationId: string;
  epoch: number;
  requestedAgent: AgentClientId;
  actualAgent: AgentClientId;
  transport: RuntimeTransport;
  handle: string;
  ownerDeviceId: string;
  daemonBootId: string;
  runtimeId: string;
  operationId: string;
  appliedConfigurationRevision: number;
  protocolVersion: number;
  capabilities: readonly RuntimeCapability[];
}

interface ExecutionBase {
  target: ExecutionTargetSpec;
  configuration: RuntimeConfiguration;
  ownerDeviceId: string;
  daemonBootId: string;
  requiredCapabilities: readonly RuntimeCapability[];
  pendingSuccessor?: PendingSuccessor;
}

export type ExecutionRecord =
  | (ExecutionBase & { state: "requested" })
  | (ExecutionBase & { state: "starting"; operationId: string })
  | (ExecutionBase & { state: "ready"; binding: ReadyBinding })
  | (ExecutionBase & {
      state: "start-failed-before-effect";
      operationId: string;
      failure: StructuredFailure;
    })
  | (ExecutionBase & {
      state: "start-ambiguous";
      operationId: string;
      suspectedRuntimeId?: string;
      failure: StructuredFailure;
    })
  | (ExecutionBase & { state: "stopped"; stoppedReason: string })
  | (ExecutionBase & {
      state: "quarantined";
      binding?: ReadyBinding;
      operationId: string;
      failure: StructuredFailure;
    });

export interface DeliveryPermit {
  messageId: string;
  deliveryId: string;
  conversationSequence: string;
  attemptId: string;
  conversationId: string;
  executionEpoch: number;
  configurationRevision: number;
  ownerDeviceId: string;
  daemonBootId: string;
  runtimeId: string;
}

export interface StartedDeliveryPermitWire extends DeliveryPermit {
  state: "delivery-started";
}

declare const startedDeliveryPermitBrand: unique symbol;

/** Only {@link parseStartedDeliveryPermit} can brand an untrusted wire value. */
export type StartedDeliveryPermit = StartedDeliveryPermitWire & {
  readonly [startedDeliveryPermitBrand]: true;
};

export type DeliveryInput =
  | { type: "text"; text: string }
  | { type: "local-image"; path: string };

export interface Delivery {
  messageId: string;
  deliveryId: string;
  conversationSequence: string;
  input: readonly DeliveryInput[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  value: Record<string, unknown>,
  field: string,
): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new TypeError(`Invalid started delivery permit: ${field} must be a non-empty string`);
  }
  return candidate;
}

function requirePositiveInteger(
  value: Record<string, unknown>,
  field: string,
): number {
  const candidate = value[field];
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
    throw new TypeError(`Invalid started delivery permit: ${field} must be a positive integer`);
  }
  return candidate as number;
}

function requireCanonicalAgent(value: Record<string, unknown>, field: string): AgentClientId {
  const candidate = requireNonEmptyString(value, field);
  if (!["claude", "codex", "cursor", "gemini", "opencode", "pi"].includes(candidate)) {
    throw new TypeError(`Invalid ready binding: ${field} is not a canonical agent id`);
  }
  return candidate as AgentClientId;
}

function requireRuntimeTransport(value: Record<string, unknown>, field: string): RuntimeTransport {
  const candidate = requireNonEmptyString(value, field);
  if (!["tmux", "app-server", "external"].includes(candidate)) {
    throw new TypeError(`Invalid ready binding: ${field} is not a runtime transport`);
  }
  return candidate as RuntimeTransport;
}

function requireCapabilities(value: Record<string, unknown>, field: string): RuntimeCapability[] {
  const candidate = value[field];
  if (!Array.isArray(candidate) || candidate.some((item) => typeof item !== "string")) {
    throw new TypeError(`Invalid ready binding: ${field} must be an array`);
  }
  const normalized = [...new Set(candidate)].sort();
  const required = [...FENCED_RUNTIME_CAPABILITIES].sort();
  if (
    normalized.length !== required.length ||
    normalized.some((capability, index) => capability !== required[index])
  ) {
    throw new TypeError("Invalid ready binding: capabilities do not exactly match protocol v1");
  }
  return normalized as RuntimeCapability[];
}

/** Strictly parse the only server shape that can authorize a runtime effect. */
export function parseReadyBinding(value: unknown): ReadyBinding {
  if (!isRecord(value)) throw new TypeError("Invalid ready binding: expected an object");
  const requestedAgent = requireCanonicalAgent(value, "requestedAgent");
  const actualAgent = requireCanonicalAgent(value, "actualAgent");
  if (requestedAgent !== actualAgent) {
    throw new TypeError("Invalid ready binding: actualAgent must equal requestedAgent");
  }
  const protocolVersion = requirePositiveInteger(value, "protocolVersion");
  if (protocolVersion !== FENCED_EXECUTION_PROTOCOL_VERSION) {
    throw new TypeError(`Invalid ready binding: unsupported protocol ${protocolVersion}`);
  }
  return {
    conversationId: requireNonEmptyString(value, "conversationId"),
    epoch: requirePositiveInteger(value, "epoch"),
    requestedAgent,
    actualAgent,
    transport: requireRuntimeTransport(value, "transport"),
    handle: requireNonEmptyString(value, "handle"),
    ownerDeviceId: requireNonEmptyString(value, "ownerDeviceId"),
    daemonBootId: requireNonEmptyString(value, "daemonBootId"),
    runtimeId: requireNonEmptyString(value, "runtimeId"),
    operationId: requireNonEmptyString(value, "operationId"),
    appliedConfigurationRevision: requirePositiveInteger(value, "appliedConfigurationRevision"),
    protocolVersion,
    capabilities: requireCapabilities(value, "capabilities"),
  };
}

/**
 * Validate and brand the exact response returned by the future Convex
 * `startDelivery` mutation. A claimed or hand-built object is not sufficient to
 * authorize an external effect.
 */
export function parseStartedDeliveryPermit(value: unknown): StartedDeliveryPermit {
  if (!isRecord(value) || value.state !== "delivery-started") {
    throw new TypeError("Invalid started delivery permit: state must be delivery-started");
  }

  const permit: StartedDeliveryPermitWire = {
    state: "delivery-started",
    messageId: requireNonEmptyString(value, "messageId"),
    deliveryId: requireNonEmptyString(value, "deliveryId"),
    conversationSequence: requireNonEmptyString(value, "conversationSequence"),
    attemptId: requireNonEmptyString(value, "attemptId"),
    conversationId: requireNonEmptyString(value, "conversationId"),
    executionEpoch: requirePositiveInteger(value, "executionEpoch"),
    configurationRevision: requirePositiveInteger(value, "configurationRevision"),
    ownerDeviceId: requireNonEmptyString(value, "ownerDeviceId"),
    daemonBootId: requireNonEmptyString(value, "daemonBootId"),
    runtimeId: requireNonEmptyString(value, "runtimeId"),
  };

  return permit as StartedDeliveryPermit;
}

export function readyBindingMatchesPermit(
  binding: ReadyBinding,
  permit: StartedDeliveryPermit,
): boolean {
  return (
    binding.conversationId === permit.conversationId &&
    binding.epoch === permit.executionEpoch &&
    binding.ownerDeviceId === permit.ownerDeviceId &&
    binding.daemonBootId === permit.daemonBootId &&
    binding.runtimeId === permit.runtimeId &&
    binding.appliedConfigurationRevision === permit.configurationRevision &&
    binding.requestedAgent === binding.actualAgent
  );
}

export function deliveryMatchesPermit(
  delivery: Delivery,
  permit: StartedDeliveryPermit,
): boolean {
  return (
    delivery.messageId === permit.messageId &&
    delivery.deliveryId === permit.deliveryId &&
    delivery.conversationSequence === permit.conversationSequence
  );
}
