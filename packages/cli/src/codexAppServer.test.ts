import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodexAppServer, approvalResultForMethod, threadForkTimeoutMsForBytes, threadItemToMessage, threadItemsToMessages } from "./codexAppServer.js";

describe("CodexAppServer protocol", () => {
  test("start, resume and fork export workspace ports without changing sandbox", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-worktree-env-"));
    const cwd = path.join(root, ".codecast/worktrees/cloud-test");
    const stateDir = path.join(root, ".codecast/workspaces/cloud-test");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ resourceIndex: 3, ports: { web: 3261 } }));
    const requests: Array<any> = [];
    const server = new CodexAppServer({ log: () => {} });
    (server as any).sendRequest = async (method: string, params: unknown) => {
      requests.push({ method, params });
      return { thread: { id: "thread" }, model: "gpt-test" };
    };
    try {
      await server.threadStart({ cwd, sandbox: "read-only", config: { model_reasoning_effort: "high", "shell_environment_policy.set": { KEEP_ME: "yes", PORT_WEB: "wrong" } } });
      await server.threadResume({ cwd, threadId: "thread", sandbox: "workspace-write" });
      await server.threadFork({ cwd, threadId: "thread", sandbox: "danger-full-access" });
      expect(requests.map((r) => r.params.sandbox)).toEqual(["read-only", "workspace-write", "danger-full-access"]);
      for (const { params } of requests) {
        expect(params.config["shell_environment_policy.set"]).toMatchObject({ PORT_WEB: "3261", AGENT_RESOURCE_INDEX: "3" });
      }
      expect(requests[0].params.config.model_reasoning_effort).toBe("high");
      expect(requests[0].params.config["shell_environment_policy.set"].KEEP_ME).toBe("yes");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  test("enables the experimental API and forks a rollout by path", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const server = new CodexAppServer({ log: () => {} });
    (server as any).sendRequest = async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "initialize") return { userAgent: "test", platformOs: "test" };
      return {
        thread: { id: "real-thread", path: "/tmp/real-thread.jsonl", forkedFromId: "synthetic-thread" },
        cwd: "/tmp/project",
        model: "gpt-test",
        sandbox: {},
        approvalPolicy: "never",
      };
    };

    await (server as any).initialize();
    const response = await server.threadFork({
      threadId: "",
      path: "/tmp/synthetic-thread.jsonl",
      cwd: "/tmp/project",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });

    expect(requests[0]).toEqual({
      method: "initialize",
      params: {
        clientInfo: { name: "codecast", title: "Codecast Daemon", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      },
    });
    expect(requests[1]?.method).toBe("thread/fork");
    expect(requests[1]?.params).toMatchObject({
      threadId: "",
      path: "/tmp/synthetic-thread.jsonl",
    });
    expect(response.thread.id).toBe("real-thread");
  });

  test("scales fork deadlines for large transcript imports", () => {
    expect(threadForkTimeoutMsForBytes(1024 * 1024)).toBe(60_000);
    expect(threadForkTimeoutMsForBytes(17 * 1024 * 1024)).toBe(300_000);
    expect(threadForkTimeoutMsForBytes(20 * 1024 * 1024)).toBe(345_000);
    expect(threadForkTimeoutMsForBytes(100 * 1024 * 1024)).toBe(600_000);
  });
});

describe("approvalResultForMethod", () => {
  test("returns a decision for command execution approvals", () => {
    expect(approvalResultForMethod("item/commandExecution/requestApproval", true)).toEqual({
      decision: "accept",
    });
    expect(approvalResultForMethod("item/commandExecution/requestApproval", false)).toEqual({
      decision: "decline",
    });
  });

  test("echoes requested permissions for permission approvals", () => {
    expect(
      approvalResultForMethod("item/permissions/requestApproval", true, {
        permissions: { workspaceWrite: true, network: false },
      }),
    ).toEqual({
      permissions: { workspaceWrite: true, network: false },
      scope: "session",
    });
  });
});

describe("threadItemsToMessages", () => {
  test("keeps Codex image paths as local files instead of treating paths as base64", () => {
    const path = "/tmp/screenshot.webp";
    const single = threadItemToMessage({
      type: "imageView",
      id: "image-1",
      path,
    } as any);
    const grouped = threadItemsToMessages([
      { type: "agentMessage", id: "msg-1", text: "Screenshot:", phase: "commentary" },
      { type: "imageView", id: "image-1", path },
    ] as any[]);

    expect(single?.images).toEqual([{ mediaType: "image/webp", localPath: path }]);
    expect(grouped[0]?.uuid).toBe("msg-1");
    expect(grouped[0]?.images).toEqual([{ mediaType: "image/webp", localPath: path }]);
    expect(grouped[0]?.images?.[0].data).toBeUndefined();
  });

  test("gives image-only groups a stable item uuid across progress rebuilds", () => {
    const first = threadItemsToMessages([
      { type: "imageView", id: "image-1", path: "/tmp/one.png" },
    ] as any[]);
    const rebuilt = threadItemsToMessages([
      { type: "imageView", id: "image-1", path: "/tmp/one.png" },
      { type: "commandExecution", id: "cmd-1", command: "true", cwd: "/tmp", status: "completed" },
    ] as any[]);

    expect(first[0]?.uuid).toBe("image-1");
    expect(rebuilt[0]?.uuid).toBe("image-1");
  });

  test("preserves live codex text/tool/text ordering for streamed items", () => {
    const items = [
      { type: "agentMessage", id: "msg-1", text: "Tracing the existing flow.", phase: "commentary" },
      { type: "plan", id: "plan-1", text: "1. Read code\n2. Patch daemon" },
      {
        type: "commandExecution",
        id: "cmd-1",
        command: "rg foo",
        cwd: "/tmp",
        status: "completed",
        aggregatedOutput: "match",
      },
      { type: "agentMessage", id: "msg-2", text: "Patch is in progress.", phase: "commentary" },
    ] as any[];

    const messages = threadItemsToMessages(items);

    expect(messages).toHaveLength(3);
    expect(messages[0]?.uuid).toBe("msg-1");
    expect(messages[0]?.content).toContain("Tracing the existing flow.");
    expect(messages[0]?.content).toContain("1. Read code");
    expect(messages[1]?.uuid).toBe("cmd-1");
    expect(messages[1]?.toolCalls?.[0]?.id).toBe("cmd-1");
    expect(messages[1]?.toolResults?.[0]?.toolUseId).toBe("cmd-1");
    expect(messages[2]?.uuid).toBe("msg-2");
    expect(messages[2]?.content).toBe("Patch is in progress.");
    expect(messages[0]!.timestamp).toBeLessThan(messages[1]!.timestamp);
    expect(messages[1]!.timestamp).toBeLessThan(messages[2]!.timestamp);
  });

  test("groups adjacent assistant items under the first item id", () => {
    const items = [
      { type: "agentMessage", id: "msg-1", text: "First partial.", phase: "commentary" },
      { type: "agentMessage", id: "msg-2", text: "Second partial.", phase: "final_answer" },
    ] as any[];

    const messages = threadItemsToMessages(items);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.uuid).toBe("msg-1");
    expect(messages[0]?.content).toBe("First partial.\nSecond partial.");
  });

  // Regression: ct-36429. A `userMessage` item is a turn BOUNDARY in the agent-output
  // stream, not a message source: it flushes any buffered assistant text so the next
  // turn starts a fresh bubble, but is NOT itself emitted here. The user's prompt is
  // recorded durably at DELIVERY time (see buildCodexUserTurnMessage / deliverMessage),
  // mirroring how Claude's JSONL sync records the user turn. Emitting it here too would
  // double-record the prompt if a resumed thread ever replays it. This pins that contract
  // so the boundary-flush isn't "fixed" into a duplicate-producing emit.
  test("treats userMessage as a turn boundary, not a message source", () => {
    const items = [
      { type: "agentMessage", id: "a1", text: "first turn reply", phase: "commentary" },
      { type: "userMessage", id: "u1", content: [{ type: "text", text: "second prompt" }] },
      { type: "agentMessage", id: "a2", text: "second turn reply", phase: "commentary" },
    ] as any[];

    const messages = threadItemsToMessages(items);

    // The userMessage flushes "first turn reply" and opens a fresh bubble for the next
    // reply, but is not itself emitted: two assistant messages, zero user messages.
    expect(messages.map((m) => m.role)).toEqual(["assistant", "assistant"]);
    expect(messages[0]?.content).toBe("first turn reply");
    expect(messages[1]?.content).toBe("second turn reply");
  });
});

describe("Codex per-turn model snapshots", () => {
  test.each(["threadStart", "threadResume", "threadFork"] as const)("records the actual model returned by %s", async method => {
    const server = new CodexAppServer({ log: () => {} });
    (server as any).sendRequest = async () => ({ thread: { id: "thread1" }, model: "gpt-6-astra", cwd: "/tmp" });
    await server[method]({ threadId: "thread1", model: "default" });
    const started: unknown[][] = [];
    const finished: unknown[][] = [];
    server.on("turnStarted", (...args) => started.push(args));
    server.on("turnCompleted", (...args) => finished.push(args));
    const notify = (method: string, params: object) => (server as any).handleNotification({ method, params: { threadId: "thread1", ...params } });
    notify("turn/started", { turn: { id: "turn1" } });
    notify("item/completed", { turnId: "turn1", item: { type: "agentMessage", id: "response1", text: "First" } });
    await server.turnStart({ threadId: "thread1", input: [], model: "gpt-5.6-sol" });
    notify("turn/completed", { turn: { id: "turn1", status: "completed" } });
    expect(started[0]).toEqual(["thread1", "turn1", "gpt-6-astra"]);
    expect(finished[0][2]).toMatchObject([{ model: "gpt-6-astra", content: "First" }]);
    notify("turn/started", { turn: { id: "turn2" } });
    expect(started[1]).toEqual(["thread1", "turn2", "gpt-5.6-sol"]);
  });
});
