import { describe, expect, test } from "bun:test";
import { locateCallMoment } from "@codecast/shared/contracts";
import {
  egressMovesRow,
  egressPatch,
  emptyRoomStopDue,
  isMinutesSpentText,
  MAX_SCREEN_FILES_PER_RUN,
  RECORDING_EMPTY_ROOM_STOP_MS,
  RECORDING_LEFT_ROOM_HOLD_MS,
  RECORDING_MINUTES_SPENT_MESSAGE,
  SCREEN_RETRY_GAP_MS,
  screenStartRetryable,
  START_RETRY_LIMIT,
  mayDeleteRun,
  mayShareVideo,
  sharedVideoRuns,
  nextPollDelayMs,
  huddleKeepers,
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

  test("only teammates keep a recording going: a guest alone never keeps a huddle", () => {
    expect(huddleKeepers([ana, guest, recorder, face]).map((p) => p.identity)).toEqual(["u_ana"]);
    expect(huddleKeepers([guest, recorder])).toEqual([]);
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

  test("a screen file refused for a passing reason is asked again, on the same row, a few times at most", () => {
    const now = 1_000_000;
    const failed = {
      kind: "screen",
      track_sid: "TR_scr",
      status: "failed" as const,
      started_at: undefined,
      stop_reason: "failed" as const,
      error: "LiveKit has no recording capacity free right now. Try again in a minute.",
      error_kind: "busy" as const,
      updated_at: now - SCREEN_RETRY_GAP_MS,
    };
    expect(screenStartRetryable(failed, now)).toBe(true);
    expect(screenSharesToRecord([ana], [failed], now).map((s) => s.trackSid)).toEqual(["TR_scr"]);
    // Not before its gap, not for spent minutes, not once it wrote frames,
    // not after a stop, and not past the limit.
    expect(screenStartRetryable({ ...failed, updated_at: now - 1_000 }, now)).toBe(false);
    expect(screenStartRetryable({ ...failed, error: RECORDING_MINUTES_SPENT_MESSAGE, error_kind: "minutes_spent" as const }, now)).toBe(false);
    // The kind decides, never the words: copy edits to either message leave
    // the retry rule where it was.
    expect(screenStartRetryable({ ...failed, error: "Reworded: no minutes left.", error_kind: "minutes_spent" as const }, now)).toBe(false);
    expect(screenStartRetryable({ ...failed, error: RECORDING_MINUTES_SPENT_MESSAGE, error_kind: "busy" as const }, now)).toBe(true);
    expect(screenStartRetryable({ ...failed, started_at: now - 60_000 }, now)).toBe(false);
    expect(screenStartRetryable({ ...failed, stop_reason: "pressed" as const }, now)).toBe(false);
    expect(screenStartRetryable({ ...failed, start_attempts: START_RETRY_LIMIT }, now)).toBe(false);
    expect(screenSharesToRecord([ana], [{ ...failed, start_attempts: START_RETRY_LIMIT }], now)).toEqual([]);
    // A retry never takes a new share's place at the cap, nor counts twice.
    const full = Array.from({ length: MAX_SCREEN_FILES_PER_RUN - 1 }, (_, i) => ({ kind: "screen", track_sid: `TR_${i}` }));
    expect(screenSharesToRecord([ana, guest], [...full, failed], now).map((s) => s.trackSid)).toEqual(["TR_scr"]);
  });

  test("a screen is encoded at its own size, even, capped at 4K, a keyframe a second", () => {
    expect(screenEncoding({ width: 2880, height: 1800 })).toEqual({ width: 2880, height: 1800, framerate: 15, key_frame_interval: 1, video_bitrate: 7800 });
    expect(screenEncoding({ width: 1281, height: 721 })).toEqual({ width: 1282, height: 722, framerate: 15, key_frame_interval: 1, video_bitrate: 4500 });
    expect(screenEncoding({ width: 5120, height: 2880 })).toEqual({ width: 3840, height: 2160, framerate: 15, key_frame_interval: 1, video_bitrate: 12000 });
    // The bitrate follows the pixels: 1080p sits on LiveKit's default, a
    // Retina share gets about 0.1 bit per pixel per frame, 4K the ceiling.
    expect(screenEncoding({ width: 1920, height: 1080 })!.video_bitrate).toBe(4500);
    expect(screenEncoding({ width: 2560, height: 1440 })!.video_bitrate).toBe(5500);
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

  test("the presser or a team admin may delete a finished run, nobody else, never mid-write", () => {
    const run = [
      { kind: "composite", started_by: "u1", status: "ready" as const },
      { kind: "screen", started_by: "u1", status: "ready" as const },
    ];
    expect(mayDeleteRun("u1", run, false)).toEqual({ ok: true });
    expect(mayDeleteRun("u2", run, true)).toEqual({ ok: true });
    // Whoever holds the scribe seat is nobody special here.
    expect(mayDeleteRun("u3", run, false)).toEqual({ ok: false, reason: "not_yours" });
    // A screen file still being written holds the whole run.
    expect(mayDeleteRun("u1", [run[0], { ...run[1], status: "stopping" as const }], false)).toEqual({ ok: false, reason: "still_recording" });
  });
});

describe("an empty room", () => {
  test("a dead tab stops the recording after the empty span; a deliberate leave holds it longer", () => {
    const t0 = 10_000_000;
    expect(emptyRoomStopDue(t0, t0 + RECORDING_EMPTY_ROOM_STOP_MS - 1)).toBe(false);
    expect(emptyRoomStopDue(t0, t0 + RECORDING_EMPTY_ROOM_STOP_MS)).toBe(true);
    // The last teammate left on purpose at t0 (a reload, as often as not):
    // the count starts RECORDING_LEFT_ROOM_HOLD_MS later.
    const due = t0 + RECORDING_LEFT_ROOM_HOLD_MS + RECORDING_EMPTY_ROOM_STOP_MS;
    expect(emptyRoomStopDue(t0, due - 1, t0)).toBe(false);
    expect(emptyRoomStopDue(t0, due, t0)).toBe(true);
    // Found empty well after the leave: the later clock counts.
    expect(emptyRoomStopDue(t0 + 200_000, t0 + 200_000 + RECORDING_EMPTY_ROOM_STOP_MS, t0)).toBe(true);
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

  test("a run that simply keeps recording moves nothing, so a look spends no mutation on it", () => {
    const active = egress({ status: "EGRESS_ACTIVE", started_at: NS(1_000), file_results: [{ filename: base.r2_key, started_at: NS(6_000) }] });
    expect(egressMovesRow({ ...base, status: "recording", started_at: 6_000 }, active)).toBe(false);
    expect(egressMovesRow(base, active)).toBe(true);
    // A stop LiveKit has not acted on yet is no change either.
    expect(egressMovesRow({ ...base, status: "stopping", stop_reason: "pressed", started_at: 6_000 }, active)).toBe(false);
  });

  test("finished: length, size and end land, and an unpressed end says why", () => {
    const done = egress({ status: "EGRESS_COMPLETE", file_results: [{ filename: base.r2_key, started_at: NS(6_000), ended_at: NS(30_000), duration: NS(24_400), size: "4096" }] });
    expect(egressPatch({ ...base, status: "recording", started_at: 6_000 }, done)).toEqual({
      drop: false,
      patch: { status: "ready", ended_at: 30_000, duration_ms: 24_400, size_bytes: 4096, stop_reason: "ended" },
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

  test("a file that was filming and then failed is kept as a loss, never dropped", () => {
    // The upload failed after somebody pressed Stop on a long call, and
    // LiveKit reports no length: the row stays, failed, saying why.
    const uploadFailed = egress({ status: "EGRESS_FAILED", error: "upload failed", file_results: [{ filename: base.r2_key, started_at: NS(6_000), ended_at: NS(3_606_000) }] });
    const kept = egressPatch({ ...base, status: "stopping", stop_reason: "pressed", started_at: 6_000 }, uploadFailed) as any;
    expect(kept.drop).toBe(false);
    expect(kept.patch).toMatchObject({ status: "failed", error: "The video could not be saved to storage." });
    // Even with no look ever catching it recording, an end after its start
    // means frames were written.
    expect((egressPatch({ ...base, status: "stopping", stop_reason: "pressed" }, uploadFailed) as any).drop).toBe(false);
  });

  test("LiveKit's errors are said in plain words, never quoted", () => {
    expect(plainEgressError(undefined).error).toBe("LiveKit stopped the recording without saying why.");
    expect(plainEgressError("track not found").error).toBe("LiveKit stopped the recording unexpectedly.");
    expect(plainEgressError("egress minutes exceeded")).toEqual({ error: RECORDING_MINUTES_SPENT_MESSAGE, kind: "minutes_spent" });
    expect(plainEgressError("project quota reached")).toEqual({ error: RECORDING_MINUTES_SPENT_MESSAGE, kind: "minutes_spent" });
    expect(plainEgressError("max duration limit reached").error).toBe("The recording stopped at LiveKit's time limit.");
    const s3 =
      "failed to upload: AccessDenied: Access Denied status code: 403, request id: 7f2a, host id: https://0123abcd.r2.cloudflarestorage.com/codecast-call-recordings/calls/k57x/1700-composite.mp4";
    expect(plainEgressError(s3)).toEqual({ error: "The video could not be saved to storage.", kind: "server" });
    expect(plainEgressError("PutObject: RequestTimeout").error).toBe("The video could not be saved to storage.");
    // Whatever LiveKit says, a reader never sees the bucket or a URL.
    for (const raw of [s3, "https://lk.example/twirp failed", "track not found", "upload to s3 failed"]) {
      expect(plainEgressError(raw).error).not.toContain("cloudflarestorage");
      expect(plainEgressError(raw).error).not.toContain("https://");
    }
    expect(isMinutesSpentText("egress minutes exceeded")).toBe(true);
    expect(isMinutesSpentText("no egress workers available")).toBe(false);
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

describe("the video on a public link", () => {
  test("publishing takes the presser of every room video it shows, or an admin", () => {
    const runs = [{ started_by: "ana" }, { started_by: "ana" }];
    expect(mayShareVideo("ana", runs, false)).toBe(true);
    expect(mayShareVideo("ben", runs, false)).toBe(false);
    expect(mayShareVideo("ben", runs, true)).toBe(true);
    // Somebody else pressed one of them: that one is not Ana's to publish.
    expect(mayShareVideo("ana", [...runs, { started_by: "ben" }], false)).toBe(false);
  });

  test("the link shows the finished room videos pressed for before the choice, and counts the later ones", () => {
    const row = (requested_at: number, extra: Record<string, unknown> = {}) => ({ kind: "composite", status: "ready", started_at: requested_at + 500, requested_at, ...extra });
    const rows = [row(100), row(200), row(300), row(150, { kind: "screen" }), row(120, { status: "failed" }), row(250, { status: "recording", started_at: null })];
    const at = (through: number | null) => {
      const { shared, later } = sharedVideoRuns(rows, through);
      return [shared.map((r) => r.requested_at), later.map((r) => r.requested_at)];
    };
    expect(at(250)).toEqual([[100, 200], [300]]);
    // A press in the very millisecond of the choice was not part of it.
    expect(at(200)).toEqual([[100], [200, 300]]);
    // A link shared before the cutoff existed keeps showing every room video.
    expect(at(null)).toEqual([[100, 200, 300], []]);
  });
});
