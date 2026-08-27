import { describe, expect, test } from "bun:test";
import { decideAutoScribe, type AutoScribeInput } from "../calls/autoScribe";

// Every huddle transcribes. These pin down WHEN a window asks to scribe: only
// a person who joined on purpose, only once there is a huddle (two seats),
// never over a run somebody seated is already holding, never when the room
// said no — and when a run this window holds has been adopted away, let go.
const base: AutoScribeInput = {
  roomKey: "channel:ch1",
  connected: true,
  deliberate: true,
  transcribeOff: false,
  rosterIds: ["me", "them"],
  meId: "me",
  live: null,
  scribeActive: false,
};

describe("decideAutoScribe", () => {
  test("a deliberate seat in a two-person room with no transcript starts one", () => {
    expect(decideAutoScribe(base)).toBe("start");
  });

  test("a walkie's background seat never scribes", () => {
    expect(decideAutoScribe({ ...base, deliberate: false })).toBe("hold");
  });

  test("alone in the room there is no huddle to transcribe yet", () => {
    expect(decideAutoScribe({ ...base, rosterIds: ["me"] })).toBe("hold");
  });

  test("the room's opt-out holds every auto start", () => {
    expect(decideAutoScribe({ ...base, transcribeOff: true })).toBe("hold");
  });

  test("nothing is decided until the live transcript is known", () => {
    expect(decideAutoScribe({ ...base, live: undefined })).toBe("hold");
  });

  test("a recording is not a room", () => {
    expect(decideAutoScribe({ ...base, roomKey: "rec:0123456789ab" })).toBe("hold");
  });

  test("somebody seated is already scribing: hold", () => {
    expect(decideAutoScribe({ ...base, live: { startedBy: "them" } })).toBe("hold");
  });

  test("the scribe left their seat: adopt the orphaned run", () => {
    expect(decideAutoScribe({ ...base, live: { startedBy: "gone" } })).toBe("start");
  });

  test("my own run after a reload resumes", () => {
    expect(decideAutoScribe({ ...base, live: { startedBy: "me" } })).toBe("start");
  });

  test("a run I hold that was adopted by someone else is yielded", () => {
    expect(decideAutoScribe({ ...base, scribeActive: true, live: { startedBy: "them" } })).toBe("yield");
    expect(decideAutoScribe({ ...base, scribeActive: true, live: { startedBy: "me" } })).toBe("hold");
  });

  test("the opt-out does not yank a run a person started by hand", () => {
    expect(decideAutoScribe({ ...base, scribeActive: true, transcribeOff: true, live: { startedBy: "me" } })).toBe("hold");
  });
});
