import { describe, expect, test } from "bun:test";
import { CALL_KNOCK_TTL_MS } from "./calls";
import { CALL_MEMBER_STALE_MS as STALE } from "./callRooms";
import { HUDDLE_GRACE_MS } from "./transcripts";
import { fakeCtx } from "./calls.testkit";

// The door. Huddles are open by default (callRooms.openRoomDoor is covered in
// callRooms.test.ts); these are the exception and the way back in from it.
describe("lock, knock and the live-room list", () => {
  async function fn(name: string) {
    const mod: any = await import("./calls");
    return mod[name]._handler ?? mod[name].handler;
  }
  const as = (ctx: any, user: string) => {
    ctx.auth = { getUserIdentity: async () => ({ subject: `${user}|sess`, tokenIdentifier: "x" }) };
  };
  function seat(rows: Record<string, any[]>, user: string, roomKey: string, lastSeen: number, team = "t1") {
    (rows.call_members ??= []).push({
      _id: `cm-${user}-${roomKey}`, room_key: roomKey, team_id: team, user_id: user,
      user_name: user, joined_at: lastSeen, last_seen: lastSeen,
      muted: true, camera: false, sharing: false,
    });
  }

  test("only someone in the huddle may lock its door", async () => {
    const { ctx, rows, now } = fakeCtx();
    // ua is a member of dm:ua:ub but is not sitting in it.
    await expect((await fn("setRoomLocked"))(ctx, { room_key: "dm:ua:ub", locked: true }))
      .rejects.toThrow(/in the huddle/);
    seat(rows, "ua", "dm:ua:ub", now);
    await (await fn("setRoomLocked"))(ctx, { room_key: "dm:ua:ub", locked: true });
    expect(rows.call_room_state).toHaveLength(1);
    expect(rows.call_room_state[0]).toMatchObject({ locked: true, locked_by: "ua", team_id: "t1" });
    // A teammate who was walking in is now refused; the pair still get in.
    const { authorizeRoom } = await import("./callRooms");
    expect((await authorizeRoom(ctx, "uc" as any, "dm:ua:ub")).ok).toBe(false);
    expect((await authorizeRoom(ctx, "ub" as any, "dm:ua:ub")).ok).toBe(true);
  });

  test("toggling reuses the room's one row and reopens the door", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ua", "dm:ua:ub", now);
    const h = await fn("setRoomLocked");
    await h(ctx, { room_key: "dm:ua:ub", locked: true });
    await h(ctx, { room_key: "dm:ua:ub", locked: false });
    expect(rows.call_room_state).toHaveLength(1);
    expect(rows.call_room_state[0].locked).toBe(false);
    const { authorizeRoom } = await import("./callRooms");
    expect((await authorizeRoom(ctx, "uc" as any, "dm:ua:ub")).ok).toBe(true);
  });

  test("unlocking answers every knock at once", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ua", "dm:ua:ub", now);
    rows.call_knocks = [
      { _id: "k1", room_key: "dm:ua:ub", team_id: "t1", from_user: "uc", created_at: now },
      { _id: "k2", room_key: "channel:ch1", team_id: "t1", from_user: "uc", created_at: now },
    ];
    const h = await fn("setRoomLocked");
    await h(ctx, { room_key: "dm:ua:ub", locked: true });
    expect(rows.call_knocks.map((k) => k._id)).toEqual(["k1", "k2"]);
    await h(ctx, { room_key: "dm:ua:ub", locked: false });
    expect(rows.call_knocks.map((k) => k._id)).toEqual(["k2"]);
  });

  test("a room restarting from empty starts open, with nobody at the door", async () => {
    // The same joinRoom branch that expires the previous huddle's grants.
    const { ctx, rows, now } = fakeCtx();
    rows.chat_channels = [{ _id: "ch1", team_id: "t1", name: "design" }];
    seat(rows, "ub", "channel:ch1", now - HUDDLE_GRACE_MS - 1000);
    rows.call_room_state = [{ _id: "rs1", room_key: "channel:ch1", team_id: "t1", locked: true, locked_by: "ub", updated_at: now - 60_000 }];
    rows.call_knocks = [{ _id: "k1", room_key: "channel:ch1", team_id: "t1", from_user: "uc", created_at: now }];
    await (await fn("joinRoom"))(ctx, { room_key: "channel:ch1", muted: true });
    expect(rows.call_room_state).toEqual([]);
    expect(rows.call_knocks).toEqual([]);
  });

  test("a seat that lapsed inside the grace is the same huddle, recorded or not", async () => {
    // Nobody pressed Leave (a laptop slept), nothing is transcribing: the
    // seat's own last beat dates the quiet, the same rule a guest's admission
    // follows (transcripts.huddleAlive), so the lock is still this huddle's.
    const { ctx, rows, now } = fakeCtx();
    rows.chat_channels = [{ _id: "ch1", team_id: "t1", name: "design" }];
    seat(rows, "ub", "channel:ch1", now - STALE - 1000);
    rows.call_room_state = [{ _id: "rs1", room_key: "channel:ch1", team_id: "t1", locked: true, locked_by: "ub", updated_at: now - 60_000 }];
    await (await fn("joinRoom"))(ctx, { room_key: "channel:ch1", muted: true });
    expect(rows.call_room_state.map((r) => r._id)).toEqual(["rs1"]);
  });

  test("a knock needs a locked door and a teammate behind it", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ua", "dm:ua:ub", now);
    const h = await fn("knock");
    // Open room: there is nothing to knock at.
    as(ctx, "uc");
    await expect(h(ctx, { room_key: "dm:ua:ub" })).rejects.toThrow(/just join it/);
    rows.call_room_state = [{ _id: "rs1", room_key: "dm:ua:ub", team_id: "t1", locked: true, locked_by: "ua", updated_at: now }];
    // Outside the billing team: refused with the lock ignored too.
    as(ctx, "ud");
    await expect(h(ctx, { room_key: "dm:ua:ub" })).rejects.toThrow(/Cannot knock/);
    // An empty room is not a huddle to knock at.
    as(ctx, "uc");
    await expect(h(ctx, { room_key: "dm:ub:uc" })).rejects.toThrow(/Cannot knock/);
    // The room's own people never knock — they walk in.
    as(ctx, "ub");
    await expect(h(ctx, { room_key: "dm:ua:ub" })).rejects.toThrow(/just join it/);
    as(ctx, "uc");
    await h(ctx, { room_key: "dm:ua:ub" });
    expect(rows.call_knocks).toHaveLength(1);
    expect(rows.call_knocks[0]).toMatchObject({ from_user: "uc", team_id: "t1" });
  });

  test("knocking again refreshes one row; dead knocks are swept", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ua", "dm:ua:ub", now);
    rows.call_room_state = [{ _id: "rs1", room_key: "dm:ua:ub", team_id: "t1", locked: true, locked_by: "ua", updated_at: now }];
    rows.call_knocks = [
      { _id: "old", room_key: "dm:ua:ub", team_id: "t1", from_user: "ub", created_at: now - CALL_KNOCK_TTL_MS - 1 },
    ];
    as(ctx, "uc");
    const h = await fn("knock");
    await h(ctx, { room_key: "dm:ua:ub" });
    await h(ctx, { room_key: "dm:ua:ub" });
    // ub's expired knock swept, uc's single row refreshed rather than twinned.
    expect(rows.call_knocks).toHaveLength(1);
    expect(rows.call_knocks[0].from_user).toBe("uc");
  });

  test("only the people inside see who is waiting", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ua", "dm:ua:ub", now);
    rows.call_knocks = [
      { _id: "k1", room_key: "dm:ua:ub", team_id: "t1", from_user: "uc", created_at: now },
      { _id: "k2", room_key: "dm:ua:ub", team_id: "t1", from_user: "ub", created_at: now - CALL_KNOCK_TTL_MS - 1 },
    ];
    const h = await fn("getRoomKnocks");
    const inside = await h(ctx, { room_key: "dm:ua:ub" });
    expect(inside).toHaveLength(1); // the expired one is filtered, never shown
    expect(inside[0]).toMatchObject({ from_user: "uc", from_name: "Cy" });
    // uc is knocking, not sitting: they learn nothing about the room.
    as(ctx, "uc");
    expect(await h(ctx, { room_key: "dm:ua:ub" })).toEqual([]);
  });

  // The room must be able to tell a second knock from the first, and the only
  // thing that distinguishes them is created_at: knocking again refreshes one
  // row rather than adding a second. Rounding that timestamp (as every other
  // room subscription does, for byte-stability across heartbeats) would round
  // the second knock onto the first and the room would never hear it.
  test("a second knock is visible: the waiting row carries its exact time", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ua", "dm:ua:ub", now);
    rows.call_knocks = [
      { _id: "k1", room_key: "dm:ua:ub", team_id: "t1", from_user: "uc", created_at: now - 12_345 },
    ];
    const read = await fn("getRoomKnocks");
    const first = await read(ctx, { room_key: "dm:ua:ub" });
    expect(first[0].created_at).toBe(now - 12_345);
    // uc knocks again, 12s later — the same minute, the same row, a new time.
    rows.call_knocks[0].created_at = now;
    const second = await read(ctx, { room_key: "dm:ua:ub" });
    expect(second[0].created_at).toBe(now);
    expect(second[0].created_at).not.toBe(first[0].created_at);
  });

  test("getLiveRooms lists every live huddle across my teams", async () => {
    const { ctx, rows, now } = fakeCtx();
    rows.teams.push({ _id: "t2", name: "T2", features: { calls: true, chat: true } });
    rows.teams.push({ _id: "t3", name: "T3", features: { calls: true, chat: true } });
    rows.team_memberships.push({ _id: "m5", user_id: "ua", team_id: "t2" });
    rows.team_memberships.push({ _id: "m6", user_id: "ub", team_id: "t2" });
    rows.team_memberships.push({ _id: "m7", user_id: "uc", team_id: "t3" });
    rows.chat_channels = [{ _id: "ch1", team_id: "t1", name: "design" }];
    // A room I am a third party to, in each of my teams; one locked.
    seat(rows, "ub", "dm:ub:uc", now);
    seat(rows, "ub", "channel:ch1", now);
    rows.call_room_state = [{ _id: "rs1", room_key: "channel:ch1", team_id: "t1", locked: true, locked_by: "ub", updated_at: now }];
    // A stale room: nobody is in it, so it is not a huddle.
    seat(rows, "uc", "dm:ua:uc", now - STALE - 1000);
    // A huddle in a team I am not on.
    seat(rows, "uc", "dm:uc:ud", now, "t3");

    const live = await (await fn("getLiveRooms"))(ctx, {});
    expect(live.map((r: any) => r.room_key)).toEqual(["channel:ch1", "dm:ub:uc"]);
    const byKey = Object.fromEntries(live.map((r: any) => [r.room_key, r]));
    // Locked rooms still LIST — seeing the room is what makes knocking possible.
    expect(byKey["channel:ch1"]).toMatchObject({ locked: true, redacted: false, title: "design" });
    expect(byKey["dm:ub:uc"]).toMatchObject({ locked: false, redacted: false, team_id: "t1" });
    expect(byKey["dm:ub:uc"].members.map((m: any) => m.user_id)).toEqual(["ub"]);
  });

  test("a group huddle lists for a teammate outside it, and locking turns Join into Knock", async () => {
    // The caller (ua) is named nowhere in a three-person room. The decided
    // product lists it with its roster and lets ua walk in; locking it leaves
    // the room listed — that is what makes knocking possible — and the same
    // teammate may then knock.
    const { ctx, rows, now } = fakeCtx();
    rows.users.push({ _id: "ue", name: "Eve" });
    rows.team_memberships.push({ _id: "m5", user_id: "ue", team_id: "t1" });
    const groupKey = "dm:ub:uc:ue";
    for (const u of ["ub", "uc", "ue"]) seat(rows, u, groupKey, now);

    const open = await (await fn("getLiveRooms"))(ctx, {});
    expect(open.map((r: any) => r.room_key)).toEqual([groupKey]);
    expect(open[0].members.map((m: any) => m.user_id)).toEqual(["ub", "uc", "ue"]);
    expect(open[0].locked).toBe(false);
    const { authorizeRoom } = await import("./callRooms");
    expect((await authorizeRoom(ctx, "ua" as any, groupKey)).ok).toBe(true);

    rows.call_room_state = [{ _id: "rs1", room_key: groupKey, team_id: "t1", locked: true, locked_by: "ub", updated_at: now }];
    const shut = await (await fn("getLiveRooms"))(ctx, {});
    expect(shut[0]).toMatchObject({ room_key: groupKey, locked: true });
    expect(shut[0].members).toHaveLength(3);
    expect((await authorizeRoom(ctx, "ua" as any, groupKey)).ok).toBe(false);
    await (await fn("knock"))(ctx, { room_key: groupKey });
    expect(rows.call_knocks.map((k: any) => k.from_user)).toEqual(["ua"]);

    // ud is on another team: the outer wall refuses them at every step.
    as(ctx, "ud");
    expect(await (await fn("getLiveRooms"))(ctx, {})).toEqual([]);
    await expect((await fn("knock"))(ctx, { room_key: groupKey })).rejects.toThrow(/Cannot knock/);
  });

  // ct-44995: the lock is a fact about the ROOM; Join versus Knock is a fact
  // about the VIEWER, and the two are not the same question. calls.knock
  // refuses anyone authorizeRoom admits ("this huddle is open — just join
  // it"), so a row that reported only `locked` handed the room's own people a
  // button the server was guaranteed to reject.
  test("a locked room reports can_join for the people its lock does not shut out", async () => {
    const { ctx, rows, now } = fakeCtx();
    // ua's own 1:1 with ub: ub is sitting in it and locks the door. The lock
    // was never meant to exclude ua — it is their DM.
    seat(rows, "ub", "dm:ua:ub", now);
    // A room ua is a third party to, joinable only through the open door.
    seat(rows, "ub", "dm:ub:uc", now);
    seat(rows, "uc", "dm:ub:uc", now);

    const read = await fn("getLiveRooms");
    const open = Object.fromEntries((await read(ctx, {})).map((r: any) => [r.room_key, r]));
    expect(open["dm:ua:ub"]).toMatchObject({ locked: false, can_join: true });
    expect(open["dm:ub:uc"]).toMatchObject({ locked: false, can_join: true });

    rows.call_room_state = [
      { _id: "rs1", room_key: "dm:ua:ub", team_id: "t1", locked: true, locked_by: "ub", updated_at: now },
      { _id: "rs2", room_key: "dm:ub:uc", team_id: "t1", locked: true, locked_by: "ub", updated_at: now },
    ];
    const shut = Object.fromEntries((await read(ctx, {})).map((r: any) => [r.room_key, r]));
    // The member walks in through a locked door; the walk-in no longer can.
    expect(shut["dm:ua:ub"]).toMatchObject({ locked: true, can_join: true });
    expect(shut["dm:ub:uc"]).toMatchObject({ locked: true, can_join: false });
    // And the row agrees with the mutation behind each button, which is the
    // whole point: knocking is refused exactly where can_join is true.
    await expect((await fn("knock"))(ctx, { room_key: "dm:ua:ub" }))
      .rejects.toThrow(/just join it/);
    await (await fn("knock"))(ctx, { room_key: "dm:ub:uc" });
    expect(rows.call_knocks.map((k: any) => k.from_user)).toEqual(["ua"]);
  });

  test("a guest holding a live grant may still join a room that locked behind them", async () => {
    // The grant survives a lock — whoever was rung in was let in deliberately
    // — so their row must offer Join, not a knock the server refuses.
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ub", "dm:ub:uc", now);
    seat(rows, "uc", "dm:ub:uc", now);
    rows.call_room_state = [
      { _id: "rs1", room_key: "dm:ub:uc", team_id: "t1", locked: true, locked_by: "ub", updated_at: now },
    ];
    const read = await fn("getLiveRooms");
    expect((await read(ctx, {}))[0]).toMatchObject({ locked: true, can_join: false });

    rows.call_invites = [
      { _id: "i1", room_key: "dm:ub:uc", team_id: "t1", from_user: "ub", to_user: "ua",
        status: "accepted", created_at: now - 5_000, responded_at: now - 4_000 },
    ];
    expect((await read(ctx, {}))[0]).toMatchObject({ locked: true, can_join: true });
    await expect((await fn("knock"))(ctx, { room_key: "dm:ub:uc" }))
      .rejects.toThrow(/just join it/);
  });

  test("a private channel huddle stays off a non-member's list", async () => {
    const { ctx, rows, now } = fakeCtx();
    rows.chat_channels = [{ _id: "chp", team_id: "t1", name: "founders", kind: "private" }];
    rows.chat_channel_members = [{ _id: "cmb1", channel_id: "chp", user_id: "ub" }];
    seat(rows, "ub", "channel:chp", now);
    // ua is on the team and not in the channel: neither the room nor its
    // roster nor its name reaches them.
    expect(await (await fn("getLiveRooms"))(ctx, {})).toEqual([]);
  });

  test("a session huddle I cannot see lists without its title", async () => {
    const { ctx, rows, now } = fakeCtx();
    rows.conversations = [
      { _id: "cvp", user_id: "ub", team_id: "t1", is_private: true, title: "Secret refactor" },
      { _id: "cvs", user_id: "ub", team_id: "t1", is_private: false, title: "Shared work" },
    ];
    seat(rows, "ub", "session:cvp", now);
    seat(rows, "uc", "session:cvs", now);
    const live = await (await fn("getLiveRooms"))(ctx, {});
    const byKey = Object.fromEntries(live.map((r: any) => [r.room_key, r]));
    // Joinable either way — the team wall holds and the voices are audible.
    expect(byKey["session:cvp"]).toMatchObject({ redacted: true, title: undefined });
    expect(JSON.stringify(byKey["session:cvp"])).not.toContain("Secret refactor");
    expect(byKey["session:cvs"]).toMatchObject({ redacted: false, title: "Shared work" });
  });

  test("a huddle started private is shut, unlisted and unknockable to the team", async () => {
    const { ctx, rows } = fakeCtx();
    // A session every teammate can see: its ordinary huddle admits them all.
    rows.conversations = [{ _id: "cvs", user_id: "ub", team_id: "t1", is_private: false, title: "Shared work" }];
    as(ctx, "ub");
    await (await fn("joinRoom"))(ctx, { room_key: "session:cvs", muted: true, private: true });
    expect(rows.call_room_state[0]).toMatchObject({ locked: true, private: true, locked_by: "ub" });
    const { authorizeRoom } = await import("./callRooms");
    expect((await authorizeRoom(ctx, "uc" as any, "session:cvs")).ok).toBe(false);
    expect((await authorizeRoom(ctx, "ub" as any, "session:cvs")).ok).toBe(true);
    as(ctx, "uc");
    expect(await (await fn("getLiveRooms"))(ctx, {})).toEqual([]);
    await expect((await fn("knock"))(ctx, { room_key: "session:cvs" })).rejects.toThrow(/Cannot knock/);
    // Rung in, they walk through like any guest.
    rows.call_invites.push({ _id: "ci1", room_key: "session:cvs", team_id: "t1", from_user: "ub", to_user: "uc", status: "accepted", created_at: Date.now(), responded_at: Date.now() });
    expect((await authorizeRoom(ctx, "uc" as any, "session:cvs")).ok).toBe(true);
    // Opening the door makes it an ordinary huddle again.
    rows.call_invites = [];
    as(ctx, "ub");
    await (await fn("setRoomLocked"))(ctx, { room_key: "session:cvs", locked: false });
    expect(rows.call_room_state[0]).toMatchObject({ locked: false, private: false });
    expect((await authorizeRoom(ctx, "uc" as any, "session:cvs")).ok).toBe(true);
  });

  test("a channel's room never starts private", async () => {
    const { ctx, rows } = fakeCtx();
    rows.chat_channels = [{ _id: "ch1", team_id: "t1", name: "design" }];
    await (await fn("joinRoom"))(ctx, { room_key: "channel:ch1", muted: true, private: true });
    expect(rows.call_room_state ?? []).toEqual([]);
  });

  test("a private huddle's record stays with the people who were in it", async () => {
    const { ctx, rows } = fakeCtx();
    rows.conversations = [{ _id: "cvs", user_id: "ub", team_id: "t1", is_private: false, title: "Shared work" }];
    const { canReadCall } = await import("./transcripts");
    const call: any = { _id: "tr1", room_key: "session:cvs", team_id: "t1", started_by: "ub", status: "ended", participants: [{ id: "ua", name: "Ann" }], routes: [], last_seq: 0 };
    expect(await canReadCall(ctx, "uc" as any, call)).toBe(true);
    call.private = true;
    expect(await canReadCall(ctx, "uc" as any, call)).toBe(false);
    expect(await canReadCall(ctx, "ua" as any, call)).toBe(true);
    expect(await canReadCall(ctx, "ub" as any, call)).toBe(true);
    // A people room's key names exactly who it was for.
    const pair: any = { ...call, room_key: "dm:ua:uc", started_by: "ua", participants: [] };
    expect(await canReadCall(ctx, "uc" as any, pair)).toBe(true);
    expect(await canReadCall(ctx, "ub" as any, pair)).toBe(false);
  });

  test("a heartbeat does not re-push the team-wide list", async () => {
    // Byte-stability is the contract: every client on the team holds this
    // subscription while any huddle runs.
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ub", "dm:ub:uc", now - 30_000);
    const h = await fn("getLiveRooms");
    const before = await h(ctx, {});
    rows.call_members[0].last_seen = now; // the 15s heartbeat, and nothing else
    expect(await h(ctx, {})).toEqual(before);
  });
});
