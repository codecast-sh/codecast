import {
  FENCED_RUNTIME_CAPABILITIES,
  type AgentClientId,
  type Delivery,
  type ExecutionTargetSpec,
  type RuntimeCapability,
  type RuntimeConfiguration,
  type StructuredFailure,
} from "@codecast/shared/contracts";
import { assertRuntimeDeliveryFence, type RuntimeDriver } from "../driver.js";
import type {
  DriverDeliveryResult,
  RuntimeAdoptionRequest,
  RuntimeAdoptionResult,
  RuntimeDeliveryRequest,
  RuntimeHandle,
  RuntimeStartRequest,
  RuntimeStartResult,
} from "../types.js";
import { structuredFailure } from "../types.js";

export const FENCED_TMUX_TAG_NAMES = {
  protocolVersion: "@codecast_protocol_version",
  conversationId: "@codecast_conversation_id",
  executionEpoch: "@codecast_execution_epoch",
  runtimeId: "@codecast_runtime_id",
  operationId: "@codecast_operation_id",
  agent: "@codecast_agent_type",
  configurationRevision: "@codecast_configuration_revision",
  ownerDeviceId: "@codecast_owner_device_id",
  daemonBootId: "@codecast_daemon_boot_id",
  projectPath: "@codecast_project_path",
} as const;

export interface FencedTmuxTags {
  protocolVersion: string;
  conversationId: string;
  executionEpoch: string;
  runtimeId: string;
  operationId: string;
  agent: string;
  configurationRevision: string;
  ownerDeviceId: string;
  daemonBootId: string;
  projectPath: string;
}

export interface ManagedTmuxCandidate {
  tmuxSession: string;
  tmuxTarget: string;
  alive: boolean;
  tags: Partial<FencedTmuxTags>;
}

export interface ManagedTmuxLaunch {
  command: string;
}

/**
 * Narrow adapter over the daemon's existing tmux primitives. Implementations
 * must use argument arrays/literal send-keys; the driver controls ordering so all
 * fence tags are written before `launchLiteral` starts the agent executable.
 */
export interface ManagedTmuxIo {
  createSession(input: { tmuxSession: string; cwd: string }): Promise<void>;
  setSessionOption(input: {
    tmuxSession: string;
    name: string;
    value: string;
  }): Promise<void>;
  launchLiteral(input: { tmuxSession: string; command: string }): Promise<void>;
  /**
   * Return the complete live/dead candidate set for either the conversation tags
   * or the deterministic operation session name. The latter includes an untagged
   * shell left by a crash between `createSession` and the first tag write.
   */
  listCandidates(input: {
    conversationId: string;
    operationId: string;
    expectedTmuxSession: string;
  }): Promise<readonly ManagedTmuxCandidate[]>;
  injectDelivery(input: {
    tmuxTarget: string;
    agent: AgentClientId;
    delivery: Delivery;
  }): Promise<DriverDeliveryResult | void>;
  stopSession(tmuxSession: string): Promise<void>;
  quarantineSession(tmuxSession: string, reason: string): Promise<void>;
}

export interface ManagedTmuxRuntimeDriverOptions {
  io: ManagedTmuxIo;
  buildLaunch(target: ExecutionTargetSpec, configuration: RuntimeConfiguration): ManagedTmuxLaunch;
  supportedAgents?: readonly AgentClientId[];
  /** Must return the same runtime id whenever the same operation is recovered. */
  runtimeIdForOperation?: (request: RuntimeStartRequest) => string;
  sessionNameFactory?: (request: RuntimeStartRequest, runtimeId: string) => string;
  capabilities?: readonly RuntimeCapability[];
}

function defaultRuntimeId(request: RuntimeStartRequest): string {
  return `tmux-${request.operationId}`;
}

function defaultSessionName(request: RuntimeStartRequest, _runtimeId: string): string {
  const conversation = request.target.conversationId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-12) || "conversation";
  const operation = request.operationId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-24) || "operation";
  return `cc-f1-${request.target.requestedAgent}-${conversation}-e${request.target.epoch}-${operation}`;
}

export function buildFencedTmuxTags(
  request: RuntimeStartRequest,
  runtimeId: string,
): FencedTmuxTags {
  return {
    protocolVersion: String(request.protocolVersion),
    conversationId: request.target.conversationId,
    executionEpoch: String(request.target.epoch),
    runtimeId,
    operationId: request.operationId,
    agent: request.target.requestedAgent,
    configurationRevision: String(request.configuration.revision),
    ownerDeviceId: request.ownerDeviceId,
    daemonBootId: request.daemonBootId,
    projectPath: request.target.projectPath,
  };
}

export function exactFencedTmuxCandidateMatch(
  candidate: ManagedTmuxCandidate,
  request: RuntimeAdoptionRequest,
): boolean {
  if (!candidate.alive) return false;
  const expected = buildFencedTmuxTags(request, candidate.tags.runtimeId ?? "");
  return (
    typeof candidate.tags.runtimeId === "string" &&
    candidate.tags.runtimeId.length > 0 &&
    (Object.keys(expected) as Array<keyof FencedTmuxTags>).every(
      (key) => candidate.tags[key] === expected[key],
    )
  );
}

function candidateHandle(
  candidate: ManagedTmuxCandidate,
  agent: AgentClientId,
  capabilities: readonly RuntimeCapability[],
): RuntimeHandle {
  return {
    runtimeId: candidate.tags.runtimeId!,
    handle: candidate.tmuxTarget,
    actualAgent: agent,
    transport: "tmux",
    capabilities,
  };
}

function tmuxSessionFromHandle(handle: string): string {
  return handle.split(":", 1)[0] || handle;
}

export class ManagedTmuxRuntimeDriver implements RuntimeDriver {
  readonly id = "managed-tmux-v1";
  readonly transport = "tmux" as const;
  readonly supportedAgents: ReadonlySet<AgentClientId>;
  readonly capabilities: readonly RuntimeCapability[];

  private readonly io: ManagedTmuxIo;
  private readonly buildLaunch: ManagedTmuxRuntimeDriverOptions["buildLaunch"];
  private readonly runtimeIdForOperation: (request: RuntimeStartRequest) => string;
  private readonly sessionNameFactory: NonNullable<ManagedTmuxRuntimeDriverOptions["sessionNameFactory"]>;

  constructor(options: ManagedTmuxRuntimeDriverOptions) {
    this.io = options.io;
    this.buildLaunch = options.buildLaunch;
    this.supportedAgents = new Set(options.supportedAgents ?? ["claude", "codex", "cursor", "gemini", "opencode", "pi"]);
    this.runtimeIdForOperation = options.runtimeIdForOperation ?? defaultRuntimeId;
    this.sessionNameFactory = options.sessionNameFactory ?? defaultSessionName;
    this.capabilities = options.capabilities ?? [...FENCED_RUNTIME_CAPABILITIES];
  }

  async start(request: RuntimeStartRequest): Promise<RuntimeStartResult> {
    if (!this.supportedAgents.has(request.target.requestedAgent) || request.target.transport !== "tmux") {
      return {
        state: "failed-before-effect",
        failure: {
          code: "TMUX_TARGET_UNSUPPORTED",
          message: `Managed tmux does not support ${request.target.requestedAgent}/${request.target.transport}`,
        },
      };
    }

    let launch: ManagedTmuxLaunch;
    let runtimeId: string;
    let tmuxSession: string;
    try {
      launch = this.buildLaunch(request.target, request.configuration);
      runtimeId = this.runtimeIdForOperation(request);
      tmuxSession = this.sessionNameFactory(request, runtimeId);
      if (!launch.command || !runtimeId || !/^[a-zA-Z0-9_.:-]+$/.test(tmuxSession)) {
        throw new Error("launch command, runtime id, and safe tmux session name are required");
      }
    } catch (error) {
      return {
        state: "failed-before-effect",
        failure: structuredFailure("TMUX_START_VALIDATION_FAILED", error),
      };
    }

    const tags = buildFencedTmuxTags(request, runtimeId);
    try {
      await this.io.createSession({ tmuxSession, cwd: request.target.projectPath });
      for (const [key, name] of Object.entries(FENCED_TMUX_TAG_NAMES) as Array<[
        keyof FencedTmuxTags,
        string,
      ]>) {
        await this.io.setSessionOption({ tmuxSession, name, value: tags[key] });
      }
      await this.io.launchLiteral({ tmuxSession, command: launch.command });
    } catch (error) {
      return {
        state: "ambiguous",
        failure: structuredFailure("TMUX_START_AMBIGUOUS", error),
        suspectedRuntimeId: runtimeId,
      };
    }

    return {
      state: "started",
      handle: {
        runtimeId,
        handle: `${tmuxSession}:0.0`,
        actualAgent: request.target.requestedAgent,
        transport: "tmux",
        capabilities: this.capabilities,
      },
    };
  }

  async adopt(request: RuntimeAdoptionRequest): Promise<RuntimeAdoptionResult> {
    let candidates: readonly ManagedTmuxCandidate[];
    try {
      const expectedRuntimeId = request.knownHandle?.runtimeId ?? this.runtimeIdForOperation(request);
      candidates = await this.io.listCandidates({
        conversationId: request.target.conversationId,
        operationId: request.operationId,
        expectedTmuxSession: this.sessionNameFactory(request, expectedRuntimeId),
      });
    } catch (error) {
      return {
        state: "unknown",
        failure: structuredFailure("TMUX_INSPECTION_FAILED", error),
      };
    }
    const live = candidates.filter((candidate) => candidate.alive);
    const exact = live.filter((candidate) => exactFencedTmuxCandidateMatch(candidate, request));
    if (exact.length === 1) {
      return {
        state: "adopted",
        handle: candidateHandle(exact[0], request.target.requestedAgent, this.capabilities),
      };
    }
    if (exact.length > 1) {
      return {
        state: "conflict",
        failure: {
          code: "DUPLICATE_EXACT_TMUX_RUNTIMES",
          message: "More than one live tmux runtime has the exact same execution fence",
        },
        conflictingHandles: exact.map((candidate) => candidate.tmuxTarget),
      };
    }
    if (live.length > 0) {
      return {
        state: "conflict",
        failure: {
          code: "TMUX_TAG_MISMATCH",
          message: "Live tmux runtime candidates exist, but none has the exact execution fence",
        },
        conflictingHandles: live.map((candidate) => candidate.tmuxTarget),
      };
    }
    return { state: "missing" };
  }

  async deliver(request: RuntimeDeliveryRequest): Promise<DriverDeliveryResult> {
    assertRuntimeDeliveryFence(request);
    if (request.binding.transport !== "tmux" || !this.supportedAgents.has(request.binding.actualAgent)) {
      return {
        state: "failed-before-effect",
        failure: {
          code: "TMUX_BINDING_UNSUPPORTED",
          message: "Managed tmux received a binding for another driver",
        },
      };
    }
    try {
      return (
        (await this.io.injectDelivery({
          tmuxTarget: request.binding.handle,
          agent: request.binding.actualAgent,
          delivery: request.delivery,
        })) ?? { state: "delivered" }
      );
    } catch (error) {
      return {
        state: "ambiguous",
        failure: structuredFailure("TMUX_DELIVERY_AMBIGUOUS", error),
      };
    }
  }

  stop(binding: Parameters<RuntimeDriver["stop"]>[0]): Promise<void> {
    return this.io.stopSession(tmuxSessionFromHandle(binding.handle));
  }

  quarantine(binding: Parameters<RuntimeDriver["quarantine"]>[0], reason: string): Promise<void> {
    return this.io.quarantineSession(tmuxSessionFromHandle(binding.handle), reason);
  }
}
