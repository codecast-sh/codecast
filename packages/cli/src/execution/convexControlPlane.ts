import {
  parseReadyBinding,
  parseStartedDeliveryPermit,
  type ReadyBinding,
  type StartedDeliveryPermit,
  type StructuredFailure,
} from "@codecast/shared/contracts";
import type {
  ExecutionControlMutationName,
  ExecutionControlQueryName,
} from "../syncService.js";
import type {
  ClaimStartRequest,
  ExecutionControlPlane,
  StartClaimResult,
} from "./controlPlane.js";
import type { DeliveryOutcome, EnsureBindingRequest } from "./types.js";

export interface ExecutionConvexTransport {
  executionControlMutation(
    name: ExecutionControlMutationName,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  executionControlQuery(
    name: ExecutionControlQueryName,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  subscribeExecutionControlQuery?(
    name: ExecutionControlQueryName,
    args: Record<string, unknown>,
    onUpdate: (value: unknown) => void,
  ): () => void;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Invalid ${label}: expected a non-empty string`);
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`Invalid ${label}: expected a string`);
  return value;
}

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`Invalid ${label}: expected a positive safe integer`);
  }
  return value as number;
}

function parseFailure(value: unknown): StructuredFailure {
  const input = record(value, "structured failure");
  const retryable = input.retryable;
  if (retryable !== undefined && typeof retryable !== "boolean") {
    throw new TypeError("Invalid structured failure: retryable must be boolean");
  }
  return {
    code: nonEmpty(input.code, "structured failure code"),
    message: nonEmpty(input.message, "structured failure message"),
    ...(retryable === undefined ? {} : { retryable }),
  };
}

function targetWire(request: EnsureBindingRequest): Record<string, unknown> {
  return {
    requested_agent: request.target.requestedAgent,
    transport: request.target.transport,
    project_path: request.target.projectPath,
    isolation: request.target.isolation
      ? {
          sandbox: request.target.isolation.sandbox,
          approval_policy: request.target.isolation.approvalPolicy,
          isolated: request.target.isolation.isolated,
          worktree_name: request.target.isolation.worktreeName,
        }
      : undefined,
    configuration_revision: request.configuration.revision,
    model: request.configuration.model,
    effort: request.configuration.effort,
    owner_device_id: request.ownerDeviceId,
    daemon_boot_id: request.daemonBootId,
    required_capabilities: [...request.requiredCapabilities],
    protocol_version: request.protocolVersion,
  };
}

function startFenceWire(request: EnsureBindingRequest): Record<string, unknown> {
  return {
    conversation_id: request.target.conversationId,
    epoch: request.target.epoch,
    owner_device_id: request.ownerDeviceId,
    daemon_boot_id: request.daemonBootId,
    configuration_revision: request.configuration.revision,
  };
}

function permitWire(permit: StartedDeliveryPermit | ClaimedDeliveryPermit): Record<string, unknown> {
  return {
    message_id: permit.messageId,
    delivery_id: permit.deliveryId,
    conversation_sequence: permit.conversationSequence,
    attempt_id: permit.attemptId,
    conversation_id: permit.conversationId,
    execution_epoch: permit.executionEpoch,
    configuration_revision: permit.configurationRevision,
    owner_device_id: permit.ownerDeviceId,
    daemon_boot_id: permit.daemonBootId,
    runtime_id: permit.runtimeId,
  };
}

function parseStartClaim(value: unknown): StartClaimResult {
  const input = record(value, "start claim");
  switch (input.state) {
    case "ready":
      return { state: "ready", binding: parseReadyBinding(input.binding) };
    case "claimed": {
      const recovery = record(input.recovery, "start recovery proof");
      if (recovery.state === "fresh") {
        return {
          state: "claimed",
          operationId: nonEmpty(input.operationId, "start operation id"),
          recovery: { state: "fresh" },
        };
      }
      if (
        recovery.state === "recovering" &&
        recovery.previousBootTerminated === true
      ) {
        return {
          state: "claimed",
          operationId: nonEmpty(input.operationId, "start operation id"),
          recovery: {
            state: "recovering",
            previousDaemonBootId: nonEmpty(
              recovery.previousDaemonBootId,
              "previous daemon boot id",
            ),
            previousBootTerminated: true,
          },
        };
      }
      throw new TypeError("Invalid start claim: malformed recovery proof");
    }
    case "busy":
      return {
        state: "busy",
        ...(input.operationId === undefined
          ? {}
          : { operationId: nonEmpty(input.operationId, "busy operation id") }),
        failure: parseFailure(input.failure),
      };
    case "rejected":
      return { state: "rejected", failure: parseFailure(input.failure) };
    default:
      throw new TypeError(`Invalid start claim state: ${String(input.state)}`);
  }
}

export interface ClaimedDeliveryPermit {
  state: "claimed";
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

export interface ClaimedDelivery {
  permit: ClaimedDeliveryPermit;
  delivery: {
    messageId: string;
    deliveryId: string;
    conversationSequence: string;
    content: string;
    imageStorageIds: readonly string[];
  };
  recovered: boolean;
}

function parseClaimedPermit(value: unknown): ClaimedDeliveryPermit {
  const input = record(value, "claimed delivery permit");
  if (input.state !== "claimed") {
    throw new TypeError("Invalid claimed delivery permit: state must be claimed");
  }
  return {
    state: "claimed",
    messageId: nonEmpty(input.messageId, "claimed message id"),
    deliveryId: nonEmpty(input.deliveryId, "claimed delivery id"),
    conversationSequence: nonEmpty(input.conversationSequence, "claimed conversation sequence"),
    attemptId: nonEmpty(input.attemptId, "claimed attempt id"),
    conversationId: nonEmpty(input.conversationId, "claimed conversation id"),
    executionEpoch: positive(input.executionEpoch, "claimed execution epoch"),
    configurationRevision: positive(input.configurationRevision, "claimed configuration revision"),
    ownerDeviceId: nonEmpty(input.ownerDeviceId, "claimed owner device id"),
    daemonBootId: nonEmpty(input.daemonBootId, "claimed daemon boot id"),
    runtimeId: nonEmpty(input.runtimeId, "claimed runtime id"),
  };
}

/** Real API-token-backed Convex adapter for the fenced coordinator. */
export class ConvexExecutionControlPlane implements ExecutionControlPlane {
  constructor(private readonly transport: ExecutionConvexTransport) {}

  async registerBoot(input: { ownerDeviceId: string; daemonBootId: string }): Promise<void> {
    await this.transport.executionControlMutation("registerExecutionDaemonBoot", {
      owner_device_id: input.ownerDeviceId,
      daemon_boot_id: input.daemonBootId,
    });
  }

  async claimStart(request: ClaimStartRequest): Promise<StartClaimResult> {
    return parseStartClaim(await this.transport.executionControlMutation("claimExecutionStart", {
      ...startFenceWire(request),
      protocol_version: request.protocolVersion,
      required_capabilities: [...request.requiredCapabilities],
      proposed_operation_id: request.proposedOperationId,
    }));
  }

  async publishReady(binding: ReadyBinding): Promise<{ accepted: boolean }> {
    const result = record(await this.transport.executionControlMutation("publishReadyBinding", {
      conversation_id: binding.conversationId,
      epoch: binding.epoch,
      requested_agent: binding.requestedAgent,
      actual_agent: binding.actualAgent,
      transport: binding.transport,
      handle: binding.handle,
      owner_device_id: binding.ownerDeviceId,
      daemon_boot_id: binding.daemonBootId,
      runtime_id: binding.runtimeId,
      operation_id: binding.operationId,
      applied_configuration_revision: binding.appliedConfigurationRevision,
      protocol_version: binding.protocolVersion,
      capabilities: [...binding.capabilities],
    }), "ready publication");
    if (typeof result.accepted !== "boolean") {
      throw new TypeError("Invalid ready publication: accepted must be boolean");
    }
    if (result.binding !== undefined) parseReadyBinding(result.binding);
    return { accepted: result.accepted };
  }

  async publishStartFailedBeforeEffect(input: {
    request: EnsureBindingRequest;
    operationId: string;
    failure: StructuredFailure;
  }): Promise<void> {
    await this.publishStartOutcome("publishStartFailedBeforeEffect", input);
  }

  async publishStartAmbiguous(input: {
    request: EnsureBindingRequest;
    operationId: string;
    failure: StructuredFailure;
    suspectedRuntimeId?: string;
  }): Promise<void> {
    await this.publishStartOutcome("publishStartAmbiguous", input);
  }

  private async publishStartOutcome(
    name: "publishStartFailedBeforeEffect" | "publishStartAmbiguous",
    input: {
      request: EnsureBindingRequest;
      operationId: string;
      failure: StructuredFailure;
      suspectedRuntimeId?: string;
    },
  ): Promise<void> {
    await this.transport.executionControlMutation(name, {
      ...startFenceWire(input.request),
      operation_id: input.operationId,
      failure_code: input.failure.code,
      failure_message: input.failure.message,
      failure_retryable: input.failure.retryable,
      suspected_runtime_id: input.suspectedRuntimeId,
    });
  }

  async completeDelivery(input: {
    permit: StartedDeliveryPermit;
    outcome: Extract<DeliveryOutcome, { state: "delivered" }>;
  }): Promise<void> {
    await this.transport.executionControlMutation("completeDelivery", {
      permit: permitWire(input.permit),
      external_delivery_id: input.outcome.externalDeliveryId,
    });
  }

  async failDeliveryBeforeEffect(input: {
    permit: StartedDeliveryPermit;
    outcome: Extract<DeliveryOutcome, { state: "failed-before-effect" }>;
  }): Promise<void> {
    await this.transport.executionControlMutation("failDeliveryBeforeEffect", {
      permit: permitWire(input.permit),
      failure_code: input.outcome.failure.code,
      failure_message: input.outcome.failure.message,
    });
  }

  async markDeliveryAmbiguous(input: {
    permit: StartedDeliveryPermit;
    outcome: Extract<DeliveryOutcome, { state: "ambiguous" }>;
  }): Promise<void> {
    await this.transport.executionControlMutation("markDeliveryAmbiguous", {
      permit: permitWire(input.permit),
      failure_code: input.outcome.failure.code,
      failure_message: input.outcome.failure.message,
    });
  }

  async requestSuccessor(input: {
    conversationId: string;
    intentId: string;
    expectedCurrentEpoch: number;
    policy: "drain-current" | "cancel-unstarted";
    request: EnsureBindingRequest;
  }): Promise<{ created: boolean; epoch: number; admissionBoundary: number }> {
    const result = record(await this.transport.executionControlMutation("requestExecutionSuccessor", {
      conversation_id: input.conversationId,
      intent_id: input.intentId,
      expected_current_epoch: input.expectedCurrentEpoch,
      policy: input.policy,
      target: targetWire(input.request),
    }), "successor proposal");
    if (typeof result.created !== "boolean") throw new TypeError("Invalid successor proposal: created");
    return {
      created: result.created,
      epoch: positive(result.epoch, "successor epoch"),
      admissionBoundary: positive(result.admissionBoundary, "successor admission boundary"),
    };
  }

  async claimNextDelivery(
    binding: ReadyBinding,
    expectedMessageId?: string,
  ): Promise<ClaimedDelivery | { state: "empty" | "busy" | "waiting" }> {
    const result = record(await this.transport.executionControlMutation("claimNextDelivery", {
      conversation_id: binding.conversationId,
      expected_message_id: expectedMessageId,
      execution_epoch: binding.epoch,
      configuration_revision: binding.appliedConfigurationRevision,
      owner_device_id: binding.ownerDeviceId,
      daemon_boot_id: binding.daemonBootId,
      runtime_id: binding.runtimeId,
    }), "delivery claim");
    if (result.state === "empty") return { state: "empty" };
    if (result.state === "busy") return { state: "busy" };
    if (result.state === "waiting-for-earlier-message" || result.state === "waiting-for-successor") {
      return { state: "waiting" };
    }
    if (result.state !== "claimed") {
      throw new TypeError(`Invalid delivery claim state: ${String(result.state)}`);
    }
    const permit = parseClaimedPermit(result.permit);
    const message = record(result.message, "claimed delivery message");
    const imageStorageIds = [
      ...(typeof message.image_storage_id === "string" ? [message.image_storage_id] : []),
      ...(Array.isArray(message.image_storage_ids)
        ? message.image_storage_ids.map((value) => nonEmpty(value, "image storage id"))
        : []),
    ];
    return {
      permit,
      delivery: {
        messageId: permit.messageId,
        deliveryId: permit.deliveryId,
        conversationSequence: permit.conversationSequence,
        content: stringValue(message.content, "claimed message content"),
        imageStorageIds,
      },
      recovered: result.recovered === true,
    };
  }

  async startDelivery(permit: ClaimedDeliveryPermit): Promise<StartedDeliveryPermit> {
    return parseStartedDeliveryPermit(await this.transport.executionControlMutation("startDelivery", {
      permit: permitWire(permit),
    }));
  }

  async releaseClaimBeforeEffect(
    permit: ClaimedDeliveryPermit,
    reason: string,
    evidence: string,
  ): Promise<void> {
    await this.transport.executionControlMutation("releaseClaimBeforeEffect", {
      permit: permitWire(permit),
      reason,
      evidence,
    });
  }

  async publishRuntimeDisposition(
    binding: ReadyBinding,
    disposition: "stopped" | "quarantined",
    reason: string,
  ): Promise<{ accepted: boolean }> {
    const result = record(await this.transport.executionControlMutation("publishRuntimeDisposition", {
      conversation_id: binding.conversationId,
      epoch: binding.epoch,
      configuration_revision: binding.appliedConfigurationRevision,
      owner_device_id: binding.ownerDeviceId,
      daemon_boot_id: binding.daemonBootId,
      runtime_id: binding.runtimeId,
      disposition,
      reason,
    }), "runtime disposition");
    if (typeof result.accepted !== "boolean") {
      throw new TypeError("Invalid runtime disposition: accepted must be boolean");
    }
    return { accepted: result.accepted };
  }

  async activateSuccessor(input: {
    current: ReadyBinding;
    successor: ReadyBinding;
  }): Promise<{ activated: boolean; remainingCancellations?: number }> {
    const result = record(await this.transport.executionControlMutation("activateExecutionSuccessor", {
      conversation_id: input.current.conversationId,
      expected_current_epoch: input.current.epoch,
      successor_epoch: input.successor.epoch,
      current_configuration_revision: input.current.appliedConfigurationRevision,
      current_owner_device_id: input.current.ownerDeviceId,
      current_daemon_boot_id: input.current.daemonBootId,
      current_operation_id: input.current.operationId,
      current_runtime_id: input.current.runtimeId,
      successor_configuration_revision: input.successor.appliedConfigurationRevision,
      successor_owner_device_id: input.successor.ownerDeviceId,
      successor_daemon_boot_id: input.successor.daemonBootId,
      successor_runtime_id: input.successor.runtimeId,
    }), "successor activation");
    if (typeof result.activated !== "boolean") {
      throw new TypeError("Invalid successor activation: activated must be boolean");
    }
    return {
      activated: result.activated,
      ...(result.remainingCancellations === undefined
        ? {}
        : { remainingCancellations: positive(result.remainingCancellations, "remaining cancellations") }),
    };
  }

  listExecutionWork(handshake: {
    ownerDeviceId: string;
    daemonBootId: string;
    protocolVersion: number;
    capabilities: readonly string[];
  }): Promise<unknown> {
    return this.transport.executionControlQuery("listExecutionWork", {
      owner_device_id: handshake.ownerDeviceId,
      daemon_boot_id: handshake.daemonBootId,
      protocol_version: handshake.protocolVersion,
      capabilities: [...handshake.capabilities],
    });
  }

  subscribeExecutionWork(
    handshake: {
      ownerDeviceId: string;
      daemonBootId: string;
      protocolVersion: number;
      capabilities: readonly string[];
    },
    onUpdate: (value: unknown) => void,
  ): () => void {
    if (!this.transport.subscribeExecutionControlQuery) {
      throw new TypeError("Execution transport does not support reactive queries");
    }
    return this.transport.subscribeExecutionControlQuery("listExecutionWork", {
      owner_device_id: handshake.ownerDeviceId,
      daemon_boot_id: handshake.daemonBootId,
      protocol_version: handshake.protocolVersion,
      capabilities: [...handshake.capabilities],
    }, onUpdate);
  }
}
