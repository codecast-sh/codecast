import { describe, expect, it } from "bun:test";
import {
  lostNoticeKey,
  owedStopNotice,
  owesRecordingNotice,
  RECORD_ASK,
  RECORDING_SHARED_WORDS,
  recordingEndHref,
  roomRunWatch,
  savedWords,
  startedWords,
  STOP_NEWS_MS,
  STOP_RECORDING_ASK,
  stopNoticeCard,
  stopNoticeVerdict,
  stoppedByItself,
  stoppedWords,
  unseenPressedFailure,
  watchRoomRun,
  type RoomRecordingEnd,
} from "./roomRecordingEnd";
import type { RoomRecordingLive } from "./roomRecordingFields";

// The walk every screen in a huddle takes over the room's runs (the web's
// notice and the phone's call screen): a stop is said once, the presser of a
// run LiveKit refused is told even though REC never came on, and a newer run
// makes the last stop old news.

const run = (over: Partial<RoomRecordingLive> = {}): RoomRecordingLive => ({
  status: "recording",
  run_id: "r1",
  started_by: { id: "u1", name: "Ann Lee" },
  requested_at: 1,
  started_at: 2,
  stop_requested_at: null,
  video_shared: false,
  ...over,
});
const end = (over: Partial<RoomRecordingEnd> = {}): RoomRecordingEnd => ({
  run_id: "r1",
  status: "ready",
  stop_reason: "pressed",
  error: null,
  stopped_by: { id: "u2", name: "Bo Park" },
  ...over,
});

describe("watchRoomRun", () => {
  it("owes the room a stop once a run it saw filming goes", () => {
    const told = new Set<string>();
    const noticed = (k: string) => told.has(k);
    const w = roomRunWatch("room");
    expect(watchRoomRun(w, run(), undefined, null, noticed, 0).running?.run_id).toBe("r1");
    expect(owedStopNotice(w, undefined, "u1", noticed, 0)).toBeNull();
    const step = watchRoomRun(w, run({ status: "stopping" }), undefined, null, noticed, 10);
    expect(step.stopped?.run_id).toBe("r1");
    // The end has not arrived yet: hold.
    expect(owedStopNotice(w, undefined, "u1", noticed, 10)?.how).toBe("wait");
    const owed = owedStopNotice(w, end(), "u1", noticed, 20);
    expect(owed?.how).toBe("say");
    expect(owed?.key).toBe("stop:r1");
    // Said once: another screen of this person's claimed it.
    told.add("stop:r1");
    expect(owedStopNotice(w, end(), "u1", noticed, 30)?.how).toBe("drop");
  });

  it("tells the presser why a run LiveKit refused never started", () => {
    const w = roomRunWatch("room");
    const refused = end({ run_id: "r9", status: "failed", stop_reason: "failed", stopped_by: null, error: "egress minutes exceeded" });
    watchRoomRun(w, null, refused, "r9", () => false, 0);
    const owed = owedStopNotice(w, refused, "u1", () => false, 0);
    expect(owed?.how).toBe("say");
    expect(owed?.stop.was.run_id).toBe("r9");
    // Somebody else's refused press is not this person's to be told about.
    const other = roomRunWatch("room");
    watchRoomRun(other, null, refused, "r8", () => false, 0);
    expect(owedStopNotice(other, refused, "u1", () => false, 0)).toBeNull();
  });

  it("says only where the file went to whoever pressed Stop, once it lands", () => {
    const w = roomRunWatch("room");
    watchRoomRun(w, run(), undefined, null, () => false, 0);
    watchRoomRun(w, null, undefined, null, () => false, 1);
    const mine = end({ status: "stopping", stopped_by: { id: "u1", name: "Ann" } });
    expect(owedStopNotice(w, mine, "u1", () => false, 2)?.how).toBe("wait");
    expect(owedStopNotice(w, { ...mine, status: "ready" }, "u1", () => false, 3)?.how).toBe("saved");
  });

  it("drops the last stop when a newer run begins, or when it is old news", () => {
    const w = roomRunWatch("room");
    watchRoomRun(w, run(), undefined, null, () => false, 0);
    watchRoomRun(w, null, undefined, null, () => false, 1);
    expect(w.stop?.was.run_id).toBe("r1");
    watchRoomRun(w, run({ run_id: "r2" }), undefined, null, () => false, 2);
    expect(w.stop).toBeNull();

    const late = roomRunWatch("room");
    watchRoomRun(late, run(), undefined, null, () => false, 0);
    watchRoomRun(late, null, undefined, null, () => false, 1);
    expect(owedStopNotice(late, end(), "u3", () => false, 1 + STOP_NEWS_MS)?.how).toBe("drop");
  });
});

// What the room is told when a recording stops: "saving" only for a run that
// was filming, a failure in its own words, and who stopped it by name.
const stopping = (over: Partial<Parameters<typeof stoppedWords>[0] & object>) => ({
  run_id: "r1",
  status: "stopping" as const,
  stop_reason: "pressed" as const,
  error: null,
  stopped_by: null,
  ...over,
});

// The consent line, said the same on the web and the phone: who pressed, and
// whether the video reaches the public link.
describe("owesRecordingNotice", () => {
  // The told set as a screen keeps it, by run id.
  const told = () => {
    const seen = new Set<string>();
    return { has: (id: string) => seen.has(id), note: (id: string) => void seen.add(id) };
  };

  it("tells everyone but the presser once a run, and never of a run being saved", () => {
    const t = told();
    expect(owesRecordingNotice(run(), "u2", t.has)).toBe(true);
    t.note("r1");
    expect(owesRecordingNotice(run(), "u2", t.has)).toBe(false);
    expect(owesRecordingNotice(run(), "u1", told().has)).toBe(false);
    expect(owesRecordingNotice(run({ status: "stopping" }), "u2", told().has)).toBe(false);
    expect(owesRecordingNotice(null, "u2", told().has)).toBe(false);
  });

  it("tells a screen that slept through a Stop and a new Record about the second run", () => {
    // The phone only ever sees the latest row: r1 filming, then r2 filming,
    // with no push where the room was quiet between them.
    const t = told();
    expect(owesRecordingNotice(run({ run_id: "r1" }), "u2", t.has)).toBe(true);
    t.note("r1");
    const second = run({ run_id: "r2", started_by: { id: "u3", name: "Bo Kim" } });
    expect(owesRecordingNotice(second, "u2", t.has)).toBe(true);
    t.note("r2");
    expect(owesRecordingNotice(second, "u2", t.has)).toBe(false);
  });
});

describe("startedWords", () => {
  it("names the presser and says when the video is public", () => {
    const live = { started_by: { id: "u2", name: "Ann Lee" }, video_shared: false };
    expect(startedWords(live)).toBe("Ann started recording. Anyone in the call can stop it.");
    expect(startedWords({ ...live, video_shared: true })).toBe(`Ann started recording. ${RECORDING_SHARED_WORDS} Anyone in the call can stop it.`);
    // A server too old to name the run: what is kept, nothing it cannot know.
    expect(startedWords(null)).toBe("Video and shared screens are kept with the call. Anyone in the call can stop it.");
  });
});

describe("stoppedWords", () => {
  it("names who stopped it, and says where the video is saving", () => {
    expect(stoppedWords(stopping({ stopped_by: { id: "u2", name: "Ann Lee" } }), "u1")).toEqual({
      title: "Ann stopped recording",
      body: "The video is still saving. It stays with the call.",
      failed: false,
    });
    const named = stopping({ stopped_by: { id: "u2", name: "Ann Lee" }, transcript_id: "t1", short_id: "cl-117", at_ms: 132_000 });
    // A person is told where the video is in words they know, never the
    // call's short id (that is for agents and the CLI).
    expect(stoppedWords(named, "u1").body).toBe("The video is still saving. It stays with the call.");
    expect(stoppedWords({ ...named, status: "ready" }, "u1").body).toBe("The video is saved with the call.");
    expect(stoppedWords({ ...named, status: "ready" }, "u1").body).not.toContain("cl-117");
    expect(stoppedWords(stopping({ stopped_by: { id: "u1", name: "Me" } }), "u1").title).toBe("You stopped recording");
    expect(stoppedWords(stopping({ stopped_by: { id: "guest:g1", name: "Ada (guest)" } }), "u1").title).toBe("Ada (guest) stopped recording");
  });

  it("never says saving for a run that left no video", () => {
    expect(stoppedWords(stopping({ status: "failed", stop_reason: "failed", error: "LiveKit lost track of this recording before it finished." }), null)).toEqual({
      title: "Recording failed",
      body: "LiveKit lost track of this recording before it finished.",
      failed: true,
    });
    // Stopped by a press before the room's video began: a stop, said as one.
    expect(
      stoppedWords(stopping({ status: "failed", error: "Stopped before the room's video began.", stopped_by: { id: "u2", name: "Ann" } }), "u1"),
    ).toEqual({ title: "Ann stopped recording", body: "Stopped before the room's video began.", failed: false });
  });

  it("says why when nobody pressed, and only that it stopped when the end is unknown", () => {
    expect(stoppedWords(stopping({ stop_reason: "limit", status: "ready" }), null).title).toBe("Recording stopped at its time limit");
    // Each reason says only what is true: the huddle over, the room left
    // with guests but no teammate, or LiveKit closing it with no cause seen.
    expect(stoppedWords(stopping({ stop_reason: "huddle_ended" }), null).title).toBe("Recording stopped when the huddle ended");
    expect(stoppedWords(stopping({ stop_reason: "room_empty" as any }), null).title).toBe("Recording stopped: no teammate was left in the call");
    expect(stoppedWords(stopping({ stop_reason: "ended" as any, status: "ready" }), null).title).toBe("Recording stopped: the media server closed the file");
    expect(stoppedWords(null, null)).toEqual({ title: "Recording stopped", body: "", failed: false });
  });
});

// The person who pressed Stop is never told it stopped, whichever window or
// device they pressed it from: the end names who stopped it, the same fact
// everywhere, so the main window says nothing after a Stop on the phone.
describe("stopNoticeVerdict", () => {
  it("never tells the person who stopped it that it stopped, only where it went once it landed", () => {
    expect(stopNoticeVerdict(stopping({ stopped_by: { id: "u1", name: "Me" } }), "r1", "u1")).toBe("wait");
    expect(stopNoticeVerdict(stopping({ status: "ready", stopped_by: { id: "u1", name: "Me" } }), "r1", "u1")).toBe("saved");
    // A run of theirs that never landed: they are told it failed.
    expect(stopNoticeVerdict(stopping({ status: "failed", stopped_by: { id: "u1", name: "Me" } }), "r1", "u1")).toBe("say");
    expect(stopNoticeVerdict(stopping({ stopped_by: { id: "u2", name: "Ann" } }), "r1", "u1")).toBe("say");
    expect(savedWords(stopping({ short_id: "cl-117" }))).toBe("Recording saved with the call");
    expect(savedWords(null)).toBe("Recording saved with the call");
  });

  it("says a stop nobody pressed, even with a stopper on record", () => {
    expect(stopNoticeVerdict(stopping({ stop_reason: "huddle_ended", stopped_by: null }), "r1", "u1")).toBe("say");
    expect(stopNoticeVerdict(stopping({ stop_reason: "limit", stopped_by: { id: "u1", name: "Me" } }), "r1", "u1")).toBe("say");
  });

  it("waits for this run's end, and says it when the server cannot send one", () => {
    expect(stopNoticeVerdict(undefined, "r1", "u1")).toBe("wait");
    expect(stopNoticeVerdict(stopping({ run_id: "r0", stopped_by: { id: "u2", name: "Ann" } }), "r1", "u1")).toBe("wait");
    expect(stopNoticeVerdict(null, "r1", "u1")).toBe("say");
  });

  it("never skips for a viewer it cannot name", () => {
    expect(stopNoticeVerdict(stopping({ stopped_by: { id: "u1", name: "Me" } }), "r1", null)).toBe("say");
  });
});

// A press LiveKit refuses within one push never shows live: the mark shows
// the press in flight and then just goes. The presser is still told why.
describe("unseenPressedFailure", () => {
  const failed = stopping({ run_id: "r9", status: "failed", stop_reason: "failed", error: "Recording is unavailable: out of minutes." });
  it("owes the presser the failure of the run their press made, when it was never seen live", () => {
    const run = unseenPressedFailure(failed, "r9", null)!;
    expect(run.run_id).toBe("r9");
    // Said through the stop notice, as a failure, with the server's words.
    expect(stoppedWords(failed, "u1")).toEqual({ title: "Recording failed", body: "Recording is unavailable: out of minutes.", failed: true });
  });
  it("owes nothing for a run seen live (its stop is told the usual way), someone else's press, or an end that is not a failure", () => {
    expect(unseenPressedFailure(failed, "r9", "r9")).toBeNull();
    expect(unseenPressedFailure(failed, "r8", null)).toBeNull();
    expect(unseenPressedFailure(failed, null, null)).toBeNull();
    expect(unseenPressedFailure({ ...failed, status: "ready" }, "r9", null)).toBeNull();
    expect(unseenPressedFailure(null, "r9", null)).toBeNull();
  });
});

// A notice's Open lands on the call page at the run's first frame.
describe("recordingEndHref", () => {
  it("opens the call at the run, the whole call before LiveKit said where, and nothing for a failure", () => {
    expect(recordingEndHref(stopping({ transcript_id: "t1", at_ms: 132_400 }))).toBe("/calls/t1?t=132");
    expect(recordingEndHref(stopping({ transcript_id: "t1", at_ms: null }))).toBe("/calls/t1");
    expect(recordingEndHref(stopping({ transcript_id: "t1", at_ms: 5_000, status: "failed" }))).toBeNull();
    expect(recordingEndHref(stopping({}))).toBeNull();
  });
});

// A run that stopped with nobody asking, while the huddle goes on, keeps its
// notice up and offers to record again; somebody's own doing does not.
describe("stoppedByItself", () => {
  it("is a failure, a limit, LiveKit's own end, or an empty room", () => {
    for (const stop_reason of ["failed", "limit", "ended", "room_empty"] as const) expect(stoppedByItself(stopping({ stop_reason }))).toBe(true);
    expect(stoppedByItself(stopping({ status: "failed", stop_reason: null as any }))).toBe(true);
  });
  it("is never a press, the huddle ending, a share ending, or an unknown end", () => {
    for (const stop_reason of ["pressed", "huddle_ended", "share_ended"] as const) expect(stoppedByItself(stopping({ stop_reason }))).toBe(false);
    expect(stoppedByItself(stopping({ status: "failed", stop_reason: "pressed" }))).toBe(false);
    expect(stoppedByItself(null)).toBe(false);
    expect(stoppedByItself(undefined)).toBe(false);
  });
});

// One card for every surface (the web's banner, toast and system banner, the
// phone's card): its words, where Open goes, and whether it stays until it is
// dismissed. Sticky is stoppedByItself, for every reason a run can stop.
describe("stopNoticeCard", () => {
  it("stays up exactly when the run stopped by itself", () => {
    const sticky: Record<string, boolean> = {
      pressed: false,
      huddle_ended: false,
      room_empty: true,
      share_ended: false,
      limit: true,
      ended: true,
      failed: true,
    };
    for (const [stop_reason, want] of Object.entries(sticky)) {
      expect({ stop_reason, sticky: stopNoticeCard("say", stopping({ stop_reason: stop_reason as any }), null).sticky }).toEqual({ stop_reason, sticky: want });
    }
    // A failure LiveKit gave no reason for, and an end that never arrived.
    expect(stopNoticeCard("say", stopping({ status: "failed", stop_reason: null as any }), null).sticky).toBe(true);
    expect(stopNoticeCard("say", null, null).sticky).toBe(false);
  });
  it("says the stop or the presser's saved line, with the notice's Open", () => {
    const landed = stopping({ status: "ready", stopped_by: { id: "u1", name: "Me" }, transcript_id: "t1", short_id: "cl-117", at_ms: 132_400 });
    expect(stopNoticeCard("saved", landed, "u1")).toEqual({
      title: savedWords(landed),
      body: "",
      failed: false,
      sticky: false,
      href: "/calls/t1?t=132",
    });
    expect(stopNoticeCard("say", landed, "u2")).toEqual({ ...stoppedWords(landed, "u2"), sticky: false, href: recordingEndHref(landed) });
  });
});

// The questions Record and Stop ask, the same on the web's popover and the
// phone's alert: the second paragraph says who may watch THIS room's video.
describe("RECORD_ASK and STOP_RECORDING_ASK", () => {
  it("asks once, in words that name who can watch the room's video", () => {
    const [told, kept] = RECORD_ASK.lines("session:conv1");
    expect(RECORD_ASK.title).toBe("Record this huddle?");
    expect(told).toBe("Everyone in the call sees that it is being recorded, and anyone who joins later is told. Anyone in the call can stop it.");
    expect(kept.startsWith("It films faces, voices and shared screens. The video stays with the call, where ")).toBe(true);
    // A two person room and a session room are watched by different people.
    expect(RECORD_ASK.lines("dm:a:b")[1]).not.toBe(kept);
    expect(STOP_RECORDING_ASK).toEqual({
      title: "Stop recording for everyone?",
      body: "The video so far is kept with the call.",
      stop: "Stop recording",
      keep: "Keep recording",
    });
  });
});

// A run stopped while the room heard "saving", whose video then failed to
// save: its presser is told once, and nobody reads the loss twice.
describe("a video lost while it saved", () => {
  const lost = (over: Partial<RoomRecordingEnd> = {}) => end({ status: "failed", lost: true, started_by: "u1", error: "LiveKit never finished saving this recording.", ...over });

  it("is said once to the run's presser, even when somebody else stopped it", () => {
    const told = new Set<string>();
    const noticed = (k: string) => told.has(k);
    const w = roomRunWatch("room");
    const owed = owedStopNotice(w, lost(), "u1", noticed, 0);
    expect(owed).toMatchObject({ how: "say", key: lostNoticeKey("r1") });
    expect(stopNoticeCard("say", owed!.end, "u1")).toMatchObject({ title: "Recording could not be saved", body: "LiveKit never finished saving this recording.", failed: true, sticky: false, href: null });
    told.add(owed!.key);
    expect(owedStopNotice(w, lost(), "u1", noticed, 1)).toBeNull();
  });

  it("is owed to whoever pressed Stop, and to nobody else in the room", () => {
    const noticed = () => false;
    expect(owedStopNotice(roomRunWatch("room"), lost({ started_by: "u3" }), "u2", noticed, 0)?.how).toBe("say");
    expect(owedStopNotice(roomRunWatch("room"), lost({ started_by: "u3" }), "u4", noticed, 0)).toBeNull();
    // A run that failed while filming was said as its stop.
    expect(owedStopNotice(roomRunWatch("room"), end({ status: "failed", stop_reason: "failed", started_by: "u1" }), "u1", noticed, 0)).toBeNull();
  });

  it("a stop said once the loss is known is the loss, claimed under its key", () => {
    const told = new Set<string>();
    const noticed = (k: string) => told.has(k);
    const w = roomRunWatch("room");
    watchRoomRun(w, run(), undefined, null, noticed, 0);
    watchRoomRun(w, null, lost(), null, noticed, 1);
    const owed = owedStopNotice(w, lost(), "u1", noticed, 2);
    expect(owed?.key).toBe(lostNoticeKey("r1"));
    told.add(owed!.key);
    w.stop = null;
    expect(owedStopNotice(w, lost(), "u1", noticed, 3)).toBeNull();
    expect(stoppedByItself(lost({ stop_reason: "room_empty" }))).toBe(false);
  });
});
