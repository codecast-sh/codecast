import { describe, expect, it } from "bun:test";
import { sessionLivenessState } from "../lib/liveness";

// sessionLivenessState defers its "active" decision to isLivenessStale, which
// now short-circuits on the retired marker. These pin the end-to-end result:
// killing a session that was mid-turn used to leave the dot pulsing green for
// up to an hour (kill never touches updated_at, and the quiet-settled arm bails
// on any ACTIVE agent_status). ct-41083.
const working = {
  is_idle: false,
  message_count: 5,
  agent_status: "working",
  updated_at: Date.now(),
};

describe("sessionLivenessState — killed rows never read active", () => {
  it("a session killed mid-turn stops pulsing immediately", () => {
    expect(sessionLivenessState({ ...working, inbox_killed_at: Date.now() })).toBe("idle");
    // Control: the same row alive is active — the marker is doing the work,
    // not the clock.
    expect(sessionLivenessState(working)).toBe("active");
  });

  it("holds for every ACTIVE status, not just 'working'", () => {
    for (const agent_status of ["working", "thinking", "compacting", "connected", "starting", "resuming"]) {
      expect(sessionLivenessState({ ...working, agent_status, inbox_killed_at: 1 })).toBe("idle");
      expect(sessionLivenessState({ ...working, agent_status })).toBe("active");
    }
  });

  it("leaves the error / unresponsive / pinned branches ahead of it alone", () => {
    expect(sessionLivenessState({ ...working, inbox_killed_at: 1, session_error: "boom" })).toBe("error");
    expect(sessionLivenessState({ ...working, inbox_killed_at: 1, is_unresponsive: true })).toBe("unresponsive");
    expect(sessionLivenessState({ ...working, is_idle: true, is_pinned: true, inbox_killed_at: 1 })).toBe("pinned");
  });

  it("a killed row with no messages is still 'new', not 'idle'", () => {
    expect(sessionLivenessState({ ...working, message_count: 0, inbox_killed_at: 1 })).toBe("new");
  });
});
