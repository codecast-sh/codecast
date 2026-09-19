import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServer } from "./codexAppServer";
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

const binary = process.env.CODEX_PERMISSIONS_NATIVE_BINARY;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test.skipIf(!binary)("native Codex recovery accepts the original first turn without a TUI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-blank-recovery-"));
  const home = join(dir, "codex");
  const cwd = join(dir, "project");
  mkdirSync(home); mkdirSync(cwd);
  const requests: any[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push(await request.json());
    const answer = { type: "message", role: "assistant", id: "answer", status: "completed", content: [{ type: "output_text", text: "RECOVERED", annotations: [] }] };
    const events = [
      { type: "response.created", response: { id: "response", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...answer, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", item_id: "answer", output_index: 0, content_index: 0, delta: "RECOVERED" },
      { type: "response.output_item.done", output_index: 0, item: answer },
      { type: "response.completed", response: { id: "response", status: "completed", output: [answer], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    ];
    return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  const wrapper = join(dir, "codex-wrapper");
  writeFileSync(wrapper, `#!/bin/sh\nunset OPENAI_API_KEY\nexport CODEX_HOME=${quote(home)}\nexec ${quote(binary!)} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(home, "config.toml"), `model = "gpt-6-astra"\nmodel_provider = "recovery_test"\n[model_providers.recovery_test]\nname = "Local recovery test"\nbase_url = "http://127.0.0.1:${provider.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
  const server = new CodexAppServer({ codexBinary: wrapper, log: () => {}, defaultPermissions: () => permissions });
  server.on("error", () => {});
  try {
    const ready = once(server, "ready"); server.start(); await ready;
    const f = fixture(server);
    expect(await f.run("conversation", blank, cwd, {})).toBe(true);
    const done = once(server, "turnCompleted");
    await server.turnStart({ threadId: f.bindings.get("conversation")!, input: [{ type: "text", text: "Original pending prompt: reply RECOVERED." }] });
    expect((await done)[3]).toBe("completed");
    expect(JSON.stringify(requests)).toContain("Original pending prompt");
    expect(await f.run("conversation", blank, cwd, {})).toBe(false);
  } finally {
    const exited = server.running ? once(server, "exited") : null;
    server.stop(); if (exited) await exited;
    provider.stop(true); rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
