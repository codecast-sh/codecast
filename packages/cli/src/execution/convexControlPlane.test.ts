import { describe, expect, test } from "bun:test";
import {
  FENCED_RUNTIME_CAPABILITIES,
  type ReadyBinding,
} from "@codecast/shared/contracts";
import { SyncService } from "../syncService.js";
import {
  ConvexExecutionControlPlane,
  type ExecutionConvexTransport,
} from "./convexControlPlane.js";
import type { ClaimStartRequest } from "./controlPlane.js";

function request(): ClaimStartRequest {
  return {
    target: {
      conversationId: "conversation-1",
      epoch: 2,
      requestedAgent: "codex",
      transport: "app-server",
      projectPath: "/work/project",
    },
    configuration: { revision: 3, model: "gpt-5.4", effort: "high" },
    ownerDeviceId: "device-1",
    daemonBootId: "boot-1",
    requiredCapabilities: [...FENCED_RUNTIME_CAPABILITIES],
    protocolVersion: 1,
    trigger: "delivery",
    proposedOperationId: "operation-1",
  };
}

function ready(overrides: Partial<ReadyBinding> = {}): ReadyBinding {
  return {
    conversationId: "conversation-1",
    epoch: 2,
    requestedAgent: "codex",
    actualAgent: "codex",
    transport: "app-server",
    handle: "thread-1",
    ownerDeviceId: "device-1",
    daemonBootId: "boot-1",
    runtimeId: "thread-1",
    operationId: "operation-1",
    appliedConfigurationRevision: 3,
    protocolVersion: 1,
    capabilities: [...FENCED_RUNTIME_CAPABILITIES],
    ...overrides,
  };
}

function fakeTransport(response: unknown) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const transport: ExecutionConvexTransport = {
    async executionControlMutation(name, args) {
      calls.push({ name, args });
      return response;
    },
    async executionControlQuery() { return null; },
  };
  return { transport, calls };
}

describe("ConvexExecutionControlPlane", () => {
  test("maps the immutable start fence and strictly parses a ready binding", async () => {
    const { transport, calls } = fakeTransport({ state: "ready", binding: ready() });
    const control = new ConvexExecutionControlPlane(transport);
    const claim = await control.claimStart(request());
    if (claim.state !== "ready") throw new Error("expected ready binding");
    const { capabilities: _capabilities, ...expectedBinding } = ready();
    expect(claim.binding).toMatchObject(expectedBinding);
    expect(new Set(claim.binding.capabilities)).toEqual(new Set(FENCED_RUNTIME_CAPABILITIES));
    expect(calls[0]).toEqual({
      name: "claimExecutionStart",
      args: {
        conversation_id: "conversation-1",
        epoch: 2,
        owner_device_id: "device-1",
        daemon_boot_id: "boot-1",
        configuration_revision: 3,
        protocol_version: 1,
        required_capabilities: [...FENCED_RUNTIME_CAPABILITIES],
        proposed_operation_id: "operation-1",
      },
    });
  });

  test("malformed or cross-agent ready responses fail closed", async () => {
    const { transport } = fakeTransport({
      state: "ready",
      binding: ready({ actualAgent: "claude" }),
    });
    await expect(new ConvexExecutionControlPlane(transport).claimStart(request())).rejects.toThrow(
      "actualAgent must equal requestedAgent",
    );
  });

  test("claim and start are two exact server transitions", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const permit = {
      messageId: "message-1",
      deliveryId: "delivery-1",
      conversationSequence: "8",
      attemptId: "attempt-1",
      conversationId: "conversation-1",
      executionEpoch: 2,
      configurationRevision: 3,
      ownerDeviceId: "device-1",
      daemonBootId: "boot-1",
      runtimeId: "thread-1",
    };
    const transport: ExecutionConvexTransport = {
      async executionControlMutation(name, args) {
        calls.push({ name, args });
        if (name === "claimNextDelivery") {
          return {
            state: "claimed",
            permit: { state: "claimed", ...permit },
            message: { content: "hello" },
          };
        }
        if (name === "startDelivery") return { state: "delivery-started", ...permit };
        throw new Error(`unexpected ${name}`);
      },
      async executionControlQuery() { return null; },
    };
    const control = new ConvexExecutionControlPlane(transport);
    const claimed = await control.claimNextDelivery(ready());
    expect("permit" in claimed).toBe(true);
    if (!("permit" in claimed)) throw new Error("expected claim");
    expect((await control.startDelivery(claimed.permit)).state).toBe("delivery-started");
    expect(calls.map((call) => call.name)).toEqual(["claimNextDelivery", "startDelivery"]);
    expect((calls[1].args.permit as any).state).toBeUndefined();
  });
});

describe("SyncService execution authority transport", () => {
  test("requires an explicit daemon token before any network request", async () => {
    const sync = new SyncService({ convexUrl: "http://localhost:0" });
    await expect(sync.executionControlQuery("getExecutionAuthority", {
      conversation_id: "conversation-1",
    })).rejects.toThrow("requires the daemon API token");
  });

  test("injects the explicit token into the exact execution mutation", async () => {
    const sync = new SyncService({ convexUrl: "http://localhost:0", authToken: "daemon-token" });
    let captured: unknown;
    (sync as any).client.mutation = async (name: unknown, args: unknown, options: unknown) => {
      captured = { name, args, options };
      return { accepted: true };
    };
    await sync.executionControlMutation("publishReadyBinding", { conversation_id: "c" });
    expect(captured).toEqual({
      name: "executionBindings:publishReadyBinding",
      args: { conversation_id: "c", api_token: "daemon-token" },
      options: { skipQueue: true },
    });
  });
});
