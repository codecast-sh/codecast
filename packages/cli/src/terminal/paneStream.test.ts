// The pane relay's protocol, pinned without tmux or a network.
//
// Everything expensive about this feature is a policy decision, not tmux: how
// often it writes, when it stops, and what it does when the far end goes quiet.
// runPaneStream takes all of that through deps, so the tests below ARE the
// contract — a change in write volume or in stop behaviour breaks one of them.

import { describe, expect, test } from "bun:test";
import { runPaneStream, capturePane, type PaneFramePush, type PaneSnapshot } from "./paneStream.js";
import { PANE_HEARTBEAT_MS, isValidPaneTarget } from "@codecast/shared/contracts";

function snap(frame: string): PaneSnapshot {
  return { frame, cols: 80, rows: 24, cursorX: 3, cursorY: 5 };
}

/** Drive the loop on a clock we control: sleeps advance time instantly, so a
 *  test covering a minute of streaming runs in microseconds. */
function harness(opts: {
  screens: (Array<string | null>) | ((tick: number) => string | null);
  answer?: (n: number) => { stop: boolean } | null;
}) {
  const pushes: PaneFramePush[] = [];
  let clock = 0;
  let tick = 0;
  const screens = opts.screens;
  return {
    pushes,
    now: () => clock,
    run: () =>
      runPaneStream("cc-test", {
        capture: () => {
          const s = typeof screens === "function" ? screens(tick) : screens[Math.min(tick, screens.length - 1)];
          tick++;
          return s === null ? null : snap(s);
        },
        push: async (msg) => {
          pushes.push(msg);
          return opts.answer ? opts.answer(pushes.length) : { stop: false };
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
