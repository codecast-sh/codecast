import { describe, expect, test } from "bun:test";
import {
  FENCED_RUNTIME_CAPABILITIES,
  parseStartedDeliveryPermit,
  type ReadyBinding,
} from "@codecast/shared/contracts";
import type { RuntimeStartRequest } from "../types.js";
import {
  CodexAppServerRuntimeDriver,
  type CodexAppServerIo,
} from "./codexAppServer.js";

function startRequest(): RuntimeStartRequest {
  return {
    target: {
      conversationId: "conversation-1",
      epoch: 1,
      requestedAgent: "codex",
      transport: "app-server",
      projectPath: "/tmp/project",
    },
    configuration: { revision: 1 },
    ownerDeviceId: "device-1",
    daemonBootId: "boot-1",
    requiredCapabilities: [...FENCED_RUNTIME_CAPABILITIES],
    protocolVersion: 1,
    trigger: "start-session",
    operationId: "operation-1",
  };
}

function fakeIo(): CodexAppServerIo {
  return {
    client: {
      async threadStart() { return { thread: { id: "thread-1" } }; },
      async turnStart() {},
    },
    async inspectThread() { return "alive"; },
    async stopThread() {},
    async quarantineThread() {},
  };
}

describe("CodexAppServerRuntimeDriver", () => {
  test("a thread/start error is ambiguous, never a signal to choose another agent", async () => {
    const io = fakeIo();
    io.client.threadStart = async () => { throw new Error("rpc timeout"); };
    const driver = new CodexAppServerRuntimeDriver({ io });
    expect(await driver.start(startRequest())).toMatchObject({
      state: "ambiguous",
      failure: { code: "CODEX_THREAD_START_AMBIGUOUS" },
    });
  });

  test("applies the epoch-bound model and effort to thread/start", async () => {
    const io = fakeIo();
    let params: Parameters<CodexAppServerIo["client"]["threadStart"]>[0] | undefined;
    io.client.threadStart = async (input) => {
      params = input;
      return { thread: { id: "thread-1" } };
    };
    const driver = new CodexAppServerRuntimeDriver({ io });
    const request = startRequest();
    request.configuration = { revision: 2, model: "gpt-5.4", effort: "high" };
    expect((await driver.start(request)).state).toBe("started");
    expect(params).toMatchObject({
      cwd: "/tmp/project",
      model: "gpt-5.4",
      config: { model_reasoning_effort: "high" },
    });
  });

  test("a turn/start error remains ambiguous on the same Codex binding", async () => {
    const io = fakeIo();
    io.client.turnStart = async () => { throw new Error("response lost"); };
    const driver = new CodexAppServerRuntimeDriver({ io });
    const binding: ReadyBinding = {
      conversationId: "conversation-1",
      epoch: 1,
      requestedAgent: "codex",
      actualAgent: "codex",
      transport: "app-server",
      handle: "thread-1",
      ownerDeviceId: "device-1",
      daemonBootId: "boot-1",
      runtimeId: "thread-1",
      operationId: "operation-1",
      appliedConfigurationRevision: 1,
      protocolVersion: 1,
      capabilities: [...FENCED_RUNTIME_CAPABILITIES],
    };
    const permit = parseStartedDeliveryPermit({
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
    });
    const result = await driver.deliver({
      binding,
      permit,
      delivery: {
        messageId: "message-1",
        deliveryId: "delivery-1",
        conversationSequence: "1",
        input: [{ type: "text", text: "hello" }],
      },
    });
    expect(result).toMatchObject({
      state: "ambiguous",
      failure: { code: "CODEX_TURN_START_AMBIGUOUS" },
    });
  });

  test("recovering without a durably journaled thread handle fails closed", async () => {
    const driver = new CodexAppServerRuntimeDriver({ io: fakeIo() });
    expect(await driver.adopt(startRequest())).toMatchObject({
      state: "unknown",
      failure: { code: "CODEX_THREAD_HANDLE_UNKNOWN" },
    });
  });
});
