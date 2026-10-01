import { describe, expect, test } from "bun:test";
import { locateCallMoment } from "@codecast/shared/contracts";
import {
  egressPatch,
  MAX_SCREEN_FILES_PER_RUN,
  mayDeleteRun,
  nextPollDelayMs,
  peopleInRoom,
  plainEgressError,
  RECORDING_POLL_FAST_MS,
  RECORDING_POLL_MS,
  runIdOf,
  screenEncoding,
  screenSharesToRecord,
} from "./callRecordingRuns";
import { parseEgressInfo, parseParticipant, type LivekitEgress } from "./livekitServer";

const NS = (ms: number) => String(ms * 1e6);

const ana = parseParticipant({
  identity: "u_ana",
  name: "Ana",
  tracks: [
    { sid: "TR_mic", type: "AUDIO", source: "MICROPHONE" },
    { sid: "TR_scr", type: "VIDEO", source: "SCREEN_SHARE", width: 2880, height: 1800 },
  ],
});
const guest = parseParticipant({ identity: "guest:g1", name: "Ben", tracks: [{ sid: "TR_gscr", type: "VIDEO", source: "SCREEN_SHARE", width: 1280, height: 720 }] });
const recorder = parseParticipant({ identity: "EG_abc", name: "", kind: "EGRESS", tracks: [] });
const face = parseParticipant({ identity: "agent:jx7abc", name: "Pip", kind: "AGENT", tracks: [{ sid: "TR_face", type: "VIDEO", source: "SCREEN_SHARE" }] });

describe("who is in the room", () => {
  test("LiveKit's recorder and agent faces are nobody; guests are people", () => {
    expect(peopleInRoom([ana, guest, recorder, face]).map((p) => p.identity)).toEqual(["u_ana", "guest:g1"]);
    // An egress recorder that old servers report without a kind is still
    // known by LiveKit's identity prefix.
    expect(peopleInRoom([parseParticipant({ identity: "EG_old", tracks: [] })])).toEqual([]);
    expect(peopleInRoom([recorder, face])).toEqual([]);
  });
});

describe("screen files", () => {
  test("every person's share gets one file, an agent's never, a share already filed never twice", () => {
    expect(screenSharesToRecord([ana, guest, face], []).map((s) => s.trackSid)).toEqual(["TR_scr", "TR_gscr"]);
    expect(screenSharesToRecord([ana, guest], [{ kind: "screen", track_sid: "TR_scr" }]).map((s) => s.trackSid)).toEqual(["TR_gscr"]);
    // A composite row never counts as a screen's file.
    expect(screenSharesToRecord([ana], [{ kind: "composite", track_sid: null }]).map((s) => s.trackSid)).toEqual(["TR_scr"]);
  });

  test("a run stops adding screen files at its cap", () => {
    const full = Array.from({ length: MAX_SCREEN_FILES_PER_RUN }, (_, i) => ({ kind: "screen", track_sid: `TR_${i}` }));
    expect(screenSharesToRecord([ana], full)).toEqual([]);
  });

  test("a screen is encoded at its own size, even, capped at 4K, a keyframe a second", () => {
    expect(screenEncoding({ width: 2880, height: 1800 })).toEqual({ width: 2880, height: 1800, framerate: 15, key_frame_interval: 1 });
    expect(screenEncoding({ width: 1281, height: 721 })).toEqual({ width: 1282, height: 722, framerate: 15, key_frame_interval: 1 });
    expect(screenEncoding({ width: 5120, height: 2880 })).toEqual({ width: 3840, height: 2160, framerate: 15, key_frame_interval: 1 });
    // Size unknown: LiveKit's preset decides.
    expect(screenEncoding({})).toBeNull();
  });
});

describe("runs", () => {
  test("a composite is its own run; a screen file names its run", () => {
    expect(runIdOf({ _id: "c1" })).toBe("c1");
    expect(runIdOf({ _id: "s1", run_id: "c1" })).toBe("c1");
  });

  test("the loop looks fast while anything is changing, slowly while recording, never once done", () => {
    expect(nextPollDelayMs([{ status: "recording" }, { status: "ready" }])).toBe(RECORDING_POLL_MS);
    expect(nextPollDelayMs([{ status: "recording" }, { status: "starting" }])).toBe(RECORDING_POLL_FAST_MS);
    expect(nextPollDelayMs([{ status: "stopping" }])).toBe(RECORDING_POLL_FAST_MS);
    expect(nextPollDelayMs([{ status: "ready" }, { status: "failed" }])).toBeNull();
    expect(nextPollDelayMs([])).toBeNull();
  });

  test("the presser or the call's owner may delete, nobody else", () => {
    expect(mayDeleteRun("u1", { started_by: "u1" }, { started_by: "u2" })).toBe(true);
    expect(mayDeleteRun("u2", { started_by: "u1" }, { started_by: "u2" })).toBe(true);
    expect(mayDeleteRun("u3", { started_by: "u1" }, { started_by: "u2" })).toBe(false);
  });
});

describe("LiveKit's view onto a row", () => {
  const base = { kind: "composite" as const, status: "starting" as const, r2_key: "calls/t1/1-composite.mp4" };
  const egress = (raw: any): LivekitEgress => parseEgressInfo({ egress_id: "EG_1", room_name: "dm:a:b", ...raw });

  test("starting, then recording with the file's own time 0", () => {
    expect(egressPatch(base, egress({ status: "EGRESS_STARTING" }))).toEqual({ drop: false, patch: {} });
    const live = egressPatch(base, egress({ status: "EGRESS_ACTIVE", started_at: NS(1_000), file_results: [{ filename: base.r2_key, started_at: NS(6_000) }] }));
    expect(live).toEqual({ drop: false, patch: { status: "recording", started_at: 6_000 } });
  });

  test("finished: length, size and end land, and an unpressed end says why", () => {
    const done = egress({ status: "EGRESS_COMPLETE", file_results: [{ filename: base.r2_key, started_at: NS(6_000), ended_at: NS(30_000), duration: NS(24_400), size: "4096" }] });
    expect(egressPatch({ ...base, status: "recording", started_at: 6_000 }, done)).toEqual({
      drop: false,
      patch: { status: "ready", ended_at: 30_000, duration_ms: 24_400, size_bytes: 4096, stop_reason: "huddle_ended" },
    });
    // A screen file ending on its own is its share ending.
    expect((egressPatch({ ...base, kind: "screen", status: "recording", started_at: 6_000 }, done) as any).patch.stop_reason).toBe("share_ended");
    // LiveKit's own ceiling.
    const limited = egress({ status: "EGRESS_LIMIT_REACHED", file_results: [{ filename: base.r2_key, started_at: NS(6_000), duration: NS(9_000) }] });
    expect((egressPatch({ ...base, status: "recording", started_at: 6_000 }, limited) as any).patch.stop_reason).toBe("limit");
    // A pressed stop keeps its reason.
    expect((egressPatch({ ...base, status: "stopping", stop_reason: "pressed", started_at: 6_000 }, done) as any).patch.stop_reason).toBeUndefined();
  });

  test("a row being stopped never reads as recording again", () => {
    const stillActive = egress({ status: "EGRESS_ACTIVE", file_results: [{ filename: base.r2_key, started_at: NS(6_000) }] });
    expect(egressPatch({ ...base, status: "stopping", stop_reason: "pressed" }, stillActive)).toEqual({ drop: false, patch: { started_at: 6_000 } });
  });

  test("a finished row only gains what it lacked", () => {
    const ready = { ...base, status: "ready" as const, started_at: 6_000, duration_ms: 24_400 };
    const late = egress({ status: "EGRESS_COMPLETE", file_results: [{ filename: base.r2_key, started_at: NS(7_000), duration: NS(1), size: "99" }] });
    expect(egressPatch(ready, late)).toEqual({ drop: false, patch: { size_bytes: 99 } });
    expect(egressPatch({ ...base, status: "failed" }, late)).toEqual({ drop: false, patch: {} });
  });

  test("stopped before a frame was written: dropped, not failed", () => {
    const aborted = egress({ status: "EGRESS_ABORTED", error: "Start signal not received", file: { filename: base.r2_key, started_at: NS(6_000), ended_at: NS(6_000), duration: "0" } });
    expect(egressPatch({ ...base, status: "stopping", stop_reason: "pressed" }, aborted)).toEqual({ drop: true });
    expect(egressPatch({ ...base, status: "stopping", stop_reason: "huddle_ended" }, aborted)).toEqual({ drop: true });
    // Nobody stopped it: that is a failure, in plain words.
    const failed = egressPatch(base, aborted) as any;
    expect(failed.drop).toBe(false);
    expect(failed.patch.status).toBe("failed");
    expect(failed.patch.stop_reason).toBe("failed");
    expect(failed.patch.error).toBe("The recording never began: nobody in the room was sending audio or video yet.");
  });

  test("LiveKit's errors are passed on, labelled", () => {
    expect(plainEgressError("track not found")).toBe("LiveKit: track not found");
    expect(plainEgressError(undefined)).toBe("LiveKit stopped the recording without saying why.");
  });
});

// The alignment rule end to end, on rows shaped the way the recordings query
// returns them: a transcript line's t0 lands on the right file and offset.
describe("alignment against recorded rows", () => {
  const callStartedAt = 1_727_000_000_000;
  const rows = [
    // First run: pressed 60s in, LiveKit's first frame 5s after the press.
    { id: "c1", kind: "composite" as const, status: "ready" as const, started_at: callStartedAt + 65_000, duration_ms: 120_000 },
    // Ana shared her screen 90s in, for 30s, inside that run.
    { id: "s1", kind: "screen" as const, status: "ready" as const, started_at: callStartedAt + 90_000, duration_ms: 30_000, participant_identity: "u_ana" },
    // Second run, after a stop: 10 minutes in, still uploading.
    { id: "c2", kind: "composite" as const, status: "stopping" as const, started_at: callStartedAt + 600_000 },
  ];

  test("a line inside the first run reads the room at the right offset", () => {
    const hit = locateCallMoment({ callStartedAt, atMs: 70_000, recordings: rows, now: callStartedAt + 700_000 });
    expect(hit).toEqual({ ok: true, recording: rows[0], offsetMs: 5_000 });
  });

  test("--screen prefers the share's own file while it was up, and the room otherwise", () => {
    const shared = locateCallMoment({ callStartedAt, atMs: 100_000, recordings: rows, prefer: "screen", now: callStartedAt + 700_000 });
    expect(shared).toMatchObject({ ok: true, recording: { id: "s1" }, offsetMs: 10_000 });
    const after = locateCallMoment({ callStartedAt, atMs: 150_000, recordings: rows, prefer: "screen", now: callStartedAt + 700_000 });
    expect(after).toMatchObject({ ok: true, recording: { id: "c1" }, offsetMs: 85_000 });
  });

  test("a moment in a file still being written is not ready; one in no file is outside", () => {
    expect(locateCallMoment({ callStartedAt, atMs: 610_000, recordings: rows, now: callStartedAt + 700_000 })).toMatchObject({ ok: false, reason: "not_ready" });
    expect(locateCallMoment({ callStartedAt, atMs: 300_000, recordings: rows, now: callStartedAt + 700_000 })).toMatchObject({ ok: false, reason: "outside" });
  });
});
