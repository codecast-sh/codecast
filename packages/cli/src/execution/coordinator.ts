import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  FENCED_EXECUTION_PROTOCOL_VERSION,
  FENCED_RUNTIME_CAPABILITIES,
  agentSupportsExecutionTransport,
  parseExecutionAgentClientId,
  readyBindingMatchesPermit,
  deliveryMatchesPermit,
  type ReadyBinding,
  type StartedDeliveryPermit,
  type StructuredFailure,
} from "@codecast/shared/contracts";
import type { ExecutionControlPlane } from "./controlPlane.js";
import type { RuntimeDriver } from "./driver.js";
import { RuntimeDriverRegistry } from "./driver.js";
import type {
  ExecutionJournalPhase,
  ExecutionJournalRecord,
  ExecutionOperationJournal,
} from "./localJournal.js";
import { EXECUTION_JOURNAL_SCHEMA_VERSION } from "./localJournal.js";
import type {
  ActiveDeliverySnapshot,
  DeliverFencedRequest,
  DeliveryOutcome,
  DriverDeliveryResult,
  EnsureBindingRequest,
  RuntimeHandle,
} from "./types.js";
import { ExecutionCoordinatorError, structuredFailure } from "./types.js";

interface BindingFlight {
  fingerprint: string;
  promise: Promise<ReadyBinding>;
}

interface CompletedAttempt {
  signature: string;
  outcome: Exclude<DeliveryOutcome, { state: "ambiguous" }>;
}

interface ActiveDelivery {
  signature: string;
  snapshot: ActiveDeliverySnapshot;
  publicPromise: Promise<DeliveryOutcome>;
  resolvePublic: (outcome: DeliveryOutcome) => void;
  publicSettled: boolean;
  ambiguityReported: boolean;
  timeout: ReturnType<typeof setTimeout>;
  controlChain: Promise<void>;
}

export interface ExecutionCoordinatorOptions {
  controlPlane: ExecutionControlPlane;
  drivers: RuntimeDriverRegistry | readonly RuntimeDriver[];
  journal: ExecutionOperationJournal;
  operationIdFactory?: () => string;
  now?: () => number;
  defaultDeliveryTimeoutMs?: number;
  completedAttemptCacheSize?: number;
}

function bindingKey(request: EnsureBindingRequest): string {
  return `${request.target.conversationId}\u0000${request.target.epoch}`;
}

function requestFingerprint(request: EnsureBindingRequest): string {
  return JSON.stringify({
    target: request.target,
    configuration: request.configuration,
    ownerDeviceId: request.ownerDeviceId,
    daemonBootId: request.daemonBootId,
    requiredCapabilities: [...request.requiredCapabilities].sort(),
    protocolVersion: request.protocolVersion,
  });
}

function journalRequestFingerprint(journal: ExecutionJournalRecord): string {
  return JSON.stringify({
    target: journal.target,
    configuration: journal.configuration,
    ownerDeviceId: journal.ownerDeviceId,
    requiredCapabilities: [...journal.requiredCapabilities].sort(),
    protocolVersion: journal.protocolVersion,
  });
}

function permitSignature(permit: StartedDeliveryPermit): string {
  return JSON.stringify({
    attemptId: permit.attemptId,
    messageId: permit.messageId,
    deliveryId: permit.deliveryId,
    conversationSequence: permit.conversationSequence,
    conversationId: permit.conversationId,
    executionEpoch: permit.executionEpoch,
    configurationRevision: permit.configurationRevision,
    ownerDeviceId: permit.ownerDeviceId,
    daemonBootId: permit.daemonBootId,
    runtimeId: permit.runtimeId,
  });
}

function validateBindingRequest(request: EnsureBindingRequest): void {
  const canonicalAgent = parseExecutionAgentClientId(request.target.requestedAgent);
  if (canonicalAgent !== request.target.requestedAgent) {
    throw new ExecutionCoordinatorError(
      "INVALID_BINDING_REQUEST",
      `Execution targets require the canonical agent id, received ${String(request.target.requestedAgent)}`,
    );
  }
  if (
    !request.target.conversationId ||
    !Number.isSafeInteger(request.target.epoch) ||
    request.target.epoch < 1 ||
    !path.isAbsolute(request.target.projectPath) ||
    !Number.isSafeInteger(request.configuration.revision) ||
    request.configuration.revision < 1 ||
    !request.ownerDeviceId ||
    !request.daemonBootId
  ) {
    throw new ExecutionCoordinatorError(
      "INVALID_BINDING_REQUEST",
      "Execution target, epoch, configuration revision, absolute project path, and owner are required",
    );
  }
  if (!agentSupportsExecutionTransport(canonicalAgent, request.target.transport)) {
    throw new ExecutionCoordinatorError(
      "INVALID_BINDING_REQUEST",
      `${canonicalAgent} does not support fenced ${request.target.transport} execution`,
    );
  }
  if (request.protocolVersion !== FENCED_EXECUTION_PROTOCOL_VERSION) {
    throw new ExecutionCoordinatorError(
      "INVALID_BINDING_REQUEST",
      `Unsupported fenced execution protocol version ${request.protocolVersion}`,
    );
  }
  const missing = FENCED_RUNTIME_CAPABILITIES.filter(
    (capability) => !request.requiredCapabilities.includes(capability),
  );
  if (missing.length > 0) {
    throw new ExecutionCoordinatorError(
      "RUNTIME_CAPABILITY_MISMATCH",
      `Fenced execution request omits required capabilities: ${missing.join(", ")}`,
    );
  }
}

function validateReadyBinding(request: EnsureBindingRequest, binding: ReadyBinding): void {
  const invalid =
    binding.conversationId !== request.target.conversationId ||
    binding.epoch !== request.target.epoch ||
    binding.requestedAgent !== request.target.requestedAgent ||
    binding.actualAgent !== request.target.requestedAgent ||
    binding.transport !== request.target.transport ||
    binding.ownerDeviceId !== request.ownerDeviceId ||
    binding.daemonBootId !== request.daemonBootId ||
    binding.appliedConfigurationRevision !== request.configuration.revision ||
    binding.protocolVersion !== request.protocolVersion ||
    !binding.handle ||
    !binding.runtimeId ||
    !binding.operationId;
  if (invalid) {
    throw new ExecutionCoordinatorError(
      "BINDING_FENCE_MISMATCH",
      "Ready binding does not exactly match its immutable execution request",
    );
  }
  const missing = request.requiredCapabilities.filter(
    (capability) => !binding.capabilities.includes(capability),
  );
  if (missing.length > 0) {
    throw new ExecutionCoordinatorError(
      "RUNTIME_CAPABILITY_MISMATCH",
      `Ready runtime omits required capabilities: ${missing.join(", ")}`,
    );
  }
}

function validateRuntimeHandle(
  request: EnsureBindingRequest,
  driver: RuntimeDriver,
  handle: RuntimeHandle,
): void {
  if (
    !handle.runtimeId ||
    !handle.handle ||
    handle.actualAgent !== request.target.requestedAgent ||
    handle.transport !== request.target.transport ||
    handle.transport !== driver.transport
  ) {
    throw new ExecutionCoordinatorError(
      "BINDING_FENCE_MISMATCH",
      "Runtime driver returned a handle for a different agent or transport",
    );
  }
  const missing = request.requiredCapabilities.filter(
    (capability) => !handle.capabilities.includes(capability),
  );
  if (missing.length > 0) {
    throw new ExecutionCoordinatorError(
      "RUNTIME_CAPABILITY_MISMATCH",
      `Runtime handle omits required capabilities: ${missing.join(", ")}`,
    );
  }
}

export class ExecutionCoordinator {
  private readonly controlPlane: ExecutionControlPlane;
  private readonly drivers: RuntimeDriverRegistry;
  private readonly journal: ExecutionOperationJournal;
  private readonly operationIdFactory: () => string;
  private readonly now: () => number;
  private readonly defaultDeliveryTimeoutMs: number;
  private readonly completedAttemptCacheSize: number;

  private readonly bindingFlights = new Map<string, BindingFlight>();
  private readonly activeDeliveries = new Map<string, ActiveDelivery>();
  private readonly completedAttempts = new Map<string, CompletedAttempt>();

  constructor(options: ExecutionCoordinatorOptions) {
    this.controlPlane = options.controlPlane;
    this.drivers = options.drivers instanceof RuntimeDriverRegistry
      ? options.drivers
      : new RuntimeDriverRegistry(options.drivers);
    this.journal = options.journal;
    this.operationIdFactory = options.operationIdFactory ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.defaultDeliveryTimeoutMs = options.defaultDeliveryTimeoutMs ?? 30_000;
    this.completedAttemptCacheSize = options.completedAttemptCacheSize ?? 10_000;
  }

  /**
   * One promise per `(conversation, epoch)`, installed before the first authority
   * call or driver await. Start commands and delivery wakeups call this exact method.
   */
  ensureBinding(request: EnsureBindingRequest): Promise<ReadyBinding> {
    validateBindingRequest(request);
    const key = bindingKey(request);
    const fingerprint = requestFingerprint(request);
    const existing = this.bindingFlights.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(
          new ExecutionCoordinatorError(
            "BINDING_REQUEST_CONFLICT",
            "Two immutable execution requests attempted to share one conversation epoch",
          ),
        );
      }
      return existing.promise;
    }

    // The microtask defers all authority/driver work until after the map entry exists.
    let promise!: Promise<ReadyBinding>;
    promise = Promise.resolve()
      .then(() => this.runEnsureBinding(request))
      .catch((error) => {
        // Only a durable, explicit proof that the start failed before any effect
        // may clear the local single-flight. Everything else remains sticky.
        let retryable = false;
        try {
          const record = this.journal.get(request.target.conversationId, request.target.epoch);
          retryable =
            error instanceof ExecutionCoordinatorError &&
            error.code === "START_FAILED_BEFORE_EFFECT" &&
            record?.phase === "start-failed-before-effect" &&
            record.failure?.retryable === true;
        } catch {
          // A corrupt/unreadable journal can never authorize another start.
        }
        if (retryable && this.bindingFlights.get(key)?.promise === promise) {
          this.bindingFlights.delete(key);
        }
        throw error;
      });
    this.bindingFlights.set(key, { fingerprint, promise });
    return promise;
  }

  getActiveDelivery(conversationId: string): ActiveDeliverySnapshot | undefined {
    const active = this.activeDeliveries.get(conversationId);
    return active ? { ...active.snapshot } : undefined;
  }

  private baseJournalRecord(
    request: EnsureBindingRequest,
    operationId: string,
  ): ExecutionJournalRecord {
    return {
      schemaVersion: EXECUTION_JOURNAL_SCHEMA_VERSION,
      target: request.target,
      configuration: request.configuration,
      ownerDeviceId: request.ownerDeviceId,
      daemonBootId: request.daemonBootId,
      requiredCapabilities: request.requiredCapabilities,
      protocolVersion: request.protocolVersion,
      operationId,
      phase: "claimed",
      updatedAt: this.now(),
    };
  }

  private transitionJournal(
    previous: ExecutionJournalRecord,
    phase: ExecutionJournalPhase,
    patch: Partial<Pick<ExecutionJournalRecord, "handle" | "binding" | "failure">> = {},
  ): ExecutionJournalRecord {
    const next: ExecutionJournalRecord = {
      ...previous,
      ...patch,
      phase,
      updatedAt: this.now(),
    };
    this.journal.record(next);
    return next;
  }

  private async publishStartAmbiguousBestEffort(input: {
    request: EnsureBindingRequest;
    operationId: string;
    failure: StructuredFailure;
    suspectedRuntimeId?: string;
  }): Promise<void> {
    try {
      await this.controlPlane.publishStartAmbiguous(input);
    } catch {
      // The sticky local flight + journal still forbid another runtime. Recovery
      // replays this evidence to the server; it must not convert to a safe retry.
    }
  }

  private withJournalFailure(
    failure: StructuredFailure,
    journalError: unknown,
  ): StructuredFailure {
    return {
      ...failure,
      details: {
        ...failure.details,
        journalError: journalError instanceof Error ? journalError.message : String(journalError),
      },
    };
  }

  private async publishStartFailedBeforeEffectBestEffort(input: {
    request: EnsureBindingRequest;
    operationId: string;
    failure: StructuredFailure;
  }): Promise<void> {
    try {
      await this.controlPlane.publishStartFailedBeforeEffect(input);
    } catch {
      // No external effect occurred. A later control-plane recovery can inspect
      // the same operation; this local flight remains sticky in the meantime.
    }
  }

  private async runEnsureBinding(request: EnsureBindingRequest): Promise<ReadyBinding> {
    const driver = this.drivers.resolve(request.target.requestedAgent, request.target.transport);
    const missingDriverCapabilities = request.requiredCapabilities.filter(
      (capability) => !driver.capabilities.includes(capability),
    );
    if (missingDriverCapabilities.length > 0) {
      throw new ExecutionCoordinatorError(
        "RUNTIME_CAPABILITY_MISMATCH",
        `Driver ${driver.id} omits required capabilities: ${missingDriverCapabilities.join(", ")}`,
      );
    }

    let journal: ExecutionJournalRecord | undefined;
    try {
      journal = this.journal.get(request.target.conversationId, request.target.epoch);
    } catch (error) {
      const proposedOperationId = this.operationIdFactory();
      let operationId = proposedOperationId;
      try {
        const claim = await this.controlPlane.claimStart({ ...request, proposedOperationId });
        if (claim.state === "claimed" || claim.state === "busy") {
          operationId = claim.operationId ?? operationId;
        }
      } catch {
        // The local corruption is already sufficient to fail closed. If the
        // authority is also unavailable, recovery will retry the report later.
      }
      const failure = structuredFailure("LOCAL_START_JOURNAL_CORRUPT", error);
      await this.publishStartAmbiguousBestEffort({ request, operationId, failure });
      throw new ExecutionCoordinatorError("START_AMBIGUOUS", failure.message, failure);
    }

    // Recovery and safe pre-effect retry retain one durable operation identity.
    // A fresh random id is used only when this epoch has no local operation.
    const proposedOperationId = journal?.operationId ?? this.operationIdFactory();
    const claim = await this.controlPlane.claimStart({ ...request, proposedOperationId });
    if (claim.state === "ready") {
      validateReadyBinding(request, claim.binding);
      return claim.binding;
    }
    if (claim.state === "busy") {
      throw new ExecutionCoordinatorError("START_BUSY", claim.failure.message, claim.failure);
    }
    if (claim.state === "rejected") {
      throw new ExecutionCoordinatorError("START_REJECTED", claim.failure.message, claim.failure);
    }
    if (!claim.operationId) {
      throw new ExecutionCoordinatorError(
        "START_REJECTED",
        "Server returned a start claim without an operation id",
      );
    }

    if (journal && journal.operationId !== claim.operationId) {
      const failure: StructuredFailure = {
        code: "LOCAL_OPERATION_ID_CONFLICT",
        message: `Local operation ${journal.operationId} conflicts with claimed operation ${claim.operationId}`,
      };
      await this.publishStartAmbiguousBestEffort({
        request,
        operationId: claim.operationId,
        failure,
      });
      throw new ExecutionCoordinatorError("START_AMBIGUOUS", failure.message, failure);
    }
    const journalWasPresent = journal !== undefined;
    const requestWithoutBoot = JSON.stringify({
      target: request.target,
      configuration: request.configuration,
      ownerDeviceId: request.ownerDeviceId,
      requiredCapabilities: [...request.requiredCapabilities].sort(),
      protocolVersion: request.protocolVersion,
    });
    if (journal && journalRequestFingerprint(journal) !== requestWithoutBoot) {
      const failure: StructuredFailure = {
        code: "LOCAL_EXECUTION_REQUEST_CONFLICT",
        message: "Local journal target, configuration, owner, or daemon boot differs from the claimed execution",
      };
      await this.publishStartAmbiguousBestEffort({
        request,
        operationId: claim.operationId,
        failure,
      });
      throw new ExecutionCoordinatorError("START_AMBIGUOUS", failure.message, failure);
    }
    if (journal && journal.daemonBootId !== request.daemonBootId) {
      const recovery = claim.recovery;
      const authorized =
        recovery.state === "recovering" &&
        recovery.previousBootTerminated === true &&
        recovery.previousDaemonBootId === journal.daemonBootId;
      if (!authorized) {
        const failure: StructuredFailure = {
          code: "DAEMON_BOOT_RECOVERY_NOT_AUTHORIZED",
          message: `Journal belongs to daemon boot ${journal.daemonBootId}; current boot ${request.daemonBootId} has no termination proof`,
        };
        await this.publishStartAmbiguousBestEffort({
          request,
          operationId: claim.operationId,
          failure,
        });
        throw new ExecutionCoordinatorError("START_AMBIGUOUS", failure.message, failure);
      }

      const priorBoot = journal.daemonBootId;
      const transferred = {
        ...journal,
        daemonBootId: request.daemonBootId,
        updatedAt: this.now(),
      };
      try {
        this.journal.record(transferred, {
          bootTransfer: {
            fromDaemonBootId: priorBoot,
            toDaemonBootId: request.daemonBootId,
            previousBootTerminated: true,
          },
        });
        journal = transferred;
      } catch (error) {
        const failure = structuredFailure("DAEMON_BOOT_RECOVERY_JOURNAL_FAILED", error);
        await this.publishStartAmbiguousBestEffort({
          request,
          operationId: claim.operationId,
          failure,
        });
        throw new ExecutionCoordinatorError("START_AMBIGUOUS", failure.message, failure);
      }
    }
    if (!journal) {
      journal = this.baseJournalRecord(request, claim.operationId);
      try {
        this.journal.record(journal);
      } catch (error) {
        const failure = structuredFailure("LOCAL_START_JOURNAL_FAILED_BEFORE_EFFECT", error);
        await this.publishStartFailedBeforeEffectBestEffort({
          request,
          operationId: claim.operationId,
          failure,
        });
        throw new ExecutionCoordinatorError(
          "START_FAILED_BEFORE_EFFECT",
          failure.message,
          failure,
        );
      }
    }

    const retryingBeforeEffect =
      journal.phase === "start-failed-before-effect" && journal.failure?.retryable === true;
    if (
      journalWasPresent &&
      claim.recovery.state === "fresh" &&
      journal.phase !== "claimed" &&
      !retryingBeforeEffect
    ) {
      const failure: StructuredFailure = {
        code: "FRESH_CLAIM_CONFLICTS_WITH_LOCAL_EFFECT_EVIDENCE",
        message: `Server returned a fresh claim but the local operation is already ${journal.phase}`,
      };
      await this.publishStartAmbiguousBestEffort({
        request,
        operationId: claim.operationId,
        failure,
      });
      throw new ExecutionCoordinatorError("START_AMBIGUOUS", failure.message, failure);
    }

    if (journal.phase === "start-failed-before-effect" && !retryingBeforeEffect) {
      throw new ExecutionCoordinatorError(
        "START_FAILED_BEFORE_EFFECT",
        journal.failure?.message ?? "Prior start failed before effect",
        journal.failure,
      );
    }
    if (journal.phase === "quarantined" || journal.phase === "stopped") {
      throw new ExecutionCoordinatorError(
        "START_AMBIGUOUS",
        `Journaled execution is ${journal.phase}; a successor epoch is required`,
        journal.failure,
      );
    }
    if (journal.phase === "ready" && journal.binding) {
      validateReadyBinding(request, journal.binding);
      return journal.binding;
    }

    let runtimeHandle: RuntimeHandle | undefined;
    const recovering =
      !retryingBeforeEffect &&
      (claim.recovery.state === "recovering" || journal.phase !== "claimed");
    if (recovering) {
      const adoption = await driver.adopt({
        ...request,
        operationId: claim.operationId,
        knownHandle: journal.handle,
      });
      if (adoption.state === "adopted") {
        runtimeHandle = adoption.handle;
      } else if (adoption.state !== "missing") {
        let failure = adoption.failure;
        try {
          journal = this.transitionJournal(journal, "start-ambiguous", { failure });
        } catch (error) {
          failure = this.withJournalFailure(failure, error);
        }
        await this.publishStartAmbiguousBestEffort({
          request,
          operationId: claim.operationId,
          failure,
        });
        throw new ExecutionCoordinatorError("START_AMBIGUOUS", failure.message, failure);
      }
    }

    if (!runtimeHandle) {
      try {
        journal = this.transitionJournal(journal, "effect-requested", {
          handle: undefined,
          binding: undefined,
          failure: undefined,
        });
      } catch (error) {
        const failure = structuredFailure("LOCAL_EFFECT_JOURNAL_FAILED_BEFORE_EFFECT", error);
        await this.publishStartFailedBeforeEffectBestEffort({
          request,
          operationId: claim.operationId,
          failure,
        });
        throw new ExecutionCoordinatorError(
          "START_FAILED_BEFORE_EFFECT",
          failure.message,
          failure,
        );
      }
      let result;
      try {
        result = await driver.start({ ...request, operationId: claim.operationId });
      } catch (error) {
        result = {
          state: "ambiguous" as const,
          failure: structuredFailure("RUNTIME_DRIVER_START_THROW", error),
        };
      }
      if (result.state === "failed-before-effect") {
        let failure = result.failure;
        try {
          journal = this.transitionJournal(journal, "start-failed-before-effect", {
            failure,
          });
        } catch (error) {
          failure = this.withJournalFailure(failure, error);
        }
        await this.publishStartFailedBeforeEffectBestEffort({
          request,
          operationId: claim.operationId,
          failure,
        });
        throw new ExecutionCoordinatorError(
          "START_FAILED_BEFORE_EFFECT",
          failure.message,
          failure,
        );
      }
      if (result.state === "ambiguous") {
        let failure = result.failure;
        try {
          journal = this.transitionJournal(journal, "start-ambiguous", {
            failure,
          });
        } catch (error) {
          failure = this.withJournalFailure(failure, error);
        }
        await this.publishStartAmbiguousBestEffort({
          request,
          operationId: claim.operationId,
          failure,
          suspectedRuntimeId: result.suspectedRuntimeId,
        });
        throw new ExecutionCoordinatorError("START_AMBIGUOUS", failure.message, failure);
      }
      runtimeHandle = result.handle;
    }

    try {
      validateRuntimeHandle(request, driver, runtimeHandle);
    } catch (error) {
      const failure = structuredFailure("RUNTIME_HANDLE_FENCE_MISMATCH", error);
      const unsafeBinding = this.bindingFromHandle(request, claim.operationId, runtimeHandle);
      try {
        await driver.quarantine(unsafeBinding, failure.message);
      } catch {
        // Server state below remains ambiguous even if physical quarantine failed.
      }
      try {
        journal = this.transitionJournal(journal, "start-ambiguous", { failure });
      } catch (error) {
        Object.assign(failure, this.withJournalFailure(failure, error));
      }
      await this.publishStartAmbiguousBestEffort({
        request,
        operationId: claim.operationId,
        failure,
        suspectedRuntimeId: runtimeHandle.runtimeId,
      });
      throw new ExecutionCoordinatorError("START_AMBIGUOUS", failure.message, failure);
    }

    const binding = this.bindingFromHandle(request, claim.operationId, runtimeHandle);
    validateReadyBinding(request, binding);
    try {
      journal = this.transitionJournal(journal, "handle-recorded", {
        handle: runtimeHandle,
        failure: undefined,
      });
    } catch (error) {
      const failure = structuredFailure("LOCAL_RUNTIME_HANDLE_JOURNAL_FAILED", error);
      try {
        await driver.quarantine(binding, failure.message);
      } catch (quarantineError) {
        failure.details = {
          quarantineError: quarantineError instanceof Error
            ? quarantineError.message
            : String(quarantineError),
        };
      }
      await this.publishStartAmbiguousBestEffort({
        request,
        operationId: claim.operationId,
        failure,
        suspectedRuntimeId: binding.runtimeId,
      });
      throw new ExecutionCoordinatorError("START_AMBIGUOUS", failure.message, failure);
    }

    let accepted = false;
    try {
      accepted = (await this.controlPlane.publishReady(binding)).accepted;
    } catch {
      // A lost response is not permission to publish or create another runtime.
    }
    if (!accepted) {
      const failure: StructuredFailure = {
        code: "STALE_READY_PUBLICATION",
        message: "Server rejected or could not confirm the completed runtime binding",
      };
      try {
        await driver.quarantine(binding, failure.message);
      } catch (error) {
        failure.details = {
          quarantineError: error instanceof Error ? error.message : String(error),
        };
      }
      try {
        journal = this.transitionJournal(journal, "quarantined", { binding, failure });
      } catch (error) {
        Object.assign(failure, this.withJournalFailure(failure, error));
      }
      await this.publishStartAmbiguousBestEffort({
        request,
        operationId: claim.operationId,
        failure,
        suspectedRuntimeId: binding.runtimeId,
      });
      throw new ExecutionCoordinatorError("STALE_START_COMPLETION", failure.message, failure);
    }

    try {
      this.transitionJournal(journal, "ready", { binding, handle: runtimeHandle });
    } catch {
      // Convex accepted the exact boot/epoch/runtime binding and handle-recorded
      // is already durable. Recovery can adopt it; do not misreport a safe ready
      // runtime as a failed start or create another one.
    }
    return binding;
  }

  private bindingFromHandle(
    request: EnsureBindingRequest,
    operationId: string,
    handle: RuntimeHandle,
  ): ReadyBinding {
    return {
      conversationId: request.target.conversationId,
      epoch: request.target.epoch,
      requestedAgent: request.target.requestedAgent,
      actualAgent: handle.actualAgent,
      transport: handle.transport,
      handle: handle.handle,
      ownerDeviceId: request.ownerDeviceId,
      daemonBootId: request.daemonBootId,
      runtimeId: handle.runtimeId,
      operationId,
      appliedConfigurationRevision: request.configuration.revision,
      protocolVersion: request.protocolVersion,
      capabilities: handle.capabilities,
    };
  }

  async deliver(request: DeliverFencedRequest): Promise<DeliveryOutcome> {
    if (
      request.permit.state !== "delivery-started" ||
      !deliveryMatchesPermit(request.delivery, request.permit)
    ) {
      throw new ExecutionCoordinatorError(
        "BINDING_FENCE_MISMATCH",
        "Delivery identity requires a matching started server permit",
      );
    }

    const signature = permitSignature(request.permit);
    let completed = this.completedAttempts.get(request.permit.attemptId);
    if (completed) {
      if (completed.signature !== signature) {
        throw new ExecutionCoordinatorError(
          "BINDING_FENCE_MISMATCH",
          "Attempt id was reused with a different delivery fence",
        );
      }
      return completed.outcome;
    }

    let existing = this.activeDeliveries.get(request.permit.conversationId);
    if (existing) {
      if (existing.snapshot.attemptId === request.permit.attemptId && existing.signature === signature) {
        return existing.publicPromise;
      }
      throw new ExecutionCoordinatorError(
        "DELIVERY_SLOT_BUSY",
        `Conversation delivery slot is held by attempt ${existing.snapshot.attemptId}`,
      );
    }

    // Do not even initialize a replacement binding while an earlier attempt owns
    // the conversation slot. The server is authoritative, but this local check
    // prevents an invalid/stale caller from turning a delivery wake into a start.
    const binding = await this.ensureBinding(request.binding);
    if (!readyBindingMatchesPermit(binding, request.permit)) {
      throw new ExecutionCoordinatorError(
        "BINDING_FENCE_MISMATCH",
        "Delivery requires a ready binding matching the started server permit",
      );
    }

    // The binding await can race another local caller; recheck both caches before
    // publishing a new driver effect.
    completed = this.completedAttempts.get(request.permit.attemptId);
    if (completed) {
      if (completed.signature !== signature) {
        throw new ExecutionCoordinatorError(
          "BINDING_FENCE_MISMATCH",
          "Attempt id was reused with a different delivery fence",
        );
      }
      return completed.outcome;
    }
    existing = this.activeDeliveries.get(request.permit.conversationId);
    if (existing) {
      if (existing.snapshot.attemptId === request.permit.attemptId && existing.signature === signature) {
        return existing.publicPromise;
      }
      throw new ExecutionCoordinatorError(
        "DELIVERY_SLOT_BUSY",
        `Conversation delivery slot is held by attempt ${existing.snapshot.attemptId}`,
      );
    }

    const timeoutMs = request.timeoutMs ?? this.defaultDeliveryTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("Delivery timeout must be positive");
    }
    const driver = this.drivers.resolve(binding.requestedAgent, binding.transport);
    let resolvePublic!: (outcome: DeliveryOutcome) => void;
    const publicPromise = new Promise<DeliveryOutcome>((resolve) => {
      resolvePublic = resolve;
    });
    const active: ActiveDelivery = {
      signature,
      snapshot: {
        conversationId: binding.conversationId,
        attemptId: request.permit.attemptId,
        deliveryId: request.permit.deliveryId,
        runtimeId: binding.runtimeId,
        state: "running",
      },
      publicPromise,
      resolvePublic,
      publicSettled: false,
      ambiguityReported: false,
      timeout: undefined as unknown as ReturnType<typeof setTimeout>,
      controlChain: Promise.resolve(),
    };

    active.timeout = setTimeout(() => {
      const failure: StructuredFailure = {
        code: "DELIVERY_TIMEOUT_AMBIGUOUS",
        message: `Delivery attempt ${request.permit.attemptId} did not settle within ${timeoutMs}ms`,
      };
      void this.reportDeliveryAmbiguous(active, request.permit, { state: "ambiguous", failure });
    }, timeoutMs);

    // Publish the slot before the driver microtask can perform an external effect.
    this.activeDeliveries.set(binding.conversationId, active);
    void Promise.resolve().then(() =>
      this.runDelivery(active, driver, binding, request.permit, request.delivery),
    );
    return publicPromise;
  }

  private settlePublic(active: ActiveDelivery, outcome: DeliveryOutcome): void {
    if (active.publicSettled) return;
    active.publicSettled = true;
    active.resolvePublic(outcome);
  }

  private enqueueControl(active: ActiveDelivery, work: () => Promise<void>): Promise<void> {
    const action = active.controlChain.then(work);
    active.controlChain = action.catch(() => {});
    return action;
  }

  private async reportDeliveryAmbiguous(
    active: ActiveDelivery,
    permit: StartedDeliveryPermit,
    outcome: Extract<DeliveryOutcome, { state: "ambiguous" }>,
  ): Promise<void> {
    if (this.activeDeliveries.get(permit.conversationId) !== active) return;
    active.snapshot.state = "ambiguous";
    if (active.ambiguityReported) {
      this.settlePublic(active, outcome);
      return;
    }
    active.ambiguityReported = true;
    // Surface the honest local state immediately even if the control-plane write
    // is unavailable. The slot remains held and the queued write still fences any
    // late terminal result before it can release that slot.
    this.settlePublic(active, outcome);
    try {
      await this.enqueueControl(active, () =>
        this.controlPlane.markDeliveryAmbiguous({ permit, outcome }),
      );
    } catch {
      // Never turn a failed ambiguity write into permission to retry.
    }
    // Deliberately retain the slot. Only a late terminal result in this process,
    // or future server-authorized ambiguity resolution, may release it.
  }

  private async runDelivery(
    active: ActiveDelivery,
    driver: RuntimeDriver,
    binding: ReadyBinding,
    permit: StartedDeliveryPermit,
    delivery: DeliverFencedRequest["delivery"],
  ): Promise<void> {
    let result: DriverDeliveryResult;
    try {
      result = await driver.deliver({ binding, permit, delivery });
    } catch (error) {
      result = {
        state: "ambiguous",
        failure: structuredFailure("RUNTIME_DRIVER_DELIVERY_THROW", error),
      };
    }
    clearTimeout(active.timeout);

    if (result.state === "ambiguous") {
      await this.reportDeliveryAmbiguous(active, permit, result);
      return;
    }

    try {
      await active.controlChain;
      if (result.state === "delivered") {
        await this.enqueueControl(active, () =>
          this.controlPlane.completeDelivery({ permit, outcome: result }),
        );
      } else {
        await this.enqueueControl(active, () =>
          this.controlPlane.failDeliveryBeforeEffect({ permit, outcome: result }),
        );
      }
    } catch (error) {
      await this.reportDeliveryAmbiguous(active, permit, {
        state: "ambiguous",
        failure: structuredFailure("DELIVERY_TERMINAL_WRITE_AMBIGUOUS", error),
      });
      return;
    }

    if (this.activeDeliveries.get(permit.conversationId) === active) {
      this.activeDeliveries.delete(permit.conversationId);
    }
    this.rememberCompleted(permit.attemptId, active.signature, result);
    this.settlePublic(active, result);
  }

  private rememberCompleted(
    attemptId: string,
    signature: string,
    outcome: Exclude<DeliveryOutcome, { state: "ambiguous" }>,
  ): void {
    this.completedAttempts.set(attemptId, { signature, outcome });
    while (this.completedAttempts.size > this.completedAttemptCacheSize) {
      const oldest = this.completedAttempts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.completedAttempts.delete(oldest);
    }
  }
}
