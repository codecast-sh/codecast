import { describe, expect, test } from "bun:test";
import { shouldMarkSessionCompleted } from "./daemon.js";

const IDLE = 10 * 60 * 1000;
const ACTIVE = 30 * 60 * 1000;

// Regression: the stale-status watchdog used to mark an idle session "completed"
// purely on elapsed time, even while its agent process was still alive and just
// waiting for the user's next prompt. That flipped the conversation to "stopped"
// and stopped the web UI from streaming the resumed turn until a manual reload —
// the "tmux messages didn't sync to the web UI" report after a long idle gap.
describe("shouldMarkSessionCompleted", () => {
  test("never reaps while the agent process is still alive — even when very stale", () => {
    // This is the bug. A live, idle-waiting session must stay live no matter how
    // long the user has been away.
    expect(
      shouldMarkSessionCompleted({ status: "idle", ageMs: 47 * 60 * 1000, hasLiveAgentProcess: true }),
    ).toBe(false);
    expect(
      shouldMarkSessionCompleted({ status: "stopped", ageMs: 6 * 60 * 60 * 1000, hasLiveAgentProcess: true }),
    ).toBe(false);
    expect(
      shouldMarkSessionCompleted({ status: "working", ageMs: 6 * 60 * 60 * 1000, hasLiveAgentProcess: true }),
    ).toBe(false);
  });

  test("reaps a dead idle/stopped session once past the 10min idle threshold", () => {
    expect(
      shouldMarkSessionCompleted({ status: "idle", ageMs: IDLE + 1, hasLiveAgentProcess: false }),
    ).toBe(true);
    expect(
      shouldMarkSessionCompleted({ status: "stopped", ageMs: IDLE, hasLiveAgentProcess: false }),
    ).toBe(true); // boundary is inclusive (>=)
  });

  test("does not reap a dead idle session that is still fresh", () => {
    expect(
      shouldMarkSessionCompleted({ status: "idle", ageMs: IDLE - 1, hasLiveAgentProcess: false }),
    ).toBe(false);
  });

  test("active (working/thinking) sessions use the longer 30min threshold", () => {
    // A working status that's been stale 11min is past the idle bar but not the
    // active one — don't reap yet.
    expect(
      shouldMarkSessionCompleted({ status: "working", ageMs: IDLE + 1, hasLiveAgentProcess: false }),
    ).toBe(false);
    expect(
      shouldMarkSessionCompleted({ status: "working", ageMs: ACTIVE + 1, hasLiveAgentProcess: false }),
    ).toBe(true);
    expect(
      shouldMarkSessionCompleted({ status: undefined, ageMs: ACTIVE, hasLiveAgentProcess: false }),
    ).toBe(true);
  });

  test("liveness wins over staleness regardless of status", () => {
    for (const status of ["idle", "stopped", "working", "thinking", undefined]) {
      expect(
        shouldMarkSessionCompleted({ status, ageMs: 24 * 60 * 60 * 1000, hasLiveAgentProcess: true }),
      ).toBe(false);
    }
  });
});
