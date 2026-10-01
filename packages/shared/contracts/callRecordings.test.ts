import { describe, expect, test } from "bun:test";
import {
  isRecordingActive,
  lineMomentMs,
  locateCallMoment,
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
      expect(miss.covered).toEqual([
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
    expect(miss).toEqual({ ok: false, reason: "not_ready", covered: [{ fromMs: min(1), toMs: min(3), kind: "composite" }] });
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
