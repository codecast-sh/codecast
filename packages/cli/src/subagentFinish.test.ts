import { describe, expect, test } from "bun:test";
import { FINISH_META_SLACK_MS, SubagentFinishTracker, subagentLooksFinished, type SubagentFileState, type SubagentStatusSink } from "./subagentFinish.js";

const T0 = 1_800_000_000_000;
const FILE = "/p/proj/parent-uuid/subagents/agent-abc.jsonl";
const CONV = "convChild1";

describe("subagentLooksFinished", () => {
  test("finished with a meta written around the transcript's end", () => {
    expect(subagentLooksFinished({ meta: { finished: true }, metaMtimeMs: T0 - 70, jsonlMtimeMs: T0 })).toBe(true);
    expect(subagentLooksFinished({ meta: { finished: true }, metaMtimeMs: T0 + 5, jsonlMtimeMs: T0 })).toBe(true);
  });
  test("finished, but the transcript ran on well past the meta (a resumed run)", () => {
    expect(subagentLooksFinished({ meta: { finished: true }, metaMtimeMs: T0, jsonlMtimeMs: T0 + FINISH_META_SLACK_MS + 1 })).toBe(false);
  });
  test("no finished flag", () => {
    expect(subagentLooksFinished({ meta: { description: "x" }, metaMtimeMs: T0, jsonlMtimeMs: T0 })).toBe(false);
    expect(subagentLooksFinished({ meta: null, metaMtimeMs: T0, jsonlMtimeMs: T0 })).toBe(false);
  });
  test("a teammate is never finished this way", () => {
    expect(subagentLooksFinished({ meta: { finished: true, teamName: "session-1" }, metaMtimeMs: T0, jsonlMtimeMs: T0 })).toBe(false);
  });
});

function harness(initial: SubagentFileState | null) {
  let state = initial;
  const calls: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const sink: SubagentStatusSink = {
    markSessionCompleted: async (id) => { calls.push(`completed:${id}`); },
    markSessionActive: async (id) => { calls.push(`active:${id}`); },
  };
  const tracker = new SubagentFinishTracker({
    readState: async () => state,
    setTimer: (fn) => { const h = nextTimer++; timers.set(h, fn); return h; },
    clearTimer: (h) => { timers.delete(h as number); },
  });
  return {
    tracker, calls, sink,
    set(next: SubagentFileState | null) { state = next; },
    pendingTimers: () => timers.size,
    /** Fire every armed timer, as if the transcript stayed quiet, and let the check finish. */
    async quiet() {
      const fns = [...timers.values()];
      timers.clear();
      for (const fn of fns) fn();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe("SubagentFinishTracker", () => {
  test("a finished subagent is marked completed once, after the transcript goes quiet", async () => {
    const h = harness({ meta: { description: "x" }, metaMtimeMs: T0, jsonlMtimeMs: T0 });
    h.tracker.noteCreated(FILE);
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    h.set({ meta: { finished: true }, metaMtimeMs: T0 + 1000, jsonlMtimeMs: T0 + 1070 });
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    expect(h.pendingTimers()).toBe(1);
    await h.quiet();
    expect(h.calls).toEqual([`completed:${CONV}`]);
    await h.tracker.check(FILE);
    expect(h.calls).toEqual([`completed:${CONV}`]);
  });

  test("growth after completion reopens it once, then it can finish again", async () => {
    const h = harness({ meta: { finished: true }, metaMtimeMs: T0, jsonlMtimeMs: T0 });
    h.tracker.noteCreated(FILE);
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    await h.quiet();
    expect(h.calls).toEqual([`completed:${CONV}`]);
    // Parent resumes it with SendMessage: new lines land.
    h.set({ meta: { finished: true }, metaMtimeMs: T0, jsonlMtimeMs: T0 + 60_000 });
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    expect(h.calls).toEqual([`completed:${CONV}`, `active:${CONV}`]);
    // The resumed run ends and Claude Code rewrites the meta.
    h.set({ meta: { finished: true }, metaMtimeMs: T0 + 90_000, jsonlMtimeMs: T0 + 90_000 });
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    await h.quiet();
    expect(h.calls).toEqual([`completed:${CONV}`, `active:${CONV}`, `completed:${CONV}`]);
  });

  test("meta written after the last transcript line is still caught by the quiet timer", async () => {
    const h = harness({ meta: { description: "x" }, metaMtimeMs: T0, jsonlMtimeMs: T0 + 500 });
    h.tracker.noteCreated(FILE);
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    expect(h.calls).toEqual([]);
    // No more lines; meta flips to finished afterwards.
    h.set({ meta: { finished: true }, metaMtimeMs: T0 + 900, jsonlMtimeMs: T0 + 500 });
    await h.quiet();
    expect(h.calls).toEqual([`completed:${CONV}`]);
  });

  test("a resumed agent with a stale finished:true stays active while it grows", async () => {
    // Completed by an earlier daemon run; this daemon first sees it grow.
    const h = harness({ meta: { finished: true }, metaMtimeMs: T0, jsonlMtimeMs: T0 + 120_000 });
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    expect(h.calls).toEqual([`active:${CONV}`]);
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    await h.quiet();
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    await h.quiet();
    expect(h.calls).toEqual([`active:${CONV}`]);
  });

  test("a check that started before new lines landed gives up", async () => {
    let release!: () => void;
    const calls: string[] = [];
    const sink: SubagentStatusSink = {
      markSessionCompleted: async (id) => { calls.push(`completed:${id}`); },
      markSessionActive: async (id) => { calls.push(`active:${id}`); },
    };
    const tracker = new SubagentFinishTracker({
      readState: () => new Promise((r) => { release = () => r({ meta: { finished: true }, metaMtimeMs: T0, jsonlMtimeMs: T0 }); }),
      setTimer: () => 0, clearTimer: () => {},
    });
    tracker.noteCreated(FILE);
    await tracker.noteGrowth(FILE, CONV, sink);
    const checking = tracker.check(FILE);
    await tracker.noteGrowth(FILE, CONV, sink);
    release();
    await checking;
    expect(calls).toEqual([]);
  });

  test("first growth this daemon sees asserts active once; created rows and teammates are skipped", async () => {
    const h = harness({ meta: { description: "x" }, metaMtimeMs: T0, jsonlMtimeMs: T0 });
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    expect(h.calls).toEqual([`active:${CONV}`]);

    const created = "/p/proj/parent-uuid/subagents/agent-new.jsonl";
    h.tracker.noteCreated(created);
    await h.tracker.noteGrowth(created, "convNew", h.sink);

    const mate = harness({ meta: { finished: true, teamName: "session-1" }, metaMtimeMs: T0, jsonlMtimeMs: T0 });
    await mate.tracker.noteGrowth(FILE, CONV, mate.sink);
    await mate.quiet();
    expect(mate.calls).toEqual([]);
    expect(h.calls).toEqual([`active:${CONV}`]);
  });

  test("top-level transcripts are ignored", async () => {
    const h = harness({ meta: { finished: true }, metaMtimeMs: T0, jsonlMtimeMs: T0 });
    await h.tracker.noteGrowth("/p/proj/parent-uuid.jsonl", CONV, h.sink);
    expect(h.pendingTimers()).toBe(0);
    await h.quiet();
    expect(h.calls).toEqual([]);
  });

  test("stop clears armed timers and blocks later checks", async () => {
    const h = harness({ meta: { finished: true }, metaMtimeMs: T0, jsonlMtimeMs: T0 });
    h.tracker.noteCreated(FILE);
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    h.tracker.stop();
    expect(h.pendingTimers()).toBe(0);
    await h.tracker.check(FILE);
    expect(h.calls).toEqual([]);
  });
});
