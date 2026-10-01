import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  CALL_MEMBER_STALE_MS,
  GUEST_DENY_COOLDOWN_MS,
  GUEST_KNOCKS_PER_LINK_PER_MINUTE,
  GUEST_LINK_MAX_TTL_MS,
  GUEST_LINK_MIN_TTL_MS,
  GUEST_ADMISSION_LAPSE_MS,
  GUEST_LINK_TTL_MS,
  MAX_WAITING_GUESTS,
  MAX_WAITING_PER_LINK,
} from "@codecast/shared/contracts";
import {
  admitGuest,
  authForGuestToken,
  clampLinkTtl,
  createGuestLink,
  allowedGuestIdentities,
  denyGuest,
  describeGuestLink,
  enforceGuestRoster,
  noteGuestsInMedia,
  getGuestState,
  guestHeartbeat,
  guestView,
  leaveCall,
  linkRefusal,
  listGuestLinks,
  removeGuest,
  requestJoin,
  revokeGuestLink,
  sweepGuestRooms,
} from "./callGuests";
import { authForToken, getLiveRooms, getRoomKnocks, leaveRoom } from "./calls";
import { appendSegments } from "./transcripts";
import { expireRoomGrants } from "./callRooms";
import { GUEST_ROSTER_TAIL_MS } from "./lib/callGuestAdmission";

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
    call_guest_attendance: [],
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

  test("the guest page's view: a closed link closes the door, an ended huddle ends an admission", () => {
    const off = { huddleRunning: false, linkClosed: false };
    const on = { huddleRunning: true, linkClosed: false };
    expect(guestView({ status: "waiting" } as any, { huddleRunning: true, linkClosed: true })).toBe("closed");
    expect(guestView({ status: "waiting" } as any, off)).toBe("waiting");
    expect(guestView({ status: "admitted" } as any, on)).toBe("admitted");
    expect(guestView({ status: "admitted" } as any, off)).toBe("ended");
    // An admitted guest's link being revoked does not touch them.
    expect(guestView({ status: "admitted" } as any, { huddleRunning: true, linkClosed: true })).toBe("admitted");
    expect(guestView({ status: "left", left_reason: "huddle_ended" } as any, on)).toBe("ended");
    expect(guestView({ status: "left", left_reason: "self" } as any, on)).toBe("left");
    expect(guestView({ status: "left", left_reason: "lapsed" } as any, on)).toBe("left");
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
    // Null, not empty: the answer is also whether they may invite at all.
    expect(await run(listGuestLinks)(w.as("u9"), { room_key: ROOM })).toBeNull();
    expect(await run(listGuestLinks)(w.as(null), { room_key: ROOM })).toBeNull();
    expect(await run(listGuestLinks)(w.as("u2"), { room_key: ROOM })).toHaveLength(1);
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

  test("a session room never sends its title to a stranger, only who invited them", async () => {
    const room = "session:c1";
    const w = world({
      conversations: [{ _id: "c1", user_id: "u2", team_id: "t1", title: "Fix the auth race in prod", is_private: false }],
      call_members: [{ _id: "cm2", room_key: room, team_id: "t1", user_id: "u2", user_name: "Lee", joined_at: 0, last_seen: Date.now(), muted: false, camera: false, sharing: false }],
    });
    // Even the conversation's owner: a session's title is the team's label for agent work.
    const own = await run(createGuestLink)(w.as("u2"), { room_key: room });
    expect((await run(describeGuestLink)(w.as(null), { token: own.token })).title).toBeNull();
    const listed = await run(listGuestLinks)(w.as("u2"), { room_key: room });
    expect(listed[0]).toMatchObject({ title: null, created_by_public: expect.any(String) });
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

describe("what guests learn about the team", () => {
  test("a teammate with no name reaches the media room under a chosen name, never their address", async () => {
    const w = world();
    const u2 = w.db._tables.users.find((u: any) => u._id === "u2");
    delete u2.name;
    u2.email = "lee@corp.example";
    u2.github_username = "leeb";
    // The LiveKit participant name every guest's browser receives.
    expect((await run(authForToken)(w.as("u2"), { room_key: ROOM }))?.name).toBe("leeb");
    delete u2.github_username;
    expect((await run(authForToken)(w.as("u2"), { room_key: ROOM }))?.name).toBe("A teammate");
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
    const knocks = await run(getRoomKnocks)(w.as("u1"), { room_key: ROOM, guests: true });
    expect(knocks).toEqual([
      {
        from_user: `guest:${guest_id}`,
        from_name: "Ada Lovelace",
        from_image: undefined,
        created_at: row.knocked_at,
        kind: "guest",
        guest_id,
        link_id: row.link_id,
        link_turned_away: 0,
        can_answer: true,
      },
    ]);
    // A client that does not know the guest shape never sees one.
    expect(await run(getRoomKnocks)(w.as("u1"), { room_key: ROOM })).toEqual([]);
    // Somebody not in the room sees no door at all.
    expect(await run(getRoomKnocks)(w.as("u2"), { room_key: ROOM, guests: true })).toEqual([]);
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
    row.last_seen = Date.now() - GUEST_ADMISSION_LAPSE_MS - 1;
    row.knocked_at = row.last_seen;
    expect(await run(getRoomKnocks)(w.as("u1"), { room_key: ROOM, guests: true })).toEqual([]);
    expect(await run(guestHeartbeat)(w.as(null), { guest_id, secret })).toEqual({ view: "waiting" });
    const knocks = await run(getRoomKnocks)(w.as("u1"), { room_key: ROOM, guests: true });
    expect(knocks).toHaveLength(1);
    // A returning page is a new knock: the door's signature moves.
    expect(knocks[0].created_at).toBeGreaterThan(Date.now() - 5_000);
  });

  test("a beat that merely ran late (a background tab) keeps the knock it had", async () => {
    const w = world();
    const { guest_id, secret } = await linkAndKnock(w);
    const row = w.db._tables.call_guests[0];
    const knocked = Date.now() - 2 * 60_000;
    row.knocked_at = knocked;
    row.last_seen = Date.now() - CALL_MEMBER_STALE_MS - 5_000;
    await run(guestHeartbeat)(w.as(null), { guest_id, secret });
    expect(row.knocked_at).toBe(knocked);
    const state = await run(getGuestState)(w.as(null), { guest_id, secret });
    expect(state.knocked_at).toBe(knocked);
  });

  test("a link mints at most a handful of new guests a minute", async () => {
    const w = world();
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    for (let i = 0; i < GUEST_KNOCKS_PER_LINK_PER_MINUTE; i++) {
      await run(requestJoin)(w.as(null), { token: link.token, name: `G${i}`, accept_notice: true });
      // Each one's page closes at once, so the waiting places never fill:
      // what stops the seventh is the rate alone.
      w.db._tables.call_guests.at(-1).last_seen = 0;
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
    expect(Object.keys(mine).sort()).toEqual(["creator_told", "knocked_at", "left_reason", "link_open", "name", "retry_at", "room", "view"]);
    expect(Object.keys(mine.room).sort()).toEqual(["inviter", "live", "recording", "title", "transcribed"]);
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
    expect(await run(getRoomKnocks)(w.as("u1"), { room_key: ROOM, guests: true })).toEqual([]);
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
    expect(w.scheduled).toContainEqual({ room_key: ROOM, tail: 0 });
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
    expect(await run(getRoomKnocks)(w.as("u1"), { room_key: ROOM, guests: true })).toEqual([]);
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
    expect(w.scheduled).toContainEqual({ room_key: ROOM, tail: 0 });
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
    expect(w.db._tables.call_guest_attendance).toMatchObject([{ transcript_id: "tr1", guest_id: ada.guest_id, name: "Ada" }]);
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
    expect(w.scheduled).toContainEqual({ room_key: ROOM, tail: 0 });
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

describe("a link closes on everybody waiting at it, however it closes", () => {
  test("expiry while somebody waits: off the door, no admit, their page reads closed and learns nothing more", async () => {
    const w = world();
    const ada = await linkAndKnock(w);
    w.db._tables.call_guest_links[0].expires_at = Date.now() - 1;
    expect(await run(getRoomKnocks)(w.as("u1"), { room_key: ROOM, guests: true })).toEqual([]);
    await expect(run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id })).rejects.toThrow(/link expired/);
    const st = await run(getGuestState)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret });
    expect(st).toMatchObject({ view: "closed", link_open: false, room: null });
    // Their beat no longer keeps a place at a door that is shut.
    const before = w.db._tables.call_guests[0].last_seen;
    expect(await run(guestHeartbeat)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).toEqual({ view: "closed" });
    expect(w.db._tables.call_guests[0].last_seen).toBe(before);
  });

  test("a link dies with its creator's standing: off the team, the door shuts and the page says why", async () => {
    const w = world();
    const ada = await linkAndKnock(w);
    w.db._tables.team_memberships.splice(0, 1); // u1 leaves the team
    expect(await run(describeGuestLink)(w.as(null), { token: ada.link.token })).toEqual({ ok: false, reason: "inviter_gone" });
    await expect(run(requestJoin)(w.as(null), { token: ada.link.token, name: "Bob", accept_notice: true })).rejects.toThrow(/can no longer invite/);
    expect((await run(getGuestState)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).view).toBe("closed");
  });

  test("a link made from a seat lives on team membership, not on the seat", async () => {
    const room = "session:c1";
    const w = world({
      conversations: [{ _id: "c1", user_id: "u2", team_id: "t1", title: "Secret plans", is_private: true }],
      call_members: [{ _id: "cm1", room_key: room, team_id: "t1", user_id: "u1", user_name: "Sam", joined_at: 0, last_seen: Date.now(), muted: false, camera: false, sharing: false }],
    });
    const link = await run(createGuestLink)(w.as("u1"), { room_key: room });
    expect(w.db._tables.call_guest_links[0].created_via).toBe("seat");
    w.db._tables.call_members.length = 0; // they leave the huddle; the link still works
    expect((await run(describeGuestLink)(w.as(null), { token: link.token })).ok).toBe(true);
    w.db._tables.team_memberships.splice(0, 1);
    expect(await run(describeGuestLink)(w.as(null), { token: link.token })).toEqual({ ok: false, reason: "inviter_gone" });
  });

  test("calls switched off for the team reads as a meeting not taking guests, in words for a stranger", async () => {
    const w = world();
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    w.db._tables.teams[0].features = { calls: false };
    expect(await run(describeGuestLink)(w.as(null), { token: link.token })).toEqual({ ok: false, reason: "unavailable" });
    await expect(run(requestJoin)(w.as(null), { token: link.token, name: "Ada", accept_notice: true })).rejects.toThrow(/isn't taking guests/);
  });
});

describe("what a guest is told about the room", () => {
  test("the inviter is a chosen name, never an address", async () => {
    const w = world({ users: [{ _id: "u1", email: "sam@acme.dev" }, { _id: "u2", name: "Lee" }] });
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    const d = await run(describeGuestLink)(w.as(null), { token: link.token });
    expect(d.inviter).toEqual({ name: "A teammate", image: null });
    expect(JSON.stringify(d)).not.toContain("acme.dev");
    // Teammates still see each other the usual way.
    expect((await run(listGuestLinks)(w.as("u1"), { room_key: ROOM }))[0].created_by_name).toBe("sam@acme.dev");
  });

  test("a removed guest's secret is not a window onto the room", async () => {
    const w = world();
    const ada = await linkAndKnock(w);
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    await run(removeGuest)(w.as("u1"), { guest_id: ada.guest_id });
    expect(await run(getGuestState)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).toEqual({
      view: "removed",
      name: "Ada",
      left_reason: null,
      retry_at: null,
      knocked_at: null,
      creator_told: false,
      link_open: true,
      room: null,
    });
  });

  test("a guest who left by their own word still sees the room, so they can knock again", async () => {
    const w = world();
    const ada = await linkAndKnock(w);
    await run(leaveCall)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret });
    const st = await run(getGuestState)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret });
    expect(st).toMatchObject({ view: "left", left_reason: "self", link_open: true, room: { live: true } });
  });
});

describe("the door sees who is really asking", () => {
  test("a new name is a new knock, and an admit for the old name is refused", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    const first = (await run(getRoomKnocks)(w.as("u1"), { room_key: ROOM, guests: true }))[0].created_at;
    w.db._tables.call_guests[0].knocked_at = first - 1_000; // inside the re-knock window
    const rekey = { token: ada.link.token, accept_notice: true, guest_id: ada.guest_id, secret: ada.secret };
    await run(requestJoin)(w.as(null), { ...rekey, name: "Sam Rivera" });
    const knock = (await run(getRoomKnocks)(w.as("u1"), { room_key: ROOM, guests: true }))[0];
    expect(knock.from_name).toBe("Sam Rivera");
    expect(knock.created_at).toBeGreaterThanOrEqual(first);
    await expect(run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id, name: "Ada" })).rejects.toThrow(/now asking to join as "Sam Rivera"/);
    expect(w.db._tables.call_guests[0].status).toBe("waiting");
    expect((await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id, name: "Sam Rivera" })).status).toBe("admitted");
  });

  test("one link holds only its share of the waiting places", async () => {
    const w = world();
    const a = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    const b = await run(createGuestLink)(w.as("u2"), { room_key: ROOM });
    for (let i = 0; i < MAX_WAITING_PER_LINK; i++) {
      await run(requestJoin)(w.as(null), { token: a.token, name: `Bot${i}`, accept_notice: true });
    }
    await expect(run(requestJoin)(w.as(null), { token: a.token, name: "Bot", accept_notice: true })).rejects.toThrow(/Too many people are waiting/);
    expect((await run(requestJoin)(w.as(null), { token: b.token, name: "Ada", accept_notice: true })).status).toBe("waiting");
  });

  test("a doorkeeper sees how many were turned away on a link, and can shut it in the same press", async () => {
    const w = world();
    const one = await linkAndKnock(w, "Bot1");
    await run(denyGuest)(w.as("u1"), { guest_id: one.guest_id });
    const two = await run(requestJoin)(w.as(null), { token: one.link.token, name: "Bot2", accept_notice: true });
    expect((await run(getRoomKnocks)(w.as("u1"), { room_key: ROOM, guests: true }))[0].link_turned_away).toBe(1);
    await run(removeGuest)(w.as("u1"), { guest_id: two.guest_id, revoke_link: true });
    expect(w.db._tables.call_guest_links[0].revoked_at).toBeNumber();
    await expect(run(requestJoin)(w.as(null), { token: one.link.token, name: "Bot3", accept_notice: true })).rejects.toThrow(/turned off/);
  });

  test("a guest arriving at an empty room is news for the link's creator, once", async () => {
    const w = world();
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    w.db._tables.users[0].push_token = "tok";
    w.db._tables.users[0].notifications_enabled = true;
    w.db._tables.push_outbox = [];
    w.db._tables.presence = [];
    w.db._tables.call_members.length = 0;
    const ada = await run(requestJoin)(w.as(null), { token: link.token, name: "Ada", accept_notice: true });
    await run(requestJoin)(w.as(null), { token: link.token, name: "Ada", accept_notice: true, guest_id: ada.guest_id, secret: ada.secret });
    w.db._tables.call_guests[0].last_seen = 0; // page closed, came back later
    await run(guestHeartbeat)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret });
    expect(w.db._tables.push_outbox).toHaveLength(1);
    expect(w.db._tables.push_outbox[0]).toMatchObject({ user_id: "u1", type: "call_guest_waiting", title: "Ada is waiting to join" });
  });
});

describe("the media room is made to agree", () => {
  test("leaving from inside and removing a guest who already left both check LiveKit", async () => {
    const w = world();
    const ada = await linkAndKnock(w);
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    w.scheduled.length = 0;
    await run(leaveCall)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret });
    expect(w.scheduled).toEqual([{ room_key: ROOM, tail: 0 }]);
    w.scheduled.length = 0;
    await run(removeGuest)(w.as("u1"), { guest_id: ada.guest_id });
    expect(w.scheduled).toEqual([{ room_key: ROOM, tail: 0 }]);
  });

  test("the roster check removes every guest identity the rows do not allow, then walks its tail", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    const bob = await linkAndKnock(w, "Bob");
    expect((await run(allowedGuestIdentities)(w.as(null), { room_key: ROOM }))).toEqual([`guest:${ada.guest_id}`]);

    const env = { ...process.env };
    const realFetch = globalThis.fetch;
    const removed: string[] = [];
    process.env.LIVEKIT_URL = "wss://lk.test";
    process.env.LIVEKIT_API_KEY = "k";
    process.env.LIVEKIT_API_SECRET = "s".repeat(32);
    globalThis.fetch = (async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (url.endsWith("/ListParticipants")) {
        return new Response(JSON.stringify({ participants: [
          { identity: "u1", name: "Sam" },
          { identity: `guest:${ada.guest_id}`, name: "Ada" },
          { identity: `guest:${bob.guest_id}`, name: "Bob" },
          { identity: "agent:c9", name: "Ember" },
        ] }));
      }
      if (url.endsWith("/RemoveParticipant")) removed.push(body.identity);
      return new Response("{}");
    }) as any;
    try {
      const touched: any[] = [];
      const actx = {
        runQuery: (_fn: any, args: any) => run(allowedGuestIdentities)(w.as(null), args),
        runMutation: (_fn: any, args: any) => {
          touched.push(args);
          return run(noteGuestsInMedia)(w.as(null), args);
        },
        scheduler: { runAfter: async (ms: number, _fn: any, args: any) => { w.scheduled.push({ ms, ...args }); } },
      };
      w.scheduled.length = 0;
      expect(await run(enforceGuestRoster)(actx, { room_key: ROOM, tail: 0 })).toEqual({ removed: 1 });
      expect(removed).toEqual([`guest:${bob.guest_id}`]);
      // The admitted guest LiveKit still holds is seen, whatever their page's timers do.
      expect(touched).toEqual([{ room_key: ROOM, identities: [`guest:${ada.guest_id}`] }]);
      expect(w.scheduled).toEqual([{ ms: GUEST_ROSTER_TAIL_MS[0], room_key: ROOM, tail: 1 }]);
      // The end of the tail looks once more and stops.
      w.scheduled.length = 0;
      await run(enforceGuestRoster)(actx, { room_key: ROOM, tail: GUEST_ROSTER_TAIL_MS.length });
      expect(w.scheduled).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      process.env = env;
    }
  });

  test("the minute sweep puts out a guest whose page went quiet, and ends admissions of a huddle that is over", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    const bob = await linkAndKnock(w, "Bob");
    await run(admitGuest)(w.as("u1"), { guest_id: bob.guest_id });
    const rows = () => Object.fromEntries(w.db._tables.call_guests.map((g: any) => [g._id, g]));
    rows()[bob.guest_id].last_seen = Date.now() - GUEST_ADMISSION_LAPSE_MS - 1;
    w.scheduled.length = 0;
    expect(await run(sweepGuestRooms)(w.as(null), {})).toEqual({ rooms: 1, ended: 0, lapsed: 1 });
    expect(rows()[bob.guest_id]).toMatchObject({ status: "left", left_reason: "lapsed" });
    expect(rows()[ada.guest_id].status).toBe("admitted");
    expect(w.scheduled).toEqual([{ room_key: ROOM, tail: 0 }]);
    // A quiet room with nobody seated, no record and no grace: over.
    w.db._tables.call_members.length = 0;
    expect(await run(sweepGuestRooms)(w.as(null), {})).toEqual({ rooms: 1, ended: 1, lapsed: 0 });
    expect(rows()[ada.guest_id]).toMatchObject({ status: "left", left_reason: "huddle_ended" });
    // Nothing admitted anywhere: the sweep is one empty read.
    expect(await run(sweepGuestRooms)(w.as(null), {})).toEqual({ rooms: 0, ended: 0, lapsed: 0 });
  });

  test("the last teammate leaving a room nothing transcribes ends the guests' admissions there and then", async () => {
    const w = world();
    const ada = await linkAndKnock(w);
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    await run(leaveRoom)(w.as("u1"), { room_key: ROOM });
    expect(w.db._tables.call_guests[0]).toMatchObject({ status: "left", left_reason: "huddle_ended" });
    expect(w.scheduled).toContainEqual({ room_key: ROOM, tail: 0 });
  });
});

describe("the huddle's grace is one rule for teammates and guests", () => {
  test("the lone teammate's lease lapsing without a leave keeps the guest in, inside the grace", async () => {
    const w = world();
    const ada = await linkAndKnock(w);
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    // Their laptop slept: the seat is past its lease and nobody pressed Leave.
    w.db._tables.call_members[0].last_seen = Date.now() - CALL_MEMBER_STALE_MS - 15_000;
    expect(await run(guestHeartbeat)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).toEqual({ view: "admitted" });
    // The same with a record running and no idle stamp.
    w.db._tables.transcripts.push({ _id: "tr1", room_key: ROOM, team_id: "t1", started_by: "u1", status: "live", started_at: Date.now() - 120_000, routes: [], last_seq: 0 });
    expect(await run(guestHeartbeat)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).toEqual({ view: "admitted" });
    // Past the grace it is over.
    w.db._tables.call_members[0].last_seen = Date.now() - 10 * 60_000;
    expect(await run(guestHeartbeat)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).toEqual({ view: "ended" });
  });
});

describe("a guest's calls", () => {
  test("each call a guest is let into keeps them on its record, under the name it let in", async () => {
    const w = world({
      transcripts: [{ _id: "tr1", room_key: ROOM, team_id: "t1", started_by: "u1", status: "live", started_at: Date.now() - 60_000, routes: [], last_seq: 0 }],
    });
    const ada = await linkAndKnock(w, "Ada");
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    await run(guestHeartbeat)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret });
    // Tuesday ends; Wednesday's huddle on the same link, under a new name.
    w.db._tables.transcripts[0].status = "ended";
    await expireRoomGrants(w.as("u1"), ROOM);
    w.db._tables.transcripts.push({ _id: "tr2", room_key: ROOM, team_id: "t1", started_by: "u1", status: "live", started_at: Date.now(), routes: [], last_seq: 0 });
    await run(requestJoin)(w.as(null), { token: ada.link.token, name: "Ada L", accept_notice: true, guest_id: ada.guest_id, secret: ada.secret });
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    expect(w.db._tables.call_guest_attendance.map((r: any) => [r.transcript_id, r.name])).toEqual([["tr1", "Ada"], ["tr2", "Ada L"]]);
  });
});
