import { describe, expect, test } from "bun:test";
import { HEARTBEAT_FLUSH_INTERVAL_MS } from "@codecast/shared/contracts";
import { makeFakeDb } from "./testDb";
import { buildHeartbeatPatch, heartbeatBatch } from "./managedSessions";

// The daemon beats every session each flush with its current status and a
// fresh client_ts. Count the row writes an hour of beats costs one session.
function writesPerHour(status: string): number {
  const session: Record<string, any> = { agent_status: status, agent_status_updated_at: 0, agent_status_write_at: 0, last_heartbeat: 0 };
  let writes = 0;
  for (let now = HEARTBEAT_FLUSH_INTERVAL_MS; now <= 3_600_000; now += HEARTBEAT_FLUSH_INTERVAL_MS) {
    const patch = buildHeartbeatPatch(session, status, now, now);
    if (!patch) continue;
    writes++;
    Object.assign(session, patch);
  }
  return writes;
}

describe("heartbeat patch", () => {
  test("a settled session is written on the refresh throttle, not on every beat", () => {
    for (const status of ["idle", "done", "stopped", "dormant", "hibernated"]) {
      expect(writesPerHour(status)).toBeLessThanOrEqual(60);
    }
  });

  test("an active reassertion still stamps its ordering on every beat", () => {
    expect(writesPerHour("working")).toBe(120);
  });

  test("a settled reassertion on the throttle still advances the ordering stamp", () => {
    const session = { agent_status: "idle", agent_status_write_at: 1_000, last_heartbeat: 1_000 };
    expect(buildHeartbeatPatch(session, "idle", 20_000, 20_000)).toBeNull();
    expect(buildHeartbeatPatch(session, "idle", 80_000, 80_000)).toEqual({ agent_status_write_at: 80_000, last_heartbeat: 80_000 });
  });

  test("a status change is written at once, and a stale one is refused", () => {
    const session = { agent_status: "working", agent_status_updated_at: 5_000, agent_status_write_at: 5_000, last_heartbeat: 5_000 };
    expect(buildHeartbeatPatch(session, "idle", 6_000, 6_000)).toMatchObject({ agent_status: "idle", agent_status_write_at: 6_000, last_heartbeat: 6_000 });
    expect(buildHeartbeatPatch(session, "idle", 4_000, 6_000)).toBeNull();
  });
});

describe("heartbeatBatch", () => {
  test("names the sessions the caller has no row for, its own and another user's", async () => {
    const db = makeFakeDb({
      managed_sessions: [
        { _id: "m1", user_id: "me", session_id: "mine", last_heartbeat: 0, pid: 1 },
        { _id: "m2", user_id: "other", session_id: "theirs", last_heartbeat: 0, pid: 2 },
      ],
    });
    const ctx = { db, auth: { getUserIdentity: async () => ({ subject: "me|session" }) }, scheduler: { runAfter: async () => null } } as any;
    const result = await (heartbeatBatch as any)._handler(ctx, { sessions: [{ session_id: "mine" }, { session_id: "gone" }, { session_id: "theirs" }] });
    expect(result).toEqual({ updated: 1, unknown: ["gone", "theirs"] });
  });
});
