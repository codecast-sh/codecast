import { describe, expect, it } from "bun:test";
import { recordingEndHref, savedWords, stopNoticeVerdict, stoppedByItself, stoppedWords, unseenPressedFailure } from "../../../lib/calls/roomRecordingEnd";

// What the room is told when a recording stops: "saving" only for a run that
// was filming, a failure in its own words, and who stopped it by name.
const end = (over: Partial<Parameters<typeof stoppedWords>[0] & object>) => ({
  run_id: "r1",
  status: "stopping" as const,
  stop_reason: "pressed" as const,
  error: null,
  stopped_by: null,
  ...over,
});

describe("stoppedWords", () => {
  it("names who stopped it, and says where the video is saving", () => {
    expect(stoppedWords(end({ stopped_by: { id: "u2", name: "Ann Lee" } }), "u1")).toEqual({
      title: "Ann stopped recording",
      body: "The video is saving to the call.",
      failed: false,
    });
    const named = end({ stopped_by: { id: "u2", name: "Ann Lee" }, transcript_id: "t1", short_id: "cl-117", at_ms: 132_000 });
    expect(stoppedWords(named, "u1").body).toBe("The video is saving to cl-117.");
    expect(stoppedWords({ ...named, status: "ready" }, "u1").body).toBe("The video is saved to cl-117.");
    expect(stoppedWords(end({ stopped_by: { id: "u1", name: "Me" } }), "u1").title).toBe("You stopped recording");
    expect(stoppedWords(end({ stopped_by: { id: "guest:g1", name: "Ada (guest)" } }), "u1").title).toBe("Ada (guest) stopped recording");
  });

  it("never says saving for a run that left no video", () => {
    expect(stoppedWords(end({ status: "failed", stop_reason: "failed", error: "LiveKit lost track of this recording before it finished." }), null)).toEqual({
      title: "Recording failed",
      body: "LiveKit lost track of this recording before it finished.",
      failed: true,
    });
    // Stopped by a press before the room's video began: a stop, said as one.
    expect(
      stoppedWords(end({ status: "failed", error: "Stopped before the room's video began.", stopped_by: { id: "u2", name: "Ann" } }), "u1"),
    ).toEqual({ title: "Ann stopped recording", body: "Stopped before the room's video began.", failed: false });
  });

  it("says why when nobody pressed, and only that it stopped when the end is unknown", () => {
    expect(stoppedWords(end({ stop_reason: "limit", status: "ready" }), null).title).toBe("Recording stopped at its time limit");
    // Each reason says only what is true: the huddle over, the room left
    // with guests but no teammate, or LiveKit closing it without a reason.
    expect(stoppedWords(end({ stop_reason: "huddle_ended" }), null).title).toBe("Recording stopped when the huddle ended");
    expect(stoppedWords(end({ stop_reason: "room_empty" as any }), null).title).toBe("Recording stopped: no teammate was left in the call");
    expect(stoppedWords(end({ stop_reason: "ended" as any, status: "ready" }), null).title).toBe("Recording stopped");
    expect(stoppedWords(null, null)).toEqual({ title: "Recording stopped", body: "", failed: false });
  });
});

// The person who pressed Stop is never told it stopped, whichever window or
// device they pressed it from: the end names who stopped it, the same fact
// everywhere, so the main window says nothing after a Stop on the phone.
describe("stopNoticeVerdict", () => {
  it("never tells the person who stopped it that it stopped, only where it went once it landed", () => {
    expect(stopNoticeVerdict(end({ stopped_by: { id: "u1", name: "Me" } }), "r1", "u1")).toBe("wait");
    expect(stopNoticeVerdict(end({ status: "ready", stopped_by: { id: "u1", name: "Me" } }), "r1", "u1")).toBe("saved");
    // A run of theirs that never landed: they are told it failed.
    expect(stopNoticeVerdict(end({ status: "failed", stopped_by: { id: "u1", name: "Me" } }), "r1", "u1")).toBe("say");
    expect(stopNoticeVerdict(end({ stopped_by: { id: "u2", name: "Ann" } }), "r1", "u1")).toBe("say");
    expect(savedWords(end({ short_id: "cl-117" }))).toBe("Recording saved to cl-117");
    expect(savedWords(null)).toBe("Recording saved to the call");
  });

  it("says a stop nobody pressed, even with a stopper on record", () => {
    expect(stopNoticeVerdict(end({ stop_reason: "huddle_ended", stopped_by: null }), "r1", "u1")).toBe("say");
    expect(stopNoticeVerdict(end({ stop_reason: "limit", stopped_by: { id: "u1", name: "Me" } }), "r1", "u1")).toBe("say");
  });

  it("waits for this run's end, and says it when the server cannot send one", () => {
    expect(stopNoticeVerdict(undefined, "r1", "u1")).toBe("wait");
    expect(stopNoticeVerdict(end({ run_id: "r0", stopped_by: { id: "u2", name: "Ann" } }), "r1", "u1")).toBe("wait");
    expect(stopNoticeVerdict(null, "r1", "u1")).toBe("say");
  });

  it("never skips for a viewer it cannot name", () => {
    expect(stopNoticeVerdict(end({ stopped_by: { id: "u1", name: "Me" } }), "r1", null)).toBe("say");
  });
});

// A press LiveKit refuses within one push never shows live: the mark shows
// the press in flight and then just goes. The presser is still told why.
describe("unseenPressedFailure", () => {
  const failed = end({ run_id: "r9", status: "failed", stop_reason: "failed", error: "Recording is unavailable: out of minutes." });
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
    expect(recordingEndHref(end({ transcript_id: "t1", at_ms: 132_400 }))).toBe("/calls/t1?t=132");
    expect(recordingEndHref(end({ transcript_id: "t1", at_ms: null }))).toBe("/calls/t1");
    expect(recordingEndHref(end({ transcript_id: "t1", at_ms: 5_000, status: "failed" }))).toBeNull();
    expect(recordingEndHref(end({}))).toBeNull();
  });
});

// A run that stopped with nobody asking, while the huddle goes on, keeps its
// notice up and offers to record again; somebody's own doing does not.
describe("stoppedByItself", () => {
  it("is a failure, a limit, LiveKit's own end, or an empty room", () => {
    for (const stop_reason of ["failed", "limit", "ended", "room_empty"] as const) expect(stoppedByItself(end({ stop_reason }))).toBe(true);
    expect(stoppedByItself(end({ status: "failed", stop_reason: null as any }))).toBe(true);
  });
  it("is never a press, the huddle ending, a share ending, or an unknown end", () => {
    for (const stop_reason of ["pressed", "huddle_ended", "share_ended"] as const) expect(stoppedByItself(end({ stop_reason }))).toBe(false);
    expect(stoppedByItself(end({ status: "failed", stop_reason: "pressed" }))).toBe(false);
    expect(stoppedByItself(null)).toBe(false);
    expect(stoppedByItself(undefined)).toBe(false);
  });
});
