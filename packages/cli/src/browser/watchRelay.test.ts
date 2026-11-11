import { describe, expect, test } from "bun:test";
import { runWatchRelay, type RelayAnswer, type RelayPush, type WatchRelayDeps } from "./watchRelay.js";
import type { WatchSink } from "./watchServer.js";

// The daemon half of the browser relay, on a fake clock: what the watch
// session produces reaches the relay as pushes, the newest frame only, input
// in the answer reaches the session, and the loop ends on a lapsed lease, on
// the session's own ending (pushed once), and on a relay that stopped answering.

function harness(answers: (push: RelayPush, n: number) => RelayAnswer | null) {
  let now = 1_000_000;
  const pushes: RelayPush[] = [];
  const inputs: unknown[] = [];
  let sink: WatchSink | null = null;
  let stopped = false;
  // Runs inside the loop's sleep: lets a test act "while the stream runs".
  const tickHooks: Array<(n: number) => void> = [];
  let ticks = 0;
  const deps: WatchRelayDeps = {
    push: async (msg) => {
      pushes.push(structuredClone(msg));
      return answers(msg, pushes.length);
    },
    startSession: (_opts, s) => {
      sink = s;
      return { input: (ev) => inputs.push(ev), stop: () => void (stopped = true) };
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      ticks++;
      for (const h of tickHooks) h(ticks);
    },
    log: () => {},
  };
  return {
    deps,
    pushes,
    inputs,
    sink: () => sink!,
    stopped: () => stopped,
    onTick: (h: (n: number) => void) => tickHooks.push(h),
  };
}

const args = { key: "sess-1", session_uuid: "sess-1" };

describe("runWatchRelay", () => {
  test("ready, frames and actions go out; only the newest frame of a burst is pushed", async () => {
    const h = harness((_m, n) => ({ stop: n >= 3 }));
    h.onTick((t) => {
      if (t !== 1) return;
      const s = h.sink();
      s.send({ type: "ready", targetId: "T1", title: "Login", url: "https://x.test", control: true });
      s.send({ type: "frame", data: "OLD", w: 10, h: 10 });
      s.send({ type: "frame", data: "NEW", w: 20, h: 10 });
      s.send({ type: "action", kind: "down", x: 0.5, y: 0.5, at: 5 });
    });
    await runWatchRelay(args, h.deps);
    // The loop's first push is an immediate heartbeat (it tells the viewer
    // the daemon answered); the session's output rides the next one.
    expect(h.pushes[0]).toEqual({ key: "sess-1" });
    const first = h.pushes[1]!;
    expect(first).toMatchObject({ key: "sess-1", frame: "NEW", frame_w: 20, frame_h: 10, control: true });
    expect(first.tab).toEqual({ id: "T1", title: "Login", url: "https://x.test" });
    expect(JSON.parse(first.actions!)).toHaveLength(1);
    // What was sent is not sent again: the next pushes are heartbeats.
    expect(h.pushes[2]).toEqual({ key: "sess-1" });
    expect(h.stopped()).toBe(true);
  });

  test("input in the answer reaches the session", async () => {
    const click = { kind: "mouse", type: "mousePressed", nx: 0.1, ny: 0.1 };
    const h = harness((_m, n) => (n === 1 ? { stop: false, input: [click], fast: true } : { stop: true }));
    await runWatchRelay(args, h.deps);
    expect(h.inputs).toEqual([click]);
  });

  test("the session's own ending is pushed once and ends the loop", async () => {
    const h = harness(() => ({ stop: false }));
    h.onTick((t) => {
      if (t === 1) h.sink().finish({ type: "error", code: "no-tab", message: "this session has not driven a browser tab" });
    });
    await runWatchRelay(args, h.deps);
    const ends = h.pushes.filter((p) => p.end);
    expect(ends).toHaveLength(1);
    expect(JSON.parse(ends[0]!.end!)).toEqual({ kind: "error", code: "no-tab", message: "this session has not driven a browser tab" });
    expect(h.pushes[h.pushes.length - 1]).toBe(h.pushes.find((p) => p.end)!);
  });

  test("a relay that stops answering ends the loop", async () => {
    const h = harness(() => null);
    await runWatchRelay(args, h.deps);
    expect(h.pushes).toHaveLength(6);
    expect(h.stopped()).toBe(true);
  });
});
