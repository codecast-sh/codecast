import { describe, expect, it } from "bun:test";
import { callWindowReport, type CallWindowPhase } from "../calls/callHandoff";

// The shell replaces its whole record of a call window on every report, and
// that record IS the handback payload: `shouldHandBackCall` refuses to hand
// back a call with no room. So a report that says "no room" while the join is
// still getting started does not merely lose a field — it erases the room the
// shell opened the window with, and a close in that instant (the traffic
// light, a moment after the window appeared) hands the call nowhere.

const report = (phase: CallWindowPhase, roomKey: string | null, windowRoom: string | null = "team/standup") =>
  callWindowReport({ phase, roomKey, windowRoom, muted: false, camera: false, scribe: false });

describe("callWindowReport", () => {
  it("carries the URL's room on the first report, at phase idle", () => {
    // Every call window begins here: opened for a room, with no call yet.
    expect(report("idle", null).room).toBe("team/standup");
  });

  it("never reports a null room while the window has one in its address", () => {
    for (const phase of ["idle", "ringing_out", "connecting", "connected", "error"] as CallWindowPhase[]) {
      expect(report(phase, null).room).toBe("team/standup");
    }
  });

  it("keeps reporting the room after a join fails", () => {
    // The failure path depends on it: this window closes with the call still
    // alive elsewhere, and the shell needs a room to route.
    expect(report("error", null).room).toBe("team/standup");
  });

  it("prefers the room the call is actually in", () => {
    expect(report("connected", "team/design", "team/standup").room).toBe("team/design");
  });

  it("reports no room only when the window was opened without one", () => {
    expect(report("idle", null, null).room).toBeNull();
  });

  it("holds the call only once connected", () => {
    expect(report("connected", "team/standup").joined).toBe(true);
    for (const phase of ["idle", "ringing_out", "connecting", "error"] as CallWindowPhase[]) {
      expect(report(phase, "team/standup").joined).toBe(false);
    }
  });

  it("reports the mic as live when the call is not muted", () => {
    const base = { phase: "connected" as CallWindowPhase, roomKey: "r", windowRoom: "r", camera: true, scribe: true };
    expect(callWindowReport({ ...base, muted: true })).toEqual({
      room: "r", mic: false, camera: true, scribe: true, joined: true,
    });
    expect(callWindowReport({ ...base, muted: false }).mic).toBe(true);
  });
});
