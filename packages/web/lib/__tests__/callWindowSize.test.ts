import { describe, expect, it } from "bun:test";
import {
  callWindowLeaveGesture,
  callWindowReport,
  callWindowSizeOnFailedJoin,
  isDuplicateIdentityDisconnect,
  shouldYieldCallOnDisconnect,
  type CallWindowPhase,
} from "../calls/callHandoff";
import type { CallWindowSize } from "../desktop";

// In its two circle sizes the call window has no title bar, no close box and no
// dock entry: it is a few circles and a transparent rectangle that lets the
// mouse through. Everything a person can do with it is drawn on the circles, so
// if the circles never arrive there is nothing on screen to act on. These rules
// are what keeps that from happening, and both failure directions are
// expensive: a window that never comes back is invisible over somebody's work,
// and a window that says the call ended takes a live call with it.

const fallback = (
  size: CallWindowSize,
  phase: CallWindowPhase,
  held: boolean,
  deadlinePassed = false,
) => callWindowSizeOnFailedJoin({ size, phase, held, deadlinePassed });

describe("callWindowSizeOnFailedJoin", () => {
  it("stays in the circles while the call is held", () => {
    expect(fallback("speaker", "connected", true)).toBe(null);
    expect(fallback("circles", "connected", true)).toBe(null);
  });

  it("stays while the join is still on its way", () => {
    expect(fallback("speaker", "connecting", false)).toBe(null);
  });

  it("does nothing on the idle moment before the join starts", () => {
    // Every window begins idle. Falling back here would mean the window gave up
    // before it ever tried.
    expect(fallback("circles", "idle", false)).toBe(null);
  });

  it("falls back to the stage on a failed join, from every circle size", () => {
    // The invisible-window case: a microphone this window was not allowed to
    // open. No faces arrive, so the circle sizes have nothing to click — the
    // stage has a surface, a close button and an account of what went wrong.
    // Tiny most of all: 40px of nothing is the hardest of them to find.
    expect(fallback("speaker", "error", false)).toBe("panel");
    expect(fallback("circles", "error", false)).toBe("panel");
    expect(fallback("tiny", "error", false)).toBe("panel");
  });

  it("falls back on a join that neither connects nor fails", () => {
    expect(fallback("circles", "connecting", false, true)).toBe("panel");
  });

  it("ignores the deadline once the call is actually held", () => {
    // A long call is not a failed join.
    expect(fallback("speaker", "connected", true, true)).toBe(null);
  });

  it("does not read an error AFTER holding the call as a failed join", () => {
    // A window that had the call and hit an error still owns it. Resizing it
    // out from under a live room would be the shape changing for no reason.
    expect(fallback("circles", "error", true)).toBe(null);
  });

  it("never fires in the stage, which is where it would fall back to", () => {
    for (const phase of ["error", "idle", "connecting"] as CallWindowPhase[]) {
      expect(fallback("panel", phase, false, true)).toBe(null);
    }
  });
});

describe("callWindowLeaveGesture", () => {
  it("hangs up when the window holds the call", () => {
    expect(callWindowLeaveGesture(true)).toEqual({ close: true, ended: true, hangUp: true });
  });

  it("never hangs up from a window that failed to join", () => {
    // `leaveCall` would delete the `call_members` seat — one row per (user,
    // room), shared with whichever window DOES hold the call. This window must
    // close and touch nothing.
    expect(callWindowLeaveGesture(false)).toEqual({ close: true, ended: false, hangUp: false });
  });

  it("always closes, whichever state the window is in", () => {
    for (const held of [true, false]) expect(callWindowLeaveGesture(held).close).toBe(true);
  });
});

describe("callWindowReport", () => {
  it("reports the room from the URL before the join has anything to say", () => {
    // The first report fires at phase idle, before the join. A null room there
    // would wipe the room the shell opened the window with, and a close in that
    // instant would hand back nothing.
    expect(
      callWindowReport({
        roomKey: null,
        windowRoom: "dm:a:b",
        muted: true,
        camera: false,
        scribe: false,
      }),
    ).toEqual({ room: "dm:a:b", mic: false, camera: false, scribe: false });
  });

  it("carries the state the person is actually in", () => {
    // Not defaults: handing a call over without them is what mutes somebody
    // mid-sentence or drops a live transcript at a window boundary.
    expect(
      callWindowReport({
        roomKey: "session:x",
        windowRoom: "dm:a:b",
        muted: false,
        camera: true,
        scribe: true,
      }),
    ).toEqual({ room: "session:x", mic: true, camera: true, scribe: true });
  });
});

describe("shouldYieldCallOnDisconnect", () => {
  const hang = { elsewhere: false, outlivesWindow: false };

  it("yields on DUPLICATE_IDENTITY, however LiveKit spells it", () => {
    // Enum 2, the name, a dashed name: hanging up on any of these is how
    // popping the call out kills it (leaveRoom deletes the other window's seat).
    expect(isDuplicateIdentityDisconnect(2)).toBe(true);
    expect(isDuplicateIdentityDisconnect("DUPLICATE_IDENTITY")).toBe(true);
    expect(isDuplicateIdentityDisconnect("duplicate-identity")).toBe(true);
    expect(shouldYieldCallOnDisconnect(2, hang)).toBe(true);
    expect(shouldYieldCallOnDisconnect("DUPLICATE_IDENTITY", hang)).toBe(true);
  });

  it("yields any disconnect once the call panel exists elsewhere", () => {
    // The panel is already open; this renderer is the one being vacated.
    expect(shouldYieldCallOnDisconnect(1, { elsewhere: true, outlivesWindow: false })).toBe(true);
    expect(shouldYieldCallOnDisconnect(undefined, { elsewhere: true, outlivesWindow: false })).toBe(true);
  });

  it("yields PARTICIPANT_REMOVED from a window that was going to leave", () => {
    // Some livekit-client versions report the eviction as a removal, not 2.
    expect(
      shouldYieldCallOnDisconnect(4, { elsewhere: false, outlivesWindow: true }),
    ).toBe(true);
    expect(
      shouldYieldCallOnDisconnect("PARTICIPANT_REMOVED", { elsewhere: false, outlivesWindow: true }),
    ).toBe(true);
  });

  it("hangs up a real kick, a network drop, a room that closed", () => {
    expect(shouldYieldCallOnDisconnect(1, hang)).toBe(false);
    expect(shouldYieldCallOnDisconnect(3, hang)).toBe(false);
    expect(shouldYieldCallOnDisconnect(9, hang)).toBe(false);
    expect(shouldYieldCallOnDisconnect(undefined, hang)).toBe(false);
  });
});
