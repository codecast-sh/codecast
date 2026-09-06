import { describe, expect, it } from "bun:test";
import { voiceHostView } from "../calls/voiceHostView";

// The voice window shows one thing at a time, and which one is a decision a
// person feels: a strip that lost to the wall is a voice they never saw.

const base = { surface: "none" as const, callSize: "panel" as const, hiddenCall: false, wallWanted: false, facesWanted: false };

describe("the voice window's shape", () => {
  it("is hidden when nothing is happening and nothing is kept", () => {
    expect(voiceHostView(base)).toBe("idle");
  });

  it("keeps the team over the work: the wall, else the faces", () => {
    expect(voiceHostView({ ...base, facesWanted: true })).toBe("faces");
    expect(voiceHostView({ ...base, wallWanted: true })).toBe("wall");
    // Both asked for (never by the shell, which makes them exclusive): the
    // one you can read wins.
    expect(voiceHostView({ ...base, wallWanted: true, facesWanted: true })).toBe("wall");
  });

  it("a ring outranks everything, even the strip", () => {
    for (const over of [{}, { wallWanted: true }, { surface: "walkie" as const }, { surface: "dock" as const, hiddenCall: true }]) {
      expect(voiceHostView({ ...base, ...over, ringing: true })).toBe("ring");
    }
  });

  it("the strip outranks everything else, whatever is wanted", () => {
    for (const over of [{}, { wallWanted: true }, { facesWanted: true }, { hiddenCall: true }]) {
      expect(voiceHostView({ ...base, ...over, surface: "walkie" })).toBe("walkie");
    }
  });

  it("a call takes the size the person chose", () => {
    expect(voiceHostView({ ...base, surface: "dock", callSize: "speaker" })).toBe("speaker");
    expect(voiceHostView({ ...base, surface: "stage", callSize: "panel" })).toBe("panel");
    expect(voiceHostView({ ...base, surface: "dock", callSize: "tiny", wallWanted: true })).toBe("tiny");
  });

  it("a call put away keeps running behind the team, or behind nothing", () => {
    expect(voiceHostView({ ...base, surface: "dock", hiddenCall: true, wallWanted: true })).toBe("wall");
    expect(voiceHostView({ ...base, surface: "dock", hiddenCall: true, facesWanted: true })).toBe("faces");
    expect(voiceHostView({ ...base, surface: "dock", hiddenCall: true })).toBe("idle");
  });
});
