import { describe, expect, it } from "bun:test";
import {
  computeDaemonHealth,
  OFFLINE_WARN_AFTER_MS,
  OFFLINE_ALERT_AFTER_MS,
  OFFLINE_SEVERE_AFTER_MS,
  SYNC_STALL_AFTER_MS,
} from "../useDaemonHealth";

const NOW = 1_000_000_000_000;

describe("computeDaemonHealth", () => {
  it("returns unknown when no daemon has ever checked in", () => {
    expect(computeDaemonHealth(null, NOW)).toEqual({ kind: "unknown" });
    expect(computeDaemonHealth({}, NOW)).toEqual({ kind: "unknown" });
  });

  it("is ok for a fresh heartbeat with no backlog", () => {
    const health = computeDaemonHealth({ daemon_last_seen: NOW - 5000 }, NOW);
    expect(health.kind).toBe("ok");
  });

  it("escalates offline tiers by staleness", () => {
    expect(computeDaemonHealth({ daemon_last_seen: NOW - OFFLINE_WARN_AFTER_MS }, NOW)).toMatchObject({ kind: "offline", tier: "warn" });
    expect(computeDaemonHealth({ daemon_last_seen: NOW - OFFLINE_ALERT_AFTER_MS }, NOW)).toMatchObject({ kind: "offline", tier: "alert" });
    expect(computeDaemonHealth({ daemon_last_seen: NOW - OFFLINE_SEVERE_AFTER_MS }, NOW)).toMatchObject({ kind: "offline", tier: "severe" });
  });

  it("falls back to last_heartbeat when daemon_last_seen is missing", () => {
    const health = computeDaemonHealth({ last_heartbeat: NOW - OFFLINE_ALERT_AFTER_MS }, NOW);
    expect(health).toMatchObject({ kind: "offline", tier: "alert" });
  });

  it("flags a sustained sync backlog while the daemon is online", () => {
    const health = computeDaemonHealth(
      {
        daemon_last_seen: NOW - 5000,
        daemon_pending_sync_count: 7,
        daemon_oldest_pending_ms: SYNC_STALL_AFTER_MS + 1000,
      },
      NOW,
    );
    expect(health).toEqual({ kind: "sync_stalled", pending: 7, stalledMs: SYNC_STALL_AFTER_MS + 1000 });
  });

  it("ignores a transient backlog that hasn't crossed the stall threshold", () => {
    const health = computeDaemonHealth(
      {
        daemon_last_seen: NOW - 5000,
        daemon_pending_sync_count: 3,
        daemon_oldest_pending_ms: SYNC_STALL_AFTER_MS - 1000,
      },
      NOW,
    );
    expect(health.kind).toBe("ok");
  });

  it("prefers offline over sync_stalled when the daemon is also stale", () => {
    const health = computeDaemonHealth(
      {
        daemon_last_seen: NOW - OFFLINE_ALERT_AFTER_MS,
        daemon_pending_sync_count: 42,
        daemon_oldest_pending_ms: SYNC_STALL_AFTER_MS * 10,
      },
      NOW,
    );
    expect(health).toMatchObject({ kind: "offline", tier: "alert" });
  });
});
