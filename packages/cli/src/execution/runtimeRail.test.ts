import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  FENCED_RUNTIME_CAPABILITIES,
  type ReadyBinding,
} from "@codecast/shared/contracts";
import type { ExecutionConvexTransport } from "./convexControlPlane.js";
import type { RuntimeDriver } from "./driver.js";
import { InMemoryExecutionOperationJournal } from "./localJournal.js";
import {
  DaemonExecutionRuntime,
  assertLegacyDeliveryEnvelope,
  fencedExecutionEnabled,
  getProcessExecutionRuntime,
} from "./runtimeRail.js";

function binding(epoch = 1, daemonBootId = "boot-1"): ReadyBinding {
  return {
    conversationId: "conversation-1",
    epoch,
    requestedAgent: "codex",
    actualAgent: "codex",
    transport: "app-server",
    handle: "thread-1",
    ownerDeviceId: "device-1",
    daemonBootId,
    runtimeId: `thread-${epoch}`,
    operationId: `operation-${epoch}`,
    appliedConfigurationRevision: epoch,
    protocolVersion: 1,
    capabilities: [...FENCED_RUNTIME_CAPABILITIES],
  };
}

function requestWire(daemonBootId = "boot-1", epoch = 1) {
  return {
    target: {
      conversationId: "conversation-1",
      epoch,
      requestedAgent: "codex",
      transport: "app-server",
      projectPath: "/work/project",
    },
    configuration: { revision: epoch },
    ownerDeviceId: "device-1",
    daemonBootId,
    requiredCapabilities: [...FENCED_RUNTIME_CAPABILITIES],
    protocolVersion: 1,
    trigger: "recovery",
  };
}

function work(daemonBootMatch = true) {
  return [{
    conversationId: "conversation-1",
    currentEpoch: 1,
    bindings: [{
      state: "ready",
      daemonBootMatch,
      request: requestWire(daemonBootMatch ? "boot-1" : "old-boot"),
      binding: daemonBootMatch ? binding() : { ...binding(), daemonBootId: "old-boot" },
    }],
  }];
}

function fakeDriver(events: string[]): RuntimeDriver {
  return {
    id: "test-codex-app-server",
    transport: "app-server",
    supportedAgents: new Set(["codex"]),
    capabilities: [...FENCED_RUNTIME_CAPABILITIES],
    async start() { events.push("start"); throw new Error("ready binding must not start"); },
    async adopt() { return { state: "unknown", failure: { code: "NO", message: "no" } }; },
    async deliver() { events.push("deliver"); return { state: "delivered" }; },
    async stop() { events.push("stop"); },
    async quarantine() { events.push("quarantine"); },
  };
}

function recoveringTransport(initialWork: unknown, calls: string[]): ExecutionConvexTransport {
  let deliveryClaims = 0;
  return {
    async executionControlQuery(name, args) {
      calls.push(`query:${name}:${String(args.daemon_boot_id)}`);
      return initialWork;
    },
    async executionControlMutation(name) {
      calls.push(`mutation:${name}`);
      if (name === "registerExecutionDaemonBoot") return { registered: true };
      if (name === "claimExecutionStart") return { state: "ready", binding: binding() };
      if (name === "claimNextDelivery") {
        deliveryClaims += 1;
        if (deliveryClaims > 1) return { state: "empty" };
        const permit = {
          messageId: "message-1",
          deliveryId: "delivery-1",
          conversationSequence: "1",
          attemptId: "attempt-1",
          conversationId: "conversation-1",
          executionEpoch: 1,
          configurationRevision: 1,
          ownerDeviceId: "device-1",
          daemonBootId: "boot-1",
          runtimeId: "thread-1",
        };
        return {
          state: "claimed",
          permit: { state: "claimed", ...permit },
          message: { content: "recover me" },
        };
      }
      if (name === "startDelivery") {
        return {
          state: "delivery-started",
          messageId: "message-1",
          deliveryId: "delivery-1",
          conversationSequence: "1",
          attemptId: "attempt-1",
          conversationId: "conversation-1",
          executionEpoch: 1,
          configurationRevision: 1,
          ownerDeviceId: "device-1",
          daemonBootId: "boot-1",
          runtimeId: "thread-1",
        };
      }
      if (name === "completeDelivery") return { delivered: true };
      throw new Error(`unexpected mutation ${name}`);
    },
    subscribeExecutionControlQuery(name, args) {
      calls.push(`subscribe:${name}:${String(args.daemon_boot_id)}`);
      return () => calls.push("unsubscribe");
    },
  };
}

describe("fenced daemon runtime rail", () => {
  test("is explicitly off by default", () => {
    expect(fencedExecutionEnabled({})).toBe(false);
    expect(fencedExecutionEnabled({ CODECAST_FENCED_EXECUTION_V1: "true" })).toBe(false);
    expect(fencedExecutionEnabled({ CODECAST_FENCED_EXECUTION_V1: "1" })).toBe(true);
  });

  test("legacy choke rejects every fenced envelope marker", () => {
    expect(() => assertLegacyDeliveryEnvelope({ _id: "legacy" })).not.toThrow();
    for (const field of [
      "delivery_protocol_version",
      "delivery_id",
      "conversation_sequence",
      "execution_epoch",
      "delivery_status",
      "active_delivery_attempt_id",
    ]) {
      expect(() => assertLegacyDeliveryEnvelope({ [field]: field })).toThrow(
        "FENCED_MESSAGE_ON_LEGACY_DELIVERY_RAIL",
      );
    }
  });

  test("startup recovery drains durable work before subscribing", async () => {
    const calls: string[] = [];
    const events: string[] = [];
    const runtime = new DaemonExecutionRuntime({
      transport: recoveringTransport(work(), calls),
      ownerDeviceId: "device-1",
      daemonBootId: "boot-1",
      drivers: [fakeDriver(events)],
      journal: new InMemoryExecutionOperationJournal(),
    });
    await runtime.start();
    expect(events).toEqual(["deliver"]);
    expect(calls).toEqual([
      "mutation:registerExecutionDaemonBoot",
      "query:listExecutionWork:boot-1",
      "mutation:claimExecutionStart",
      "mutation:claimNextDelivery",
      "mutation:startDelivery",
      "mutation:completeDelivery",
      "mutation:claimNextDelivery",
      "subscribe:listExecutionWork:boot-1",
    ]);
    runtime.stop();
    expect(calls.at(-1)).toBe("unsubscribe");
  });

  test("a stale daemon boot routes through server recovery, never a driver or legacy fallback", async () => {
    // A binding stranded by a terminated boot is presented to the SERVER under
    // this boot's id — the server transfers it only to the device's registered
    // current boot. When the server refuses (this boot never registered), the
    // refusal is a hard claim rejection: no driver runs and nothing falls back
    // to the legacy rail.
    const events: string[] = [];
    const logs: string[] = [];
    const claims: Array<Record<string, unknown>> = [];
    const transport: ExecutionConvexTransport = {
      async executionControlQuery() { return []; },
      async executionControlMutation(name, args) {
        if (name === "claimExecutionStart") {
          claims.push(args);
          return {
            state: "rejected",
            failure: {
              code: "EXECUTION_BINDING_FENCE_MISMATCH",
              message: "daemon boot differs and is not the device's registered current boot",
            },
          };
        }
        throw new Error(`unexpected mutation ${name}`);
      },
    };
    const runtime = new DaemonExecutionRuntime({
      transport,
      ownerDeviceId: "device-1",
      daemonBootId: "boot-1",
      drivers: [fakeDriver(events)],
      journal: new InMemoryExecutionOperationJournal(),
      onLog: (message) => logs.push(message),
    });
    await expect(runtime.processWorkUpdate(work(false))).rejects.toThrow(
      "not the device's registered current boot",
    );
    // The recovery handshake presents OUR boot id, not the stranded binding's.
    expect(claims).toHaveLength(1);
    expect(claims[0].daemon_boot_id).toBe("boot-1");
    expect(events).toEqual([]);
    expect(logs.join("\n")).toContain("recovering conversation-1 epoch 1 from terminated daemon boot");
  });

  test("startup recovery completes activation after predecessor disposition committed", async () => {
    const calls: string[] = [];
    const events: string[] = [];
    const successor = binding(2);
    const transport: ExecutionConvexTransport = {
      async executionControlQuery() { return []; },
      async executionControlMutation(name) {
        calls.push(name);
        if (name === "claimExecutionStart") return { state: "ready", binding: successor };
        if (name === "activateExecutionSuccessor") return { activated: true };
        if (name === "claimNextDelivery") return { state: "empty" };
        throw new Error(`unexpected mutation ${name}`);
      },
    };
    const runtime = new DaemonExecutionRuntime({
      transport,
      ownerDeviceId: "device-1",
      daemonBootId: "boot-1",
      drivers: [fakeDriver(events)],
      journal: new InMemoryExecutionOperationJournal(),
    });

    await runtime.processWorkUpdate([{
      conversationId: "conversation-1",
      currentEpoch: 1,
      pendingEpoch: 2,
      pendingPolicy: "drain-current",
      bindings: [
        {
          state: "stopped",
          daemonBootMatch: false,
          request: requestWire("old-boot", 1),
          binding: binding(1, "old-boot"),
        },
        {
          state: "ready",
          daemonBootMatch: true,
          request: requestWire("boot-1", 2),
          binding: successor,
        },
      ],
    }]);

    expect(events).toEqual([]);
    expect(calls).toEqual([
      "claimExecutionStart",
      "activateExecutionSuccessor",
      "claimNextDelivery",
    ]);
  });

  test("rejects malformed isolation before selecting a driver", async () => {
    const runtime = new DaemonExecutionRuntime({
      transport: recoveringTransport([], []),
      ownerDeviceId: "device-1",
      daemonBootId: "boot-1",
      drivers: [fakeDriver([])],
      journal: new InMemoryExecutionOperationJournal(),
    });
    const malformed = work();
    (malformed[0].bindings[0].request.target as Record<string, unknown>).isolation = {
      sandbox: "everything-write",
      isolated: "yes",
    };
    expect(() => runtime.processWorkUpdate(malformed)).toThrow("unsupported value");
  });

  test("process factory owns exactly one coordinator, registry, journal, and boot", () => {
    const calls: string[] = [];
    const options = {
      transport: recoveringTransport([], calls),
      ownerDeviceId: "device-1",
      drivers: [fakeDriver([])],
      journal: new InMemoryExecutionOperationJournal(),
    };
    const first = getProcessExecutionRuntime(options);
    const second = getProcessExecutionRuntime(options);
    expect(second).toBe(first);
    expect(second.coordinator).toBe(first.coordinator);
    expect(second.drivers).toBe(first.drivers);
    expect(second.daemonBootId).toBe(first.daemonBootId);
    expect(first.daemonBootId.length).toBeGreaterThan(20);
  });

  test("static guard keeps the fenced service out of generic daemon delivery", () => {
    const executionSource = fs.readFileSync(path.join(import.meta.dir, "runtimeRail.ts"), "utf8");
    expect(executionSource).not.toContain("claimPendingMessageForDelivery(");
    expect(executionSource).not.toContain("deliverMessage(");
    expect(executionSource).not.toContain("updateMessageStatus(");

    const daemonSource = fs.readFileSync(path.join(import.meta.dir, "..", "daemon.ts"), "utf8");
    const guard = daemonSource.indexOf("assertLegacyDeliveryEnvelope(pendingMsg)");
    const legacyClaim = daemonSource.indexOf(
      "claimPendingMessageForDelivery(pendingMsg._id)",
      guard,
    );
    expect(guard).toBeGreaterThan(-1);
    expect(legacyClaim).toBeGreaterThan(guard);
  });
});
