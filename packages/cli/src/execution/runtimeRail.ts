import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  FENCED_EXECUTION_PROTOCOL_VERSION,
  FENCED_RUNTIME_CAPABILITIES,
  agentSupportsExecutionTransport,
  parseExecutionAgentClientId,
  parseReadyBinding,
  type Delivery,
  type ReadyBinding,
  type RuntimeCapability,
} from "@codecast/shared/contracts";
import { ConvexExecutionControlPlane } from "./convexControlPlane.js";
import { ExecutionCoordinator } from "./coordinator.js";
import { RuntimeDriverRegistry, type RuntimeDriver } from "./driver.js";
import {
  FileExecutionOperationJournal,
  type ExecutionOperationJournal,
} from "./localJournal.js";
import type { EnsureBindingRequest } from "./types.js";
import type { ExecutionConvexTransport } from "./convexControlPlane.js";

export const FENCED_EXECUTION_FEATURE_FLAG = "CODECAST_FENCED_EXECUTION_V1" as const;

/** Explicitly off unless the single rollout bit is exactly `1`. */
export function fencedExecutionEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[FENCED_EXECUTION_FEATURE_FLAG] === "1";
}

/**
 * Legacy delivery's fail-closed choke. A fenced envelope reaching this point is
 * a programming error; it must never be handed to claimPendingMessageForDelivery,
 * deliverMessage, direct tmux injection, or a fallback transport.
 */
export function assertLegacyDeliveryEnvelope(message: Record<string, unknown>): void {
  if (
    message.delivery_protocol_version !== undefined ||
    message.delivery_id !== undefined ||
    message.conversation_sequence !== undefined ||
    message.execution_epoch !== undefined ||
    message.delivery_status !== undefined ||
    message.active_delivery_attempt_id !== undefined
  ) {
    throw new Error("FENCED_MESSAGE_ON_LEGACY_DELIVERY_RAIL");
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}: expected object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Invalid ${label}: expected non-empty string`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`Invalid ${label}: expected positive safe integer`);
  }
  return value as number;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}

function optionalEnum<const T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TypeError(`Invalid ${label}: unsupported value`);
  }
  return value as T;
}

function parseCapabilities(value: unknown): RuntimeCapability[] {
  if (!Array.isArray(value) || value.some((candidate) => typeof candidate !== "string")) {
    throw new TypeError("Invalid execution work: capabilities must be an array");
  }
  const actual = [...new Set(value)].sort();
  const expected = [...FENCED_RUNTIME_CAPABILITIES].sort();
  if (
    actual.length !== expected.length ||
    actual.some((capability, index) => capability !== expected[index])
  ) {
    throw new TypeError("Invalid execution work: capability handshake mismatch");
  }
  return actual as RuntimeCapability[];
}

function parseEnsureRequest(value: unknown): EnsureBindingRequest {
  const request = object(value, "execution request");
  const target = object(request.target, "execution target");
  const configuration = object(request.configuration, "runtime configuration");
  const requestedAgent = parseExecutionAgentClientId(target.requestedAgent);
  if (requestedAgent !== target.requestedAgent) {
    throw new TypeError("Invalid execution work: agent id is not canonical");
  }
  const transport = string(target.transport, "runtime transport");
  if (!["tmux", "app-server", "external"].includes(transport)) {
    throw new TypeError("Invalid execution work: unsupported transport spelling");
  }
  if (!agentSupportsExecutionTransport(requestedAgent, transport as any)) {
    throw new TypeError("Invalid execution work: agent/transport mismatch");
  }
  let isolation: EnsureBindingRequest["target"]["isolation"];
  if (target.isolation !== undefined) {
    const raw = object(target.isolation, "isolation spec");
    const sandbox = optionalEnum(raw.sandbox, "isolation sandbox", [
      "read-only",
      "workspace-write",
      "danger-full-access",
    ] as const);
    const approvalPolicy = optionalEnum(raw.approvalPolicy, "isolation approval policy", [
      "untrusted",
      "on-failure",
      "on-request",
      "never",
    ] as const);
    if (raw.isolated !== undefined && typeof raw.isolated !== "boolean") {
      throw new TypeError("Invalid isolation flag: expected boolean");
    }
    isolation = {
      ...(sandbox === undefined ? {} : { sandbox }),
      ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
      ...(raw.isolated === undefined ? {} : { isolated: raw.isolated }),
      ...(raw.worktreeName === undefined ? {} : { worktreeName: string(raw.worktreeName, "worktree name") }),
    };
  }
  const protocolVersion = integer(request.protocolVersion, "protocol version");
  if (protocolVersion !== FENCED_EXECUTION_PROTOCOL_VERSION) {
    throw new TypeError(`Invalid execution work: unsupported protocol ${protocolVersion}`);
  }
  return {
    target: {
      conversationId: string(target.conversationId, "conversation id"),
      epoch: integer(target.epoch, "execution epoch"),
      requestedAgent,
      transport: transport as EnsureBindingRequest["target"]["transport"],
      projectPath: string(target.projectPath, "project path"),
      ...(isolation ? { isolation } : {}),
    },
    configuration: {
      revision: integer(configuration.revision, "configuration revision"),
      model: optionalString(configuration.model, "model"),
      effort: optionalString(configuration.effort, "effort"),
    },
    ownerDeviceId: string(request.ownerDeviceId, "owner device id"),
    daemonBootId: string(request.daemonBootId, "daemon boot id"),
    requiredCapabilities: parseCapabilities(request.requiredCapabilities),
    protocolVersion,
    trigger: "recovery",
  };
}

interface BindingWork {
  state: string;
  daemonBootMatch: boolean;
  request: EnsureBindingRequest;
  binding?: ReadyBinding;
}

interface ExecutionWorkItem {
  conversationId: string;
  currentEpoch: number;
  pendingEpoch?: number;
  pendingPolicy?: "drain-current" | "cancel-unstarted";
  bindings: BindingWork[];
  pendingIntent?: {
    intentId: string;
    expectedCurrentEpoch: number;
    policy: "drain-current" | "cancel-unstarted";
    request: EnsureBindingRequest;
  };
}

function parseWork(value: unknown): ExecutionWorkItem[] {
  if (!Array.isArray(value)) throw new TypeError("Invalid execution work feed: expected array");
  return value.map((rawItem) => {
    const item = object(rawItem, "execution work item");
    const bindingsRaw = item.bindings;
    if (!Array.isArray(bindingsRaw)) throw new TypeError("Invalid execution work bindings");
    const bindings = bindingsRaw.map((rawBinding): BindingWork => {
      const binding = object(rawBinding, "binding work");
      if (typeof binding.daemonBootMatch !== "boolean") {
        throw new TypeError("Invalid binding work: daemonBootMatch must be boolean");
      }
      const state = string(binding.state, "binding state");
      return {
        state,
        daemonBootMatch: binding.daemonBootMatch,
        request: parseEnsureRequest(binding.request),
        ...(binding.binding === undefined ? {} : { binding: parseReadyBinding(binding.binding) }),
      };
    });
    let pendingIntent: ExecutionWorkItem["pendingIntent"];
    if (item.pendingIntent !== undefined) {
      const intent = object(item.pendingIntent, "pending successor intent");
      const policy = string(intent.policy, "successor policy");
      if (policy !== "drain-current" && policy !== "cancel-unstarted") {
        throw new TypeError("Invalid execution work: unsupported successor policy");
      }
      pendingIntent = {
        intentId: string(intent.intentId, "successor intent id"),
        expectedCurrentEpoch: integer(intent.expectedCurrentEpoch, "expected current epoch"),
        policy,
        request: parseEnsureRequest(intent.request),
      };
    }
    const pendingPolicy = item.pendingPolicy;
    if (
      pendingPolicy !== undefined &&
      pendingPolicy !== "drain-current" &&
      pendingPolicy !== "cancel-unstarted"
    ) {
      throw new TypeError("Invalid execution work: malformed pending policy");
    }
    return {
      conversationId: string(item.conversationId, "work conversation id"),
      currentEpoch: integer(item.currentEpoch, "current epoch"),
      ...(item.pendingEpoch === undefined ? {} : { pendingEpoch: integer(item.pendingEpoch, "pending epoch") }),
      ...(pendingPolicy === undefined ? {} : { pendingPolicy }),
      bindings,
      ...(pendingIntent ? { pendingIntent } : {}),
    };
  });
}

export interface DaemonExecutionRuntimeOptions {
  transport: ExecutionConvexTransport;
  ownerDeviceId: string;
  drivers: RuntimeDriverRegistry | readonly RuntimeDriver[];
  journal?: ExecutionOperationJournal;
  journalDirectory?: string;
  daemonBootId?: string;
  resolveImage?: (storageId: string) => Promise<string | null>;
  onLog?: (message: string) => void;
}

export class DaemonExecutionRuntime {
  readonly daemonBootId: string;
  readonly controlPlane: ConvexExecutionControlPlane;
  readonly coordinator: ExecutionCoordinator;
  readonly drivers: RuntimeDriverRegistry;
  private readonly ownerDeviceId: string;
  private readonly resolveImage?: DaemonExecutionRuntimeOptions["resolveImage"];
  private readonly onLog: (message: string) => void;
  private unsubscribe?: () => void;
  private workChain: Promise<void> = Promise.resolve();

  constructor(options: DaemonExecutionRuntimeOptions) {
    this.daemonBootId = options.daemonBootId ?? randomUUID();
    this.ownerDeviceId = options.ownerDeviceId;
    this.resolveImage = options.resolveImage;
    this.onLog = options.onLog ?? (() => {});
    this.controlPlane = new ConvexExecutionControlPlane(options.transport);
    this.drivers = options.drivers instanceof RuntimeDriverRegistry
      ? options.drivers
      : new RuntimeDriverRegistry(options.drivers);
    const journal = options.journal ?? new FileExecutionOperationJournal(
      options.journalDirectory ?? path.join(os.homedir(), ".codecast", "execution-journal"),
    );
    this.coordinator = new ExecutionCoordinator({
      controlPlane: this.controlPlane,
      drivers: this.drivers,
      journal,
    });
  }

  private handshake() {
    return {
      ownerDeviceId: this.ownerDeviceId,
      daemonBootId: this.daemonBootId,
      protocolVersion: FENCED_EXECUTION_PROTOCOL_VERSION,
      capabilities: [...FENCED_RUNTIME_CAPABILITIES],
    };
  }

  async start(): Promise<void> {
    // Startup recovery is an actual read/process pass before reactive updates;
    // a WebSocket subscription alone can otherwise wait forever on unchanged
    // durable work left by the prior process.
    await this.processWorkUpdate(await this.controlPlane.listExecutionWork(this.handshake()));
    this.unsubscribe = this.controlPlane.subscribeExecutionWork(this.handshake(), (value) => {
      void this.processWorkUpdate(value).catch((error) => {
        this.onLog(`[fenced-execution] work update failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  processWorkUpdate(value: unknown): Promise<void> {
    const work = parseWork(value);
    const next = this.workChain.then(async () => {
      for (const item of work) await this.processItem(item);
    });
    this.workChain = next.catch(() => {});
    return next;
  }

  private async processItem(item: ExecutionWorkItem): Promise<void> {
    let successorFromIntent: ReadyBinding | undefined;
    if (item.pendingIntent) {
      const intent = item.pendingIntent;
      if (intent.request.daemonBootId !== this.daemonBootId) {
        throw new Error("FENCED_INTENT_BOOT_HANDSHAKE_MISMATCH");
      }
      await this.controlPlane.requestSuccessor({
        conversationId: item.conversationId,
        intentId: intent.intentId,
        expectedCurrentEpoch: intent.expectedCurrentEpoch,
        policy: intent.policy,
        request: intent.request,
      });
      successorFromIntent = await this.coordinator.ensureBinding(intent.request);
    }

    const ready = new Map<number, {
      binding: ReadyBinding;
      request: EnsureBindingRequest;
      state: "ready" | "stopped" | "quarantined";
    }>();
    for (const work of item.bindings) {
      if (
        (work.state === "stopped" || work.state === "quarantined") &&
        work.binding
      ) {
        // A disposition is durable evidence, not live effect authority. Keep it
        // even across a daemon-boot boundary so recovery can finish the atomic
        // successor activation that may have been interrupted after stop.
        ready.set(work.binding.epoch, {
          binding: work.binding,
          request: work.request,
          state: work.state,
        });
        continue;
      }
      if (!work.daemonBootMatch) {
        this.onLog(
          `[fenced-execution] blocked ${item.conversationId} epoch ${work.request.target.epoch}: daemon boot mismatch`,
        );
        continue;
      }
      if (["stopped", "quarantined", "start-ambiguous"].includes(work.state)) continue;
      const binding = await this.coordinator.ensureBinding(work.request);
      ready.set(binding.epoch, { binding, request: work.request, state: "ready" });
    }
    if (successorFromIntent && item.pendingIntent) {
      ready.set(successorFromIntent.epoch, {
        binding: successorFromIntent,
        request: item.pendingIntent.request,
        state: "ready",
      });
    }

    const current = ready.get(item.currentEpoch);
    const pendingEpoch = item.pendingEpoch ?? item.pendingIntent?.request.target.epoch;
    const successor = pendingEpoch === undefined ? undefined : ready.get(pendingEpoch);
    const policy = item.pendingPolicy ?? item.pendingIntent?.policy;

    if (current && successor && policy) {
      if (current.state === "ready") {
        if (policy === "drain-current") await this.drain(current.binding, current.request);
        const driver = this.drivers.resolve(current.binding.actualAgent, current.binding.transport);
        await driver.stop(current.binding);
        const disposition = await this.controlPlane.publishRuntimeDisposition(
          current.binding,
          "stopped",
          `successor epoch ${successor.binding.epoch} ready`,
        );
        if (!disposition.accepted) throw new Error("STALE_RUNTIME_DISPOSITION");
      }
      for (let batch = 0; batch < 1024; batch += 1) {
        const activation = await this.controlPlane.activateSuccessor({
          current: current.binding,
          successor: successor.binding,
        });
        if (activation.activated) break;
        if (!activation.remainingCancellations) {
          throw new Error("SUCCESSOR_ACTIVATION_STALLED");
        }
        if (batch === 1023) throw new Error("SUCCESSOR_ACTIVATION_BATCH_LIMIT");
      }
      if (successor.state === "ready") {
        await this.drain(successor.binding, successor.request);
      }
      return;
    }
    if (current?.state === "ready") await this.drain(current.binding, current.request);
  }

  private async drain(binding: ReadyBinding, request: EnsureBindingRequest): Promise<void> {
    for (let index = 0; index < 1024; index += 1) {
      const claim = await this.controlPlane.claimNextDelivery(binding);
      if (!("permit" in claim)) return;
      const input: Array<Delivery["input"][number]> = [
        { type: "text", text: claim.delivery.content },
      ];
      try {
        for (const storageId of claim.delivery.imageStorageIds) {
          if (!this.resolveImage) throw new Error("fenced image resolver is unavailable");
          const localPath = await this.resolveImage(storageId);
          if (!localPath) throw new Error(`could not resolve fenced image ${storageId}`);
          input.push({ type: "local-image", path: localPath });
        }
      } catch (error) {
        await this.controlPlane.releaseClaimBeforeEffect(
          claim.permit,
          "input preparation failed before delivery/start",
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      const permit = await this.controlPlane.startDelivery(claim.permit);
      const outcome = await this.coordinator.deliver({
        binding: request,
        permit,
        delivery: {
          messageId: claim.delivery.messageId,
          deliveryId: claim.delivery.deliveryId,
          conversationSequence: claim.delivery.conversationSequence,
          input,
        },
      });
      if (outcome.state !== "delivered") return;
    }
    throw new Error("FENCED_DELIVERY_DRAIN_LIMIT");
  }
}

let processRuntime: DaemonExecutionRuntime | null = null;

/** Exactly one coordinator, driver registry, journal and daemon boot per process. */
export function getProcessExecutionRuntime(
  options: DaemonExecutionRuntimeOptions,
): DaemonExecutionRuntime {
  processRuntime ??= new DaemonExecutionRuntime(options);
  return processRuntime;
}
