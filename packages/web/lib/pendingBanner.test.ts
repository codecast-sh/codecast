import { test, expect, describe } from "bun:test";
import { pendingBannerState, isActiveAgentStatus, isBootingAgentStatus, isAliveIdleStatus, type LiveAgentStatus } from "./pendingBanner";

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

describe("isAliveIdleStatus", () => {
  test("dormant / waiting / done prove a live, parked pane", () => {
    for (const s of ["dormant", "waiting", "done"] as LiveAgentStatus[]) {
      expect(isAliveIdleStatus(s)).toBe(true);
      expect(isActiveAgentStatus(s)).toBe(false);
      expect(isBootingAgentStatus(s)).toBe(false);
    }
  });
  test("idle / undefined are NOT alive-idle (no liveness verdict behind them)", () => {
    expect(isAliveIdleStatus("idle")).toBe(false);
    expect(isAliveIdleStatus(undefined)).toBe(false);
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

  test("an alive-but-parked session (dormant/waiting/done) reassures on the boot budget, never the 8s idle grace", () => {
    // 2026-08-20: a message sent to a dormant-but-live session fell through to
    // the idle branch, went "stuck" ~20s after send, and the web auto-fired a
    // resume that interrupted the delivery already in flight — the false
    // "Message hasn't reached the agent" loop. A parked pane heartbeats; the
    // daemon delivers on its next pass; only the generous budget may escalate.
    for (const s of ["dormant", "waiting", "done"] as LiveAgentStatus[]) {
      expect(pendingBannerState(s, opts({ bootGraceElapsed: false }))).toBe("queued");
      expect(pendingBannerState(s, opts({ bootGraceElapsed: true }))).toBe("stuck");
      expect(pendingBannerState(s, opts({ messageReachedSession: true }))).toBe("none");
    }
  });

  test("a restart already in flight always shows the stuck bar (so its progress keeps rendering)", () => {
    // Even if the agent flips back to working mid-restart, keep showing progress.
    expect(pendingBannerState("working", opts({ restartInFlight: true }))).toBe("stuck");
    expect(pendingBannerState("idle", opts({ restartInFlight: true, retryEligible: false }))).toBe("stuck");
  });
});

// 2026-08-16: the daemon restarted twice and then froze 5–48s at a time under
// machine load. Every sent message sat unechoed and the bubble said "Message
// hasn't reached the agent" with a kill & restart button — the message HAD
// reached the agent, and the restart would have gone through the frozen daemon.
import { withDaemonHealth } from "./pendingBanner";

test("a degraded daemon replaces the session verdict with a daemon note", () => {
  expect(withDaemonHealth("stuck", { daemonDegraded: true, restartInFlight: false })).toBe("daemon");
  expect(withDaemonHealth("queued", { daemonDegraded: true, restartInFlight: false })).toBe("daemon");
});

test("a healthy daemon leaves the session verdict alone", () => {
  expect(withDaemonHealth("stuck", { daemonDegraded: false, restartInFlight: false })).toBe("stuck");
  expect(withDaemonHealth("queued", { daemonDegraded: false, restartInFlight: false })).toBe("queued");
});

test("nothing to say stays nothing, and a restart in flight keeps its progress UI", () => {
  expect(withDaemonHealth("none", { daemonDegraded: true, restartInFlight: false })).toBe("none");
  expect(withDaemonHealth("stuck", { daemonDegraded: true, restartInFlight: true })).toBe("stuck");
});
