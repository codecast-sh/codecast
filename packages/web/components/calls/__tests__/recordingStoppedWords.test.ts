import { describe, expect, it } from "bun:test";
import { stoppedWords } from "../RoomRecording";

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
  it("names who stopped it, and says the video is saving", () => {
    expect(stoppedWords(end({ stopped_by: { id: "u2", name: "Ann Lee" } }), "u1")).toEqual({
      title: "Ann stopped recording",
      body: "The video is saving to the call.",
      failed: false,
    });
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
    expect(stoppedWords(null, null)).toEqual({ title: "Recording stopped", body: "", failed: false });
  });
});
