import { describe, expect, test } from "bun:test";
import { teardownConversationBackends } from "./daemon.js";

// Regression test for the cross-agent split-brain (ct-33497): a conversation was
// started as BOTH Codex (app-server thread) and Claude (tmux) ~13s apart because
// the second start_session never tore the first backend down. teardown must drop
// EVERY bound backend regardless of agent type, so exactly one survives the next
// start.

type ThreadEntry = { threadId: string; conversationId: string };

function makeDeps(overrides: Partial<Parameters<typeof teardownConversationBackends>[1]> = {}) {
  const calls = {
    killedTmux: [] as string[],
    deletedStarted: [] as string[],
    stoppedHeartbeat: [] as string[],
    forgotPersisted: [] as string[],
    interrupted: [] as string[],
  };
  const appServerConversations = new Map<string, string>();
  const appServerThreads = new Map<string, ThreadEntry>();
  const startedTmux = new Map<string, { tmuxSession: string }>();

  const deps = {
    appServerConversations,
    appServerThreads,
    startedTmux,
    killTmuxTree: async (s: string) => { calls.killedTmux.push(s); },
    deleteStarted: (c: string) => { calls.deletedStarted.push(c); },
    stopHeartbeat: (s: string) => { calls.stoppedHeartbeat.push(s); },
    forgetPersisted: (c: string) => { calls.forgotPersisted.push(c); },
    interruptActiveTurn: async (t: string) => { calls.interrupted.push(t); },
    ...overrides,
  };
  return { deps, calls, appServerConversations, appServerThreads, startedTmux };
}

function bindCodex(d: ReturnType<typeof makeDeps>, conv: string, thread: string) {
  d.appServerConversations.set(conv, thread);
  d.appServerThreads.set(thread, { threadId: thread, conversationId: conv });
}

describe("teardownConversationBackends", () => {
  test("split-brain: kills BOTH the Codex thread and the Claude tmux", async () => {
    const d = makeDeps();
    bindCodex(d, "conv-1", "thread-x");
    d.startedTmux.set("conv-1", { tmuxSession: "cc-claude-conv1suffix" });

    const r = await teardownConversationBackends("conv-1", d.deps);

    expect(r.killedAppServer).toBe(true);
    expect(r.killedTmux).toBe(true);
    expect(r.appServerThreadId).toBe("thread-x");
    // App-server registration fully dropped (both sides of the 1:1 mapping).
    expect(d.appServerConversations.size).toBe(0);
    expect(d.appServerThreads.size).toBe(0);
    // tmux killed + started-session entry removed.
    expect(d.calls.killedTmux).toEqual(["cc-claude-conv1suffix"]);
    expect(d.calls.deletedStarted).toEqual(["conv-1"]);
    expect(d.calls.stoppedHeartbeat).toEqual(["thread-x"]);
    expect(d.calls.forgotPersisted).toEqual(["conv-1"]);
    expect(d.calls.interrupted).toEqual(["thread-x"]);
  });

  test("Codex-only: tears down the thread, no tmux touched", async () => {
    const d = makeDeps();
    bindCodex(d, "conv-2", "thread-y");

    const r = await teardownConversationBackends("conv-2", d.deps);

    expect(r).toMatchObject({ killedAppServer: true, killedTmux: false, appServerThreadId: "thread-y" });
    expect(d.appServerConversations.size).toBe(0);
    expect(d.calls.killedTmux).toEqual([]);
  });

  test("Claude-only: kills the tmux, no app-server touched", async () => {
    const d = makeDeps();
    d.startedTmux.set("conv-3", { tmuxSession: "cc-claude-conv3" });

    const r = await teardownConversationBackends("conv-3", d.deps);

    expect(r).toMatchObject({ killedAppServer: false, killedTmux: true });
    expect(r.appServerThreadId).toBeUndefined();
    expect(d.calls.killedTmux).toEqual(["cc-claude-conv3"]);
    expect(d.calls.deletedStarted).toEqual(["conv-3"]);
    expect(d.calls.interrupted).toEqual([]);
  });

  test("nothing bound: pure no-op (first start of a fresh conversation)", async () => {
    const d = makeDeps();
    const r = await teardownConversationBackends("conv-new", d.deps);
    expect(r).toEqual({ killedAppServer: false, killedTmux: false, appServerThreadId: undefined });
    expect(d.calls.killedTmux).toEqual([]);
    expect(d.calls.deletedStarted).toEqual([]);
  });

  test("a failing turn-interrupt still tears the thread down", async () => {
    const d = makeDeps({
      interruptActiveTurn: async () => { throw new Error("app-server down"); },
    });
    bindCodex(d, "conv-4", "thread-z");

    const r = await teardownConversationBackends("conv-4", d.deps);

    expect(r.killedAppServer).toBe(true);
    expect(d.appServerConversations.size).toBe(0);
    expect(d.calls.stoppedHeartbeat).toEqual(["thread-z"]);
  });

  test("an invalid tmux target is left alone", async () => {
    const d = makeDeps({ isValidTmuxTarget: () => false });
    d.startedTmux.set("conv-5", { tmuxSession: "garbage; rm -rf" });

    const r = await teardownConversationBackends("conv-5", d.deps);

    expect(r.killedTmux).toBe(false);
    expect(d.calls.killedTmux).toEqual([]);
    expect(d.calls.deletedStarted).toEqual([]);
  });
});
