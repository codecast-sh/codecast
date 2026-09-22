import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { getLiveRooms, roomSeatClass } from "./calls";
import { getTeamMembers } from "./teams";
import { PRESENCE_BUCKET_MS } from "./presenceState";

// WHAT A SEAT MEANS TO SOMEBODY OUTSIDE THE ROOM. A walkie burst seats every
// listener for the burst and half a minute after it, and every seat used to
// read as "in a huddle" to the rest of the team. The seat rows carry no intent
// flag, so the class is read off what the room records: a people room with no
// deliberate stamp and no ring behind it is a walkie room; anything else is a
// call. Pinned against the real handlers over the fake db, on both queries
// that carry it to third parties.

const NOW = Date.now();
const T1 = "t1";
const ANN = "ua";
const BOB = "ub";
const CY = "uc";
const DM = `dm:${ANN}:${BOB}`;

function tables() {
  return {
    teams: [{ _id: T1, name: "T", features: { calls: true, chat: true } }],
    team_memberships: [
      { _id: "m1", user_id: ANN, team_id: T1, visibility: "full" },
      { _id: "m2", user_id: BOB, team_id: T1, visibility: "full" },
      { _id: "m3", user_id: CY, team_id: T1, visibility: "full" },
    ],
    users: [
      { _id: ANN, name: "Ann" },
      { _id: BOB, name: "Bob" },
      { _id: CY, name: "Cy" },
    ],
    chat_channels: [{ _id: "ch1", team_id: T1, name: "design", kind: "channel" }],
    call_members: [] as any[],
    call_invites: [] as any[],
    call_room_state: [] as any[],
    devices: [] as any[],
    user_presence: [] as any[],
    session_owners: [] as any[],
    conversations: [] as any[],
  };
}

function ctxFor(rows: ReturnType<typeof tables>, user: string) {
  return {
    db: makeFakeDb(rows as any),
    auth: { getUserIdentity: async () => ({ subject: `${user}|sess`, tokenIdentifier: "x" }) },
  };
}

const handler = (fn: any) => fn._handler ?? fn.handler;

function seat(rows: ReturnType<typeof tables>, user: string, roomKey: string, over: Record<string, unknown> = {}) {
  rows.call_members.push({
    _id: `cm-${user}-${roomKey}`,
    room_key: roomKey,
    team_id: T1,
    user_id: user,
    user_name: user,
    joined_at: NOW - 10_000,
    last_seen: NOW,
    muted: false,
    camera: false,
    sharing: false,
    ...over,
  });
}

async function liveRoom(rows: ReturnType<typeof tables>, viewer: string, roomKey: string) {
  const rooms = await handler(getLiveRooms)(ctxFor(rows, viewer), {});
  return rooms.find((r: any) => r.room_key === roomKey);
}

async function rosterRow(rows: ReturnType<typeof tables>, viewer: string, member: string) {
  const members = await handler(getTeamMembers)(ctxFor(rows, viewer), { team_id: T1 });
  return members.find((m: any) => String(m._id) === member);
}

describe("roomSeatClass", () => {
  test("a people room with unstamped seats and no ring is a walkie room", async () => {
    const rows = tables();
    seat(rows, ANN, DM);
    seat(rows, BOB, DM);
    expect(await roomSeatClass(ctxFor(rows, ANN), DM, rows.call_members)).toBe("walkie");
  });

  test("one deliberate stamp makes the room a call for everyone in it", async () => {
    const rows = tables();
    seat(rows, ANN, DM);
    seat(rows, BOB, DM, { walkie_joined_at: NOW });
    expect(await roomSeatClass(ctxFor(rows, ANN), DM, rows.call_members)).toBe("call");
  });

  test("a ring somebody accepted makes it a call; a used up grant does not", async () => {
    const rows = tables();
    seat(rows, ANN, DM);
    seat(rows, BOB, DM);
    rows.call_invites.push({ _id: "i1", room_key: DM, team_id: T1, from_user: ANN, to_user: BOB, status: "cancelled", created_at: NOW - 60_000 });
    expect(await roomSeatClass(ctxFor(rows, ANN), DM, rows.call_members)).toBe("walkie");
    rows.call_invites.push({ _id: "i2", room_key: DM, team_id: T1, from_user: ANN, to_user: BOB, status: "accepted", created_at: NOW - 5_000, responded_at: NOW - 4_000 });
    expect(await roomSeatClass(ctxFor(rows, ANN), DM, rows.call_members)).toBe("call");
  });

  test("a channel or session huddle is always a call", async () => {
    const rows = tables();
    expect(await roomSeatClass(ctxFor(rows, ANN), "channel:ch1", [])).toBe("call");
    expect(await roomSeatClass(ctxFor(rows, ANN), "session:conv1", [])).toBe("call");
  });
});

describe("getLiveRooms carries the seat class", () => {
  test("on the room and on every seat", async () => {
    const rows = tables();
    seat(rows, ANN, DM);
    seat(rows, BOB, DM);
    seat(rows, CY, "channel:ch1");
    const dm = await liveRoom(rows, CY, DM);
    expect(dm.seat).toBe("walkie");
    expect(dm.members.map((m: any) => m.seat)).toEqual(["walkie", "walkie"]);
    const channel = await liveRoom(rows, ANN, "channel:ch1");
    expect(channel.seat).toBe("call");
    expect(channel.members[0].seat).toBe("call");
  });

  test("a stamp turns the whole room over, and the stamp itself is bucketed", async () => {
    const rows = tables();
    const stamp = NOW - 61_234;
    seat(rows, ANN, DM);
    seat(rows, BOB, DM, { walkie_joined_at: stamp });
    const dm = await liveRoom(rows, CY, DM);
    expect(dm.seat).toBe("call");
    expect(dm.members.map((m: any) => m.seat)).toEqual(["call", "call"]);
    const bob = dm.members.find((m: any) => m.user_id === BOB);
    expect(bob.walkie_joined_at).toBe(Math.floor(stamp / PRESENCE_BUCKET_MS) * PRESENCE_BUCKET_MS);
  });
});

describe("getTeamMembers carries the seat class", () => {
  test("a viewer the room admits reads burst from call; the stamp is bucketed", async () => {
    const rows = tables();
    seat(rows, ANN, DM);
    seat(rows, BOB, DM);
    let bob = await rosterRow(rows, ANN, BOB);
    expect(bob).toMatchObject({ in_huddle: true, in_room_key: DM, seat: "walkie" });
    expect(bob.walkie_joined_at).toBeUndefined();

    const stamp = NOW - 61_234;
    rows.call_members.find((m: any) => m.user_id === BOB)!.walkie_joined_at = stamp;
    bob = await rosterRow(rows, ANN, BOB);
    expect(bob.seat).toBe("call");
    expect(bob.walkie_joined_at).toBe(Math.floor(stamp / PRESENCE_BUCKET_MS) * PRESENCE_BUCKET_MS);
    // Ann holds no stamp of her own, yet her seat is in a call now: the class
    // is the room's, not the row's.
    const ann = await rosterRow(rows, BOB, ANN);
    expect(ann).toMatchObject({ seat: "call" });
    expect(ann.walkie_joined_at).toBeUndefined();
  });

  test("a viewer the room does not admit gets the bare boolean and nothing else", async () => {
    const rows = tables();
    seat(rows, ANN, DM);
    seat(rows, BOB, DM, { walkie_joined_at: NOW });
    const bob = await rosterRow(rows, CY, BOB);
    expect(bob.in_huddle).toBe(true);
    expect(bob.in_room_key).toBeUndefined();
    expect(bob.seat).toBeUndefined();
    expect(bob.walkie_joined_at).toBeUndefined();
  });

  test("no seat, no class", async () => {
    const rows = tables();
    const bob = await rosterRow(rows, ANN, BOB);
    expect(bob.in_huddle).toBe(false);
    expect(bob.seat).toBeUndefined();
    expect(bob.walkie_joined_at).toBeUndefined();
  });
});
