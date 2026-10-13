// The pane relay's protocol, pinned without tmux or a network.
//
// Everything expensive about this feature is a policy decision, not tmux: how
// often it writes, when it stops, and what it does when the far end goes quiet.
// runPaneStream takes all of that through deps, so the tests below ARE the
// contract — a change in write volume or in stop behaviour breaks one of them.

import { describe, expect, test } from "bun:test";
import { runPaneStream, capturePane, type PaneFramePush, type PaneSnapshot } from "./paneStream.js";
import {
  PANE_CAPTURE_INTERVAL_MS,
  PANE_HEARTBEAT_MS,
  bytesToHex,
  hexToBytes,
  isValidPaneTarget,
} from "@codecast/shared/contracts";

function snap(frame: string): PaneSnapshot {
  return { frame, cols: 80, rows: 24, cursorX: 3, cursorY: 5 };
}

/** Drive the loop on a clock we control: sleeps advance time instantly, so a
 *  test covering a minute of streaming runs in microseconds. */
function harness(opts: {
  screens: (Array<string | null>) | ((tick: number) => string | null);
  answer?: (n: number) => { stop: boolean; input?: string; fast?: boolean } | null;
}) {
  const pushes: PaneFramePush[] = [];
  /** Bytes the loop typed into the pane, with the clock time it happened. */
  const writes: Array<{ at: number; bytes: number[] }> = [];
  /** Clock time of each capture, so a test can assert the loop re-read the pane
   *  without sleeping first. */
  const captures: number[] = [];
  let clock = 0;
  let tick = 0;
  const screens = opts.screens;
  return {
    pushes,
    writes,
    captures,
    now: () => clock,
    run: () =>
      runPaneStream("cc-test", {
        capture: () => {
          captures.push(clock);
          const s = typeof screens === "function" ? screens(tick) : screens[Math.min(tick, screens.length - 1)];
          tick++;
          return s === null ? null : snap(s);
        },
        push: async (msg) => {
          pushes.push(msg);
          return opts.answer ? opts.answer(pushes.length) : { stop: false };
        },
        write: (_t, bytes) => {
          writes.push({ at: clock, bytes });
        },
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
  };
}

describe("runPaneStream", () => {
  test("an unchanged screen is not re-pushed — only heartbeats", async () => {
    // 40 ticks of a totally static pane. At a 400ms capture interval that is
    // 16 seconds of wall clock: one opening frame plus a heartbeat every four
    // seconds, NOT 40 writes.
    let n = 0;
    const h = harness({
      screens: () => "idle screen",
      answer: () => (++n >= 8 ? { stop: true } : { stop: false }),
    });
    await h.run();

    const frames = h.pushes.filter((p) => p.frame !== undefined);
    const beats = h.pushes.filter((p) => p.frame === undefined);
    expect(frames.length).toBe(1);
    expect(beats.length).toBeGreaterThan(0);
    // Heartbeats are spaced, not per-tick.
    expect(h.now()).toBeGreaterThanOrEqual(PANE_HEARTBEAT_MS * (beats.length - 1));
  });

  test("every change is pushed, with geometry and cursor", async () => {
    const h = harness({
      screens: ["one", "two", "three"],
      answer: (n) => ({ stop: n >= 3 }),
    });
    await h.run();

    const frames = h.pushes.filter((p) => p.frame !== undefined);
    expect(frames.map((f) => f.frame)).toEqual(["one", "two", "three"]);
    expect(frames[0]).toMatchObject({ cols: 80, rows: 24, cursor_x: 3, cursor_y: 5 });
  });

  test("a lapsed lease stops the loop — no stop message needed", async () => {
    const h = harness({ screens: ["a", "b", "c", "d", "e"], answer: () => ({ stop: true }) });
    await h.run();
    // The very first push comes back "nobody is watching", so it never captures
    // a second time.
    expect(h.pushes.length).toBe(1);
  });

  test("a vanished pane reports once and stops", async () => {
    const h = harness({ screens: ["a", null, "c"] });
    await h.run();
    expect(h.pushes.length).toBe(2);
    expect(h.pushes[1]).toEqual({ target: "cc-test", error: "pane is gone" });
  });

  test("pushes that fail are retried, then give up", async () => {
    // A relay that never answers must not leave the daemon capturing forever.
    const h = harness({ screens: (t) => `screen ${t}`, answer: () => null });
    await h.run();
    expect(h.pushes.length).toBe(6);
  });

  test("a transient push failure does not end the stream", async () => {
    let n = 0;
    const h = harness({
      screens: (t) => `screen ${t}`,
      answer: () => {
        n++;
        if (n <= 3) return null; // three dropped pushes in a row
        return { stop: n >= 8 };
      },
    });
    await h.run();
    expect(h.pushes.length).toBe(8);
  });

  test("a frame is re-sent after a failed push, so no screen is lost", async () => {
    // The failure is what makes this subtle: the screen changed, the push
    // dropped, and the NEXT capture is identical. Treating that as "unchanged"
    // would strand the viewer on a stale screen until the pane happened to
    // change again.
    let n = 0;
    const h = harness({
      screens: () => "the only screen",
      answer: () => {
        n++;
        if (n === 1) return null;
        return { stop: true };
      },
    });
    await h.run();
    const frames = h.pushes.filter((p) => p.frame !== undefined);
    expect(frames.length).toBe(2);
    expect(frames[1].frame).toBe("the only screen");
  });
});

describe("runPaneStream typing", () => {
  test("input from the relay is typed into the pane, decoded", async () => {
    let n = 0;
    const h = harness({
      screens: () => "prompt",
      // "hi\r" — an ordinary thing to send an agent.
      answer: () => (++n === 1 ? { stop: false, input: "68690d" } : { stop: true }),
    });
    await h.run();
    expect(h.writes.length).toBe(1);
    expect(h.writes[0].bytes).toEqual([0x68, 0x69, 0x0d]);
  });

  test("malformed input is dropped, not half-typed", async () => {
    // A truncated or corrupted payload must not reach the pane at all: typing
    // the first half of someone's keystrokes into an agent is worse than
    // typing none of them.
    let n = 0;
    const h = harness({
      screens: () => "prompt",
      answer: () => (++n === 1 ? { stop: false, input: "68zz" } : { stop: true }),
    });
    await h.run();
    expect(h.writes.length).toBe(0);
  });

  test("a keystroke is followed by an immediate re-capture, not a sleep", async () => {
    // The echo is the whole point: whoever typed sees nothing until the next
    // capture, so the loop must not nap first.
    let n = 0;
    const h = harness({
      screens: (t) => (t < 2 ? "prompt" : "prompt hi"),
      answer: () => {
        n++;
        if (n === 1) return { stop: false, input: "6869" };
        return n >= 2 ? { stop: true } : { stop: false };
      },
    });
    await h.run();
    // The write landed on the first capture, and the SECOND capture happened at
    // the same instant — no sleep between typing and looking.
    expect(h.writes[0].at).toBe(0);
    expect(h.captures.slice(0, 2)).toEqual([0, 0]);
  });

  test("typing speeds the loop up, and it settles back on its own", async () => {
    // One keystroke, then silence. The ticks right after it are at the typing
    // cadence; once the window passes, the loop returns to watching speed.
    let n = 0;
    const h = harness({
      screens: (t) => `screen ${t}`,
      answer: () => (++n === 1 ? { stop: false, input: "61" } : { stop: n > 60 }),
    });
    await h.run();
    // 3s of typing window at 100ms, then 400ms ticks: 60 pushes must span
    // clearly more than the window and clearly less than 60 watching ticks.
    expect(h.now()).toBeGreaterThan(3_000);
    expect(h.now()).toBeLessThan(60 * PANE_CAPTURE_INTERVAL_MS);
  });

  test("a focused viewer gets fast heartbeats on a pane that never changes", async () => {
    // Input can only travel on a push, so a quiet pane still has to push while
    // someone is at the keyboard — otherwise their first keystroke waits out
    // the idle heartbeat.
    let n = 0;
    const h = harness({
      screens: () => "static",
      answer: () => ({ stop: ++n >= 10, fast: true }),
    });
    await h.run();
    // 10 pushes inside the time ONE idle heartbeat would have taken.
    expect(h.pushes.length).toBe(10);
    expect(h.now()).toBeLessThan(PANE_HEARTBEAT_MS);
  });

  test("an unfocused viewer costs the same as before typing existed", async () => {
    let n = 0;
    const h = harness({
      screens: () => "static",
      answer: () => ({ stop: ++n >= 5, fast: false }),
    });
    await h.run();
    // Opening frame plus four heartbeats, one per PANE_HEARTBEAT_MS.
    expect(h.pushes.filter((p) => p.frame !== undefined).length).toBe(1);
    expect(h.now()).toBeGreaterThanOrEqual(4 * PANE_HEARTBEAT_MS);
  });
});

describe("hex transport", () => {
  test("round-trips every byte value, including NUL and high bytes", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(hexToBytes(bytesToHex(all))).toEqual([...all]);
  });

  test("survives the sequences a terminal actually sends", () => {
    for (const seq of ["\x1b[A", "\x03", "\x1b", "\r", "\x7f", "é", "🎉"]) {
      const bytes = new TextEncoder().encode(seq);
      expect(hexToBytes(bytesToHex(bytes))).toEqual([...bytes]);
    }
  });

  test("rejects anything that isn't clean lowercase hex", () => {
    for (const bad of ["6", "6g", "0X41", "68 69", "ABCD"]) expect(hexToBytes(bad)).toBeNull();
  });

  test("empty means empty, not invalid", () => {
    expect(hexToBytes("")).toEqual([]);
  });
});

describe("isValidPaneTarget", () => {
  test("accepts the pane names the daemon actually mints", () => {
    for (const t of ["cc-abc123", "cast-term-1a2b", "cc-resume-f61304a3:0.0", "codex-x1:1.2"]) {
      expect(isValidPaneTarget(t)).toBe(true);
    }
  });

  test("rejects junk, format characters and empty targets", () => {
    for (const t of ["", "a b", "a;b", "#{pane_id}", "$(whoami)", "a".repeat(121)]) {
      expect(isValidPaneTarget(t)).toBe(false);
    }
  });
});

describe("capturePane", () => {
  test("refuses an invalid target before ever spawning tmux", () => {
    expect(capturePane("#{pane_id}")).toBeNull();
  });
});
