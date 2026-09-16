import { describe, expect, it } from "bun:test";
import {
  applyRestartingSessionStamp,
  deriveRestartStage,
  liveRestartStartedAt,
  rebindRestartLifecycle,
  restartConfirmedLive,
  RESTART_GIVE_UP_AFTER_MS,
  type RestartProgressRow,
} from "./useSessionRestart";

const A = "a".repeat(32);
const B = "b".repeat(32);

const row = (over: Partial<RestartProgressRow>): RestartProgressRow => ({
  command: "resume_session",
  created_at: 1000,
  executed_at: null,
  result: null,
  error: null,
  ...over,
});

describe("pending message restart progress", () => {
  it("distinguishes a ready session from delivery of its pending message", () => {
    for (const result of [{ resumed: true }, { reconstituted: true }, { started_fresh: true }]) {
      expect(deriveRestartStage([row({ executed_at: 2000, result: JSON.stringify(result) })], false, true))
        .toEqual({ label: "Session is ready — waiting for message delivery…", tone: "active" });
    }
  });

  it("keeps reconnecting until the resumed session is ready", () => {
    expect(deriveRestartStage([row({ executed_at: 2000, result: '{"resumed":true}' })], false))
      .toEqual({ label: "Session resumed — reconnecting…", tone: "active" });
  });

  it("does not hide a failed restart behind stale liveness", () => {
    expect(deriveRestartStage([row({ executed_at: 2000, error: "resume failed" })], false, true))
      .toEqual({ label: "Restart failed: resume failed", tone: "error" });
  });
});

describe("restartConfirmedLive", () => {
  // The reported bug: restart clicked on a session whose liveness signal is
  // still true (header says Connected), no daemon progress yet — the stale
  // snapshot must NOT read as "Session is back live".
  it("rejects the pre-kill liveness snapshot at click time", () => {
    expect(restartConfirmedLive(true, false, null)).toBe(false);
    expect(restartConfirmedLive(true, false, [])).toBe(false);
  });

  it("confirms once the session was observed down and is live again", () => {
    expect(restartConfirmedLive(true, true, null)).toBe(true);
  });

  it("confirms a seamless restart via a cleanly executed resume command", () => {
    // Fast kill→resume inside the liveness signal's freshness window: isLive
    // never dips, so the daemon's stamped resume row is the only evidence.
    expect(restartConfirmedLive(true, false, [row({ executed_at: 2000, result: '{"resumed":true}' })])).toBe(true);
  });

  it("never confirms while the session is not live", () => {
    expect(restartConfirmedLive(false, true, [row({ executed_at: 2000 })])).toBe(false);
  });

  it("ignores a pending (unexecuted) resume command", () => {
    expect(restartConfirmedLive(true, false, [row({})])).toBe(false);
  });

  it("ignores a resume that executed with an error", () => {
    expect(restartConfirmedLive(true, false, [row({ executed_at: 2000, error: "no transcript" })])).toBe(false);
  });

  it("ignores kill-only progress — the replacement is not up yet", () => {
    expect(restartConfirmedLive(true, false, [row({ command: "kill_session", executed_at: 2000 })])).toBe(false);
  });
});

describe("applyRestartingSessionStamp", () => {
  // The reported bug: ConversationView is reused, so a leftover isRestarting
  // from A must not stamp B when the inbox selection changes.
  it("does not copy an in-flight restart onto a different conversation", () => {
    const cur = { [A]: 1000 };
    expect(applyRestartingSessionStamp(cur, B, { isRestarting: true, startedAt: 1000, ownerId: A })).toBe(cur);
  });

  it("leaves the original stamp when the newly open conversation is idle", () => {
    const cur = { [A]: 1000 };
    expect(applyRestartingSessionStamp(cur, B, { isRestarting: false, startedAt: null, ownerId: B })).toBe(cur);
  });

  it("clears only the owned conversation when its restart ends", () => {
    const cur = { [A]: 1000, [B]: 2000 };
    expect(applyRestartingSessionStamp(cur, A, { isRestarting: false, startedAt: null, ownerId: A }))
      .toEqual({ [B]: 2000 });
  });

  it("stamps the owned conversation while it is restarting", () => {
    expect(applyRestartingSessionStamp({}, A, { isRestarting: true, startedAt: 1000, ownerId: A }))
      .toEqual({ [A]: 1000 });
  });

  it("is a no-op when the stamp is already the same", () => {
    const cur = { [A]: 1000 };
    expect(applyRestartingSessionStamp(cur, A, { isRestarting: true, startedAt: 1000, ownerId: A })).toBe(cur);
  });
});

describe("liveRestartStartedAt", () => {
  it("returns the stamp while it is inside the give-up window", () => {
    expect(liveRestartStartedAt({ [A]: 1000 }, A, 1000)).toBe(1000);
  });

  it("expires a stamp past the give-up window", () => {
    expect(liveRestartStartedAt({ [A]: 1000 }, A, 1000 + RESTART_GIVE_UP_AFTER_MS)).toBeUndefined();
  });

  it("does not read another conversation's stamp", () => {
    expect(liveRestartStartedAt({ [A]: 1000 }, B, 1000)).toBeUndefined();
  });
});

describe("rebindRestartLifecycle", () => {
  it("does not follow a leftover restart onto a different conversation", () => {
    expect(rebindRestartLifecycle(B, A, { [A]: 1000 }, 1000))
      .toEqual({ ownerId: B, phase: "idle", startedAt: null });
  });

  it("hydrates when navigating back to the conversation that is still restarting", () => {
    expect(rebindRestartLifecycle(A, B, { [A]: 1000 }, 1000))
      .toEqual({ ownerId: A, phase: "restarting", startedAt: 1000 });
  });

  it("is a no-op while the open conversation is unchanged", () => {
    expect(rebindRestartLifecycle(A, A, { [A]: 1000 }, 1000)).toBeNull();
  });
});
