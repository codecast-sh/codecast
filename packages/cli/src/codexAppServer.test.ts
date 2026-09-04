import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodexAppServer, CodexRequestRefused, approvalResultForMethod, threadForkTimeoutMsForBytes, threadItemToMessage, threadItemsToMessages } from "./codexAppServer.js";
import { persistedPolicyFor } from "./codexTurnRecovery.js";

describe("CodexAppServer sandbox restatement", () => {
  // Codex 0.153+ recomputes a restrictive managed permission profile for any
  // request that names no sandbox, instead of inheriting the thread's. Two live
  // sessions lost file and network access mid-task that way on 2026-09-04.
  //
  // Wire shape verified against codex-cli 0.153.3 `app-server generate-ts`:
  // thread/start, thread/resume and thread/fork take `sandbox: SandboxMode`;
  // turn/start takes `sandboxPolicy: SandboxPolicy`. Different fields, different
  // types. A live probe confirmed the server accepts the wrong one silently.
  //
  // The client never invents a sandbox. It replays only a policy the server
  // returned, so a restatement can never widen a thread's real access.
  const FULL = { type: "dangerFullAccess" } as const;
  const READONLY = { type: "readOnly", networkAccess: false } as const;
  const WORKSPACE = {
    type: "workspaceWrite", writableRoots: ["/Users/x/proj"], networkAccess: false,
    excludeTmpdirEnvVar: false, excludeSlashTmp: false,
  } as const;

  const stubbed = (resolved: any = FULL) => {
    const requests: Array<{ method: string; params: any }> = [];
    const server = new CodexAppServer({ log: () => {} });
    (server as any).sendRequest = async (method: string, params: any) => {
      requests.push({ method, params });
      if (method === "turn/start") return { turn: { id: "turn", items: [], status: "inProgress" } };
      return { thread: { id: params.threadId ?? "thread" }, model: "gpt-test", sandbox: resolved };
    };
    return { server, requests };
  };
  const turns = (r: Array<{ method: string; params: any }>) => r.filter(x => x.method === "turn/start");

  test("thread requests carry the caller's mode, turns carry the resolved policy", async () => {
    const { server, requests } = stubbed(FULL);
    await server.threadStart({ cwd: "/p", sandbox: "danger-full-access" });
    await server.turnStart({ threadId: "thread", input: [{ type: "text", text: "hi" }] });
    expect(requests[0].params.sandbox).toBe("danger-full-access");
    expect(requests[0].params.sandboxPolicy).toBeUndefined();
    expect(turns(requests)[0].params.sandboxPolicy).toEqual(FULL);
    expect(turns(requests)[0].params.sandbox).toBeUndefined();
  });

  test("every turn restates it, not just the first", async () => {
    const { server, requests } = stubbed(FULL);
    await server.threadStart({ cwd: "/p", sandbox: "danger-full-access" });
    await server.turnStart({ threadId: "thread", input: [{ type: "text", text: "a" }] });
    await server.turnStart({ threadId: "thread", input: [{ type: "text", text: "b" }] });
    expect(turns(requests).map(r => r.params.sandboxPolicy)).toEqual([FULL, FULL]);
  });

  test("a read-only thread stays read-only", async () => {
    const { server, requests } = stubbed(READONLY);
    await server.threadStart({ cwd: "/p", sandbox: "read-only" });
    await server.turnStart({ threadId: "thread", input: [{ type: "text", text: "hi" }] });
    expect(turns(requests)[0].params.sandboxPolicy).toEqual(READONLY);
  });

  test("workspace-write writable roots and network access survive verbatim", async () => {
    const { server, requests } = stubbed(WORKSPACE);
    await server.threadResume({ threadId: "thread", cwd: "/p", sandbox: "workspace-write" });
    await server.turnStart({ threadId: "thread", input: [{ type: "text", text: "hi" }] });
    expect(turns(requests)[0].params.sandboxPolicy).toEqual(WORKSPACE);
  });

  // A caller that names no sandbox must be passed through untouched. Injecting a
  // default here would widen a thread that is genuinely restricted.
  test("resume and fork of an unknown thread never invent a sandbox", async () => {
    const { server, requests } = stubbed(READONLY);
    await server.threadResume({ threadId: "unknown-a", cwd: "/p" });
    await server.threadFork({ threadId: "unknown-b", cwd: "/p" });
    await server.threadStart({ cwd: "/p" });
    expect(requests.map(r => r.params.sandbox)).toEqual([undefined, undefined, undefined]);
  });

  test("a turn on an unknown thread sends no policy rather than inventing one", async () => {
    const { server, requests } = stubbed(FULL);
    await server.turnStart({ threadId: "never-seen", input: [{ type: "text", text: "hi" }] });
    expect(turns(requests)[0].params.sandboxPolicy).toBeUndefined();
  });

  test("an accepted explicit override wins and sticks", async () => {
    const { server, requests } = stubbed(FULL);
    await server.threadStart({ cwd: "/p", sandbox: "danger-full-access" });
    await server.turnStart({ threadId: "thread", input: [{ type: "text", text: "a" }], sandboxPolicy: READONLY });
    await server.turnStart({ threadId: "thread", input: [{ type: "text", text: "b" }] });
    expect(turns(requests).map(r => r.params.sandboxPolicy)).toEqual([READONLY, READONLY]);
  });

  // A refused widening must not leak into the next implicit turn. The refusal
  // must be the answered kind: an ambiguous transport failure is handled
  // differently, and is covered separately below.
  test("a REFUSED widening does not poison the next turn", async () => {
    const { server, requests } = stubbed(READONLY);
    await server.threadStart({ cwd: "/p", sandbox: "read-only" });
    const ok = (server as any).sendRequest;
    (server as any).sendRequest = async () => { throw new CodexRequestRefused("policy refused"); };
    await expect(server.turnStart({
      threadId: "thread", input: [{ type: "text", text: "a" }], sandboxPolicy: FULL,
    })).rejects.toThrow("policy refused");
    (server as any).sendRequest = ok;
    await server.turnStart({ threadId: "thread", input: [{ type: "text", text: "b" }] });
    expect(turns(requests).at(-1)!.params.sandboxPolicy).toEqual(READONLY);
  });

  // These drive the real client together with the real persistence decision
  // (persistedPolicyFor, the same function every daemon persist site calls), so
  // they assert what actually reaches disk rather than an accessor's opinion.
  const disk = (server: CodexAppServer, threadId: string, previous?: any) =>
    persistedPolicyFor({
      pending: server.hasPendingPolicyChange(threadId),
      invalidated: server.isPolicyInvalidated(threadId),
      live: server.policyForThread(threadId),
      previous,
    });

  test("old full, pending narrow, crash mid-flight: disk stays unknown", async () => {
    const { server } = stubbed(FULL);
    await server.threadStart({ cwd: "/p", sandbox: "danger-full-access" });
    expect(disk(server, "thread", FULL)).toEqual(FULL);

    const invalidated: string[] = [];
    server.on("policyInvalidated", (id: string) => invalidated.push(id));
    (server as any).sendRequest = () => new Promise(() => {});   // never settles
    void server.turnStart({ threadId: "thread", input: [{ type: "text", text: "a" }], sandboxPolicy: READONLY });
    await Promise.resolve();

    // Invalidated BEFORE the write, and disk must not claim the old broader one.
    expect(invalidated).toEqual(["thread"]);
    expect(disk(server, "thread", FULL)).toBeUndefined();
  });

  test("timeout after a narrowing leaves the policy unspecified, not the old one", async () => {
    const { server } = stubbed(FULL);
    await server.threadStart({ cwd: "/p", sandbox: "danger-full-access" });
    (server as any).sendRequest = async () => { throw new Error("Request turn/start timed out after 1ms"); };
    await expect(server.turnStart({
      threadId: "thread", input: [{ type: "text", text: "a" }], sandboxPolicy: READONLY,
    })).rejects.toThrow("timed out");

    expect(server.hasPendingPolicyChange("thread")).toBe(false);
    expect(server.policyForThread("thread")).toBeUndefined();
    expect(disk(server, "thread", FULL)).toBeUndefined();
  });

  test("a dropped connection is ambiguous too, and does not restore the old policy", async () => {
    const { server } = stubbed(FULL);
    await server.threadStart({ cwd: "/p", sandbox: "danger-full-access" });
    (server as any).sendRequest = async () => { throw new Error("codex app-server process terminated"); };
    await expect(server.turnStart({
      threadId: "thread", input: [{ type: "text", text: "a" }], sandboxPolicy: READONLY,
    })).rejects.toThrow("terminated");
    expect(disk(server, "thread", FULL)).toBeUndefined();
  });

  test("an EXPLICIT refusal is authoritative, so the old policy remains valid", async () => {
    const { server } = stubbed(FULL);
    await server.threadStart({ cwd: "/p", sandbox: "danger-full-access" });
    const confirmed: any[] = [];
    server.on("policyConfirmed", (_id: string, policy: any) => confirmed.push(policy));
    (server as any).sendRequest = async () => { throw new CodexRequestRefused("sandbox not permitted"); };
    await expect(server.turnStart({
      threadId: "thread", input: [{ type: "text", text: "a" }], sandboxPolicy: READONLY,
    })).rejects.toThrow("sandbox not permitted");

    expect(server.policyForThread("thread")).toEqual(FULL);
    expect(disk(server, "thread", FULL)).toEqual(FULL);
    expect(confirmed).toEqual([FULL]);
  });

  test("a concurrent rejected call cannot clear the first call's pending mark", async () => {
    const { server } = stubbed(FULL);
    await server.threadStart({ cwd: "/p", sandbox: "danger-full-access" });

    let releaseFirst: (v: any) => void = () => {};
    (server as any).sendRequest = (_m: string, p: any) =>
      p.input[0].text === "first"
        ? new Promise(r => { releaseFirst = r; })
        : Promise.reject(new CodexRequestRefused("no"));

    const first = server.turnStart({ threadId: "thread", input: [{ type: "text", text: "first" }], sandboxPolicy: READONLY });
    await expect(server.turnStart({
      threadId: "thread", input: [{ type: "text", text: "second" }], sandboxPolicy: { ...WORKSPACE, writableRoots: [...WORKSPACE.writableRoots] },
    })).rejects.toThrow("no");

    // The second call finished; the first is still in flight and still owns the mark.
    expect(server.hasPendingPolicyChange("thread")).toBe(true);
    expect(disk(server, "thread", FULL)).toBeUndefined();

    releaseFirst({ turn: { id: "t", items: [], status: "inProgress" } });
    await first;
    // The first call's acceptance is now SUPERSEDED: a later override was issued
    // for this thread, so an older response may not resolve the uncertainty. The
    // policy stays unknown and a resume sends none, which is restrictive.
    expect(server.hasPendingPolicyChange("thread")).toBe(false);
    expect(disk(server, "thread", FULL)).toBeUndefined();
  });

  // A=FULL and B=READONLY both in flight. A is accepted while B is still
  // pending, then B times out. A's acceptance must NOT clear the uncertainty B
  // introduced: B's narrowing may have been applied and never reported, so
  // replaying FULL would restore access the thread may no longer have.
  test("an earlier acceptance cannot clear uncertainty from a later pending override", async () => {
    const { server } = stubbed(FULL);
    await server.threadStart({ cwd: "/p", sandbox: "danger-full-access" });

    let releaseA: (v: any) => void = () => {};
    let failB: (e: any) => void = () => {};
    (server as any).sendRequest = (_m: string, p: any) =>
      p.sandboxPolicy?.type === "dangerFullAccess"
        ? new Promise(r => { releaseA = r; })
        : new Promise((_r, j) => { failB = j; });

    const a = server.turnStart({ threadId: "thread", input: [{ type: "text", text: "a" }], sandboxPolicy: FULL });
    const b = server.turnStart({ threadId: "thread", input: [{ type: "text", text: "b" }], sandboxPolicy: READONLY });

    releaseA({ turn: { id: "t", items: [], status: "inProgress" } });
    await a;
    // A settled, but B is newer and still unresolved.
    expect(server.hasPendingPolicyChange("thread")).toBe(true);
    expect(disk(server, "thread", FULL)).toBeUndefined();

    failB(new Error("Request turn/start timed out after 1ms"));
    await expect(b).rejects.toThrow("timed out");

    // B was ambiguous, so the thread's policy is still unknown. FULL must not
    // come back from A's earlier acceptance or from the record.
    expect(server.hasPendingPolicyChange("thread")).toBe(false);
    expect(server.policyForThread("thread")).toBeUndefined();
    expect(disk(server, "thread", FULL)).toBeUndefined();
  });

  // Same stale-response guard at the other entry point. A resume knows its
  // thread id up front, so a slow resume response must not make itself newest
  // and overwrite a narrowing accepted while it was in flight.
  test("a delayed resume response cannot restore a policy a newer turn narrowed", async () => {
    const { server } = stubbed(FULL);
    let releaseResume: (v: any) => void = () => {};
    (server as any).sendRequest = (method: string, p: any) =>
      method === "thread/resume"
        ? new Promise(r => { releaseResume = r; })
        : Promise.resolve({ turn: { id: "t", items: [], status: "inProgress" } });

    // The resume is in flight and its generation is already taken.
    const resumed = server.threadResume({ threadId: "thread", cwd: "/p" });
    expect(server.hasPendingPolicyChange("thread")).toBe(true);

    // A newer override narrows the thread and is accepted while the resume waits.
    await server.turnStart({ threadId: "thread", input: [{ type: "text", text: "a" }], sandboxPolicy: READONLY });
    expect(server.policyForThread("thread")).toEqual(READONLY);

    // The stale resume finally answers, reporting the OLD broader policy.
    releaseResume({ thread: { id: "thread" }, model: "gpt-test", sandbox: FULL });
    await resumed;

    expect(server.policyForThread("thread")).toEqual(READONLY);
    expect(disk(server, "thread", FULL)).toEqual(READONLY);
  });

  test("a resume marks the thread unknown before it is sent", async () => {
    const { server } = stubbed(FULL);
    await server.threadStart({ cwd: "/p", sandbox: "danger-full-access" });
    const invalidated: string[] = [];
    server.on("policyInvalidated", (id: string) => invalidated.push(id));
    (server as any).sendRequest = () => new Promise(() => {});
    void server.threadResume({ threadId: "thread", cwd: "/p" });
    await Promise.resolve();
    expect(invalidated).toEqual(["thread"]);
    expect(disk(server, "thread", FULL)).toBeUndefined();
  });

  test("a failed resume leaves the policy unknown rather than reverting", async () => {
    const { server } = stubbed(FULL);
    await server.threadStart({ cwd: "/p", sandbox: "danger-full-access" });
    (server as any).sendRequest = async () => { throw new Error("Request thread/resume timed out after 1ms"); };
    await expect(server.threadResume({ threadId: "thread", cwd: "/p" })).rejects.toThrow("timed out");
    expect(server.policyForThread("thread")).toBeUndefined();
    expect(disk(server, "thread", FULL)).toBeUndefined();
  });

  test("an implicit turn never touches an override's pending mark", async () => {
    const { server } = stubbed(FULL);
    await server.threadStart({ cwd: "/p", sandbox: "danger-full-access" });
    let release: (v: any) => void = () => {};
    (server as any).sendRequest = (_m: string, p: any) =>
      p.sandboxPolicy === READONLY ? new Promise(r => { release = r; })
                                   : Promise.resolve({ turn: { id: "t", items: [], status: "inProgress" } });
    const override = server.turnStart({ threadId: "thread", input: [{ type: "text", text: "a" }], sandboxPolicy: READONLY });
    await server.turnStart({ threadId: "thread", input: [{ type: "text", text: "implicit" }] });
    expect(server.hasPendingPolicyChange("thread")).toBe(true);
    release({ turn: { id: "t", items: [], status: "inProgress" } });
    await override;
    expect(server.hasPendingPolicyChange("thread")).toBe(false);
  });

  test("an accepted override announces itself so persisters can catch up", async () => {
    const { server } = stubbed(FULL);
    await server.threadStart({ cwd: "/p", sandbox: "danger-full-access" });
    const seen: Array<[string, any]> = [];
    server.on("policyConfirmed", (id: string, policy: any) => seen.push([id, policy]));
    await server.turnStart({ threadId: "thread", input: [{ type: "text", text: "a" }], sandboxPolicy: READONLY });
    expect(seen).toEqual([["thread", READONLY]]);
  });

  test("a failed turn with no override keeps the remembered policy for the retry", async () => {
    const { server, requests } = stubbed(FULL);
    await server.threadStart({ cwd: "/p", sandbox: "danger-full-access" });
    const ok = (server as any).sendRequest;
    (server as any).sendRequest = async () => { throw new Error("transport died"); };
    await expect(server.turnStart({ threadId: "thread", input: [{ type: "text", text: "a" }] })).rejects.toThrow("transport died");
    (server as any).sendRequest = ok;
    await server.turnStart({ threadId: "thread", input: [{ type: "text", text: "b" }] });
    expect(turns(requests).at(-1)!.params.sandboxPolicy).toEqual(FULL);
  });
});

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
