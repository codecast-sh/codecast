import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performClaimDeviceAccount } from "./devices";
import { DEVICE_ONLINE_MS } from "./deviceRouting";

const PREV = "u".repeat(31) + "p";
const NEXT = "u".repeat(31) + "n";
const TEAM = "t".repeat(32);
const NOW = 1_700_000_000_000;

function fixtures(over: { prevSeen?: number; conv?: Record<string, any> } = {}) {
  return makeFakeDb({
    users: [
      { _id: PREV, name: "Ashot" },
      { _id: NEXT, name: "Aivery" },
    ],
    team_memberships: [
      { _id: "m1", user_id: PREV, team_id: TEAM, role: "admin" },
      { _id: "m2", user_id: NEXT, team_id: TEAM, role: "member" },
    ],
    devices: [
      { _id: "d-next", user_id: NEXT, device_id: "mini", last_seen: NOW },
      { _id: "d-prev", user_id: PREV, device_id: "mini", last_seen: over.prevSeen ?? NOW - DEVICE_ONLINE_MS - 1 },
    ],
    conversations: [
      {
        _id: "conv1",
        user_id: PREV,
        owner_device_id: "mini",
        session_id: "sess-1",
        project_path: "/Users/ec2-user/.intern-data/worktrees/cs-1/outreach",
        status: "active",
        ...(over.conv ?? {}),
      },
      {
        _id: "conv-other",
        user_id: PREV,
        owner_device_id: "laptop",
        session_id: "sess-2",
        status: "active",
      },
    ],
    managed_sessions: [
      { _id: "ms1", session_id: "sess-1", conversation_id: "conv1", user_id: PREV, pid: 1, last_heartbeat: NOW },
    ],
  });
}

const conv = (db: any, id = "conv1") => db._tables.conversations.find((c: any) => c._id === id);

describe("performClaimDeviceAccount", () => {
  test("sessions this device owns move to the new account without a resume", async () => {
    const db = fixtures();
    const result = await performClaimDeviceAccount({ db }, NEXT as any, {
      previousUserId: PREV as any,
      deviceId: "mini",
    }, NOW);
    expect(result).toEqual({ moved: 1, more: false });
    expect(conv(db).user_id).toBe(NEXT);
    expect(conv(db).author_user_id).toBe(PREV);
    expect(conv(db).owner_device_id).toBe("mini");
    expect(conv(db, "conv-other").user_id).toBe(PREV);
    expect(db._tables.managed_sessions[0].user_id).toBe(NEXT);
    expect(db._tables.daemon_commands ?? []).toEqual([]);
  });

  test("a previous login that is still heartbeating is left alone", async () => {
    const db = fixtures({ prevSeen: NOW });
    const result = await performClaimDeviceAccount({ db }, NEXT as any, {
      previousUserId: PREV as any,
      deviceId: "mini",
    }, NOW);
    expect(result.pending).toBe(true);
    expect(result.moved).toBe(0);
    expect(conv(db).user_id).toBe(PREV);
  });

  test("accounts that do not share a team are refused", async () => {
    const db = fixtures();
    db._tables.team_memberships = db._tables.team_memberships.filter((m: any) => m.user_id !== NEXT);
    const result = await performClaimDeviceAccount({ db }, NEXT as any, {
      previousUserId: PREV as any,
      deviceId: "mini",
    }, NOW);
    expect(result.error).toMatch(/share a team/);
    expect(conv(db).user_id).toBe(PREV);
  });
});
