import { describe, expect, it } from "bun:test";
import { voiceHostView } from "../calls/voiceHostView";

// The voice window shows one thing at a time, and which one is a decision a
// person feels: a ring that stayed hidden is a call they never saw, and a
// float that hides under the pointer is one they cannot answer.

const base = { engaged: false, inCall: false, expanded: false, floating: false, appFocused: true, wallWanted: false };

describe("the voice window's shape", () => {
  it("is hidden when nothing is happening and nothing is kept", () => {
    expect(voiceHostView(base)).toBe("idle");
    expect(voiceHostView({ ...base, appFocused: false })).toBe("idle");
  });

  it("is the float whenever the row is popped out, whatever is happening", () => {
    for (const over of [{}, { appFocused: false }, { engaged: true }, { inCall: true }, { wallWanted: true }]) {
      expect(voiceHostView({ ...base, ...over, floating: true })).toBe("float");
    }
  });

  it("reaches a person who is looking elsewhere: a ring, a burst or a call while the app is behind", () => {
    expect(voiceHostView({ ...base, engaged: true, appFocused: false })).toBe("float");
    expect(voiceHostView({ ...base, engaged: true, inCall: true, appFocused: false })).toBe("float");
    // The wall gives way: a voice arriving outranks the buddy list.
    expect(voiceHostView({ ...base, engaged: true, appFocused: false, wallWanted: true })).toBe("float");
  });

  it("stays out of the way while the app is in front, where the header shows the same row", () => {
    expect(voiceHostView({ ...base, engaged: true })).toBe("idle");
    expect(voiceHostView({ ...base, engaged: true, inCall: true })).toBe("idle");
    expect(voiceHostView({ ...base, engaged: true, wallWanted: true })).toBe("wall");
  });

  it("stays hidden for this engagement once the person hides it, and never when popped out", () => {
    expect(voiceHostView({ ...base, engaged: true, appFocused: false, dismissed: true })).toBe("idle");
    expect(voiceHostView({ ...base, engaged: true, inCall: true, appFocused: false, dismissed: true })).toBe("idle");
    expect(voiceHostView({ ...base, engaged: true, appFocused: false, dismissed: true, wallWanted: true })).toBe("wall");
    expect(voiceHostView({ ...base, engaged: true, appFocused: false, dismissed: true, floating: true })).toBe("float");
  });

  it("hides again after the engagement ends, unless popped out", () => {
    expect(voiceHostView({ ...base, engaged: false, appFocused: false })).toBe("idle");
    expect(voiceHostView({ ...base, engaged: false, appFocused: false, floating: true })).toBe("float");
  });

  it("the stage opens only on an explicit expand, and then outranks everything", () => {
    expect(voiceHostView({ ...base, inCall: true, expanded: true })).toBe("panel");
    expect(voiceHostView({ ...base, inCall: true, expanded: true, floating: true })).toBe("panel");
    expect(voiceHostView({ ...base, inCall: true, expanded: true, appFocused: false, engaged: true })).toBe("panel");
    // An expand with no call behind it is nothing: the stage has nothing to show.
    expect(voiceHostView({ ...base, expanded: true })).toBe("idle");
    expect(voiceHostView({ ...base, expanded: true, floating: true })).toBe("float");
  });

  it("keeps the wall over the work when nothing else is showing", () => {
    expect(voiceHostView({ ...base, wallWanted: true })).toBe("wall");
    expect(voiceHostView({ ...base, wallWanted: true, appFocused: false })).toBe("wall");
  });
});
