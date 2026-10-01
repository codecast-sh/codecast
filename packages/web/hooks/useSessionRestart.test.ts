import { describe, expect, it } from "bun:test";
import {
  deriveRestartStage,
  restartConfirmedLive,
  restartPhaseOf,
  restartResumeRow,
  type RestartProgressRow,
} from "./useSessionRestart";
import { RESTART_GIVE_UP_AFTER_MS } from "../lib/sessionCommands";

const A = "a".repeat(32);
const B = "b".repeat(32);

const row = (over: Partial<RestartProgressRow>): RestartProgressRow => ({
  command: "resume_session",
  requested_at: 1000,
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
    expect(restartConfirmedLive(true, undefined)).toBe(false);
    expect(restartConfirmedLive(true, row({}))).toBe(false);
  });

  it("confirms once the daemon stamped the resume clean and the session is live", () => {
    expect(restartConfirmedLive(true, row({ executed_at: 2000, result: '{"resumed":true}' }))).toBe(true);
  });

  it("never confirms while the session is not live", () => {
    expect(restartConfirmedLive(false, row({ executed_at: 2000 }))).toBe(false);
  });

  it("ignores a resume that executed with an error", () => {
    expect(restartConfirmedLive(true, row({ executed_at: 2000, error: "no transcript" }))).toBe(false);
  });
});

describe("restartResumeRow", () => {
  const gesture = { _id: "req", conversation_id: A, command: "resume_session", kind: "restart" as const, requested_at: 1000, executed_at: null, result: null, error: null };

  it("reads the click's own resume once the daemon stamped it", () => {
    const done = { ...gesture, executed_at: 2000 };
    expect(restartResumeRow(done, [])).toBe(done);
  });

  it("follows the queued resume the server folded the click into", () => {
    const queued = row({ executed_at: 1500 });
    expect(restartResumeRow(gesture, [row({ command: "kill_session", executed_at: 1400 }), queued])).toBe(queued);
  });
});

describe("restartPhaseOf", () => {
  const base = { _id: "req", conversation_id: B, command: "resume_session", kind: "restart" as const, requested_at: 1000, executed_at: null, result: null, error: null };

  it("is restarting until the give-up deadline, then failed", () => {
    expect(restartPhaseOf(base, 1000).phase).toBe("restarting");
    expect(restartPhaseOf(base, 1000 + RESTART_GIVE_UP_AFTER_MS).phase).toBe("failed");
  });

  it("keeps a restart whose resume errored in flight: the repair follows", () => {
    expect(restartPhaseOf({ ...base, executed_at: 2000, error: "boom" }, 2000).phase).toBe("restarting");
    expect(restartPhaseOf({ ...base, kind: "repair", executed_at: 2000, error: "boom" }, 2000)).toEqual({ phase: "failed", failure: "Restart failed: boom" });
  });

  it("shows restored briefly after confirmation, then idle", () => {
    expect(restartPhaseOf({ ...base, confirmed_at: 5000 }, 5001).phase).toBe("restored");
    expect(restartPhaseOf({ ...base, confirmed_at: 5000 }, 20_000).phase).toBe("idle");
  });

  it("is failed at once when the server refused it", () => {
    expect(restartPhaseOf({ ...base, executed_at: 1, result: "dispatch_refused", error: "Not authorized" }, 1001).phase).toBe("failed");
  });
});
