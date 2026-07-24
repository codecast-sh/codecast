import {
  FENCED_RUNTIME_CAPABILITIES,
  type RuntimeCapability,
} from "@codecast/shared/contracts";
import { assertRuntimeDeliveryFence, type RuntimeDriver } from "../driver.js";
import type {
  DriverDeliveryResult,
  RuntimeAdoptionRequest,
  RuntimeAdoptionResult,
  RuntimeDeliveryRequest,
  RuntimeStartRequest,
  RuntimeStartResult,
} from "../types.js";
import { structuredFailure } from "../types.js";

interface CodexThreadStartResponse {
  thread: { id: string };
}

export interface CodexAppServerClient {
  threadStart(params: {
    cwd: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
    model?: string;
    config?: Record<string, unknown>;
  }): Promise<CodexThreadStartResponse>;
  turnStart(params: {
    threadId: string;
    input: Array<
      | { type: "text"; text: string }
      | { type: "localImage"; path: string }
    >;
    model?: string;
    cwd?: string;
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  }): Promise<unknown>;
}

export interface CodexAppServerIo {
  client: CodexAppServerClient;
  registerThread?(input: {
    conversationId: string;
    threadId: string;
    cwd: string;
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  }): void;
  inspectThread(threadId: string): Promise<"alive" | "missing" | "unknown">;
  stopThread(threadId: string): Promise<void>;
  quarantineThread(threadId: string, reason: string): Promise<void>;
}

export interface CodexAppServerRuntimeDriverOptions {
  io: CodexAppServerIo;
  capabilities?: readonly RuntimeCapability[];
}

export class CodexAppServerRuntimeDriver implements RuntimeDriver {
  readonly id = "codex-app-server-v1";
  readonly transport = "app-server" as const;
  readonly supportedAgents = new Set(["codex"] as const);
  readonly capabilities: readonly RuntimeCapability[];

  private readonly io: CodexAppServerIo;

  constructor(options: CodexAppServerRuntimeDriverOptions) {
    this.io = options.io;
    this.capabilities = options.capabilities ?? [...FENCED_RUNTIME_CAPABILITIES];
  }

  async start(request: RuntimeStartRequest): Promise<RuntimeStartResult> {
    if (request.target.requestedAgent !== "codex" || request.target.transport !== "app-server") {
      return {
        state: "failed-before-effect",
        failure: {
          code: "CODEX_APP_SERVER_TARGET_UNSUPPORTED",
          message: `Codex app-server does not support ${request.target.requestedAgent}/${request.target.transport}`,
        },
      };
    }
    try {
      const response = await this.io.client.threadStart({
        cwd: request.target.projectPath,
        sandbox: request.target.isolation?.sandbox,
        approvalPolicy: request.target.isolation?.approvalPolicy,
        model: request.configuration.model,
        ...(request.configuration.effort
          ? { config: { model_reasoning_effort: request.configuration.effort } }
          : {}),
      });
      const threadId = response?.thread?.id;
      if (typeof threadId !== "string" || threadId.length === 0) {
        throw new Error("thread/start returned no thread id");
      }
      this.io.registerThread?.({
        conversationId: request.target.conversationId,
        threadId,
        cwd: request.target.projectPath,
        approvalPolicy: request.target.isolation?.approvalPolicy,
      });
      return {
        state: "started",
        handle: {
          runtimeId: threadId,
          handle: threadId,
          actualAgent: "codex",
          transport: "app-server",
          capabilities: this.capabilities,
        },
      };
    } catch (error) {
      // JSON-RPC request failure/timeout cannot prove thread creation did not occur.
      return {
        state: "ambiguous",
        failure: structuredFailure("CODEX_THREAD_START_AMBIGUOUS", error),
      };
    }
  }

  async adopt(request: RuntimeAdoptionRequest): Promise<RuntimeAdoptionResult> {
    const handle = request.knownHandle;
    if (!handle) {
      return {
        state: "unknown",
        failure: {
          code: "CODEX_THREAD_HANDLE_UNKNOWN",
          message: "A recovering Codex start has no durably journaled thread handle",
        },
      };
    }
    if (
      handle.actualAgent !== "codex" ||
      handle.transport !== "app-server" ||
      handle.runtimeId !== handle.handle
    ) {
      return {
        state: "conflict",
        failure: {
          code: "CODEX_THREAD_HANDLE_MISMATCH",
          message: "Journaled handle is not an exact Codex app-server runtime",
        },
        conflictingHandles: [handle.handle],
      };
    }
    try {
      const state = await this.io.inspectThread(handle.handle);
      if (state === "alive") return { state: "adopted", handle };
      if (state === "missing") return { state: "missing" };
      return {
        state: "unknown",
        failure: {
          code: "CODEX_THREAD_INSPECTION_UNKNOWN",
          message: "Codex app-server could not prove whether the journaled thread exists",
        },
      };
    } catch (error) {
      return {
        state: "unknown",
        failure: structuredFailure("CODEX_THREAD_INSPECTION_FAILED", error),
      };
    }
  }

  async deliver(request: RuntimeDeliveryRequest): Promise<DriverDeliveryResult> {
    assertRuntimeDeliveryFence(request);
    if (request.binding.actualAgent !== "codex" || request.binding.transport !== "app-server") {
      return {
        state: "failed-before-effect",
        failure: {
          code: "CODEX_APP_SERVER_BINDING_UNSUPPORTED",
          message: "Codex app-server received a binding for another driver",
        },
      };
    }
    try {
      await this.io.client.turnStart({
        threadId: request.binding.handle,
        input: request.delivery.input.map((item) =>
          item.type === "text"
            ? { type: "text" as const, text: item.text }
            : { type: "localImage" as const, path: item.path },
        ),
      });
      return { state: "delivered" };
    } catch (error) {
      // A failed/late RPC response does not prove the user turn was not accepted.
      return {
        state: "ambiguous",
        failure: structuredFailure("CODEX_TURN_START_AMBIGUOUS", error),
      };
    }
  }

  stop(binding: Parameters<RuntimeDriver["stop"]>[0]): Promise<void> {
    return this.io.stopThread(binding.handle);
  }

  quarantine(binding: Parameters<RuntimeDriver["quarantine"]>[0], reason: string): Promise<void> {
    return this.io.quarantineThread(binding.handle, reason);
  }
}
