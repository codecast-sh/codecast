import { test, expect, describe } from "bun:test";
import { pendingBannerState, isActiveAgentStatus, isBootingAgentStatus, type LiveAgentStatus } from "./pendingBanner";

const opts = (o: Partial<{ retryEligible: boolean; restartInFlight: boolean; idleGraceElapsed: boolean; bootGraceElapsed: boolean }> = {}) => ({
  retryEligible: true,
  restartInFlight: false,
  idleGraceElapsed: true,
  bootGraceElapsed: true,
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
  test("agent busy (the incident: long xhigh thinking turn) → calm 'queued', never a kill & restart", () => {
    // A message queued behind a long thinking turn must NOT offer to kill the agent.
    expect(pendingBannerState("thinking", opts())).toBe("queued");
    expect(pendingBannerState("working", opts())).toBe("queued");
    expect(pendingBannerState("compacting", opts())).toBe("queued");
    expect(pendingBannerState("permission_blocked", opts())).toBe("queued");
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
