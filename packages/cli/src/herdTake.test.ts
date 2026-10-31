import { describe, expect, test } from "bun:test";
import { holdSwap, releaseSwap, resolveSessionRef, swapHeld, takeSessionIntoHerdr, type Busy, type HerdTakeDeps } from "./herdTake.js";

const SID = "11111111-2222-3333-4444-555555555555";
const req = { sessionId: SID, socketPath: "/tmp/herdr.sock", workspaceId: "w1" };

function fixture(over: Partial<HerdTakeDeps> = {}) {
  const calls: string[] = [];
  const busyQueue: Array<Busy | null> = [];
  const state = { tmux: "cc-claude-abc:0.0" as string | null, proc: null as { pid: number } | null, heldDuringKill: false, heldWhileWaiting: false };
  const deps: HerdTakeDeps = {
    agentType: () => "claude",
    liveTarget: async () => ({ tmuxTarget: state.tmux, proc: state.proc }),
    busy: () => (busyQueue.length ? busyQueue.shift()! : null),
    wait: async () => { state.heldWhileWaiting ||= swapHeld(SID); calls.push("wait"); },
    killRefusal: async () => null,
    prepareLaunch: async () => ({ cwd: "/work", label: "My title", line: () => "claude --resume x" }),
    kill: async () => { state.heldDuringKill = swapHeld(SID); calls.push("kill"); state.tmux = null; },
    launch: async () => { calls.push("launch"); return "w1:p9"; },
    agentUp: async (_s, _ms, tick) => { tick(5); return true; },
    ...over,
  };
  const events: string[] = [];
  const run = (r = req, signal = new AbortController().signal) => takeSessionIntoHerdr(r, deps, (m) => events.push(m), signal);
  return { deps, calls, busyQueue, state, events, run };
}

describe("swap hold", () => {
  test("holds until released, and an expired hold is ignored", () => {
    holdSwap("s1", 1000);
    expect(swapHeld("s1", 1000 + 59_000)).toBe(true);
    expect(swapHeld("s1", 1000 + 61_000)).toBe(false);
    holdSwap("s2", 1000);
    releaseSwap("s2");
    expect(swapHeld("s2", 1001)).toBe(false);
  });
});

describe("takeSessionIntoHerdr", () => {
  test("happy path: ordered progress, hold taken only around the kill and released after", async () => {
    const f = fixture();
    expect(await f.run()).toEqual({ ok: true, paneId: "w1:p9", label: "My title" });
    expect(f.events).toEqual([
      "looking for the session's tmux copy",
      "holding message delivery to the session",
      "stopping tmux cc-claude-abc",
      'opening herdr tab "My title"',
      "starting claude in pane w1:p9",
      "waiting for claude to come up (5s)",
    ]);
    expect(f.calls).toEqual(["kill", "launch"]);
    expect(f.state.heldDuringKill).toBe(true);
    expect(swapHeld(SID)).toBe(false);
  });

  test("a busy agent is waited out, re-announced when the cause changes, with no hold until idle", async () => {
    const f = fixture();
    f.busyQueue.push({ kind: "turn", detail: "the turn to finish" }, { kind: "turn", detail: "the turn to finish" }, { kind: "background", detail: "background work to finish" });
    expect((await f.run()).ok).toBe(true);
    expect(f.events.filter((e) => e.startsWith("agent is"))).toEqual([
      "agent is active — waiting for the turn to finish",
      "agent is active — waiting for background work to finish",
      "agent is idle",
    ]);
    expect(f.calls.filter((c) => c === "wait")).toHaveLength(3);
    expect(f.state.heldWhileWaiting).toBe(false);
    expect(f.calls.indexOf("kill")).toBeGreaterThan(f.calls.lastIndexOf("wait"));
  });

  test("a hang-up while waiting does nothing: no hold, no kill, no launch", async () => {
    const abort = new AbortController();
    const f = fixture({ busy: () => ({ kind: "turn", detail: "the turn to finish" }), wait: async () => { abort.abort(); } });
    const result = await f.run(req, abort.signal);
    expect(result).toEqual({ ok: false, error: "cancelled while waiting for the agent" });
    expect(f.calls).toEqual([]);
    expect(swapHeld(SID)).toBe(false);
  });

  test("--force does not wait", async () => {
    const f = fixture({ busy: () => ({ kind: "turn", detail: "x" }) });
    expect((await f.run({ ...req, force: true })).ok).toBe(true);
    expect(f.calls).not.toContain("wait");
  });

  test("a hang-up after the kill does not stop the launch", async () => {
    const abort = new AbortController();
    const f = fixture();
    f.deps.kill = async () => { f.calls.push("kill"); f.state.tmux = null; abort.abort(); };
    expect((await f.run(req, abort.signal)).ok).toBe(true);
    expect(f.calls).toEqual(["kill", "launch"]);
    expect(swapHeld(SID)).toBe(false);
  });

  test("refuses a non-claude session", async () => {
    const f = fixture({ agentType: () => "codex" });
    expect(await f.run()).toEqual({ ok: false, error: "only claude sessions can be taken into herdr (this one is codex)" });
    expect(f.calls).toEqual([]);
  });

  test("refuses a session with no live tmux copy", async () => {
    const f = fixture();
    f.state.tmux = null;
    expect(await f.run()).toEqual({ ok: false, error: "the session has no live tmux copy to take" });
  });

  test("reports an agent that already runs outside tmux", async () => {
    const f = fixture();
    f.state.tmux = null;
    f.state.proc = { pid: 42 };
    const result = await f.run();
    expect(result.ok === false && result.error).toContain("already runs outside tmux (pid 42)");
    expect(f.calls).toEqual([]);
  });

  test("refuses, without killing, when the tmux server is shared", async () => {
    const f = fixture({ killRefusal: async () => "tmux server also hosts cc-claude-other" });
    expect(await f.run()).toEqual({ ok: false, error: "tmux server also hosts cc-claude-other" });
    expect(f.calls).toEqual([]);
    expect(swapHeld(SID)).toBe(false);
  });

  test("never starts a second copy when the old one survives the kill", async () => {
    const f = fixture({ kill: async () => { f.calls.push("kill"); } });
    const result = await f.run();
    expect(result.ok === false && result.error).toContain("still running after the kill");
    expect(f.calls).toEqual(["kill"]);
    expect(swapHeld(SID)).toBe(false);
  });

  test("releases the hold when claude never comes up", async () => {
    const f = fixture({ agentUp: async () => false });
    const result = await f.run();
    expect(result.ok === false && result.error).toContain("did not start");
    expect(swapHeld(SID)).toBe(false);
  });
});

describe("resolveSessionRef", () => {
  const map = { "aaaaaaaa-1111-2222-3333-444444444444": "jx7c6zk0000000000000000000000001", "bbbbbbbb-1111-2222-3333-444444444444": "jx7c6zk0000000000000000000000002" };
  test("takes a full session id as is", () => {
    expect(resolveSessionRef("cccccccc-1111-2222-3333-444444444444", map)).toEqual({ sessionId: "cccccccc-1111-2222-3333-444444444444" });
  });
  test("finds a session by session-id prefix or conversation id", () => {
    expect(resolveSessionRef("aaaaaaaa", map)).toEqual({ sessionId: "aaaaaaaa-1111-2222-3333-444444444444" });
    expect(resolveSessionRef("jx7c6zk0000000000000000000000002", map)).toEqual({ sessionId: "bbbbbbbb-1111-2222-3333-444444444444" });
  });
  test("refuses an ambiguous or unknown reference", () => {
    expect("error" in resolveSessionRef("jx7c6zk", map)).toBe(true);
    expect("error" in resolveSessionRef("zzzzzzzz", map)).toBe(true);
  });
});
