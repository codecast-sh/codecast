import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  CALL_MEMBER_STALE_MS,
  GUEST_DENY_COOLDOWN_MS,
  GUEST_KNOCKS_PER_LINK_PER_MINUTE,
  GUEST_LINK_MAX_TTL_MS,
  GUEST_LINK_MIN_TTL_MS,
  GUEST_LINK_TTL_MS,
  MAX_WAITING_GUESTS,
} from "@codecast/shared/contracts";
import {
  admitGuest,
  authForGuestToken,
  clampLinkTtl,
  createGuestLink,
  denyGuest,
  describeGuestLink,
  getGuestState,
  guestHeartbeat,
  guestView,
  leaveCall,
  linkRefusal,
  listGuestLinks,
  removeGuest,
  requestJoin,
  revokeGuestLink,
} from "./callGuests";
import { getLiveRooms, getRoomKnocks } from "./calls";
import { appendSegments } from "./transcripts";
import { expireRoomGrants } from "./callRooms";

const ROOM = "dm:u1:u2";
const run = (fn: any) => fn._handler ?? fn.handler;

// A team with calls on, two teammates in a people room, u1 seated in it, and
// an outsider (u9) on no team. Everything a guest touches is in these tables.
function world(extra: Record<string, any[]> = {}) {
  const now = Date.now();
  const db = makeFakeDb({
    teams: [{ _id: "t1", name: "T", features: { calls: true } }],
    users: [
      { _id: "u1", name: "Sam Rivera", image: "https://img/sam.png" },
      { _id: "u2", name: "Lee" },
      { _id: "u9", name: "Outsider" },
    ],
    team_memberships: [
      { _id: "tm1", user_id: "u1", team_id: "t1" },
      { _id: "tm2", user_id: "u2", team_id: "t1" },
    ],
    call_members: [
      { _id: "cm1", room_key: ROOM, team_id: "t1", user_id: "u1", user_name: "Sam Rivera", joined_at: now - 60_000, last_seen: now, muted: false, camera: false, sharing: false, walkie_joined_at: now - 60_000 },
    ],
    call_invites: [],
    call_room_state: [],
    call_knocks: [],
    call_guest_links: [],
    call_guests: [],
    call_recordings: [],
    transcripts: [],
    transcript_segments: [],
    conversations: [],
    chat_channels: [],
    ...extra,
  }, { strictPatch: true });
  const scheduled: any[] = [];
  const as = (userId: string | null) => ({
    db,
    auth: { getUserIdentity: async () => (userId ? { subject: `${userId}|s`, tokenIdentifier: userId } : null) },
    scheduler: { runAfter: async (_ms: number, fn: any, args: any) => { scheduled.push(args); } },
  });
  return { db, as, scheduled, now };
}

async function linkAndKnock(w: ReturnType<typeof world>, name = "Ada") {
  const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
  const joined = await run(requestJoin)(w.as(null), { token: link.token, name, accept_notice: true });
  return { link, ...joined };
}

describe("pure rules", () => {
  test("link refusal names why", () => {
    const now = 1_000;
    expect(linkRefusal(null, now)).toBe("not_found");
    expect(linkRefusal({ expires_at: 2_000, revoked_at: 500 } as any, now)).toBe("revoked");
    expect(linkRefusal({ expires_at: 1_000 } as any, now)).toBe("expired");
    expect(linkRefusal({ expires_at: 1_001 } as any, now)).toBeNull();
  });

  test("a link's lifetime is held inside the allowed range", () => {
    expect(clampLinkTtl(undefined)).toBe(GUEST_LINK_TTL_MS);
    expect(clampLinkTtl(1)).toBe(GUEST_LINK_MIN_TTL_MS);
    expect(clampLinkTtl(Number.MAX_SAFE_INTEGER)).toBe(GUEST_LINK_MAX_TTL_MS);
    expect(clampLinkTtl(Number.NaN)).toBe(GUEST_LINK_TTL_MS);
  });

  test("the guest page's view: a revoked link closes the door, an ended huddle ends an admission", () => {
    const off = { huddleRunning: false, linkRevoked: false };
    const on = { huddleRunning: true, linkRevoked: false };
    expect(guestView({ status: "waiting" } as any, { huddleRunning: true, linkRevoked: true })).toBe("closed");
    expect(guestView({ status: "waiting" } as any, off)).toBe("waiting");
    expect(guestView({ status: "admitted" } as any, on)).toBe("admitted");
    expect(guestView({ status: "admitted" } as any, off)).toBe("ended");
    // An admitted guest's link being revoked does not touch them.
    expect(guestView({ status: "admitted" } as any, { huddleRunning: true, linkRevoked: true })).toBe("admitted");
    expect(guestView({ status: "left", left_reason: "huddle_ended" } as any, on)).toBe("ended");
    expect(guestView({ status: "left", left_reason: "self" } as any, on)).toBe("left");
    expect(guestView({ status: "removed" } as any, on)).toBe("removed");
  });
});

describe("links", () => {
  test("someone in the room makes one, and copying it twice hands out one door", async () => {
    const w = world();
    const a = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    const b = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    expect(a.path).toBe(`/meet/${a.token}`);
    expect(a.token.length).toBeGreaterThanOrEqual(24);
    expect(b.reused).toBe(true);
    expect(b.token).toBe(a.token);
    // A fresh link revokes the old one: a leaked link is replaced, not added to.
    const c = await run(createGuestLink)(w.as("u1"), { room_key: ROOM, fresh: true });
    expect(c.token).not.toBe(a.token);
    expect(w.db._tables.call_guest_links.find((l: any) => l.token === a.token).revoked_at).toBeNumber();
    const listed = await run(listGuestLinks)(w.as("u2"), { room_key: ROOM });
    expect(listed.map((l: any) => l.token)).toEqual([c.token]);
  });

  test("nobody outside the room can make or list one", async () => {
    const w = world();
    await expect(run(createGuestLink)(w.as("u9"), { room_key: ROOM })).rejects.toThrow(/Cannot invite guests/);
    await expect(run(createGuestLink)(w.as(null), { room_key: ROOM })).rejects.toThrow(/Not authenticated/);
    await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    expect(await run(listGuestLinks)(w.as("u9"), { room_key: ROOM })).toEqual([]);
    expect(await run(listGuestLinks)(w.as(null), { room_key: ROOM })).toEqual([]);
  });

  test("a link's page shows the inviter and the notice, and nothing about the team", async () => {
    const w = world();
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    const d = await run(describeGuestLink)(w.as(null), { token: link.token });
    expect(d).toEqual({
      ok: true,
      title: null,
      inviter: { name: "Sam Rivera", image: "https://img/sam.png" },
      expires_at: link.expires_at,
      live: true,
      transcribed: true,
      recording: false,
    });
    expect(await run(describeGuestLink)(w.as(null), { token: "nope-not-a-token" })).toEqual({ ok: false, reason: "not_found" });
  });

  test("a session room's title shows only if the link's creator could see it", async () => {
    const room = "session:c1";
    const w = world({
      conversations: [{ _id: "c1", user_id: "u2", team_id: "t1", title: "Secret plans", is_private: true }],
      call_members: [{ _id: "cm1", room_key: room, team_id: "t1", user_id: "u1", user_name: "Sam", joined_at: 0, last_seen: Date.now(), muted: false, camera: false, sharing: false }],
    });
    // u1 sits in the huddle through the open door but cannot see the private conversation.
    const link = await run(createGuestLink)(w.as("u1"), { room_key: room });
    const d = await run(describeGuestLink)(w.as(null), { token: link.token });
    expect(d.title).toBeNull();
    // The conversation's owner made a link of their own: they can see it, so the guest may.
    w.db._tables.call_members.push({ _id: "cm2", room_key: room, team_id: "t1", user_id: "u2", user_name: "Lee", joined_at: 0, last_seen: Date.now(), muted: false, camera: false, sharing: false });
    const own = await run(createGuestLink)(w.as("u2"), { room_key: room });
    expect((await run(describeGuestLink)(w.as(null), { token: own.token })).title).toBe("Secret plans");
  });

  test("the notice follows the room: transcription off and a recording running", async () => {
    const w = world();
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    w.db._tables.call_room_state.push({ _id: "rs1", room_key: ROOM, team_id: "t1", locked: false, locked_by: "u1", transcribe_off: true, updated_at: 0 });
    w.db._tables.call_recordings.push({ _id: "rec1", room_key: ROOM, kind: "composite", status: "recording" });
    const d = await run(describeGuestLink)(w.as(null), { token: link.token });
    expect(d.transcribed).toBe(false);
    expect(d.recording).toBe(true);
  });
});

describe("knocking", () => {
  test("the first knock mints a secret that is never stored, and the room sees a guest at the door", async () => {
    const w = world();
    const { guest_id, secret, status } = await linkAndKnock(w, "  Ada​  Lovelace ");
    expect(status).toBe("waiting");
    expect(secret).toBeString();
    const row = w.db._tables.call_guests[0];
    expect(row.name).toBe("Ada Lovelace");
    expect(row.secret_hash).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row.notice_accepted_at).toBeNumber();
    const knocks = await run(getRoomKnocks)(w.as("u1"), { room_key: ROOM });
    expect(knocks).toEqual([
      { from_user: `guest:${guest_id}`, from_name: "Ada Lovelace", from_image: undefined, created_at: row.knocked_at, kind: "guest", guest_id },
    ]);
    // Somebody not in the room sees no door at all.
    expect(await run(getRoomKnocks)(w.as("u2"), { room_key: ROOM })).toEqual([]);
  });

  test("an empty name is refused rather than defaulted", async () => {
    const w = world();
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    await expect(run(requestJoin)(w.as(null), { token: link.token, name: " \u0007 ", accept_notice: true })).rejects.toThrow(/name/);
  });

  test("re-knocking with the secret refreshes the same row instead of making another", async () => {
    const w = world();
    const { link, guest_id, secret } = await linkAndKnock(w);
    const again = await run(requestJoin)(w.as(null), { token: link.token, name: "Ada L", accept_notice: true, guest_id, secret });
    expect(again).toEqual({ guest_id, secret: null, status: "waiting" });
    expect(w.db._tables.call_guests).toHaveLength(1);
    expect(w.db._tables.call_guests[0].name).toBe("Ada L");
  });

  test("a knock whose page went away drops off the door, and its next beat puts it back", async () => {
    const w = world();
    const { guest_id, secret } = await linkAndKnock(w);
    const row = w.db._tables.call_guests[0];
    row.last_seen = Date.now() - CALL_MEMBER_STALE_MS - 1;
    row.knocked_at = row.last_seen;
    expect(await run(getRoomKnocks)(w.as("u1"), { room_key: ROOM })).toEqual([]);
    expect(await run(guestHeartbeat)(w.as(null), { guest_id, secret })).toEqual({ view: "waiting" });
    const knocks = await run(getRoomKnocks)(w.as("u1"), { room_key: ROOM });
    expect(knocks).toHaveLength(1);
    // A returning page is a new knock: the door's signature moves.
    expect(knocks[0].created_at).toBeGreaterThan(Date.now() - 5_000);
  });

  test("a link mints at most a handful of new guests a minute", async () => {
    const w = world();
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    for (let i = 0; i < GUEST_KNOCKS_PER_LINK_PER_MINUTE; i++) {
      await run(requestJoin)(w.as(null), { token: link.token, name: `G${i}`, accept_notice: true });
    }
    await expect(run(requestJoin)(w.as(null), { token: link.token, name: "One more", accept_notice: true })).rejects.toThrow(/Too many people are joining/);
  });

  test("a room shows at most so many strangers waiting", async () => {
    const w = world();
    const a = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    const b = await run(createGuestLink)(w.as("u2"), { room_key: ROOM }).catch(() => null);
    // u2 is not seated in a people room it belongs to: membership lets them make a link.
    expect(b).not.toBeNull();
    const tokens = [a.token, b!.token];
    for (let i = 0; i < MAX_WAITING_GUESTS; i++) {
      await run(requestJoin)(w.as(null), { token: tokens[i % 2], name: `G${i}`, accept_notice: true });
    }
    await expect(run(requestJoin)(w.as(null), { token: tokens[0], name: "Late", accept_notice: true })).rejects.toThrow(/Too many people are waiting/);
  });
});

describe("a guest secret opens one row and nothing else", () => {
  test("wrong secret, someone else's row, and ids from other tables all read as nobody", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    const link = w.db._tables.call_guest_links[0];
    const bob = await run(requestJoin)(w.as(null), { token: link.token, name: "Bob", accept_notice: true });
    const state = run(getGuestState);
    expect(await state(w.as(null), { guest_id: ada.guest_id, secret: "x".repeat(32) })).toBeNull();
    expect(await state(w.as(null), { guest_id: ada.guest_id, secret: bob.secret })).toBeNull();
    expect(await state(w.as(null), { guest_id: "u1", secret: ada.secret })).toBeNull();
    expect(await state(w.as(null), { guest_id: link._id, secret: ada.secret })).toBeNull();
    expect(await run(guestHeartbeat)(w.as(null), { guest_id: ada.guest_id, secret: bob.secret })).toBeNull();
    expect(await run(leaveCall)(w.as(null), { guest_id: bob.guest_id, secret: ada.secret })).toBeNull();
    expect((await run(authForGuestToken)(w.as(null), { guest_id: ada.guest_id, secret: bob.secret })).ok).toBe(false);
    // Its own row reads, and what it reads is about this meeting only.
    const mine = await state(w.as(null), { guest_id: ada.guest_id, secret: ada.secret });
    expect(Object.keys(mine).sort()).toEqual(["inviter", "link_open", "live", "name", "recording", "retry_at", "title", "transcribed", "view"]);
    expect(mine.view).toBe("waiting");
  });

  test("a guest cannot answer the door: the room's mutations need an account", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    await expect(run(admitGuest)(w.as(null), { guest_id: ada.guest_id })).rejects.toThrow(/Not authenticated/);
    await expect(run(removeGuest)(w.as(null), { guest_id: ada.guest_id })).rejects.toThrow(/Not authenticated/);
  });
});

describe("answering the door", () => {
  test("only someone seated may admit; admission mints a guest identity token", async () => {
    const w = world();
    const ada = await linkAndKnock(w);
    // u2 belongs to the room but is not in the huddle.
    await expect(run(admitGuest)(w.as("u2"), { guest_id: ada.guest_id })).rejects.toThrow(/Only someone in the huddle/);
    expect((await run(authForGuestToken)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).ok).toBe(false);
    expect(await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id })).toEqual({ status: "admitted" });
    // Twice is once.
    expect(await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id })).toEqual({ status: "admitted" });
    expect(await run(authForGuestToken)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).toEqual({
      ok: true,
      room_key: ROOM,
      identity: `guest:${ada.guest_id}`,
      name: "Ada",
    });
    // In the room's roster, as a guest and apart from the members.
    expect(await run(getRoomKnocks)(w.as("u1"), { room_key: ROOM })).toEqual([]);
    const rooms = await run(getLiveRooms)(w.as("u2"), {});
    expect(rooms[0].members.map((m: any) => m.user_id)).toEqual(["u1"]);
    expect(rooms[0].guests).toEqual([
      { guest_id: ada.guest_id, identity: `guest:${ada.guest_id}`, name: "Ada", joined_at: expect.any(Number) },
    ]);
  });

  test("a denied guest waits out the cooldown before asking again", async () => {
    const w = world();
    const ada = await linkAndKnock(w);
    await run(denyGuest)(w.as("u1"), { guest_id: ada.guest_id });
    const st = await run(getGuestState)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret });
    expect(st.view).toBe("denied");
    expect(st.retry_at).toBeGreaterThan(Date.now());
    const again = { token: ada.link.token, name: "Ada", accept_notice: true, guest_id: ada.guest_id, secret: ada.secret };
    await expect(run(requestJoin)(w.as(null), again)).rejects.toThrow(/not now/);
    w.db._tables.call_guests[0].decided_at = Date.now() - GUEST_DENY_COOLDOWN_MS - 1;
    expect((await run(requestJoin)(w.as(null), again)).status).toBe("waiting");
  });

  test("a removed guest gets no new token, cannot knock again on that row, and is put out of the media room", async () => {
    const w = world();
    const ada = await linkAndKnock(w);
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    await run(removeGuest)(w.as("u1"), { guest_id: ada.guest_id });
    expect(w.scheduled).toContainEqual({ room_key: ROOM, identity: `guest:${ada.guest_id}` });
    expect(await run(authForGuestToken)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).toEqual({
      ok: false,
      reason: "You were removed from this call",
    });
    await expect(
      run(requestJoin)(w.as(null), { token: ada.link.token, name: "Ada", accept_notice: true, guest_id: ada.guest_id, secret: ada.secret }),
    ).rejects.toThrow(/removed/);
    expect((await run(getLiveRooms)(w.as("u1"), {}))[0].guests).toEqual([]);
  });
});

describe("revoking a link", () => {
  test("stops new knocks and closes the door on people waiting, and leaves people inside alone", async () => {
    const w = world();
    const inside = await linkAndKnock(w, "Ada");
    await run(admitGuest)(w.as("u1"), { guest_id: inside.guest_id });
    const waiting = await run(requestJoin)(w.as(null), { token: inside.link.token, name: "Bob", accept_notice: true });
    await run(revokeGuestLink)(w.as("u1"), { link_id: inside.link.link_id });

    expect(await run(describeGuestLink)(w.as(null), { token: inside.link.token })).toEqual({ ok: false, reason: "revoked" });
    await expect(run(requestJoin)(w.as(null), { token: inside.link.token, name: "Eve", accept_notice: true })).rejects.toThrow(/turned off/);
    expect((await run(getGuestState)(w.as(null), { guest_id: waiting.guest_id, secret: waiting.secret })).view).toBe("closed");
    expect(await run(getRoomKnocks)(w.as("u1"), { room_key: ROOM })).toEqual([]);
    await expect(run(admitGuest)(w.as("u1"), { guest_id: waiting.guest_id })).rejects.toThrow(/turned off/);

    expect((await run(authForGuestToken)(w.as(null), { guest_id: inside.guest_id, secret: inside.secret })).ok).toBe(true);
  });

  test("only its creator or someone who could make one may revoke it", async () => {
    const w = world();
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    await expect(run(revokeGuestLink)(w.as("u9"), { link_id: link.link_id })).rejects.toThrow(/not found/);
    expect(await run(revokeGuestLink)(w.as("u2"), { link_id: link.link_id })).toEqual({ revoked: true });
  });
});

describe("an admission is for one huddle", () => {
  test("with everyone from the team gone, the guest's next beat ends it and puts them out", async () => {
    const w = world();
    const ada = await linkAndKnock(w);
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    w.db._tables.call_members.length = 0;
    expect(await run(guestHeartbeat)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).toEqual({ view: "ended" });
    expect(w.db._tables.call_guests[0]).toMatchObject({ status: "left", left_reason: "huddle_ended" });
    expect(w.scheduled).toContainEqual({ room_key: ROOM, identity: `guest:${ada.guest_id}` });
    expect(await run(authForGuestToken)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).toEqual({
      ok: false,
      reason: "You have not been let in",
    });
  });

  test("inside the grace the huddle still runs for a guest", async () => {
    const w = world({
      transcripts: [{ _id: "tr1", room_key: ROOM, team_id: "t1", started_by: "u1", status: "live", started_at: Date.now() - 60_000, idle_since: Date.now() - 10_000, routes: [], last_seq: 0 }],
    });
    const ada = await linkAndKnock(w);
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    w.db._tables.call_members.length = 0;
    expect(await run(guestHeartbeat)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).toEqual({ view: "admitted" });
    expect(w.db._tables.call_guests[0].transcript_id).toBe("tr1");
  });

  test("a room restarting from empty settles the last huddle's guests and keeps the ones waiting", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    const bob = await run(requestJoin)(w.as(null), { token: ada.link.token, name: "Bob", accept_notice: true });
    await expireRoomGrants(w.as("u1"), ROOM);
    const rows = Object.fromEntries(w.db._tables.call_guests.map((g: any) => [g._id, g]));
    expect(rows[ada.guest_id]).toMatchObject({ status: "left", left_reason: "huddle_ended" });
    expect(rows[bob.guest_id].status).toBe("waiting");
    expect(w.scheduled).toContainEqual({ room_key: ROOM, identity: `guest:${ada.guest_id}` });
    expect((await run(getGuestState)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).view).toBe("ended");
  });

  test("leaving is the guest's own word", async () => {
    const w = world();
    const ada = await linkAndKnock(w);
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    expect(await run(leaveCall)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).toEqual({ view: "left" });
    expect((await run(getGuestState)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).view).toBe("left");
    // And a knock brings them back to the door, not straight in.
    const back = await run(requestJoin)(w.as(null), { token: ada.link.token, name: "Ada", accept_notice: true, guest_id: ada.guest_id, secret: ada.secret });
    expect(back.status).toBe("waiting");
  });
});

describe("guests in the transcript", () => {
  test("a guest's words carry the name the room admitted, marked as a guest, whatever the scribe sent", async () => {
    const w = world({
      transcripts: [{ _id: "tr1", room_key: ROOM, team_id: "t1", started_by: "u1", status: "live", started_at: Date.now(), routes: [], last_seq: 0 }],
    });
    const ada = await linkAndKnock(w);
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    await run(appendSegments)(w.as("u1"), {
      transcript_id: "tr1",
      segments: [
        { speaker_id: `guest:${ada.guest_id}`, speaker_name: "Sam Rivera", text: "hello from outside", t0: 0, t1: 900 },
        { speaker_id: "guest:call_guests_999", speaker_name: "Mallory", text: "not a real guest", t0: 1000, t1: 1500 },
        { speaker_id: "u1", speaker_name: "Sam Rivera", text: "welcome", t0: 2000, t1: 2500 },
      ],
    });
    const segs = w.db._tables.transcript_segments;
    expect(segs.map((s: any) => s.speaker_name)).toEqual(["Ada (guest)", "Mallory (guest)", "Sam Rivera"]);
    expect(w.db._tables.transcripts[0].participants).toEqual([
      { id: `guest:${ada.guest_id}`, name: "Ada (guest)" },
      { id: "guest:call_guests_999", name: "Mallory (guest)" },
      { id: "u1", name: "Sam Rivera" },
    ]);
  });
});
