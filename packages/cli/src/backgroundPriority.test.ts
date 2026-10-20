import { beforeEach, expect, test } from "bun:test";
import { applyBackground, resetBackgroundForTest, setBackgroundSessions } from "./backgroundPriority";
import type { ResourceProcess } from "@codecast/shared/contracts";

const proc = (pid: number, sessionId?: string, startedAt = 100): ResourceProcess => ({ pid, ppid: 1, name: "ffmpeg", kind: "tool", cpu: 300, rss: 1, startedAt, ...(sessionId ? { sessionId } : {}) });

beforeEach(() => resetBackgroundForTest());

test("a session put in the background has every process lowered, including ones it starts later, and comes back when released", async () => {
  const calls: Array<[number, boolean]> = [];
  const run = async (pid: number, bg: boolean) => { calls.push([pid, bg]); return true; };
  await applyBackground([proc(1, "s1"), proc(2, "s2"), proc(3)], run);
  await setBackgroundSessions(["s1"], run);
  expect(calls).toEqual([[1, true]]);

  const tick = await applyBackground([proc(1, "s1"), proc(4, "s1"), proc(2, "s2")], run);
  expect(calls).toEqual([[1, true], [4, true]]);
  expect(tick.filter((p) => p.background).map((p) => p.pid)).toEqual([1, 4]);

  await setBackgroundSessions([], run);
  expect(calls.slice(2)).toEqual([[1, false], [4, false]]);
  expect((await applyBackground([proc(1, "s1"), proc(4, "s1")], run)).some((p) => p.background)).toBe(false);
});

test("a reused pid is a new process, and a process that failed to change is not reported as lowered", async () => {
  const calls: number[] = [];
  await setBackgroundSessions(["s1"]);
  const fail = async (pid: number) => { calls.push(pid); return false; };
  expect((await applyBackground([proc(7, "s1")], fail))[0].background).toBeUndefined();
  const ok = async (pid: number) => { calls.push(pid); return true; };
  await applyBackground([proc(7, "s1")], ok);
  await applyBackground([proc(7, "s1", 100 + 60_000)], ok);
  expect(calls).toEqual([7, 7, 7]);
});

// ps reports a start time as now minus elapsed, so it moves by up to a second
// between samples. The same process must not be lowered again every tick, and
// releasing must still reach it.
test("start-time jitter between samples is the same process", async () => {
  const calls: Array<[number, boolean]> = [];
  const run = async (pid: number, bg: boolean) => { calls.push([pid, bg]); return true; };
  await applyBackground([proc(1, "s1", 100_000)], run);
  await setBackgroundSessions(["s1"], run);
  const tick = await applyBackground([proc(1, "s1", 99_543)], run);
  expect(tick[0].background).toBe(true);
  await applyBackground([proc(1, "s1", 100_420)], run);
  await setBackgroundSessions([], run);
  expect(calls).toEqual([[1, true], [1, false]]);
});
