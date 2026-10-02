import { describe, expect, test } from "bun:test";
import {
  CALL_FRAME_PREFER,
  coveredSpans,
  isRecordingActive,
  playableFiles,
  recordingSubject,
  segmentAt,
  lineMomentMs,
  locateCallMoment,
  offsetIntoRecording,
  recordingAudience,
  recordingFailureWords,
  recordingKeptWords,
  recordingWindow,
  sampleCallMoments,
  type CallRecordingSpan,
} from "./callRecordings";

// A call that started at wall time T. Two runs: the first from 1:00 to 5:00
// (composite, with Ana's screen shared 2:00 to 4:00), a gap, then a second
// from 10:00 to 12:00 with Ben sharing all of it.
const T = 1_700_000_000_000;
const min = (n: number) => n * 60_000;
const rec = (r: Partial<CallRecordingSpan> & Pick<CallRecordingSpan, "id" | "kind">): CallRecordingSpan => ({ status: "ready", ...r });
const runs: CallRecordingSpan[] = [
  rec({ id: "c1", kind: "composite", started_at: T + min(1), duration_ms: min(4) }),
  rec({ id: "s1", kind: "screen", started_at: T + min(2), duration_ms: min(2), participant_identity: "u_ana", participant_name: "Ana" }),
  rec({ id: "c2", kind: "composite", started_at: T + min(10), duration_ms: min(2) }),
  rec({ id: "s2", kind: "screen", started_at: T + min(10) + 500, ended_at: T + min(12), participant_identity: "guest:g1", participant_name: "Ben" }),
];
const at = (atMs: number, extra: Partial<Parameters<typeof locateCallMoment>[0]> = {}) =>
  locateCallMoment({ callStartedAt: T, atMs, recordings: runs, now: T + min(60), ...extra });

describe("locateCallMoment", () => {
  test("the offset is the call clock moved onto the file's own clock", () => {
    expect(at(min(3))).toEqual({ ok: true, recording: runs[0], offsetMs: min(2) });
    expect(at(min(11))).toEqual({ ok: true, recording: runs[2], offsetMs: min(1) });
  });

  test("a screen file is preferred when asked, and the composite stands in when no screen was shared", () => {
    expect(at(min(3), { prefer: "screen" })).toEqual({ ok: true, recording: runs[1], offsetMs: min(1) });
    // 1:30 is inside the run but before Ana shared.
    expect(at(min(1.5), { prefer: "screen" })).toEqual({ ok: true, recording: runs[0], offsetMs: min(0.5) });
  });

  test("without a composite covering the moment, a screen file still answers", () => {
    const onlyScreen = runs.filter((r) => r.id !== "c1");
    const hit = locateCallMoment({ callStartedAt: T, atMs: min(3), recordings: onlyScreen, now: T + min(60) });
    expect(hit).toEqual({ ok: true, recording: runs[1], offsetMs: min(1) });
  });

  test("ended_at stands in for a length LiveKit has not reported, and a file starting late is offset from its own start", () => {
    expect(at(min(10) + 2_500, { prefer: "screen" })).toEqual({ ok: true, recording: runs[3], offsetMs: 2_000 });
  });

  test("two people sharing at once: the named one, else the newest share", () => {
    const both = [
      ...runs,
      rec({ id: "s3", kind: "screen", started_at: T + min(3), duration_ms: min(1), participant_identity: "u_cy" }),
    ];
    const moment = { callStartedAt: T, atMs: min(3.5), recordings: both, prefer: "screen" as const, now: T + min(60) };
    expect(locateCallMoment(moment)).toMatchObject({ ok: true, recording: { id: "s3" }, offsetMs: min(0.5) });
    expect(locateCallMoment({ ...moment, identity: "u_ana" })).toMatchObject({ ok: true, recording: { id: "s1" }, offsetMs: min(1.5) });
    // A name nobody shared under falls back to the rule, not to nothing.
    expect(locateCallMoment({ ...moment, identity: "u_zed" })).toMatchObject({ ok: true, recording: { id: "s3" } });
  });

  test("the start is inclusive and the end is not", () => {
    expect(at(min(1))).toMatchObject({ ok: true, recording: { id: "c1" }, offsetMs: 0 });
    expect(at(min(5))).toMatchObject({ ok: false, reason: "outside" });
  });

  test("a moment in the gap, before the press or after the stop says what was recorded", () => {
    for (const m of [min(0.5), min(7), min(13)]) {
      const miss = at(m);
      expect(miss.ok).toBe(false);
      if (miss.ok) continue;
      expect(miss.reason).toBe("outside");
      expect(miss.covered.map(({ fromMs, toMs, kind }) => ({ fromMs, toMs, kind }))).toEqual([
        { fromMs: min(1), toMs: min(5), kind: "composite" },
        { fromMs: min(2), toMs: min(4), kind: "screen" },
        { fromMs: min(10), toMs: min(12), kind: "composite" },
        { fromMs: min(10) + 500, toMs: min(12), kind: "screen" },
      ]);
    }
  });

  test("a call never recorded, and one whose only file failed, have nothing to show", () => {
    expect(locateCallMoment({ callStartedAt: T, atMs: 0, recordings: [] })).toEqual({ ok: false, reason: "no_recordings", covered: [] });
    const failed = [rec({ id: "f", kind: "composite", status: "failed", started_at: T, duration_ms: min(5) })];
    expect(locateCallMoment({ callStartedAt: T, atMs: min(1), recordings: failed })).toMatchObject({ ok: false, reason: "no_recordings" });
  });

  test("a file still being written covers the moment but cannot show it yet", () => {
    const live = [rec({ id: "c", kind: "composite", status: "recording", started_at: T + min(1) })];
    const miss = locateCallMoment({ callStartedAt: T, atMs: min(2), recordings: live, now: T + min(3) });
    expect(miss).toEqual({
      ok: false,
      reason: "not_ready",
      covered: [{ id: "c", fromMs: min(1), toMs: min(3), kind: "composite", pending: true, participant_name: null }],
    });
    // After `now` the live file does not reach yet: that is outside, not pending.
    expect(locateCallMoment({ callStartedAt: T, atMs: min(4), recordings: live, now: T + min(3) })).toMatchObject({ reason: "outside" });
  });

  test("a ready file wins over a pending one of the same kind", () => {
    const mixed = [
      rec({ id: "old", kind: "composite", started_at: T, duration_ms: min(10) }),
      rec({ id: "new", kind: "composite", status: "stopping", started_at: T + min(5), ended_at: T + min(9) }),
    ];
    expect(locateCallMoment({ callStartedAt: T, atMs: min(6), recordings: mixed })).toMatchObject({ ok: true, recording: { id: "old" } });
  });

  test("a file LiveKit never started has no place on the clock", () => {
    const starting = [rec({ id: "s", kind: "composite", status: "starting" })];
    expect(recordingWindow(starting[0], T)).toBeNull();
    expect(locateCallMoment({ callStartedAt: T, atMs: 0, recordings: starting, now: T + 5 })).toEqual({ ok: false, reason: "outside", covered: [] });
  });
});

describe("recordingWindow", () => {
  test("the length wins over the end stamp, and a live file runs to now", () => {
    expect(recordingWindow(rec({ id: "a", kind: "composite", started_at: 100, duration_ms: 50, ended_at: 400 }), 0)).toEqual({ start: 100, end: 150 });
    expect(recordingWindow(rec({ id: "a", kind: "composite", status: "recording", started_at: 100 }), 900)).toEqual({ start: 100, end: 900 });
    expect(recordingWindow(rec({ id: "a", kind: "composite", started_at: 100 }), 900)).toEqual({ start: 100, end: 100 });
  });

  test("active means anything LiveKit is still working on", () => {
    expect(["starting", "recording", "stopping"].every((s) => isRecordingActive(s as any))).toBe(true);
    expect(isRecordingActive("ready") || isRecordingActive("failed")).toBe(false);
  });
});

describe("sampleCallMoments", () => {
  test("evenly across a stretch, both ends included", () => {
    expect(sampleCallMoments(0, 10_000, 5)).toEqual([0, 2_500, 5_000, 7_500, 10_000]);
    expect(sampleCallMoments(10_000, 0, 3)).toEqual([0, 5_000, 10_000]);
  });

  test("a short stretch gives its middle, not copies of one picture", () => {
    expect(sampleCallMoments(4_000, 4_400, 6)).toEqual([4_200]);
    expect(sampleCallMoments(0, 2_000, 10, 1_000)).toEqual([0, 1_000, 2_000]);
  });

  test("a line points where its first word was said", () => {
    expect(lineMomentMs({ t0: 1234 })).toBe(1234);
    expect(lineMomentMs({ t0: -5 })).toBe(0);
  });
});

describe("a frame of a moment", () => {
  test("one default view: the share's own file when one covers the moment, else the room", () => {
    // `cast call snap` and the cl-42@12:34 embed both locate with this, so
    // the picture an agent read is the one its readers are shown.
    expect(CALL_FRAME_PREFER).toBe("screen");
    expect(at(min(3), { prefer: CALL_FRAME_PREFER })).toMatchObject({ ok: true, recording: { id: "s1" }, offsetMs: min(1) });
    expect(at(min(1.5), { prefer: CALL_FRAME_PREFER })).toMatchObject({ ok: true, recording: { id: "c1" } });
  });

  test("playable files are finished, signed and placed on the clock", () => {
    const files = [
      { ...runs[2], url: "https://r2/c2" },
      { ...runs[0], url: "https://r2/c1" },
      { ...runs[1], url: null },
      { ...rec({ id: "x", kind: "composite", status: "recording", started_at: T }), url: "https://r2/x" },
      { ...rec({ id: "y", kind: "composite" }), url: "https://r2/y" },
    ];
    expect(playableFiles(files).map((f) => f.id)).toEqual(["c1", "c2"]);
  });

  test("what a file shows, as a label and in a sentence", () => {
    expect(recordingSubject({ kind: "composite" }, "label")).toBe("Room");
    expect(recordingSubject({ kind: "screen", participant_name: "Ana Ruiz" }, "label")).toBe("Ana's screen");
    expect(recordingSubject({ kind: "screen" }, "label")).toBe("Screen");
    expect(recordingSubject({ kind: "composite" })).toBe("the room");
    expect(recordingSubject({ kind: "screen", participant_name: "Ana Ruiz" })).toBe("Ana Ruiz's screen");
    expect(recordingSubject({ kind: "screen", participant_name: " " })).toBe("a shared screen");
  });

  test("covered spans: in call time, the room first, pending marked, failed left out", () => {
    const rows = [
      ...runs,
      rec({ id: "f", kind: "composite", status: "failed", started_at: T + min(20), duration_ms: min(1) }),
      rec({ id: "live", kind: "screen", status: "recording", started_at: T + min(1), participant_name: "Cy" }),
    ];
    const spans = coveredSpans(rows, T, T + min(1.5));
    expect(spans.map((x) => [x.id, x.fromMs, x.toMs, x.pending])).toEqual([
      ["c1", min(1), min(5), false],
      ["live", min(1), min(1.5), true],
      ["s1", min(2), min(4), false],
      ["c2", min(10), min(12), false],
      ["s2", min(10) + 500, min(12), false],
    ]);
  });
});

describe("segmentAt", () => {
  const lines = [
    { t0: 0, t1: 2000 },
    { t0: 5000, t1: 9000 },
  ];
  test("the line whose words span the moment, its end exclusive", () => {
    expect(segmentAt(lines, 6000)).toEqual({ index: 1, during: true });
    expect(segmentAt(lines, 5000)).toEqual({ index: 1, during: true });
    expect(segmentAt(lines, 9000)).toBeNull();
  });
  test("a hold keeps the last line through a silence, as long as it lasts", () => {
    expect(segmentAt(lines, 12_000, { holdMs: 20_000 })).toEqual({ index: 1, during: false });
    expect(segmentAt(lines, 60_000, { holdMs: 20_000 })).toBeNull();
    expect(segmentAt(lines, 60_000, { holdMs: Infinity })).toEqual({ index: 1, during: false });
    expect(segmentAt(lines, -1, { holdMs: Infinity })).toBeNull();
  });
  test("a line with no end yet is never under the moment, only before it", () => {
    expect(segmentAt([{ t0: 0 }], 500)).toBeNull();
    expect(segmentAt([{ t0: 0 }], 500, { holdMs: 1000 })).toEqual({ index: 0, during: false });
  });
});

describe("offsetIntoRecording", () => {
  const room: CallRecordingSpan = { id: "r", kind: "composite", status: "ready", started_at: T + min(1), duration_ms: min(4) };
  test("is the alignment rule, end exclusive", () => {
    expect(offsetIntoRecording(room, T, min(1))).toBe(0);
    expect(offsetIntoRecording(room, T, min(3))).toBe(min(2));
    expect(offsetIntoRecording(room, T, min(5))).toBeNull();
    expect(offsetIntoRecording(room, T, min(0.5))).toBeNull();
  });
  test("a finished file with no length covers nothing, as recordingWindow has it", () => {
    expect(offsetIntoRecording({ ...room, duration_ms: null, ended_at: null }, T, min(2))).toBeNull();
  });
  test("a file still filming runs to now", () => {
    const live = { ...room, status: "recording" as const, duration_ms: null };
    expect(offsetIntoRecording(live, T, min(2), T + min(3))).toBe(min(1));
    expect(offsetIntoRecording(live, T, min(4), T + min(3))).toBeNull();
  });
});

describe("recording words", () => {
  test("the audience follows the room's kind, as canReadCall does", () => {
    expect(recordingAudience("dm:a:b")).toBe("the people this huddle is between");
    expect(recordingAudience("channel:c1")).toBe("everyone in the channel");
    expect(recordingAudience("session:s1")).toBe("everyone who can open the session");
    expect(recordingAudience(null)).toBe("the team hosting it");
    expect(recordingKeptWords("channel:c1")).toContain("everyone in the channel can watch it");
    expect(recordingKeptWords()).toContain("public link if someone shares the video");
  });
  test("a failure reads as one sentence whichever side wrote it", () => {
    expect(recordingFailureWords(null)).toBe("The recording failed.");
    expect(recordingFailureWords("Stopped before the room's video began.")).toBe("Stopped before the room's video began.");
    expect(recordingFailureWords("The recording hit its limit.")).toBe("The recording hit its limit.");
    expect(recordingFailureWords("egress timed out")).toBe("The recording failed. egress timed out");
  });
});
