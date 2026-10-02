import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { heartbeat, joinRoom, leaveRoom } from "./calls";

// END ON ONE DEVICE HANGS UP EVERY DEVICE. A seat is one per person per room,
// so pressing End on the desktop deletes the seat a browser tab is still
// holding media for. That tab's heartbeat used to read the missing row as a
// lease sweep (a laptop that slept) and take the seat back, so End was undone
// within one beat. The heartbeat now tells a hang-up from a sweep.

const NOW = Date.now();
const T1 = "t1";
const ANN = "ua";
const BOB = "ub";
const DM = `dm:${ANN}:${BOB}`;

function tables() {
  return {
    teams: [{ _id: T1, name: "T", features: { calls: true, chat: true } }],
    team_memberships: [
      { _id: "m1", user_id: ANN, team_id: T1, visibility: "full" },
      { _id: "m2", user_id: BOB, team_id: T1, visibility: "full" },
    ],
    users: [
      { _id: ANN, name: "Ann", active_team_id: T1 },
      { _id: BOB, name: "Bob", active_team_id: T1 },
    ],
    call_members: [
      {
        _id: "cm-ann",
        room_key: DM,
        team_id: T1,
        user_id: ANN,
        user_name: "Ann",
        joined_at: NOW - 10_000,
        last_seen: NOW,
        muted: false,
        camera: false,
        sharing: false,
      },
    ] as any[],
    call_hangups: [] as any[],
    call_invites: [] as any[],
    call_room_state: [] as any[],
    call_grants: [] as any[],
    call_recordings: [] as any[],
    transcripts: [] as any[],
    devices: [] as any[],
    user_presence: [] as any[],
    conversations: [] as any[],
  };
}

const handler = (fn: any) => fn._handler ?? fn.handler;

function asAnn(rows: ReturnType<typeof tables>) {
  return {
    db: makeFakeDb(rows as any),
    auth: { getUserIdentity: async () => ({ subject: `${ANN}|sess`, tokenIdentifier: "x" }) },
    scheduler: { runAfter: async () => null },
  };
}

describe("hang-up from another device", () => {
  test("a heartbeat after End answers hungUp, so the holding client leaves", async () => {
    const rows = tables();
    await handler(leaveRoom)(asAnn(rows), { room_key: DM });
    const res = await handler(heartbeat)(asAnn(rows), { room_key: DM });
    expect(res).toEqual({ ok: false, hungUp: true });
  });

  test("a swept seat is not a hang-up: the client still takes it back", async () => {
    const rows = tables();
    rows.call_members.length = 0;
    const res = await handler(heartbeat)(asAnn(rows), { room_key: DM });
    expect(res).toEqual({ ok: false });
  });

  test("joining again takes back the hang-up", async () => {
    const rows = tables();
    await handler(leaveRoom)(asAnn(rows), { room_key: DM });
    await handler(joinRoom)(asAnn(rows), { room_key: DM });
    expect(rows.call_hangups).toHaveLength(0);
    const res = await handler(heartbeat)(asAnn(rows), { room_key: DM });
    expect(res).toEqual({ ok: true });
  });
});
