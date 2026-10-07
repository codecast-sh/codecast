import { describe, expect, spyOn, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import {
  CALL_MEMBER_STALE_MS,
  GUEST_CREATOR_NOTICE_ANY_LINK_MS,
  GUEST_DENY_COOLDOWN_MS,
  GUEST_KNOCKS_PER_LINK_PER_MINUTE,
  GUEST_LINK_MAX_TTL_MS,
  GUEST_LINK_MIN_TTL_MS,
  GUEST_ADMISSION_LAPSE_MS,
  GUEST_LINK_TTL_MS,
  MAX_WAITING_GUESTS,
  MAX_WAITING_PER_LINK,
  GUEST_RESUME_MS,
  GUEST_JOIN_REFUSAL_TEXT,
  GUEST_LINK_REFUSAL_TEXT,
  guestIdentity,
} from "@codecast/shared/contracts";
import {
  acceptGuestNotice,
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
  guestLinkPreview,
  guestView,
  listGuestsWaiting,
  noteGuestsWaitingShown,
  leaveCall,
  listGuestLinks,
  mintGuestToken,
  guestPushName,
  removeGuest,
  requestJoin,
  revokeGuestLink,
  revokeRoomGuestLinks,
  settleQuietGuests,
  sweepGuestRooms,
} from "./callGuests";
import { authForToken, getLiveRooms, getRoomKnocks, joinRoom, leaveRoom } from "./calls";
import { appendSegments, endIdleTranscript, HUDDLE_GRACE_MS, sweepOrphanedLive } from "./transcripts";
import { expireRoomGrants, stampRoomWordsPublic } from "./callRooms";
import { claimShareToken } from "./publicShare";
import { GUEST_ROSTER_TAIL_MS, callGuestsOnRecord } from "./lib/callGuestAdmission";

const ROOM = "dm:u1:u2";
const run = (fn: any) => fn._handler ?? fn.handler;

// A team with calls on, two teammates in a people room, u1 seated in it, and
// an outsider (u9) on no team. Everything a guest touches is in these tables.
function world(extra: Record<string, any[]> = {}, opts: { indexes?: boolean } = {}) {
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
  }, { strictPatch: true, ...(opts.indexes ? { indexes: schemaIndexes(schema as any) } : {}) });
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

  test("a room's past links are not read: only the ones still open by the clock", async () => {
    // Read through the schema's real indexes, so a range the index cannot
    // serve throws here as it would in convex, and the expired rows never
    // reach the filter at all.
    const t = Date.now();
    const past = Array.from({ length: 30 }, (_, i) => ({
      _id: `old${i}`, room_key: ROOM, team_id: "t1", token: `old-token-${i}`, created_by: "u1", created_at: t - 40 * 86_400_000, expires_at: t - 86_400_000 * (i + 1),
    }));
    const w = world({ call_guest_links: past }, { indexes: true });
    // Every link row a collect() hands back, by index.
    const linkRows: Record<string, number> = {};
    const query = w.db.query.bind(w.db);
    (w.db as any).query = (table: string) => {
      const q = query(table);
      if (table !== "call_guest_links") return q;
      const withIndex = q.withIndex.bind(q);
      q.withIndex = (name: string, range: any) => {
        const r = withIndex(name, range);
        const collect = r.collect.bind(r);
        r.collect = async () => {
          const rows = await collect();
          linkRows[name] = (linkRows[name] ?? 0) + rows.length;
          return rows;
        };
        return r;
      };
      return q;
    };
    // An expired link of their own is never handed out again.
    const made = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    expect(made.reused).toBe(false);
    const listed = await run(listGuestLinks)(w.as("u1"), { room_key: ROOM });
    expect(listed.map((l: any) => l.token)).toEqual([made.token]);
    // createGuestLink read none of the 30 past links, listGuestLinks only the new one.
    expect(linkRows.by_room ?? 0).toBe(0);
    expect(linkRows.by_room_expires).toBe(1);
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
      video_public: false,
      words_public: false,
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
    // The invite panel says the same before any link exists.
    expect(await run(guestLinkPreview)(w.as("u2"), { room_key: room })).toEqual({ title: null, inviter: "Lee" });
  });

  test("the invite panel's preview keeps a private channel's name inside, and is for inviters only", async () => {
    const seat = (id: string, room: string) => ({ _id: id, room_key: room, team_id: "t1", user_id: "u1", user_name: "Sam", joined_at: 0, last_seen: Date.now(), muted: false, camera: false, sharing: false });
    const w = world({
      teams: [{ _id: "t1", name: "T", features: { calls: true, chat: true } }],
      chat_channels: [
        { _id: "ch1", team_id: "t1", name: "design", kind: "public" },
        { _id: "ch2", team_id: "t1", name: "layoffs-q4", kind: "private" },
      ],
      chat_channel_members: [
        { _id: "chm0", channel_id: "ch1", user_id: "u1" },
        { _id: "chm1", channel_id: "ch2", user_id: "u1" },
      ],
      call_members: [seat("cm1", "channel:ch1"), seat("cm2", "channel:ch2")],
    });
    expect(await run(guestLinkPreview)(w.as("u1"), { room_key: "channel:ch1" })).toEqual({ title: "#design", inviter: "Sam Rivera" });
    expect(await run(guestLinkPreview)(w.as("u1"), { room_key: "channel:ch2" })).toEqual({ title: null, inviter: "Sam Rivera" });
    expect(await run(guestLinkPreview)(w.as(null), { room_key: "channel:ch2" })).toBeNull();
    expect(await run(guestLinkPreview)(w.as("u9"), { room_key: ROOM })).toBeNull();
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
        // Whose link brought them: the doorkeeper tells an expected guest
        // from a link that got out.
        link_by: "Sam Rivera",
        link_mine: true,
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
    expect(Object.keys(mine).sort()).toEqual(["creator_told", "knocked_at", "left_reason", "link_open", "name", "resumable", "retry_at", "room", "view"]);
    expect(Object.keys(mine.room).sort()).toEqual(["inviter", "live", "recording", "title", "transcribed", "video_public", "words_public"]);
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
      reason: "removed",
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

    // Still named, so the page can say whom to ask for a new one.
    expect(await run(describeGuestLink)(w.as(null), { token: inside.link.token })).toEqual({ ok: false, reason: "revoked", title: null, inviter: { name: "Sam Rivera", image: "https://img/sam.png" } });
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
      reason: "not_admitted",
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
    // The link's own page still names the meeting and its sender, so the
    // guest is told whom to ask; a token that opens nothing names nobody.
    expect(await run(describeGuestLink)(w.as(null), { token: ada.link.token })).toEqual({
      ok: false,
      reason: "expired",
      title: null,
      inviter: { name: "Sam Rivera", image: "https://img/sam.png" },
    });
    // Their beat no longer keeps a place at a door that is shut.
    const before = w.db._tables.call_guests[0].last_seen;
    expect(await run(guestHeartbeat)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).toEqual({ view: "closed" });
    expect(w.db._tables.call_guests[0].last_seen).toBe(before);
  });

  test("a link dies with its creator's standing: off the team, the door shuts and the page says why", async () => {
    const w = world();
    const ada = await linkAndKnock(w);
    w.db._tables.team_memberships.splice(0, 1); // u1 leaves the team
    expect(await run(describeGuestLink)(w.as(null), { token: ada.link.token })).toEqual({ ok: false, reason: "inviter_gone", title: null, inviter: { name: "Sam Rivera", image: "https://img/sam.png" } });
    await expect(run(requestJoin)(w.as(null), { token: ada.link.token, name: "Bob", accept_notice: true })).rejects.toThrow(/can no longer invite/);
    expect((await run(getGuestState)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).view).toBe("closed");
  });

  test("a link made from a seat lives as long as that huddle, and the next huddle turns it off", async () => {
    const room = "session:c1";
    const w = world({
      conversations: [{ _id: "c1", user_id: "u2", team_id: "t1", title: "Secret plans", is_private: true }],
      call_members: [
        { _id: "cm1", room_key: room, team_id: "t1", user_id: "u1", user_name: "Sam", joined_at: 0, last_seen: Date.now(), muted: false, camera: false, sharing: false },
        { _id: "cm2", room_key: room, team_id: "t1", user_id: "u2", user_name: "Lee", joined_at: 0, last_seen: Date.now(), muted: false, camera: false, sharing: false },
      ],
    });
    const link = await run(createGuestLink)(w.as("u1"), { room_key: room });
    expect(w.db._tables.call_guest_links[0].created_via).toBe("seat");
    // The creator steps out; the huddle they made it in still runs.
    w.db._tables.call_members.splice(0, 1);
    expect((await run(describeGuestLink)(w.as(null), { token: link.token })).ok).toBe(true);
    // The huddle is over: the private session's room keeps no door for strangers.
    w.db._tables.call_members.length = 0;
    expect(await run(describeGuestLink)(w.as(null), { token: link.token })).toMatchObject({ ok: false, reason: "inviter_gone", title: null });
    await expect(run(requestJoin)(w.as(null), { token: link.token, name: "Ada", accept_notice: true })).rejects.toThrow(/can no longer invite/);
    // And the room's next huddle starts without it for good.
    await expireRoomGrants(w.as("u2"), room);
    expect(w.db._tables.call_guest_links[0].revoked_at).toBeNumber();
  });

  test("a seat link still dies with its creator's team membership mid-huddle", async () => {
    const room = "session:c1";
    const w = world({
      conversations: [{ _id: "c1", user_id: "u2", team_id: "t1", title: "x", is_private: true }],
      call_members: [{ _id: "cm1", room_key: room, team_id: "t1", user_id: "u1", user_name: "Sam", joined_at: 0, last_seen: Date.now(), muted: false, camera: false, sharing: false }],
    });
    const link = await run(createGuestLink)(w.as("u1"), { room_key: room });
    w.db._tables.team_memberships.splice(0, 1);
    expect(await run(describeGuestLink)(w.as(null), { token: link.token })).toMatchObject({ ok: false, reason: "inviter_gone" });
  });

  test("calls switched off for the team reads as a meeting not taking guests, in words for a stranger", async () => {
    const w = world();
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    w.db._tables.teams[0].features = { calls: false };
    expect(await run(describeGuestLink)(w.as(null), { token: link.token })).toEqual({ ok: false, reason: "unavailable" });
    await expect(run(requestJoin)(w.as(null), { token: link.token, name: "Ada", accept_notice: true })).rejects.toThrow(/isn't taking guests/);
  });
});

describe("a call's words on its public link", () => {
  const TOKEN = "3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c";
  const liveCall = (w: ReturnType<typeof world>, over: Record<string, unknown> = {}) => {
    const row = { _id: "tr1", room_key: ROOM, team_id: "t1", started_by: "u1", status: "live", started_at: Date.now() - 60_000, short_id: "cl-1", routes: [], last_seq: 0, ...over };
    w.db._tables.transcripts.push(row);
    return row;
  };

  test("a link turned on mid-call widens the notice for guests and for the room, and off narrows it", async () => {
    const w = world();
    const call = liveCall(w);
    const ada = await linkAndKnock(w);
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    const state = async () => (await run(getGuestState)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).room;
    expect((await state()).words_public).toBe(false);

    await claimShareToken(w.as("u1") as any, "transcripts", call as any, TOKEN, "u1" as any);
    expect((await state()).words_public).toBe(true);
    expect((await run(describeGuestLink)(w.as(null), { token: ada.link.token })).words_public).toBe(true);
    const room = (await run(getLiveRooms)(w.as("u1"), {})).find((r: any) => r.room_key === ROOM);
    expect(room.words_public).toBe(true);

    // Told under the transcript alone, the guest is held at the door of the
    // media until they agree to the wider notice.
    expect(await run(authForGuestToken)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).toEqual({ ok: false, reason: "notice_changed" });

    await claimShareToken(w.as("u1") as any, "transcripts", w.db._tables.transcripts[0], null, "u1" as any);
    expect((await state()).words_public).toBe(false);
    expect((await run(authForGuestToken)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).ok).toBe(true);
  });

  test("only the record the room is keeping now speaks for it", async () => {
    const w = world();
    const earlier = { _id: "tr0", room_key: ROOM, team_id: "t1", started_by: "u1", status: "ended", started_at: 0, short_id: "cl-0", routes: [], last_seq: 0 };
    w.db._tables.transcripts.push(earlier);
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    // Sharing last week's call says nothing about this one.
    await claimShareToken(w.as("u1") as any, "transcripts", earlier as any, TOKEN, "u1" as any);
    expect((await run(describeGuestLink)(w.as(null), { token: link.token })).words_public).toBe(false);

    // A record that ends takes its stamp with it; a new one starts unshared.
    const call = liveCall(w);
    await claimShareToken(w.as("u1") as any, "transcripts", call as any, "4a2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c", "u1" as any);
    expect((await run(describeGuestLink)(w.as(null), { token: link.token })).words_public).toBe(true);
    await stampRoomWordsPublic(w.as("u1"), { ...w.db._tables.transcripts[1] }, { ending: true });
    expect((await run(describeGuestLink)(w.as(null), { token: link.token })).words_public).toBe(false);

    // Transcription off: nothing is being written onto the link.
    await stampRoomWordsPublic(w.as("u1"), w.db._tables.transcripts[1]);
    w.db._tables.call_room_state[0].transcribe_off = true;
    expect((await run(describeGuestLink)(w.as(null), { token: link.token })).words_public).toBe(false);
  });
});

describe("what a guest agreed to is kept, and held to", () => {
  const recordingStarts = (w: ReturnType<typeof world>) =>
    w.db._tables.call_recordings.push({ _id: "rec1", room_key: ROOM, kind: "composite", status: "recording" });

  test("the knock keeps the notice the page showed, and refuses one that says less than the room keeps", async () => {
    const w = world();
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    const shown = { recording: false, transcribed: true };
    const ada = await run(requestJoin)(w.as(null), { token: link.token, name: "Ada", accept_notice: shown });
    expect(w.db._tables.call_guests[0].notice_accepted).toEqual({ ...shown, video_public: false, words_public: false });

    recordingStarts(w);
    await expect(run(requestJoin)(w.as(null), { token: link.token, name: "Bo", accept_notice: shown })).rejects.toThrow(/keeps more than the notice you saw/);
    // A page from before pages said which agreed to the room as it is.
    await run(requestJoin)(w.as(null), { token: link.token, name: "Ada", accept_notice: true, guest_id: ada.guest_id, secret: ada.secret });
    expect(w.db._tables.call_guests[0].notice_accepted).toMatchObject({ recording: true, transcribed: true });
  });

  test("a recording started after the knock holds the media until a Join under the wider notice", async () => {
    const w = world();
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    const ada = await run(requestJoin)(w.as(null), { token: link.token, name: "Ada", accept_notice: { recording: false, transcribed: true } });
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    const creds = { guest_id: ada.guest_id, secret: ada.secret };
    expect((await run(authForGuestToken)(w.as(null), creds)).ok).toBe(true);

    recordingStarts(w);
    // A page that walks in by itself, or reconnects, is refused.
    expect(await run(authForGuestToken)(w.as(null), creds)).toEqual({ ok: false, reason: "notice_changed" });
    // A press under a notice that still says less is refused too.
    expect(await run(authForGuestToken)(w.as(null), { ...creds, accept_notice: { recording: false, transcribed: true } })).toEqual({ ok: false, reason: "notice_changed" });
    // The press under the notice as it is: let through, and kept.
    expect((await run(authForGuestToken)(w.as(null), { ...creds, accept_notice: { recording: true, transcribed: true } })).ok).toBe(true);
    expect(w.db._tables.call_guests[0].notice_accepted).toEqual({ recording: true, transcribed: true, video_public: false, words_public: false });
    expect((await run(authForGuestToken)(w.as(null), creds)).ok).toBe(true);
    expect(GUEST_JOIN_REFUSAL_TEXT.notice_changed).toContain("Read the notice again");
  });

  test("putting away the line about a recording that started inside is agreeing to it: the next reconnect goes through", async () => {
    const w = world();
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    const ada = await run(requestJoin)(w.as(null), { token: link.token, name: "Ada", accept_notice: { recording: false, transcribed: true } });
    const creds = { guest_id: ada.guest_id, secret: ada.secret };
    // Not inside yet: a guest at the door agrees by pressing Join, not here.
    expect(await run(acceptGuestNotice)(w.as(null), { ...creds, notice: { recording: false, transcribed: true } })).toBeNull();
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });

    recordingStarts(w);
    expect(await run(authForGuestToken)(w.as(null), creds)).toEqual({ ok: false, reason: "notice_changed" });
    // A page still showing less than the room keeps is refused, and the row
    // keeps what it had.
    await expect(run(acceptGuestNotice)(w.as(null), { ...creds, notice: { recording: false, transcribed: true } })).rejects.toThrow(/keeps more than the notice you saw/);
    expect(w.db._tables.call_guests[0].notice_accepted).toMatchObject({ recording: false });
    // A wrong secret reads as nobody.
    expect(await run(acceptGuestNotice)(w.as(null), { ...creds, secret: "nope", notice: { recording: true, transcribed: true } })).toBeNull();

    await run(acceptGuestNotice)(w.as(null), { ...creds, notice: { recording: true, transcribed: true } });
    expect(w.db._tables.call_guests[0].notice_accepted).toEqual({ recording: true, transcribed: true, video_public: false, words_public: false });
    expect((await run(authForGuestToken)(w.as(null), creds)).ok).toBe(true);
  });

  test("a row from before notices were kept is not held to one", async () => {
    const w = world();
    const ada = await linkAndKnock(w);
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    delete w.db._tables.call_guests[0].notice_accepted;
    recordingStarts(w);
    expect((await run(authForGuestToken)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).ok).toBe(true);
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
      resumable: false,
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
    expect(w.db._tables.push_outbox[0]).toMatchObject({ user_id: "u1", type: "call_guest_waiting", title: "Ada (guest) is waiting to join" });
    // And the guest's page may say so.
    expect((await run(getGuestState)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).creator_told).toBe(true);
  });

  test("a leaked link cannot page its creator: one push per link per window, however many arrive", async () => {
    const w = world();
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    w.db._tables.users[0].push_token = "tok";
    w.db._tables.users[0].notifications_enabled = true;
    w.db._tables.push_outbox = [];
    w.db._tables.presence = [];
    w.db._tables.call_members.length = 0;
    const guests = [];
    for (let i = 0; i < 3; i++) {
      const g = await run(requestJoin)(w.as(null), { token: link.token, name: `G${i}`, accept_notice: true });
      guests.push(g);
      // Walk away to free the place, then come back as somebody new.
      await run(leaveCall)(w.as(null), { guest_id: g.guest_id, secret: g.secret });
    }
    expect(w.db._tables.push_outbox).toHaveLength(1);
    // Every arrival the push covered may say "we let them know".
    for (const g of guests) {
      const row = w.db._tables.call_guests.find((r: any) => r._id === g.guest_id);
      expect(row.creator_told_at).toBe(w.db._tables.call_guest_links[0].creator_told_at);
    }
    // Past the window, one push names everybody waiting on the link.
    w.db._tables.call_guest_links[0].creator_told_at = Date.now() - 11 * 60_000;
    await run(requestJoin)(w.as(null), { token: link.token, name: "Bo", accept_notice: true });
    await run(requestJoin)(w.as(null), { token: link.token, name: "Cy", accept_notice: true });
    expect(w.db._tables.push_outbox).toHaveLength(2);
    expect(w.db._tables.push_outbox[1].title).toBe("Bo (guest) is waiting to join");
    w.db._tables.call_guest_links[0].creator_told_at = Date.now() - 11 * 60_000;
    await run(requestJoin)(w.as(null), { token: link.token, name: "Di", accept_notice: true });
    expect(w.db._tables.push_outbox[2].title).toBe("3 guests are waiting to join");
  });

  test("several leaked links of one creator do not multiply the pushes", async () => {
    const OTHER = "dm:u1:u3";
    const w = world();
    w.db._tables.users.push({ _id: "u3", name: "Kit" });
    w.db._tables.team_memberships.push({ _id: "tm3", user_id: "u3", team_id: "t1" });
    w.db._tables.users[0].push_token = "tok";
    w.db._tables.users[0].notifications_enabled = true;
    w.db._tables.push_outbox = [];
    w.db._tables.presence = [];
    const one = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    w.db._tables.call_members[0].room_key = OTHER;
    const two = await run(createGuestLink)(w.as("u1"), { room_key: OTHER });
    w.db._tables.call_members.length = 0;
    await run(requestJoin)(w.as(null), { token: one.token, name: "Ada", accept_notice: true });
    const bo = await run(requestJoin)(w.as(null), { token: two.token, name: "Bo", accept_notice: true });
    expect(w.db._tables.push_outbox).toHaveLength(1);
    // The push was about another door, so Bo's page does not claim word was sent.
    expect((await run(getGuestState)(w.as(null), { guest_id: bo.guest_id, secret: bo.secret })).creator_told).toBe(false);
    // Past the cross-link window the other room's next arrival is news again.
    w.db._tables.call_guest_links[0].creator_told_at = Date.now() - GUEST_CREATOR_NOTICE_ANY_LINK_MS - 1;
    await run(requestJoin)(w.as(null), { token: two.token, name: "Cy", accept_notice: true });
    expect(w.db._tables.push_outbox).toHaveLength(2);
  });

  test("a creator at their desk is told by the app, and the guest's page says so only once it has", async () => {
    const w = world();
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    w.db._tables.users[0].push_token = "tok";
    w.db._tables.users[0].notifications_enabled = true;
    w.db._tables.push_outbox = [];
    // Typing in the app right now: the phone push is held for minutes.
    w.db._tables.user_presence = [{ _id: "p1", user_id: "u1", last_seen: Date.now(), last_input_at: Date.now(), focused: true }];
    w.db._tables.devices = [];
    w.db._tables.call_members.length = 0;
    const ada = await run(requestJoin)(w.as(null), { token: link.token, name: "Ada", accept_notice: true });
    const state = () => run(getGuestState)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret });
    expect(w.db._tables.push_outbox).toHaveLength(1);
    expect((await state()).creator_told).toBe(false);
    // The app's feed carries her to the creator, and to nobody else.
    const feed = await run(listGuestsWaiting)(w.as("u1"), {});
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ guest_id: ada.guest_id, name: "Ada", room_key: ROOM });
    expect(feed[0].present_until).toBeGreaterThan(Date.now());
    expect(await run(listGuestsWaiting)(w.as("u2"), {})).toEqual([]);
    expect(await run(listGuestsWaiting)(w.as(null), {})).toEqual([]);
    // Somebody else saying they saw her stamps nothing.
    await run(noteGuestsWaitingShown)(w.as("u2"), { guest_ids: [ada.guest_id] });
    expect((await state()).creator_told).toBe(false);
    await run(noteGuestsWaitingShown)(w.as("u1"), { guest_ids: [ada.guest_id, "junk"] });
    expect((await state()).creator_told).toBe(true);
  });

  test("the waiting feed is for a room nobody is in, and for knocks still standing", async () => {
    const w = world();
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    const ada = await run(requestJoin)(w.as(null), { token: link.token, name: "Ada", accept_notice: true });
    // u1 is seated: the door shows her, the feed stays out of it.
    expect(await run(listGuestsWaiting)(w.as("u1"), {})).toEqual([]);
    w.db._tables.call_members.length = 0;
    expect(await run(listGuestsWaiting)(w.as("u1"), {})).toHaveLength(1);
    // She stopped asking.
    await run(leaveCall)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret });
    expect(await run(listGuestsWaiting)(w.as("u1"), {})).toEqual([]);
    // A link turned off waits for nobody.
    const bo = await run(requestJoin)(w.as(null), { token: link.token, name: "Bo", accept_notice: true });
    expect(await run(listGuestsWaiting)(w.as("u1"), {})).toHaveLength(1);
    await run(revokeGuestLink)(w.as("u1"), { link_id: link.link_id });
    expect(await run(listGuestsWaiting)(w.as("u1"), {})).toEqual([]);
    expect(bo.guest_id).toBeString();
  });

  test("a creator with hundreds of old links still hears about a guest at the newest one", async () => {
    const w = world();
    const now = Date.now();
    // 201 links pushed about long ago and expired since: they used to fill
    // the feed's bounded read ahead of a fresh link nobody was told about.
    for (let i = 0; i < 201; i++) {
      w.db._tables.call_guest_links.push({
        _id: `old${i}`, room_key: `dm:u1:x${i}`, team_id: "t1", token: `old-${i}`, created_by: "u1",
        created_via: "member", created_at: now - 30 * 86_400_000, expires_at: now - 86_400_000, creator_told_at: now - 20 * 86_400_000 + i,
      });
    }
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    expect(w.db._tables.call_guest_links.find((l: any) => l.token === link.token).creator_told_at).toBeUndefined();
    w.db._tables.call_members.length = 0;
    w.db._tables.users[0].push_token = undefined;
    const ada = await run(requestJoin)(w.as(null), { token: link.token, name: "Ada", accept_notice: true });
    const feed = await run(listGuestsWaiting)(w.as("u1"), {});
    expect(feed.map((g: any) => g.guest_id)).toEqual([ada.guest_id]);
  });

  test("a name that is a link or an address never reaches a lock screen", () => {
    expect(guestPushName("Ada")).toBe("Ada (guest)");
    for (const n of ["evil.example/login", "www.x.io", "pay at bank.com now", "ada@corp.example", "https //x"]) {
      expect(guestPushName(n)).toBe("A guest");
    }
    expect(guestPushName("Dr. Ada")).toBe("Dr. Ada (guest)");
  });

  test("a creator with no phone to tell is not claimed to have been told", async () => {
    const w = world();
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    w.db._tables.push_outbox = [];
    w.db._tables.presence = [];
    w.db._tables.call_members.length = 0;
    const ada = await run(requestJoin)(w.as(null), { token: link.token, name: "Ada", accept_notice: true });
    expect(w.db._tables.push_outbox).toHaveLength(0);
    expect((await run(getGuestState)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).creator_told).toBe(false);
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

  test("a guest who closed the tab is let go by the next roster check, not minutes later, and can walk back in", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    const bob = await linkAndKnock(w, "Bob");
    await run(admitGuest)(w.as("u1"), { guest_id: bob.guest_id });
    const cy = await linkAndKnock(w, "Cy");
    await run(admitGuest)(w.as("u1"), { guest_id: cy.guest_id });
    const rows = () => Object.fromEntries(w.db._tables.call_guests.map((g: any) => [g._id, g]));
    // All three were in the media; then a seat's lease passes with no beat.
    const quiet = Date.now() - CALL_MEMBER_STALE_MS - 1;
    for (const g of [ada, bob]) Object.assign(rows()[g.guest_id], { last_seen: quiet, media_seen_at: quiet });
    // Cy was admitted a moment ago and is still connecting: never seen in the media.
    rows()[cy.guest_id].last_seen = quiet;

    // LiveKit lists Ada (a phone in a pocket keeps its call) and nobody else.
    const res = await run(noteGuestsInMedia)(w.as(null), { room_key: ROOM, identities: [`guest:${ada.guest_id}`] });
    expect(res).toEqual({ touched: 1, lapsed: 1 });
    expect(rows()[ada.guest_id].status).toBe("admitted");
    expect(rows()[bob.guest_id]).toMatchObject({ status: "left", left_reason: "lapsed" });
    expect(rows()[cy.guest_id].status).toBe("admitted");

    // A page that does come back walks in without knocking.
    const back = await run(requestJoin)(w.as(null), { token: bob.link.token, name: "Bob", accept_notice: true, guest_id: bob.guest_id, secret: bob.secret });
    expect(back).toMatchObject({ status: "admitted" });
  });

  test("a listing with no guest in it still tells the rows, so the last guest to close a tab is let go too", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    const row = w.db._tables.call_guests.find((g: any) => g._id === ada.guest_id);
    Object.assign(row, { last_seen: Date.now() - CALL_MEMBER_STALE_MS - 1, media_seen_at: Date.now() - CALL_MEMBER_STALE_MS - 1 });
    const lk = fakeLivekit(() => ["u1"]);
    try {
      const calls: string[] = [];
      expect(await run(enforceGuestRoster)(rosterCtx(w, calls), { room_key: ROOM, tail: GUEST_ROSTER_TAIL_MS.length })).toEqual({ removed: 0 });
    } finally {
      lk.restore();
    }
    expect(row).toMatchObject({ status: "left", left_reason: "lapsed" });
  });

  test("the minute sweep puts out a guest whose page went quiet, and ends admissions of a huddle that is over", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    const bob = await linkAndKnock(w, "Bob");
    await run(admitGuest)(w.as("u1"), { guest_id: bob.guest_id });
    const rows = () => Object.fromEntries(w.db._tables.call_guests.map((g: any) => [g._id, g]));
    rows()[bob.guest_id].last_seen = Date.now() - GUEST_ADMISSION_LAPSE_MS - 1;
    rows()[bob.guest_id].media_seen_at = Date.now() - GUEST_ADMISSION_LAPSE_MS - 1;
    w.scheduled.length = 0;
    expect(await run(sweepGuestRooms)(w.as(null), {})).toMatchObject({ rooms: 1, ended: 0, lapsed: 1 });
    // The media server is asked before anybody is let go.
    expect(w.scheduled).toEqual([{ room_key: ROOM, guest_ids: [bob.guest_id] }]);
    expect(rows()[bob.guest_id].status).toBe("admitted");
    w.scheduled.length = 0;
    expect(await run(settleQuietGuests)(w.as(null), { room_key: ROOM, guest_ids: [bob.guest_id], in_media: [] })).toEqual({ kept: 0, lapsed: 1 });
    expect(rows()[bob.guest_id]).toMatchObject({ status: "left", left_reason: "lapsed" });
    expect(rows()[ada.guest_id].status).toBe("admitted");
    expect(w.scheduled).toEqual([{ room_key: ROOM, tail: 0 }]);
    // A quiet room with nobody seated, no record and no grace: over.
    w.db._tables.call_members.length = 0;
    expect(await run(sweepGuestRooms)(w.as(null), {})).toMatchObject({ rooms: 1, ended: 1, lapsed: 0 });
    expect(rows()[ada.guest_id]).toMatchObject({ status: "left", left_reason: "huddle_ended" });
    // Nothing admitted anywhere and no huddle running: nothing to check.
    expect(await run(sweepGuestRooms)(w.as(null), {})).toEqual({ rooms: 0, ended: 0, lapsed: 0, watched: 1, abandoned: 0 });
  });

  test("a teammate reloading the tab in a room nothing transcribes keeps the guests in, and the grace still ends it", async () => {
    const w = world();
    const ada = await linkAndKnock(w);
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    // beforeunload leaves; the reloaded page joins a second later.
    await run(leaveRoom)(w.as("u1"), { room_key: ROOM });
    expect(w.db._tables.call_guests[0].status).toBe("admitted");
    expect(w.db._tables.call_room_state[0].emptied_at).toBeNumber();
    expect(await run(guestHeartbeat)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).toEqual({ view: "admitted" });
    await run(joinRoom)(w.as("u1"), { room_key: ROOM });
    expect(w.db._tables.call_guests[0].status).toBe("admitted");
    expect((await run(authForGuestToken)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).ok).toBe(true);
    // A real departure: past the grace the huddle is over, and the sweep says so.
    await run(leaveRoom)(w.as("u1"), { room_key: ROOM });
    w.db._tables.call_room_state[0].emptied_at = Date.now() - 4 * 60_000;
    await run(sweepGuestRooms)(w.as(null), {});
    expect(w.db._tables.call_guests[0]).toMatchObject({ status: "left", left_reason: "huddle_ended" });
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

// A fake LiveKit for the roster check: who is listed, and every call in order.
function fakeLivekit(listed: () => string[]) {
  const env = { ...process.env };
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  process.env.LIVEKIT_URL = "wss://lk.test";
  process.env.LIVEKIT_API_KEY = "k";
  process.env.LIVEKIT_API_SECRET = "s".repeat(32);
  globalThis.fetch = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    const method = url.split("/").at(-1)!;
    if (method === "ListParticipants") {
      calls.push("list");
      return new Response(JSON.stringify({ participants: listed().map((identity) => ({ identity, name: identity })) }));
    }
    calls.push(`${method}:${body.identity}${body.permission ? `:${JSON.stringify(body.permission)}` : ""}`);
    return new Response("{}");
  }) as any;
  return { calls, restore: () => { globalThis.fetch = realFetch; process.env = env; } };
}

function rosterCtx(w: ReturnType<typeof world>, calls: string[]) {
  return {
    runQuery: (_fn: any, args: any) => {
      calls.push("allowed");
      return run(allowedGuestIdentities)(w.as(null), args);
    },
    runMutation: (_fn: any, args: any) => run(noteGuestsInMedia)(w.as(null), args),
    scheduler: { runAfter: async () => {} },
  };
}

describe("a guest put out stays out, past every tail", () => {
  test("the roster check lists first, then strips a put-out guest's rights before dropping them", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    await run(removeGuest)(w.as("u1"), { guest_id: ada.guest_id });
    const lk = fakeLivekit(() => [`guest:${ada.guest_id}`]);
    try {
      expect(await run(enforceGuestRoster)(rosterCtx(w, lk.calls), { room_key: ROOM, tail: GUEST_ROSTER_TAIL_MS.length })).toEqual({ removed: 1 });
      expect(lk.calls).toEqual([
        "list",
        "allowed",
        `UpdateParticipant:guest:${ada.guest_id}:${JSON.stringify({ can_subscribe: false, can_publish: false, can_publish_data: false, can_update_metadata: false })}`,
        `RemoveParticipant:guest:${ada.guest_id}`,
      ]);
    } finally {
      lk.restore();
    }
  });

  test("a guest from an earlier huddle still connected after the tail is put out when the next huddle starts", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    await run(removeGuest)(w.as("u1"), { guest_id: ada.guest_id });
    // The tail has long run out; nobody is admitted; LiveKit still lists them.
    w.scheduled.length = 0;
    await expireRoomGrants(w.as("u1"), ROOM);
    expect(w.scheduled).toEqual([{ room_key: ROOM, tail: 0 }]);
    const lk = fakeLivekit(() => [`guest:${ada.guest_id}`, "u1"]);
    try {
      expect(await run(enforceGuestRoster)(rosterCtx(w, lk.calls), { room_key: ROOM, tail: GUEST_ROSTER_TAIL_MS.length })).toEqual({ removed: 1 });
    } finally {
      lk.restore();
    }
    // A room nobody ever made a guest link for costs LiveKit nothing.
    const other = world();
    await expireRoomGrants(other.as("u1"), ROOM);
    expect(other.scheduled).toEqual([]);
  });

  test("the minute sweep keeps looking at a running huddle whose room put a guest out within the hour", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    await run(removeGuest)(w.as("u1"), { guest_id: ada.guest_id });
    expect(w.db._tables.call_guests[0].settled_at).toBeNumber();
    w.scheduled.length = 0;
    expect(await run(sweepGuestRooms)(w.as(null), {})).toMatchObject({ rooms: 0, watched: 1 });
    expect(w.scheduled).toEqual([{ room_key: ROOM, tail: GUEST_ROSTER_TAIL_MS.length }]);
    // An hour on, the room is no longer watched.
    w.db._tables.call_guests[0].settled_at = Date.now() - 61 * 60_000;
    w.scheduled.length = 0;
    expect(await run(sweepGuestRooms)(w.as(null), {})).toMatchObject({ watched: 0 });
    expect(w.scheduled).toEqual([]);
  });

  test("a team switching calls off puts its guests out, not only stops new tokens", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    expect(await run(allowedGuestIdentities)(w.as(null), { room_key: ROOM })).toEqual([`guest:${ada.guest_id}`]);
    w.db._tables.teams[0].features = { calls: false };
    expect(await run(allowedGuestIdentities)(w.as(null), { room_key: ROOM })).toEqual([]);
  });

  test("the media server sees a marked name, and the guest's page gets theirs back plain", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Sam Rivera");
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    const env = { ...process.env };
    process.env.LIVEKIT_URL = "wss://lk.test";
    process.env.LIVEKIT_API_KEY = "k";
    process.env.LIVEKIT_API_SECRET = "s".repeat(32);
    try {
      const actx = { runMutation: (_fn: any, args: any) => run(authForGuestToken)(w.as(null), args) };
      const minted = await run(mintGuestToken)(actx, { guest_id: ada.guest_id, secret: ada.secret });
      expect(minted.name).toBe("Sam Rivera");
      const claims = JSON.parse(Buffer.from(minted.token.split(".")[1], "base64url").toString());
      expect(claims.name).toBe("Sam Rivera (guest)");
    } finally {
      process.env = env;
    }
  });
});

describe("a leaked link cannot wear down the door", () => {
  test("hundreds of abandoned knocks cost the door nothing, and the sweep settles them", async () => {
    const w = world();
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    const linkRow = w.db._tables.call_guest_links[0];
    const old = Date.now() - 20 * 60_000;
    for (let i = 0; i < 300; i++) {
      w.db._tables.call_guests.push({ _id: `call_guests_old${i}`, link_id: linkRow._id, room_key: ROOM, team_id: "t1", name: `Bot${i}`, secret_hash: "x", status: "waiting", created_at: old, knocked_at: old, last_seen: old });
    }
    const live = await run(requestJoin)(w.as(null), { token: link.token, name: "Ada", accept_notice: true });
    const knocks = await run(getRoomKnocks)(w.as("u1"), { room_key: ROOM, guests: true });
    expect(knocks.map((k: any) => k.guest_id)).toEqual([live.guest_id]);
    const res = await run(sweepGuestRooms)(w.as(null), {});
    expect(res.abandoned).toBe(300);
    expect(w.db._tables.call_guests.filter((g: any) => g.status === "waiting").map((g: any) => g._id)).toEqual([live.guest_id]);
    expect(w.db._tables.call_guests.find((g: any) => g._id === "call_guests_old0")).toMatchObject({ status: "left", left_reason: "lapsed" });
  });

  test("pages beating back after a lapse take no more places at the door than a knock could", async () => {
    const w = world();
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    const guests = [];
    for (let i = 0; i < 2 * MAX_WAITING_PER_LINK; i++) {
      // Each knock's page goes quiet at once, so the next one finds a place.
      guests.push(await run(requestJoin)(w.as(null), { token: link.token, name: `Bot${i}`, accept_notice: true }));
      w.db._tables.call_guests.at(-1).last_seen = Date.now() - GUEST_ADMISSION_LAPSE_MS - 1;
      w.db._tables.call_guests.at(-1).created_at = Date.now() - 120_000;
    }
    const answers = [];
    for (const g of guests) answers.push(await run(guestHeartbeat)(w.as(null), { guest_id: g.guest_id, secret: g.secret }));
    const knocks = await run(getRoomKnocks)(w.as("u1"), { room_key: ROOM, guests: true });
    expect(knocks).toHaveLength(MAX_WAITING_PER_LINK);
    expect(answers.filter((a: any) => a.door_full)).toHaveLength(MAX_WAITING_PER_LINK);
    expect(answers.every((a: any) => a.view === "waiting")).toBe(true);
  });
});

describe("the room's mutations and reads", () => {
  test("a guest id that names nothing answers the same as a guest elsewhere", async () => {
    const w = world();
    const ada = await linkAndKnock(w);
    for (const fn of [admitGuest, denyGuest, removeGuest]) {
      await expect(run(fn)(w.as("u9"), { guest_id: ada.guest_id })).rejects.toThrow("Only someone in the huddle can do that");
      await expect(run(fn)(w.as("u9"), { guest_id: "call_guests_nope" })).rejects.toThrow("Only someone in the huddle can do that");
    }
  });

  test("a private channel's name never travels with a link", async () => {
    const pub = "channel:ch1";
    const priv = "channel:ch2";
    const seat = (id: string, room: string) => ({ _id: id, room_key: room, team_id: "t1", user_id: "u1", user_name: "Sam", joined_at: 0, last_seen: Date.now(), muted: false, camera: false, sharing: false });
    const w = world({
      chat_channels: [
        { _id: "ch1", team_id: "t1", name: "design", kind: "public" },
        { _id: "ch2", team_id: "t1", name: "layoffs-q4", kind: "private" },
      ],
      chat_channel_members: [{ _id: "chm1", channel_id: "ch2", user_id: "u1" }],
      call_members: [seat("cm1", pub), seat("cm2", priv)],
    });
    const { linkTitle } = await import("./callGuests");
    expect(await linkTitle(w.as(null), { room_key: pub })).toBe("#design");
    expect(await linkTitle(w.as(null), { room_key: priv })).toBeNull();
  });

  test("a guest whose phone holds the page in the background stays in the room's list between beats", async () => {
    const w = world();
    const ada = await linkAndKnock(w);
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    w.db._tables.call_guests[0].last_seen = Date.now() - CALL_MEMBER_STALE_MS - 15_000;
    expect((await run(getLiveRooms)(w.as("u1"), {}))[0].guests).toHaveLength(1);
    expect((await run(listGuestLinks)(w.as("u1"), { room_key: ROOM }))[0]).toMatchObject({ admitted: 1, waiting: 0 });
  });

  test("a beat that computes a new view for the page writes it once, so the page's subscription follows", async () => {
    const w = world();
    const ada = await linkAndKnock(w);
    await run(guestHeartbeat)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret });
    expect(w.db._tables.call_guests[0].beat_view).toBe("waiting:live");
    w.db._tables.call_guest_links[0].expires_at = Date.now() - 1;
    expect(await run(guestHeartbeat)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).toEqual({ view: "closed" });
    expect(w.db._tables.call_guests[0].beat_view).toBe("closed:live");
    const writes = w.db._tables.call_guests[0];
    const before = JSON.stringify(writes);
    await run(guestHeartbeat)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret });
    expect(JSON.stringify(w.db._tables.call_guests[0])).toBe(before);
  });

  test("the call record lists its guests, spoken or not, marked as guests", async () => {
    const w = world({
      transcripts: [{ _id: "tr1", room_key: ROOM, team_id: "t1", started_by: "u1", status: "live", started_at: Date.now() - 60_000, routes: [], last_seq: 0 }],
    });
    const bo = await linkAndKnock(w, "Bo");
    await run(admitGuest)(w.as("u1"), { guest_id: bo.guest_id });
    const ada = await linkAndKnock(w, "Ada");
    w.db._tables.call_guests.find((g: any) => g._id === ada.guest_id).last_seen = Date.now();
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    w.db._tables.call_guest_attendance[1].joined_at += 1;
    expect(await callGuestsOnRecord(w.as(null), { _id: "tr1", participants: [] } as any)).toEqual([
      { name: "Bo (guest)", joined_at: expect.any(Number), spoke: false },
      { name: "Ada (guest)", joined_at: expect.any(Number), spoke: false },
    ]);
  });

  test("who spoke is matched by identity: two guests with one name stay two, a renamed guest stays one", async () => {
    const w = world({
      transcripts: [{ _id: "tr1", room_key: ROOM, team_id: "t1", started_by: "u1", status: "live", started_at: Date.now() - 60_000, routes: [], last_seq: 0 }],
    });
    const first = await linkAndKnock(w, "Ada");
    await run(admitGuest)(w.as("u1"), { guest_id: first.guest_id });
    const second = await linkAndKnock(w, "Ada");
    w.db._tables.call_guests.find((g: any) => g._id === second.guest_id).last_seen = Date.now();
    await run(admitGuest)(w.as("u1"), { guest_id: second.guest_id });
    w.db._tables.call_guest_attendance[1].joined_at += 1;
    // The first Ada spoke under a corrected name; the transcript carries the
    // name the row has now, the attendance the one she came in under.
    const record = {
      _id: "tr1",
      participants: [{ id: guestIdentity(first.guest_id), name: "Ada Lovelace (guest)" }],
    } as any;
    expect(await callGuestsOnRecord(w.as(null), record)).toEqual([
      { name: "Ada (guest)", joined_at: expect.any(Number), spoke: true },
      { name: "Ada (guest)", joined_at: expect.any(Number), spoke: false },
    ]);
  });
});

describe("a quiet page is asked about before it is let go", () => {
  function quiet(w: ReturnType<typeof world>, id: string, opts: { media?: boolean } = {}) {
    const row = w.db._tables.call_guests.find((g: any) => g._id === id);
    row.last_seen = Date.now() - GUEST_ADMISSION_LAPSE_MS - 1;
    if (opts.media) row.media_seen_at = Date.now() - GUEST_ADMISSION_LAPSE_MS - 1;
    return row;
  }

  test("a guest the media server still lists is kept; one it does not is let go", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    const row = quiet(w, ada.guest_id, { media: true });
    expect(
      await run(settleQuietGuests)(w.as(null), { room_key: ROOM, guest_ids: [ada.guest_id], in_media: [guestIdentity(ada.guest_id)] }),
    ).toEqual({ kept: 1, lapsed: 0 });
    expect(row.status).toBe("admitted");
    expect(Date.now() - row.last_seen).toBeLessThan(1000);
    // A beat that landed between the sweep and the answer keeps them too.
    expect(await run(settleQuietGuests)(w.as(null), { room_key: ROOM, guest_ids: [ada.guest_id], in_media: [] })).toEqual({ kept: 0, lapsed: 0 });
    expect(row.status).toBe("admitted");
  });

  test("a place nobody came into ends as not_joined, one that dropped as lapsed", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    const bob = await linkAndKnock(w, "Bob");
    await run(admitGuest)(w.as("u1"), { guest_id: bob.guest_id });
    // Bob's page beat from inside the media; Ada never left the lobby.
    await run(guestHeartbeat)(w.as(null), { guest_id: bob.guest_id, secret: bob.secret, in_media: true });
    quiet(w, ada.guest_id);
    quiet(w, bob.guest_id);
    await run(settleQuietGuests)(w.as(null), { room_key: ROOM, guest_ids: [ada.guest_id, bob.guest_id], in_media: [] });
    const rows = Object.fromEntries(w.db._tables.call_guests.map((g: any) => [g._id, g]));
    expect(rows[ada.guest_id]).toMatchObject({ status: "left", left_reason: "not_joined" });
    expect(rows[bob.guest_id]).toMatchObject({ status: "left", left_reason: "lapsed" });
  });

  test("a guest let go that way walks back in without a knock, inside the window and the same huddle", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    quiet(w, ada.guest_id, { media: true });
    await run(settleQuietGuests)(w.as(null), { room_key: ROOM, guest_ids: [ada.guest_id], in_media: [] });
    const st = await run(getGuestState)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret });
    expect(st).toMatchObject({ view: "left", left_reason: "lapsed", resumable: true });
    const back = await run(requestJoin)(w.as(null), { token: ada.link.token, name: "Ada", accept_notice: true, guest_id: ada.guest_id, secret: ada.secret });
    expect(back.status).toBe("admitted");
    expect(await run(getRoomKnocks)(w.as("u1"), { room_key: ROOM, guests: true })).toEqual([]);
    expect((await run(authForGuestToken)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).ok).toBe(true);
  });

  test("an admission outlives its link: a guest let go after a short link expired walks back in", async () => {
    const w = world();
    const link = await run(createGuestLink)(w.as("u1"), { room_key: ROOM, ttl_ms: GUEST_LINK_MIN_TTL_MS });
    const ada = await run(requestJoin)(w.as(null), { token: link.token, name: "Ada", accept_notice: true });
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    const linkRow = w.db._tables.call_guest_links.find((l: any) => l.token === link.token);
    linkRow.expires_at = Date.now() - 1;
    const creds = { token: link.token, name: "Ada", accept_notice: true, guest_id: ada.guest_id, secret: ada.secret };
    // Still inside: told so, past the closed link.
    expect((await run(requestJoin)(w.as(null), creds)).status).toBe("admitted");
    quiet(w, ada.guest_id, { media: true });
    await run(settleQuietGuests)(w.as(null), { room_key: ROOM, guest_ids: [ada.guest_id], in_media: [] });
    expect(await run(getGuestState)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).toMatchObject({
      view: "left",
      link_open: false,
      resumable: true,
    });
    expect(await run(requestJoin)(w.as(null), creds)).toMatchObject({ status: "admitted", secret: null });
    expect(await run(getRoomKnocks)(w.as("u1"), { room_key: ROOM, guests: true })).toEqual([]);
  });

  test("a turned-off link still lets a let-go guest back in, and nobody new knock on it", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    await run(revokeGuestLink)(w.as("u1"), { link_id: ada.link.link_id });
    quiet(w, ada.guest_id, { media: true });
    await run(settleQuietGuests)(w.as(null), { room_key: ROOM, guest_ids: [ada.guest_id], in_media: [] });
    const back = await run(requestJoin)(w.as(null), { token: ada.link.token, name: "Ada", accept_notice: true, guest_id: ada.guest_id, secret: ada.secret });
    expect(back.status).toBe("admitted");
    await expect(run(requestJoin)(w.as(null), { token: ada.link.token, name: "Bob", accept_notice: true })).rejects.toThrow(
      GUEST_LINK_REFUSAL_TEXT.revoked,
    );
    // Once the place is gone for good (past the window), Ada knocks like
    // anyone, and the closed link turns her away too.
    const row = w.db._tables.call_guests.find((g: any) => g._id === ada.guest_id);
    quiet(w, ada.guest_id, { media: true });
    await run(settleQuietGuests)(w.as(null), { room_key: ROOM, guest_ids: [ada.guest_id], in_media: [] });
    row.settled_at = Date.now() - GUEST_RESUME_MS - 1;
    await expect(
      run(requestJoin)(w.as(null), { token: ada.link.token, name: "Ada", accept_notice: true, guest_id: ada.guest_id, secret: ada.secret }),
    ).rejects.toThrow(GUEST_LINK_REFUSAL_TEXT.revoked);
  });

  test("past the window, or once the huddle ends, a let-go guest knocks like anyone", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    const row = quiet(w, ada.guest_id, { media: true });
    await run(settleQuietGuests)(w.as(null), { room_key: ROOM, guest_ids: [ada.guest_id], in_media: [] });
    row.settled_at = Date.now() - GUEST_RESUME_MS - 1;
    expect((await run(getGuestState)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).resumable).toBe(false);
    row.settled_at = Date.now() - 1;
    expect((await run(getGuestState)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).resumable).toBe(true);
    // The huddle ended and a new one started: every seat is newer than the
    // moment the place went.
    w.db._tables.call_members[0].joined_at = Date.now();
    const st = await run(getGuestState)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret });
    expect(st).toMatchObject({ view: "left", resumable: false });
    const again = await run(requestJoin)(w.as(null), { token: ada.link.token, name: "Ada", accept_notice: true, guest_id: ada.guest_id, secret: ada.secret });
    expect(again.status).toBe("waiting");
  });

  test("a knock abandoned at the door never resumes into the call", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    const row = w.db._tables.call_guests[0];
    row.last_seen = 0;
    await run(sweepGuestRooms)(w.as(null), {});
    expect(row).toMatchObject({ status: "left", left_reason: "lapsed" });
    expect((await run(getGuestState)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret })).resumable).toBe(false);
  });
});

describe("the room's thread keeps who let a stranger in or out", () => {
  test("admit and remove each write one line naming the doorkeeper and the guest", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    await run(removeGuest)(w.as("u1"), { guest_id: ada.guest_id });
    const lines = (w.db._tables.call_chat_messages ?? []).map((r: any) => [r.event, String(r.user_id), r.event_guest_name, r.room_key]);
    expect(lines).toEqual([
      ["guest_admitted", "u1", "Ada", ROOM],
      ["guest_removed", "u1", "Ada", ROOM],
    ]);
  });

  test("turning a knock away writes nothing", async () => {
    const w = world();
    const ada = await linkAndKnock(w, "Ada");
    await run(denyGuest)(w.as("u1"), { guest_id: ada.guest_id });
    expect(w.db._tables.call_chat_messages ?? []).toEqual([]);
  });
});

describe("a join the server refuses says why in words the page can act on", () => {
  test("mintGuestToken throws a coded ConvexError", async () => {
    const env = { ...process.env };
    process.env.LIVEKIT_URL = "wss://lk.test";
    process.env.LIVEKIT_API_KEY = "k";
    process.env.LIVEKIT_API_SECRET = "s".repeat(32);
    try {
      const ctx = { runMutation: async () => ({ ok: false, reason: "removed" }) };
      const err: any = await run(mintGuestToken)(ctx, { guest_id: "x", secret: "y" }).catch((e: any) => e);
      expect(err.data).toEqual({ code: "removed", message: GUEST_JOIN_REFUSAL_TEXT.removed });
    } finally {
      process.env = env;
    }
  });
});

// A guest's page beats for as long as it stays open, and whoever made the
// link is told about a knock until it is answered. Neither is a teammate in
// the room, so neither may hold a huddle's record open: a record that ran for
// hours with one line in it would also keep a recording billing by the minute.
describe("a guest at the door never keeps an empty huddle's record going", () => {
  async function emptiedWithAGuestWaiting(admitted: boolean) {
    const w = world({
      transcripts: [{ _id: "tr1", room_key: ROOM, team_id: "t1", started_by: "u1", status: "live", started_at: Date.now() - 60_000, routes: [], last_seq: 1 }],
    });
    const ada = await linkAndKnock(w);
    if (admitted) await run(admitGuest)(w.as("u1"), { guest_id: ada.guest_id });
    await run(leaveRoom)(w.as("u1"), { room_key: ROOM });
    const leftAt = w.db._tables.transcripts[0].idle_since;
    expect(leftAt).toBeNumber();
    return { w, ada, leftAt };
  }

  // Every way the guest's side touches the room, a few times over, the way
  // an open page and a creator's notification would across the grace.
  async function guestActivity(w: ReturnType<typeof world>, ada: { guest_id: string; secret: string }) {
    for (let i = 0; i < 3; i++) {
      await run(guestHeartbeat)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret });
      await run(getGuestState)(w.as(null), { guest_id: ada.guest_id, secret: ada.secret });
      await run(noteGuestsWaitingShown)(w.as("u1"), { guest_ids: [ada.guest_id] });
    }
  }

  for (const admitted of [false, true]) {
    const who = admitted ? "an admitted guest alone" : "a guest knocking";
    test(`${who}: the grace check ends the record where the room emptied`, async () => {
      const { w, ada, leftAt } = await emptiedWithAGuestWaiting(admitted);
      await guestActivity(w, ada);
      const now = spyOn(Date, "now").mockReturnValue(leftAt + HUDDLE_GRACE_MS);
      try {
        await guestActivity(w, ada);
        expect(w.db._tables.transcripts[0].idle_since).toBe(leftAt);
        expect(await run(endIdleTranscript)(w.as(null), { transcript_id: "tr1" })).toEqual({ ended: true });
      } finally {
        now.mockRestore();
      }
      expect(w.db._tables.transcripts[0]).toMatchObject({ status: "ended", ended_at: leftAt });
    });

    test(`${who}: the orphan sweep ends it too, dated from the last seat`, async () => {
      const { w, ada, leftAt } = await emptiedWithAGuestWaiting(admitted);
      const now = spyOn(Date, "now").mockReturnValue(leftAt + HUDDLE_GRACE_MS + 1_000);
      try {
        await guestActivity(w, ada);
        expect(await run(sweepOrphanedLive)(w.as(null), {})).toMatchObject({ ended: 1 });
      } finally {
        now.mockRestore();
      }
      expect(w.db._tables.transcripts[0]).toMatchObject({ status: "ended", ended_at: leftAt });
    });
  }
});

describe("the e2e harness's cleanup", () => {
  test("turns off every open link into the room made since the run began, and nothing older", async () => {
    const w = world();
    const links = () => w.db._tables.call_guest_links;
    const older = await run(createGuestLink)(w.as("u2"), { room_key: ROOM });
    links()[0].created_at = Date.now() - 60_000;
    const since = Date.now() - 1_000;
    const mine = await run(createGuestLink)(w.as("u1"), { room_key: ROOM });
    const bob = await run(requestJoin)(w.as(null), { token: mine.token, name: "Bob", accept_notice: true });
    const res = await run(revokeRoomGuestLinks)(w.as(null), { room_key: ROOM, since });
    expect(res.revoked).toEqual([String(mine.link_id)]);
    expect(links().find((l: any) => l.token === mine.token)).toMatchObject({ revoked_by: "u1" });
    expect(links().find((l: any) => l.token === older.token).revoked_at).toBeUndefined();
    // Revoked the way the panel does: the guest waiting on it is told so.
    expect((await run(getGuestState)(w.as(null), { guest_id: bob.guest_id, secret: bob.secret })).view).toBe("closed");
    // With no start given it takes the rest, and a second run finds nothing.
    expect((await run(revokeRoomGuestLinks)(w.as(null), { room_key: ROOM })).revoked).toEqual([String(older.link_id)]);
    expect((await run(revokeRoomGuestLinks)(w.as(null), { room_key: ROOM })).revoked).toEqual([]);
  });
});
