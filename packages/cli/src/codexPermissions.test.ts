import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CodexAppServer, type ThreadStartParams } from "./codexAppServer";
import { applyPolicyInPlace, codexResumeParams, persistedPolicyFor, registerPolicyPersistenceHandlers, type PersistedCodexThread } from "./codexTurnRecovery";
import { buildLaunchArgs, buildPrintArgs, codexPermissionsFromArgs, getPermissionFlags, permissionFlagsForMode } from "./launchCommand";
import { getAgentArgs } from "./config/types.js";

const full = { sandbox: "danger-full-access", approvalPolicy: "never" } as const;
const readonly = { type: "readOnly", networkAccess: false } as const;

function client(defaults: Pick<ThreadStartParams, "sandbox" | "approvalPolicy"> = full) {
  const requests: Array<{ method: string; params: any }> = [];
  const server = new CodexAppServer({ log: () => {}, defaultPermissions: () => defaults });
  (server as any).sendRequest = async (method: string, params: any) => {
    requests.push({ method, params });
    if (method === "turn/start") return { turn: { id: "turn", items: [], status: "inProgress" } };
    return { thread: { id: params.threadId ?? "thread" }, model: "test", sandbox: params.sandbox === "danger-full-access" ? { type: "dangerFullAccess" } : readonly };
  };
  return { server, requests };
}

describe("configured Codex permissions", () => {
  test("all production resumes pass through the persisted-policy boundary", () => {
    const calls: string[] = [];
    for (const file of new Bun.Glob("**/*.ts").scanSync(import.meta.dir)) {
      if (/\.(test|spec)\.ts$/.test(file) || file.includes("__fixtures__") || file.includes("test-helpers")) continue;
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      for (const call of source.matchAll(/\.threadResume\s*\(([^\n]*)/g)) calls.push(`${file}:${call[1]}`);
    }
    expect(calls).toEqual(['daemon.ts:codexResumeParams(record, policy));']);
  });

  test("ordinary configured launches default to full access independently of approval policy", () => {
    const flags = getPermissionFlags("codex", null)!.split(" ");
    expect(codexPermissionsFromArgs(flags)).toEqual(full);
    expect(codexPermissionsFromArgs(["--ask-for-approval", "never"])).toEqual({ sandbox: "workspace-write", approvalPolicy: "never" });
    expect(codexPermissionsFromArgs(["--full-auto"])).toEqual({ sandbox: "workspace-write", approvalPolicy: "on-request" });
  });

  test.each(["--sandbox read-only -a never", "-s read-only --ask-for-approval=never", "--sandbox=read-only -a=never", "-sread-only -anever", "-s=read-only -a=never"])("explicit sandbox arguments suppress the bypass default: %s", args => {
    expect(getPermissionFlags("codex", { agent_args: { codex: args } } as any)).toBeNull();
    expect(permissionFlagsForMode("codex", "bypass", args)).toBeNull();
    expect(codexPermissionsFromArgs(args.split(" "))).toEqual({ sandbox: "read-only", approvalPolicy: "never" });
  });

  test("attached approval intent remains independent from sandbox intent", () => {
    expect(getPermissionFlags("codex", { agent_args: { codex: "-anever" } } as any)).toBeNull();
    expect(codexPermissionsFromArgs(["-anever"])).toEqual({ sandbox: "workspace-write", approvalPolicy: "never" });
  });

  test.each(["-sread-only", "-anever", "--sandbox read-only", "--yolo"])("permission-looking prompt text after -- is ignored: %s", prompt => {
    const args = `-- ${prompt}`;
    expect(getPermissionFlags("codex", { agent_args: { codex: args } } as any)).toBe("--dangerously-bypass-approvals-and-sandbox");
    expect(permissionFlagsForMode("codex", "bypass", args)).toBe("--dangerously-bypass-approvals-and-sandbox");
    expect(codexPermissionsFromArgs(["--yolo", ...args.split(" ")])).toEqual(full);
    expect(codexPermissionsFromArgs(["-sread-only", "--", "--yolo"])).toEqual({ sandbox: "read-only", approvalPolicy: "on-request" });
  });

  test.each(["-- -sread-only", "-sread-only -- --yolo"])("actual launch, print and daemon defaults preserve the option boundary: %s", configuredArgs => {
    const config = { agent_args: { codex: configuredArgs } } as any;
    const input = { agentType: "codex" as const, configuredArgs, permFlags: getPermissionFlags("codex", config), defaultFlags: null, modelAlias: "test-model" };
    const launch = buildLaunchArgs(input).binaryArgs;
    const print = buildPrintArgs({ ...input, prompt: "" }).binaryArgs;
    const expected = configuredArgs.startsWith("--") ? full : { sandbox: "read-only", approvalPolicy: "on-request" } as const;
    for (const args of [launch, print]) {
      expect(args.slice(args.indexOf("--"))).toEqual(configuredArgs.split(" ").slice(configuredArgs.split(" ").indexOf("--")));
      expect(args.slice(0, args.indexOf("--"))).toContain("-m");
      expect(args.slice(0, args.indexOf("--"))).toContain("test-model");
      expect(codexPermissionsFromArgs(args)).toEqual(expected);
    }
    const source = readFileSync(join(import.meta.dir, "daemon.ts"), "utf8");
    const start = source.indexOf("function resolveCodexPermissionDefaults(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\ninterface ConversationCache", start));
    const resolve = new Function("buildLaunchArgs", "getAgentArgs", "getPermissionFlags", "codexPermissionsFromArgs", new Bun.Transpiler().transformSync(body, "ts") + "; return resolveCodexPermissionDefaults;")(buildLaunchArgs, getAgentArgs, getPermissionFlags, codexPermissionsFromArgs);
    expect(resolve(config)).toEqual(expected);
  });

  test("ordinary start, resume and fork explicitly request full access without approvals", async () => {
    const { server, requests } = client();
    await server.threadStart({ cwd: "/project" });
    await server.threadResume({ threadId: "legacy", cwd: "/project" });
    await server.threadFork({ threadId: "source", cwd: "/project" });
    for (const request of requests) expect(request.params).toMatchObject(full);
  });

  test("explicit restrictions override the configured default on all thread requests", async () => {
    const { server, requests } = client();
    const restricted = { sandbox: "read-only", approvalPolicy: "on-request" } as const;
    await server.threadStart({ cwd: "/project", ...restricted });
    await server.threadResume({ threadId: "legacy", ...restricted });
    await server.threadFork({ threadId: "source", ...restricted });
    for (const request of requests) expect(request.params).toMatchObject(restricted);
  });

  test("an absent persisted policy may be an older invalidation and remains restricted", async () => {
    const { server, requests } = client();
    await server.threadResume(codexResumeParams({ threadId: "legacy", updatedAt: 1 }, "never"));
    await server.turnStart({ threadId: "legacy", input: [{ type: "text", text: "continue" }] });
    expect(requests[0].params.sandbox).toBe("read-only");
    expect(requests[1].params.sandboxPolicy).toEqual(readonly);
  });

  test("an explicit turn restriction remains in force despite full-access defaults", async () => {
    const { server, requests } = client();
    await server.threadStart({ cwd: "/project" });
    await server.turnStart({ threadId: "thread", input: [], sandboxPolicy: readonly });
    await server.turnStart({ threadId: "thread", input: [] });
    expect(requests.at(-1)!.params.sandboxPolicy).toEqual(readonly);
  });

  test("defaults never fill an unknown turn policy", async () => {
    const { server, requests } = client();
    await server.turnStart({ threadId: "unknown", input: [] });
    expect(requests[0].params.sandboxPolicy).toBeUndefined();
  });

  test("recorded restrictions survive cold resume", async () => {
    const { server, requests } = client();
    await server.threadResume(codexResumeParams({ threadId: "safe", updatedAt: 1, sandboxPolicy: readonly }, "never"));
    expect(requests[0].params.sandbox).toBe("read-only");
  });

  test("legacy coarse restrictions survive cold resume until a server policy supersedes them", async () => {
    const record: PersistedCodexThread = { threadId: "safe", updatedAt: 1, sandbox: "read-only" };
    const { server, requests } = client();
    const response = await server.threadResume(codexResumeParams(JSON.parse(JSON.stringify(record)), "never"));
    expect(requests[0].params.sandbox).toBe("read-only");
    applyPolicyInPlace(record, "safe", response.sandbox);
    expect(record.sandbox).toBeUndefined();
    expect(record.sandboxPolicy).toEqual(readonly);
  });

  test("a live restricted thread retains its known policy on an implicit resume", async () => {
    const { server, requests } = client();
    await server.threadStart({ cwd: "/project", sandbox: "read-only" });
    await server.threadResume({ threadId: "thread", cwd: "/project" });
    expect(requests.at(-1)!.params.sandbox).toBe("read-only");
  });

  test("durable invalidation survives JSON and does not acquire the legacy default", async () => {
    const record: PersistedCodexThread = { threadId: "thread", updatedAt: 1, sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } };
    const identity = record;
    const policy = persistedPolicyFor({ pending: true, previous: record.sandboxPolicy });
    applyPolicyInPlace(record, "thread", policy);
    expect(record).toBe(identity);
    expect(record.sandboxPolicy).toBeNull();
    expect(record.sandbox).toBeUndefined();
    const { server, requests } = client();
    await server.threadResume(codexResumeParams(JSON.parse(JSON.stringify(record)), "never"));
    expect(requests[0].params.sandbox).toBe("read-only");
  });

  test("an ambiguous narrowing persists invalidation before the request and stays restricted on restart", async () => {
    const { server } = client();
    const record: PersistedCodexThread = { threadId: "thread", updatedAt: 1 };
    await server.threadStart({ cwd: "/project" });
    registerPolicyPersistenceHandlers({
      client: server,
      conversationForThread: () => "conversation",
      persist: () => {
        applyPolicyInPlace(record, "thread", persistedPolicyFor({
          pending: server.hasPendingPolicyChange("thread"), invalidated: server.isPolicyInvalidated("thread"),
          live: server.policyForThread("thread"), previous: record.sandboxPolicy,
        }));
        return true;
      },
    });
    (server as any).sendRequest = async () => {
      expect(JSON.parse(JSON.stringify(record)).sandboxPolicy).toBeNull();
      throw new Error("response lost");
    };
    await expect(server.turnStart({ threadId: "thread", input: [], sandboxPolicy: readonly })).rejects.toThrow("response lost");
    const restarted = client();
    await restarted.server.threadResume(codexResumeParams(JSON.parse(JSON.stringify(record)), "never"));
    expect(restarted.requests[0].params.sandbox).toBe("read-only");
  });

  test("configured defaults are read again for each request", async () => {
    const defaults: Pick<ThreadStartParams, "sandbox" | "approvalPolicy"> = { ...full };
    const { server, requests } = client(defaults);
    await server.threadStart({ cwd: "/project" });
    defaults.sandbox = "read-only";
    defaults.approvalPolicy = "on-request";
    await server.threadStart({ cwd: "/project" });
    expect(requests[0].params).toMatchObject(full);
    expect(requests[1].params).toMatchObject(defaults);
  });
});
