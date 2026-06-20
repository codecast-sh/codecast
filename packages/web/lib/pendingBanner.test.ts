import { test, expect, describe } from "bun:test";
import { pendingBannerState, isActiveAgentStatus, isBootingAgentStatus, type LiveAgentStatus } from "./pendingBanner";

const opts = (o: Partial<{ retryEligible: boolean; restartInFlight: boolean; idleGraceElapsed: boolean; bootGraceElapsed: boolean; messageReachedSession: boolean }> = {}) => ({
  retryEligible: true,
  restartInFlight: false,
  idleGraceElapsed: true,
  bootGraceElapsed: true,
  messageReachedSession: false,
  ...o,
});

describe("isActiveAgentStatus", () => {
  test("working / thinking / compacting / permission_blocked are active", () => {
    for (const s of ["working", "thinking", "compacting", "permission_blocked"] as LiveAgentStatus[]) {
      expect(isActiveAgentStatus(s)).toBe(true);
    }
  });
  test("idle / connected / starting / resuming / undefined are NOT active", () => {
    for (const s of ["idle", "connected", "starting", "resuming", undefined] as (LiveAgentStatus | undefined)[]) {
      expect(isActiveAgentStatus(s)).toBe(false);
    }
  });
});

describe("isBootingAgentStatus", () => {
  test("starting / resuming / connected are booting", () => {
    for (const s of ["starting", "resuming", "connected"] as LiveAgentStatus[]) {
      expect(isBootingAgentStatus(s)).toBe(true);
    }
  });
  test("working / idle / undefined are NOT booting", () => {
    for (const s of ["working", "thinking", "idle", undefined] as (LiveAgentStatus | undefined)[]) {
      expect(isBootingAgentStatus(s)).toBe(false);
    }
  });
});

describe("pendingBannerState", () => {
  test("agent busy (long turn) → 'none': message is already in the agent's native queue, so no nag and no kill & restart", () => {
    // The daemon pastes a mid-turn message straight into Claude Code's type-ahead box
    // (ensureTmuxReady busy path); it submits when the turn ends. Nothing to show, and
    // certainly no offer to kill the agent.
    expect(pendingBannerState("thinking", opts())).toBe("none");
    expect(pendingBannerState("working", opts())).toBe("none");
    expect(pendingBannerState("compacting", opts())).toBe("none");
    expect(pendingBannerState("permission_blocked", opts())).toBe("none");
  });

  test("within the initial send grace (not yet eligible) → nothing, even if idle", () => {
    expect(pendingBannerState("idle", opts({ retryEligible: false }))).toBe("none");
    expect(pendingBannerState(undefined, opts({ retryEligible: false }))).toBe("none");
  });

  test("agent idle but still within the busy→idle grace → nothing (daemon inject imminent)", () => {
    expect(pendingBannerState("idle", opts({ idleGraceElapsed: false }))).toBe("none");
    expect(pendingBannerState(undefined, opts({ idleGraceElapsed: false }))).toBe("none");
  });

  test("agent genuinely idle/gone past the grace and still hasn't taken it → escalate to stuck", () => {
    expect(pendingBannerState("idle", opts())).toBe("stuck");
    expect(pendingBannerState(undefined, opts())).toBe("stuck"); // disconnected session has no status
  });

  test("durable delivery proof suppresses the alarm even when agent_status is unknown (the 'no crash, old version' false alarm)", () => {
    // The incident: a delivered message whose conversation reports no live agent_status
    // (disconnected / non-active / old CLI) flashed "Message hasn't reached the agent" +
    // kill & restart. pending_messages already proves it landed — never alarm.
    expect(pendingBannerState(undefined, opts({ messageReachedSession: true }))).toBe("none");
    expect(pendingBannerState("idle", opts({ messageReachedSession: true }))).toBe("none");
  });

  test("a booting/resuming/connecting session reassures instead of alarming during the boot budget", () => {
    // The false-alarm incident: a normal cold start / resume flashed "hasn't reached
    // the agent" + kill & restart at ~20s while the session was still coming up.
    for (const s of ["starting", "resuming", "connected"] as LiveAgentStatus[]) {
      expect(pendingBannerState(s, opts({ bootGraceElapsed: false }))).toBe("queued");
    }
  });

  test("a session still not processing past the generous boot budget → escalate to stuck", () => {
    for (const s of ["starting", "resuming", "connected"] as LiveAgentStatus[]) {
      expect(pendingBannerState(s, opts({ bootGraceElapsed: true }))).toBe("stuck");
    }
  });

  test("a restart already in flight always shows the stuck bar (so its progress keeps rendering)", () => {
    // Even if the agent flips back to working mid-restart, keep showing progress.
    expect(pendingBannerState("working", opts({ restartInFlight: true }))).toBe("stuck");
    expect(pendingBannerState("idle", opts({ restartInFlight: true, retryEligible: false }))).toBe("stuck");
  });
});
