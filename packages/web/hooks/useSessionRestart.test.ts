import { describe, expect, it } from "bun:test";
import { deriveRestartStage, restartConfirmedLive, type RestartProgressRow } from "./useSessionRestart";

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
