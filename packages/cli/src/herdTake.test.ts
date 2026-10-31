import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatProgress, holdSwap, releaseSwap, requestHerdTake, resolveSessionRef, swapHeld, takeSessionIntoHerdr, type Busy, type HerdTakeDeps, type HerdTakeRequest } from "./herdTake.js";

const SID = "11111111-2222-3333-4444-555555555555";
const req: HerdTakeRequest = { sessionId: SID, socketPath: "/tmp/herdr.sock", workspaceId: "w1" };

function fixture(over: Partial<HerdTakeDeps> = {}) {
  const calls: string[] = [];
  const busyQueue: Array<Busy | null> = [];
  const state = { tmux: "cc-claude-abc:0.0" as string | null, proc: null as { pid: number } | null, heldDuringKill: false, heldWhileWaiting: false, heldAtClose: null as boolean | null, heldAtBuild: null as boolean | null };
  const deps: HerdTakeDeps = {
    agentType: () => "claude",
    liveTarget: async () => ({ tmuxTarget: state.tmux, proc: state.proc }),
    busy: () => (busyQueue.length ? busyQueue.shift()! : null),
    deliveryInFlight: () => false,
    wait: async () => { state.heldWhileWaiting ||= swapHeld(SID); calls.push("wait"); },
    killRefusal: async () => null,
    prepareLaunch: async () => { calls.push("prepare"); return { cwd: "/work", label: "My title" }; },
    kill: async () => { state.heldDuringKill = swapHeld(SID); calls.push("kill"); state.tmux = null; },
    buildLine: async () => { state.heldAtBuild = swapHeld(SID); calls.push("build"); return { line: "claude --resume x" }; },
    launch: async () => { calls.push("launch"); return "w1:p9"; },
    closePane: async () => { state.heldAtClose = swapHeld(SID); calls.push("close"); },
    agentUp: async (_s, _ms, tick) => { tick(5); return true; },
    ...over,
  };
  const events: string[] = [];
  const run = (r: HerdTakeRequest = req, signal = new AbortController().signal) => takeSessionIntoHerdr(r, deps, (m, info) => events.push(formatProgress(m, info?.elapsedSec)), signal);
  return { deps, calls, busyQueue, state, events, run };
}

describe("swap hold", () => {
  test("holds until released; only the crash backstop expires it", () => {
    holdSwap("s1", 1000);
    expect(swapHeld("s1", 1000 + 5 * 60_000)).toBe(true);
    expect(swapHeld("s1", 1000 + 11 * 60_000)).toBe(false);
    holdSwap("s2", 1000);
    releaseSwap("s2");
    expect(swapHeld("s2", 1001)).toBe(false);
  });
});

describe("takeSessionIntoHerdr", () => {
  test("happy path: ordered progress, hold taken only around the swap and released after", async () => {
    const f = fixture();
    expect(await f.run()).toEqual({ ok: true, paneId: "w1:p9", label: "My title" });
    expect(f.events).toEqual([
      "looking for the session's tmux copy",
      "holding message delivery to the session",
      "stopping tmux cc-claude-abc",
      'opening herdr tab "My title"',
      "starting claude in pane w1:p9",
      "waiting for claude to come up · 5s",
    ]);
    expect(f.calls).toEqual(["prepare", "kill", "build", "launch"]);
    expect(f.state.heldDuringKill).toBe(true);
    expect(f.state.heldAtBuild).toBe(true);
    expect(swapHeld(SID)).toBe(false);
  });

  test("a launch that left a pinned account says so before the tab opens", async () => {
    const note = "note: runs on your keychain login (was work); it won't follow cast account switches";
    const f = fixture({ buildLine: async () => ({ line: "claude --resume x", note }) });
    expect((await f.run()).ok).toBe(true);
    expect(f.events.indexOf(note)).toBeGreaterThan(f.events.indexOf("stopping tmux cc-claude-abc"));
    expect(f.events.indexOf(note)).toBeLessThan(f.events.findIndex((e) => e.startsWith("opening herdr tab")));
  });

  test("the transcript is only touched after the old agent is gone", async () => {
    const f = fixture();
    await f.run();
    expect(f.calls.indexOf("build")).toBeGreaterThan(f.calls.indexOf("kill"));
    expect(f.calls.indexOf("prepare")).toBeLessThan(f.calls.indexOf("kill"));
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

  test("a wait that goes on says so every 15s with the time so far, as the same step", async () => {
    let clock = 0;
    let polls = 0;
    const f = fixture({ now: () => clock, busy: () => (polls++ < 12 ? { kind: "turn", detail: "the turn to finish (working)" } : null), wait: async () => { clock += 5000; } });
    const infos: Array<{ message: string; step?: string; elapsedSec?: number }> = [];
    const result = await takeSessionIntoHerdr(req, f.deps, (message, info) => infos.push({ message, ...info }), new AbortController().signal);
    expect(result.ok).toBe(true);
    const waiting = infos.filter((e) => e.message.startsWith("agent is active"));
    expect(waiting.map((e) => e.elapsedSec)).toEqual([undefined, 15, 30, 45]);
    expect(new Set(waiting.map((e) => e.step))).toEqual(new Set(["busy:turn"]));
    expect(waiting[1].message).toBe("agent is active — waiting for the turn to finish (working)");
    expect(formatProgress(waiting[3].message, waiting[3].elapsedSec)).toBe("agent is active — waiting for the turn to finish (working) · 45s");
  });

  test("a message that makes the agent busy between the idle check and the kill sends the take back to waiting", async () => {
    const f = fixture();
    // idle at the poll, busy at the re-check under the hold, then idle for good
    f.busyQueue.push(null, { kind: "turn", detail: "the turn to finish" }, null, null);
    expect((await f.run()).ok).toBe(true);
    expect(f.calls.filter((c) => c === "kill")).toHaveLength(1);
    expect(f.events.filter((e) => e.startsWith("agent is active"))).toEqual(["agent is active — waiting for the turn to finish"]);
    expect(f.state.heldWhileWaiting).toBe(false);
    expect(f.calls.indexOf("kill")).toBeGreaterThan(f.calls.indexOf("wait"));
  });

  test("waits under the hold for a delivery already in flight to land before re-checking", async () => {
    let inFlight = 2;
    const f = fixture({ deliveryInFlight: () => inFlight-- > 0 });
    f.busyQueue.push(null, { kind: "turn", detail: "the turn to finish" }, null, null);
    expect((await f.run()).ok).toBe(true);
    expect(f.calls.filter((c) => c === "kill")).toHaveLength(1);
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
    expect(f.calls).toEqual(["prepare", "kill", "build", "launch"]);
    expect(swapHeld(SID)).toBe(false);
  });

  test("two concurrent takes of one session launch once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const f = fixture();
    f.deps.launch = async () => { f.calls.push("launch"); await gate; return "w1:p9"; };
    const first = f.run();
    await new Promise((r) => setTimeout(r, 0));
    expect(await f.run()).toEqual({ ok: false, error: "a take of this session is already running" });
    release();
    expect((await first).ok).toBe(true);
    expect(f.calls.filter((c) => c === "launch")).toHaveLength(1);
    expect((await f.run()).ok).toBe(false);
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
    expect(f.calls).toEqual(["prepare", "kill"]);
    expect(swapHeld(SID)).toBe(false);
  });

  test("when claude never comes up the pane is closed before the hold lifts", async () => {
    const f = fixture({ agentUp: async () => false });
    const result = await f.run();
    expect(result.ok === false && result.error).toContain("was closed");
    expect(f.calls.at(-1)).toBe("close");
    expect(f.state.heldAtClose).toBe(true);
    expect(swapHeld(SID)).toBe(false);
  });

  test("a failing command build after the kill reports the session as down and releases the hold", async () => {
    const f = fixture({ buildLine: async () => { throw new Error("no transcript"); } });
    const result = await f.run();
    expect(result.ok === false && result.error).toContain("the tmux copy is gone");
    expect(f.calls).not.toContain("launch");
    expect(swapHeld(SID)).toBe(false);
  });
});

describe("requestHerdTake", () => {
  function daemon(handler: (r: Request) => Response) {
    const server = Bun.serve({ port: 0, fetch: handler });
    const dir = mkdtempSync(join(tmpdir(), "herd-take-client-"));
    writeFileSync(join(dir, "hook-port"), String(server.port));
    writeFileSync(join(dir, "loopback-identity.json"), JSON.stringify({ port: server.port, token: "loopback-tok", created_at: 1 }));
    return { dir, stop: () => { server.stop(true); rmSync(dir, { recursive: true, force: true }); } };
  }

  test("presents the loopback bearer and hands each streamed line to the caller", async () => {
    const got = { auth: "" };
    const d = daemon((r) => {
      got.auth = r.headers.get("authorization") ?? "";
      return new Response('{"type":"progress","message":"one"}\n{"type":"progress","message":"two"}\n{"type":"done","paneId":"w1:p3","label":"T"}\n');
    });
    try {
      const seen: string[] = [];
      expect(await requestHerdTake(req, (p) => seen.push(p.message), d.dir)).toEqual({ ok: true, paneId: "w1:p3", label: "T" });
      expect(seen).toEqual(["one", "two"]);
      expect(got.auth).toBe("Bearer loopback-tok");
    } finally { d.stop(); }
  });

  test("reports an HTTP refusal by status, not as a parse error", async () => {
    const d = daemon(() => new Response("unauthorized", { status: 401 }));
    try {
      expect(await requestHerdTake(req, () => {}, d.dir)).toEqual({ ok: false, error: "daemon answered HTTP 401" });
    } finally { d.stop(); }
  });

  test("an error event ends the take as a failure", async () => {
    const d = daemon(() => new Response('{"type":"error","error":"nope"}\n'));
    try {
      expect(await requestHerdTake(req, () => {}, d.dir)).toEqual({ ok: false, error: "nope" });
    } finally { d.stop(); }
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
