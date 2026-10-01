import { describe, expect, test } from "bun:test";
import { callMsOf, callVideoNotice, callVideoRuns, fileSecondsAt, screensAt, turnIndexAt, videoAt, videoViewLabel, type CallVideoFile } from "./callVideo";

// A call that started at wall 1_000_000. One run pressed 65s in: the room's
// file from 65s to 125s, Ann's screen from 80s to 110s. A second run from
// 200s, still being saved.
const T = 1_000_000;
const file = (over: Partial<CallVideoFile>): CallVideoFile => ({
  id: "x",
  kind: "composite",
  status: "ready",
  started_at: T + 65_000,
  duration_ms: 60_000,
  url: "https://r2/x",
  run_id: "run1",
  ...over,
});
const room = file({ id: "run1" });
const ann = file({ id: "s1", kind: "screen", started_at: T + 80_000, duration_ms: 30_000, participant_identity: "ann", participant_name: "Ann Lee" });
const saving = file({ id: "run2", run_id: "run2", status: "stopping", started_at: T + 200_000, duration_ms: null, url: null });

describe("call video", () => {
  test("a line 70s into the call is 5s into a file that began at 65s, and back", () => {
    expect(fileSecondsAt(room, T, 70_000)).toBe(5);
    expect(callMsOf(room, T, 5)).toBe(70_000);
    expect(fileSecondsAt(room, T, 64_999)).toBeNull();
    // The end is exclusive: a file has no frame at its own length.
    expect(fileSecondsAt(room, T, 125_000)).toBeNull();
  });

  test("the room's file by default, the screen when asked, only while it was up", () => {
    expect(videoAt([room, ann], T, 90_000)).toEqual({ file: room, seconds: 25 });
    expect(videoAt([room, ann], T, 90_000, "screen")).toEqual({ file: ann, seconds: 10 });
    expect(videoAt([room, ann], T, 115_000, "screen")).toEqual({ file: room, seconds: 50 });
    expect(videoAt([room, ann, saving], T, 210_000)).toBeNull();
  });

  test("screens up at a moment, one per sharer", () => {
    expect(screensAt([room, ann], T, 90_000).map((f) => f.id)).toEqual(["s1"]);
    expect(screensAt([room, ann], T, 70_000)).toEqual([]);
    expect(videoViewLabel(ann)).toBe("Ann's screen");
    expect(videoViewLabel(room)).toBe("Room");
  });

  test("runs group a press's files and say where they stand", () => {
    const runs = callVideoRuns([saving, ann, room]);
    expect(runs.map((r) => [r.id, r.state, r.composite?.id, r.screens.length])).toEqual([
      ["run1", "ready", "run1", 1],
      ["run2", "saving", "run2", 0],
    ]);
    expect(callVideoNotice(runs)?.kind).toBe("saving");
    const failed = callVideoRuns([room, file({ id: "run3", run_id: "run3", status: "failed", error: "LiveKit: boom", started_at: T + 300_000, url: null })]);
    expect(callVideoNotice(failed)).toMatchObject({ kind: "failed", run: { error: "LiveKit: boom" } });
    expect(callVideoNotice(callVideoRuns([room]))).toBeNull();
  });

  test("the line being said, and the line last said through a silence", () => {
    const turns = [
      { t0: 0, segments: [{ t1: 4_000 }] },
      { t0: 10_000, segments: [{ t1: 12_000 }, { t1: 15_000 }] },
    ];
    expect(turnIndexAt(turns, 2_000)).toBe(0);
    expect(turnIndexAt(turns, 6_000)).toBeNull();
    expect(turnIndexAt(turns, 6_000, true)).toBe(0);
    expect(turnIndexAt(turns, 14_000)).toBe(1);
    expect(turnIndexAt(turns, 99_000, true)).toBe(1);
  });
});
