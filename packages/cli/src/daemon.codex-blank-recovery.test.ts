import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { blankCodexRecoveryParams } from "./launchCommand";
import { buildBlankLaunchArgs, sessionStartConversationId } from "./daemon";
import { functionBlock } from "./test-helpers/sourceRegion";

const source = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
const recovery = new Bun.Transpiler({ loader: "ts" }).transformSync(functionBlock(source, "recoverBlankCodexForDelivery").text);
const permissions = { approvalPolicy: "never", sandbox: "danger-full-access" } as const;
const blank = { conversation: { agent_type: "codex", model: null, message_count: 0 }, messages: [] };

function fixture(server: { running: boolean; threadStart: (...args: any[]) => Promise<any> }) {
  const bindings = new Map<string, string>();
  const starts = new Map<string, string>();
  const persisted = new Map<string, unknown>();
  const events: string[] = [];
  const hooks = { context: () => {} };
  const deps = {
    codexAppServerInstance: server, pendingSessionStarts: starts,
    appServerConversations: bindings, persistedAppServerThreads: persisted,
    blankCodexRecoveryParams, resolveCodexPermissionDefaults: () => permissions,
    buildCodexStableContext: async () => { hooks.context(); return { text: "Project instructions", data: {} }; },
    startCodexThreadThenRecordStableContext: async (start: () => Promise<unknown>, record: () => void) => { const result = await start(); record(); return result; },
    recordStableContext: () => { events.push("context"); },
    registerAppServerConversation: (id: string, thread: string, opts: any) => {
      expect(opts).toMatchObject({ ...permissions, persist: true });
      bindings.set(id, thread); persisted.set(id, { threadId: thread, ...opts }); events.push("register");
    },
    pushSessionIdBinding: async () => { events.push("bind"); },
    syncServiceRef: {
      markSessionActive: async () => { events.push("active"); },
      registerManagedSession: async () => { events.push("managed"); },
      updateSessionAgentStatus: async () => { events.push("connected"); },
    },
    ensureManagedSessionHeartbeat: () => { events.push("heartbeat"); },
    logConvexFailure: (err: unknown) => { throw err; }, logDelivery: () => {},
  };
  const run = new Function(...Object.keys(deps), recovery + "\nreturn recoverBlankCodexForDelivery;")(...Object.values(deps));
  return { run, bindings, starts, persisted, events, hooks };
}

describe("blank Codex delivery recovery", () => {
  test("starts and durably binds a missing empty session only once", async () => {
    const calls: unknown[] = [];
    const f = fixture({ running: true, threadStart: async (params) => { calls.push(params); return { thread: { id: "native-thread" } }; } });
    expect(await f.run("conversation", blank, "/project", {})).toBe(true);
    expect(calls).toEqual([{ cwd: "/project", ...permissions, developerInstructions: "Project instructions" }]);
    expect(f.bindings.get("conversation")).toBe("native-thread");
    expect(f.events).toEqual(["context", "register", "bind", "active", "managed", "connected", "heartbeat"]);
    expect(await f.run("conversation", blank, "/project", {})).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("never replaces history, another agent, an absent checkout, or a saved thread", async () => {
    const f = fixture({ running: true, threadStart: async () => { throw new Error("must not start"); } });
    for (const data of [
      { ...blank, messages: [{}] },
      { ...blank, conversation: { ...blank.conversation, message_count: 1 } },
      { ...blank, conversation: { ...blank.conversation, agent_type: "claude_code" } },
    ]) expect(await f.run("conversation", data, "/project", {})).toBe(false);
    expect(await f.run("conversation", blank, null, {})).toBe(false);
    f.persisted.set("conversation", { threadId: "existing" });
    expect(await f.run("conversation", blank, "/project", {})).toBe(false);
  });

  test("waits for an ordinary launch, including one arriving during context fetch", async () => {
    const f = fixture({ running: true, threadStart: async () => { throw new Error("must not race start"); } });
    f.starts.set("conversation", "command");
    expect(await f.run("conversation", blank, "/project", {})).toBe(false);
    f.starts.clear();
    f.hooks.context = () => { f.starts.set("conversation", "command"); };
    expect(await f.run("conversation", blank, "/project", {})).toBe(false);
  });

  test("launch tracking ignores malformed and non-launch commands", () => {
    for (const command of ["start_session", "resume_session"]) {
      expect(sessionStartConversationId({ command, args: '{"conversation_id":"conv"}' })).toBe("conv");
      for (const args of ["{", "null", '{"conversation_id":1}']) expect(sessionStartConversationId({ command, args })).toBeUndefined();
    }
    expect(sessionStartConversationId({ command: "kill_session", args: '{"conversation_id":"conv"}' })).toBeUndefined();
  });

  test("blank TUI recovery skips the interactive update menu", () => {
    expect(buildBlankLaunchArgs("codex", null)).toContain("check_for_update_on_startup=false");
  });

  test("retains requested model, effort, and configured restrictions", () => {
    expect(blankCodexRecoveryParams({ ...blank, conversation: { ...blank.conversation, model: "gpt-6-astra", effort: "high" } }, "/project", { approvalPolicy: "on-request", sandbox: "read-only" }))
      .toMatchObject({ model: "gpt-6-astra", config: { model_reasoning_effort: "high" }, approvalPolicy: "on-request", sandbox: "read-only" });
  });
});
