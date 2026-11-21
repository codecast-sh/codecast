import { describe, expect, test } from "bun:test";
import { ParkedClock } from "./parkedClock.js";

// Two time sources the test moves by hand: awake (performance.now, which stops
// while the machine sleeps) and wall (Date.now, which runs through a sleep).
function clocks(startWall = 1_000_000, awakeAt = 5_000) {
  const t = { wall: startWall, awake: awakeAt };
  const run = (ms: number) => { t.wall += ms; t.awake += ms; };
  const sleep = (ms: number) => { t.wall += ms; };
  return { t, run, sleep };
}

describe("ParkedClock", () => {
  test("counts ordinary awake time", () => {
    const { t, run } = clocks();
    const clock = new ParkedClock(t.wall, () => t.awake, () => t.wall);
    expect(clock.elapsed()).toBe(0);
    run(60_000);
    clock.beginPoll();
    expect(clock.elapsed()).toBe(60_000);
  });

  test("leaves out a machine sleep", () => {
    const { t, run, sleep } = clocks();
    const clock = new ParkedClock(t.wall, () => t.awake, () => t.wall);
    run(10 * 60_000);
    sleep(5 * 3_600_000);
    clock.beginPoll();
    expect(clock.elapsed()).toBe(10 * 60_000);
    run(60_000);
    expect(clock.elapsed()).toBe(11 * 60_000);
  });

  test("counts wall time between the run's start and the clock's creation", () => {
    const { t, run } = clocks();
    const startMs = t.wall;
    run(2_000);
    const clock = new ParkedClock(startMs, () => t.awake, () => t.wall);
    expect(clock.elapsed()).toBe(2_000);
    run(3_000);
    expect(clock.elapsed()).toBe(5_000);
  });

  test("leaves out a park, from the poll that finds it to the first that does not", () => {
    const { t, run } = clocks();
    const clock = new ParkedClock(t.wall, () => t.awake, () => t.wall);
    run(1_000);
    clock.beginPoll();
    expect(clock.park()).toBe(true);
    run(10_000);
    clock.beginPoll();
    expect(clock.park()).toBe(false);
    expect(clock.elapsed()).toBe(1_000);
    run(10_000);
    clock.beginPoll(); // not parked any more: the park ends here
    expect(clock.elapsed()).toBe(1_000);
    run(4_000);
    expect(clock.elapsed()).toBe(5_000);
  });

  test("a park from the clock's first instant still counts as a park", () => {
    const { t, run } = clocks(1_000_000, 0);
    const clock = new ParkedClock(t.wall, () => t.awake, () => t.wall);
    expect(clock.park()).toBe(true);
    run(10_000);
    expect(clock.elapsed()).toBe(0);
  });

  test("a sleep inside a park and one outside it are both left out", () => {
    const { t, run, sleep } = clocks();
    const clock = new ParkedClock(t.wall, () => t.awake, () => t.wall);
    run(1_000);
    clock.beginPoll();
    clock.park();
    sleep(3_600_000);
    run(1_000);
    clock.beginPoll();
    clock.park();
    run(1_000);
    clock.beginPoll(); // park ends
    sleep(3_600_000);
    run(2_000);
    clock.beginPoll();
    expect(clock.elapsed()).toBe(3_000);
  });

  test("defaults to the process's monotonic clock", () => {
    const clock = new ParkedClock(Date.now());
    const e = clock.elapsed();
    expect(e).toBeGreaterThanOrEqual(0);
    expect(e).toBeLessThan(1_000);
  });
});
