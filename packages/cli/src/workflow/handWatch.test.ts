// A hand station ends on quiet, never on working long (ct-98764), on a simulated clock.
import { describe, expect, test } from "bun:test";
import { HandWatch, handTimeouts, steadyTail } from "./handWatch";
import { ParkedClock } from "./parkedClock";
import { loadScaledMs, machineLoadFactor } from "../machineLoad";

const MIN = 60_000;

/** A clock the test moves: awake time and wall time advance together. */
function simulated() {
  let now = 1_000_000;
  const clock = new ParkedClock(now, () => now, () => now);
  return { clock, advance: (ms: number) => { now += ms; } };
}

describe("a hand's wait", () => {
  test("a hand that keeps working past the old 30 minutes is not given up on", () => {
    const { clock, advance } = simulated();
    const watch = new HandWatch(clock, handTimeouts({}, {}), () => 1);
    for (let t = 0; t < 120; t += 5) {
      advance(5 * MIN);
      watch.active();
      expect(watch.over()).toBeNull();
    }
  });

  test("a silent hand is given up on once its quiet window passes", () => {
    const { clock, advance } = simulated();
    const watch = new HandWatch(clock, handTimeouts({}, {}), () => 1);
    advance(10 * MIN);
    watch.active();
    advance(29 * MIN);
    expect(watch.over()).toBeNull();
    advance(1 * MIN);
    expect(watch.over()).toBe("showed no work for 30m");
  });

  test("a hand that never stops ends at its station's limit", () => {
    const { clock, advance } = simulated();
    const watch = new HandWatch(clock, handTimeouts({ timeout: 3600 }, {}), () => 1);
    for (let t = 0; t < 55; t += 5) {
      advance(5 * MIN);
      watch.active();
    }
    expect(watch.over()).toBeNull();
    advance(5 * MIN);
    watch.active();
    expect(watch.over()).toBe("ran 60m, its station's limit");
  });

  test("time the hand spends parked is not quiet", () => {
    const { clock, advance } = simulated();
    const watch = new HandWatch(clock, handTimeouts({}, {}), () => 1);
    advance(20 * MIN);
    clock.beginPoll();
    clock.park();
    advance(60 * MIN);
    clock.beginPoll();
    clock.park();
    expect(watch.over()).toBeNull();
  });

  test("a loaded machine stretches the quiet window, at most four times", () => {
    const { clock, advance } = simulated();
    let load = 3;
    const watch = new HandWatch(clock, handTimeouts({}, {}), () => load);
    expect(watch.idleWindowMs()).toBe(90 * MIN);
    advance(60 * MIN);
    expect(watch.over()).toBeNull();
    advance(30 * MIN);
    expect(watch.over()).toBe("showed no work for 90m");
    load = 50;
    expect(watch.idleWindowMs()).toBe(120 * MIN);
  });
});

describe("a pane's tail as work", () => {
  test("a hung TUI's ticking clock and spinner are no work; new output and a moving token count are", () => {
    const pane = (status: string, body = "● Bash(bun test)") => `${body}\n${status}\n> `;
    // Claude Code and Codex status lines a second apart, the agent hung.
    expect(steadyTail(pane("✻ Thinking… (12m 3s · ↓ 1.2k tokens · esc to interrupt)"))).toBe(steadyTail(pane("✶ Thinking… (12m 4s · ↓ 1.2k tokens · esc to interrupt)")));
    expect(steadyTail(pane("• Working (41s • esc to interrupt)"))).toBe(steadyTail(pane("◦ Working (42s • esc to interrupt)")));
    expect(steadyTail(pane("✻ Thinking… (12m 3s · ↓ 1.2k tokens · esc to interrupt)"))).not.toBe(steadyTail(pane("✻ Thinking… (12m 9s · ↓ 1.4k tokens · esc to interrupt)")));
    expect(steadyTail(pane("• Working (41s • esc to interrupt)"))).not.toBe(steadyTail(pane("• Working (49s • esc to interrupt)", "● Bash(bun test)\n  ⎿ 12 pass")));
  });
});

describe("the load stretch", () => {
  test("up to two runnable threads per core is an idle machine; beyond, the run queue per core", () => {
    expect(machineLoadFactor(0.5)).toBe(1);
    expect(machineLoadFactor(2)).toBe(1);
    expect(machineLoadFactor(6.5)).toBe(6.5);
    expect(loadScaledMs(1000, 8, 1)).toBe(1000);
    expect(loadScaledMs(1000, 8, 3)).toBe(3000);
    expect(loadScaledMs(1000, 4, 10)).toBe(4000);
  });
});
