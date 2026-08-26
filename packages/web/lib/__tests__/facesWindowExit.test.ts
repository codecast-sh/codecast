import { describe, expect, it } from "bun:test";
import { facesLeaveGesture, facesWindowExit, type CallWindowPhase } from "../calls/callHandoff";

// The floating faces window has no title bar, no close box and no dock entry.
// These rules are the only thing that closes it, and the only thing that tells
// the shell whether a live call is coming back. Both failure directions are
// expensive: a window that never closes sits over somebody's work forever, and
// a window that closes claiming the call ended takes a live call with it.

const exit = (phase: CallWindowPhase, held: boolean, deadlinePassed = false) =>
  facesWindowExit({ phase, held, deadlinePassed });

describe("facesWindowExit", () => {
  it("stays while it holds the call", () => {
    expect(exit("connected", true)).toEqual({ close: false, ended: false });
  });

  it("stays while it is still joining", () => {
    expect(exit("connecting", false)).toEqual({ close: false, ended: false });
  });

  it("does not close on the idle moment before the join starts", () => {
    // Every one of these windows begins idle. Closing here would mean the
    // window shut itself before it ever tried.
    expect(exit("idle", false)).toEqual({ close: false, ended: false });
  });

  it("closes and declares the call over once it held it and lost it", () => {
    expect(exit("idle", true)).toEqual({ close: true, ended: true });
  });

  it("closes on a failed join and says the call is still alive", () => {
    // The zombie case: a microphone this window was not allowed to open. It
    // must close (nothing else can close it) and must NOT claim the call
    // ended — the call is still in the window it was minimized from.
    expect(exit("error", false)).toEqual({ close: true, ended: false });
  });

  it("closes on a join that neither connects nor fails", () => {
    expect(exit("connecting", false, true)).toEqual({ close: true, ended: false });
  });

  it("ignores the deadline once the call is actually held", () => {
    // A long call is not a failed join.
    expect(exit("connected", true, true)).toEqual({ close: false, ended: false });
  });

  it("does not treat an error AFTER holding the call as a failed join", () => {
    // A window that had the call and hit an error still owns it until it goes
    // idle; closing here would hand the room somewhere while this window is
    // still in the room.
    expect(exit("error", true)).toEqual({ close: false, ended: false });
  });
});

describe("facesLeaveGesture", () => {
  it("hangs up when this window holds the call", () => {
    expect(facesLeaveGesture(true)).toEqual({ close: true, ended: true, hangUp: true });
  });

  it("never hangs up from a window that failed to join", () => {
    // `leaveCall` would delete the `call_members` seat — one row per (user,
    // room), shared with the window that DOES hold the call. This window must
    // close and touch nothing.
    expect(facesLeaveGesture(false)).toEqual({ close: true, ended: false, hangUp: false });
  });

  it("always closes, whichever state the window is in", () => {
    for (const held of [true, false]) expect(facesLeaveGesture(held).close).toBe(true);
  });
});
