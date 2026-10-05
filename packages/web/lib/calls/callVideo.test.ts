import { describe, expect, test } from "bun:test";
import {
  callMsOf,
  callVideoNotice,
  callVideoRuns,
  describeStretches,
  fileSecondsAt,
  filmedSpans,
  noVideoWords,
  screenChips,
  shownMomentNear,
  turnIndexAt,
  videoAt,
  videoStretches,
  type CallVideoFile,
} from "./callVideo";

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

  test("the page says which part of the call has video, and where the nearest is from a moment without", () => {
    const later = file({ id: "run3", run_id: "run3", started_at: T + 300_000, duration_ms: 20_000 });
    const spans = filmedSpans([room, ann, saving, later], T);
    // A screen inside its run adds nothing; a run still saving plays nothing yet.
    expect(videoStretches(spans)).toEqual([{ fromMs: 65_000, toMs: 125_000 }, { fromMs: 300_000, toMs: 320_000 }]);
    expect(describeStretches(videoStretches(spans))).toBe("1:05-2:05, 5:00-5:20");
    expect(noVideoWords(10_000, spans).jump).toEqual({ ms: 65_000, words: "The video starts at 1:05" });
    expect(noVideoWords(280_000, spans).jump).toEqual({ ms: 300_000, words: "The video resumes at 5:00" });
    expect(noVideoWords(400_000, spans).jump).toEqual({ ms: 318_000, words: "The nearest video is at 5:18" });
    expect(noVideoWords(10_000).jump).toBeNull();
  });

  test("a ready file with no length covers nothing, as the shared rule has it", () => {
    expect(fileSecondsAt(file({ duration_ms: null, ended_at: null }), T, 70_000)).toBeNull();
  });

  test("a thread line jumps to the video it is about, snapping a press to the first frame", () => {
    // Record pressed 62s in, the room's first frame at 65s; Stop at 127s,
    // the file ending at 125s.
    expect(shownMomentNear([room], T, 62_000)).toBe(65_000);
    expect(shownMomentNear([room], T, 90_000)).toBe(90_000);
    expect(shownMomentNear([room], T, 127_000)).toBe(124_000);
    expect(shownMomentNear([room], T, 300_000)).toBeNull();
  });

  test("one chip per sharer: the share up now, else their next, else their last", () => {
    // Ann shares twice (80s to 110s, then 115s to 120s); Ben once, later.
    const ann2 = file({ id: "s2", kind: "screen", started_at: T + 115_000, duration_ms: 5_000, participant_identity: "ann", participant_name: "Ann Lee" });
    const ben = file({ id: "s3", kind: "screen", started_at: T + 118_000, duration_ms: 5_000, participant_identity: "ben", participant_name: "Ben" });
    const chips = (ms: number) => screenChips([ann, ann2, ben], T, ms).map((c) => [c.file.id, c.up, c.several]);
    expect(chips(90_000)).toEqual([["s1", true, true], ["s3", false, false]]);
    expect(chips(112_000)).toEqual([["s2", false, true], ["s3", false, false]]);
    expect(chips(119_000)).toEqual([["s2", true, true], ["s3", true, false]]);
    expect(chips(124_000)).toEqual([["s2", false, true], ["s3", false, false]]);
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
