// A huddle that is one person's alone (callRooms.isOwnerOnlyRoom): a people
// room of one (`dm:<you>`), and a session room whose conversation the team
// cannot read. Nothing stores that it is private, so these tests drive every
// surface a teammate could reach it through, live and after it ends, and the
// rooms that must stay open beside them.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { ensureCallBoard } from "./callStage";
import { authorizeRoom, dmRoomKey, isOwnerOnlyRoom, sessionRoomKey } from "./callRooms";
import { createTeamFeedFilter } from "./privacy";

setDefaultTimeout(30_000);

const backends: any[] = [];
afterEach(async () => {
  for (const t of backends.splice(0)) await t.finishAllScheduledFunctions?.(() => {}).catch?.(() => {});
});

async function world() {
  const t = convexTest(schema, allModules);
  backends.push(t);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "T", features: { calls: true, chat: true } } as any);
    // A team whose calls are off: Ana's active team, so a borrowed billing
    // team has to look past it.
    const quiet = await ctx.db.insert("teams", { name: "Quiet", features: {} } as any);
    const ana = await ctx.db.insert("users", { name: "Ana", active_team_id: quiet } as any);
    const ben = await ctx.db.insert("users", { name: "Ben", active_team_id: team } as any);
    const cy = await ctx.db.insert("users", { name: "Cy", active_team_id: team } as any);
    await ctx.db.insert("team_memberships", { user_id: ana, team_id: quiet, role: "member", joined_at: now } as any);
    for (const u of [ana, ben, cy]) {
      await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: now } as any);
    }
    const conv = (fields: Record<string, unknown>) =>
      ctx.db.insert("conversations", {
        user_id: ana, title: "Ana's session", agent_type: "claude_code", status: "active",
        started_at: now, updated_at: now, message_count: 0, ...fields,
      } as any);
    const noTeam = await conv({ is_private: true, session_id: "s-none" });
    const routed = await conv({ is_private: true, team_id: team, session_id: "s-routed" });
    const shared = await conv({ is_private: false, team_id: team, team_visibility: "full", session_id: "s-shared" });
    const channel = await ctx.db.insert("chat_channels", { team_id: team, name: "design", kind: "public", created_by: ana, created_at: now, updated_at: now } as any);
    return { team, quiet, ana, ben, cy, noTeam, routed, shared, channel };
  });
  const as = (u: string) => t.withIdentity({ subject: `${u}|session` });
  return { t, ids, as };
}

type World = Awaited<ReturnType<typeof world>>;

/** Ana starts a huddle in the room and transcribes it, with one line said and
 *  one typed, and a doc route on it that a teammate could try to take off. */
async function startHuddle({ t, as, ids }: World, roomKey: string) {
  await as(ids.ana).mutation(api.calls.joinRoom, { room_key: roomKey, deliberate: true });
  const started = await as(ids.ana).mutation(api.transcripts.start, { room_key: roomKey });
  const transcriptId = started.transcript_id!;
  await t.run(async (ctx) => {
    await ctx.db.insert("transcript_segments", { transcript_id: transcriptId, seq: 1, speaker_id: String(ids.ana), speaker_name: "Ana", text: "thinking out loud", t0: 0, t1: 1000 });
    await ctx.db.patch(transcriptId, { last_seq: 1 });
  });
  await as(ids.ana).mutation(api.callChat.post, { room_key: roomKey, text: "a note to self" });
  await as(ids.ana).mutation(api.transcripts.addRoute, { transcript_id: transcriptId, kind: "doc", target: "doc-notes", mode: "after" });
  return transcriptId;
}

async function endCall({ t }: World, transcriptId: any) {
  await t.run(async (ctx) => ctx.db.patch(transcriptId, { status: "ended", ended_at: Date.now() }));
}

async function roomKeyIn(w: World, viewer: any, member: any) {
  const rows = await w.as(viewer).query(api.teams.getTeamMembers, { team_id: w.ids.team });
  return rows.find((r: any) => String(r._id) === String(member))?.in_room_key;
}

const ownerOnlyRooms: Array<[string, (ids: World["ids"]) => string]> = [
  ["a people room of one", (ids) => dmRoomKey(ids.ana)],
  ["a session with no team", (ids) => sessionRoomKey(ids.noTeam)],
  ["a personal session routed to the team", (ids) => sessionRoomKey(ids.routed)],
];

describe("owner-only huddles", () => {
  for (const [name, keyOf] of ownerOnlyRooms) {
    describe(name, () => {
      test("a teammate cannot find, enter or read it while it runs", async () => {
        const w = await world();
        const { t, as, ids } = w;
        const room = keyOf(ids);
        const transcriptId = await startHuddle(w, room);

        expect((await as(ids.ben).query(api.calls.getLiveRooms, {})).map((r: any) => r.room_key)).not.toContain(room);
        await expect(as(ids.ben).mutation(api.calls.joinRoom, { room_key: room, deliberate: true })).rejects.toThrow("Cannot join room");
        expect(await as(ids.ben).query(internal.calls.authForToken, { room_key: room })).toBeNull();
        expect(await as(ids.ben).query(api.calls.getRoomOccupancy, { room_keys: [room] })).toEqual({});
        expect(await as(ids.ben).query(api.transcripts.getLive, { room_key: room })).toBeNull();
        expect(await as(ids.ben).query(api.transcripts.webGetCall, { transcript_id: transcriptId })).toBeNull();
        expect(await as(ids.ben).query(api.callChat.list, { room_key: room })).toBeNull();
        await expect(as(ids.ben).mutation(api.callChat.post, { room_key: room, text: "hi" })).rejects.toThrow("Cannot chat");
        await expect(as(ids.ben).mutation(api.transcripts.addRoute, { transcript_id: transcriptId, kind: "doc", target: "doc-ben", mode: "after" })).rejects.toThrow("Transcript not found");
        await expect(as(ids.ben).mutation(api.transcripts.removeRoute, { transcript_id: transcriptId, kind: "doc", target: "doc-notes" })).rejects.toThrow("Not your route");
        await expect(as(ids.ben).mutation(api.calls.knock, { room_key: room })).rejects.toThrow("Cannot knock");
        expect(await roomKeyIn(w, ids.ben, ids.ana)).toBeUndefined();

        // The board lives in Ana's own workspace and its pin is the room's.
        const board = await t.run(async (ctx) => ensureCallBoard(ctx as any, (await ctx.db.get(transcriptId))!, ids.ana));
        const boardDoc = await t.run(async (ctx) => ctx.db.get(board!));
        expect(boardDoc?.workspace).toBe(`user:${ids.ana}`);
        expect(await as(ids.ben).query(api.callStage.listPins, { room_key: room })).toEqual([]);
        expect((await as(ids.ana).query(api.callStage.listPins, { room_key: room })).map((p: any) => p.ref)).toEqual([`doc:${board}`]);

        // Ana has all of it.
        const mine = (await as(ids.ana).query(api.calls.getLiveRooms, {})).find((r: any) => r.room_key === room);
        expect(mine).toMatchObject({ can_join: true, private: true, team_id: String(ids.team) });
        expect(await as(ids.ana).query(internal.calls.authForToken, { room_key: room })).not.toBeNull();
        expect(Object.keys(await as(ids.ana).query(api.calls.getRoomOccupancy, { room_keys: [room] }))).toEqual([room]);
        expect((await as(ids.ana).query(api.transcripts.getLive, { room_key: room }))?.transcript_id).toBe(transcriptId);
        expect(await as(ids.ana).query(api.transcripts.webGetCall, { transcript_id: transcriptId })).not.toBeNull();
        expect((await as(ids.ana).query(api.callChat.list, { room_key: room }))?.map((m: any) => m.text)).toContain("a note to self");
        expect(await roomKeyIn(w, ids.ana, ids.ana)).toBe(room);
        await as(ids.ana).mutation(api.transcripts.removeRoute, { transcript_id: transcriptId, kind: "doc", target: "doc-notes" });

        // The record says it is private, wherever it was billed.
        const record = await t.run(async (ctx) => ctx.db.get(transcriptId));
        expect(record).toMatchObject({ private: true, team_id: ids.team });
      });

      test("after it ends only its owner reads it", async () => {
        const w = await world();
        const { as, ids } = w;
        const room = keyOf(ids);
        const transcriptId = await startHuddle(w, room);
        await endCall(w, transcriptId);
        expect(await as(ids.ben).query(api.transcripts.webGetCall, { transcript_id: transcriptId })).toBeNull();
        expect((await as(ids.ben).query(api.transcripts.webListCalls, {})).map((c: any) => c._id)).not.toContain(transcriptId);
        expect(await as(ids.ana).query(api.transcripts.webGetCall, { transcript_id: transcriptId })).not.toBeNull();
        expect((await as(ids.ana).query(api.transcripts.webListCalls, {})).find((c: any) => c._id === transcriptId)?.private).toBe(true);
      });

      test("someone the owner rings in may join", async () => {
        const w = await world();
        const { t, as, ids } = w;
        const room = keyOf(ids);
        await startHuddle(w, room);
        await as(ids.ana).mutation(api.calls.invite, { room_key: room, to_user: ids.cy });
        const invite = await t.run(async (ctx) => (await ctx.db.query("call_invites").collect()).find((i) => String(i.to_user) === String(ids.cy)));
        await as(ids.cy).mutation(api.calls.respondInvite, { invite_id: invite!._id, accept: true });
        await as(ids.cy).mutation(api.calls.joinRoom, { room_key: room, deliberate: true });
        expect(await as(ids.cy).query(api.transcripts.getLive, { room_key: room })).not.toBeNull();
        // Ben, never rung, is still outside.
        await expect(as(ids.ben).mutation(api.calls.joinRoom, { room_key: room, deliberate: true })).rejects.toThrow("Cannot join room");
      });
    });
  }

  test("an owner-only session room keeps its own route, so the session hears the huddle", async () => {
    const w = await world();
    for (const conv of [w.ids.noTeam, w.ids.routed]) {
      const transcriptId = await startHuddle(w, sessionRoomKey(conv));
      const record = await w.t.run(async (ctx) => ctx.db.get(transcriptId));
      expect(record?.routes.filter((r) => r.kind === "session").map((r) => r.target)).toEqual([String(conv)]);
      expect(record?.own_route_owed).toBeUndefined();
      await w.as(w.ids.ana).mutation(api.calls.leaveRoom, { room_key: sessionRoomKey(conv) });
    }
  });

  test("a user-made private huddle on a team-visible session still holds its own route back", async () => {
    const w = await world();
    const room = sessionRoomKey(w.ids.shared);
    await w.as(w.ids.ana).mutation(api.calls.joinRoom, { room_key: room, deliberate: true, private: true });
    const { transcript_id } = await w.as(w.ids.ana).mutation(api.transcripts.start, { room_key: room });
    const record = await w.t.run(async (ctx) => ctx.db.get(transcript_id!));
    expect(record?.routes.filter((r) => r.kind === "session")).toEqual([]);
    expect(record?.private).toBe(true);
  });

  test("a teamless session and a room of one bill to a team of the owner's with calls on, past an active team without", async () => {
    const w = await world();
    for (const room of [sessionRoomKey(w.ids.noTeam), dmRoomKey(w.ids.ana)]) {
      await w.as(w.ids.ana).mutation(api.calls.joinRoom, { room_key: room, deliberate: true });
      const seat = await w.t.run(async (ctx) => (await ctx.db.query("call_members").collect()).find((m) => m.room_key === room));
      expect(String(seat?.team_id)).toBe(String(w.ids.team));
    }
  });

  test("a session whose owner left its team is owner-only, billed elsewhere", async () => {
    const w = await world();
    const { t, as, ids } = w;
    // Ana leaves T for a new team with calls on; her shared session still names T.
    const other = await t.run(async (ctx) => {
      const other = await ctx.db.insert("teams", { name: "Other", features: { calls: true } } as any);
      await ctx.db.insert("team_memberships", { user_id: ids.ana, team_id: other, role: "member", joined_at: Date.now() } as any);
      const m = (await ctx.db.query("team_memberships").collect()).find((r) => String(r.user_id) === String(ids.ana) && String(r.team_id) === String(ids.team));
      await ctx.db.delete(m!._id);
      return other;
    });
    const room = sessionRoomKey(ids.shared);
    await as(ids.ana).mutation(api.calls.joinRoom, { room_key: room, deliberate: true });
    const seat = await t.run(async (ctx) => (await ctx.db.query("call_members").collect()).find((m) => m.room_key === room));
    expect(String(seat?.team_id)).toBe(String(other));
    await expect(as(ids.ben).mutation(api.calls.joinRoom, { room_key: room, deliberate: true })).rejects.toThrow("Cannot join room");
  });
});

describe("rooms that stay open", () => {
  test("a huddle on a team-visible session admits the teammate, and its record is not private", async () => {
    const w = await world();
    const room = sessionRoomKey(w.ids.shared);
    const transcriptId = await startHuddle(w, room);
    expect((await w.as(w.ids.ben).query(api.calls.getLiveRooms, {})).find((r: any) => r.room_key === room)).toMatchObject({ can_join: true, private: false });
    await w.as(w.ids.ben).mutation(api.calls.joinRoom, { room_key: room, deliberate: true });
    const record = await w.t.run(async (ctx) => ctx.db.get(transcriptId));
    expect(record?.private).toBeUndefined();
    expect(record?.routes.some((r) => r.kind === "session" && r.target === String(w.ids.shared))).toBe(true);
    expect(await roomKeyIn(w, w.ids.cy, w.ids.ana)).toBe(room);
  });

  test("a two-person room's open door still admits a third teammate", async () => {
    const w = await world();
    const room = dmRoomKey(w.ids.ana, w.ids.ben);
    const transcriptId = await startHuddle(w, room);
    expect((await w.as(w.ids.cy).query(api.calls.getLiveRooms, {})).find((r: any) => r.room_key === room)).toMatchObject({ can_join: true, private: false });
    await w.as(w.ids.cy).mutation(api.calls.joinRoom, { room_key: room, deliberate: true });
    expect(await w.as(w.ids.cy).query(api.transcripts.getLive, { room_key: room })).not.toBeNull();
    const record = await w.t.run(async (ctx) => ctx.db.get(transcriptId));
    expect(record?.private).toBeUndefined();
  });

  test("a public channel's room admits its teammates", async () => {
    const w = await world();
    const room = `channel:${w.ids.channel}`;
    await startHuddle(w, room);
    await w.as(w.ids.cy).mutation(api.calls.joinRoom, { room_key: room, deliberate: true });
    expect((await w.as(w.ids.cy).query(api.callChat.list, { room_key: room }))?.map((m: any) => m.text)).toContain("a note to self");
  });
});

describe("handing the scribe seat back", () => {
  test("only the scribe may release; after a release another seat's start takes the run", async () => {
    const w = await world();
    const { t, as, ids } = w;
    const room = dmRoomKey(ids.ana, ids.ben);
    const transcriptId = await startHuddle(w, room);
    await as(ids.ben).mutation(api.calls.joinRoom, { room_key: room, deliberate: true });

    expect(await as(ids.ben).mutation(api.transcripts.releaseScribe, { room_key: room })).toEqual({ released: false });
    expect((await t.run(async (ctx) => ctx.db.get(transcriptId)))?.scribe_open).toBeUndefined();
    // While Ana scribes from her seat, Ben's start only observes.
    expect((await as(ids.ben).mutation(api.transcripts.start, { room_key: room, auto: true })).role).toBe("observer");

    expect(await as(ids.ana).mutation(api.transcripts.releaseScribe, { room_key: room })).toEqual({ released: true });
    expect((await as(ids.ana).query(api.transcripts.getLive, { room_key: room }))?.started_by).toBeNull();
    // A second release has nothing to hand back.
    expect(await as(ids.ana).mutation(api.transcripts.releaseScribe, { room_key: room })).toEqual({ released: false });

    const taken = await as(ids.ben).mutation(api.transcripts.start, { room_key: room, auto: true });
    expect(taken).toMatchObject({ transcript_id: transcriptId, existing: true, role: "scribe" });
    const record = await t.run(async (ctx) => ctx.db.get(transcriptId));
    expect([String(record?.started_by), record?.scribe_open]).toEqual([String(ids.ben), undefined]);
  });

  test("a room with no live record releases nothing", async () => {
    const w = await world();
    expect(await w.as(w.ids.ana).mutation(api.transcripts.releaseScribe, { room_key: dmRoomKey(w.ids.ana) })).toEqual({ released: false });
  });
});

describe("review fixes", () => {
  test("a session room whose conversation is gone mid-huddle stays shut to the team", async () => {
    const w = await world();
    const { t, as, ids } = w;
    const room = sessionRoomKey(ids.routed);
    await startHuddle(w, room);
    await t.run(async (ctx) => ctx.db.delete(ids.routed));
    expect((await as(ids.ben).query(api.calls.getLiveRooms, {})).map((r: any) => r.room_key)).not.toContain(room);
    expect(await as(ids.ben).query(internal.calls.authForToken, { room_key: room })).toBeNull();
    expect(await as(ids.ben).query(api.transcripts.getLive, { room_key: room })).toBeNull();
    expect(await as(ids.ben).query(api.callChat.list, { room_key: room })).toBeNull();
  });

  test("a session owner who makes the session private later does not gain a teammate's private huddle record", async () => {
    const w = await world();
    const { t, as, ids } = w;
    const room = sessionRoomKey(ids.shared);
    await as(ids.ben).mutation(api.calls.joinRoom, { room_key: room, deliberate: true, private: true });
    const { transcript_id } = await as(ids.ben).mutation(api.transcripts.start, { room_key: room });
    await t.run(async (ctx) => {
      await ctx.db.insert("transcript_segments", { transcript_id: transcript_id!, seq: 1, speaker_id: String(ids.ben), speaker_name: "Ben", text: "mine", t0: 0, t1: 1000 });
      await ctx.db.patch(transcript_id!, { last_seq: 1 });
    });
    await endCall(w, transcript_id);
    expect(await as(ids.ana).query(api.transcripts.webGetCall, { transcript_id: transcript_id! })).toBeNull();
    await t.run(async (ctx) => ctx.db.patch(ids.shared, { is_private: true, team_visibility: "private" } as any));
    expect(await as(ids.ana).query(api.transcripts.webGetCall, { transcript_id: transcript_id! })).toBeNull();
    expect(await as(ids.ben).query(api.transcripts.webGetCall, { transcript_id: transcript_id! })).not.toBeNull();
  });

  test("a session room is owner-only exactly when the team feed hides the session", async () => {
    const w = await world();
    const { t, ids } = w;
    const cases: Array<{ conv: Record<string, unknown>; membership?: Record<string, unknown> }> = [];
    for (const is_private of [true, false]) {
      for (const team_visibility of [undefined, "private", "summary", "full"]) {
        for (const visibility of [undefined, "hidden", "activity", "summary", "full"]) {
          cases.push({ conv: { is_private, team_visibility }, membership: { visibility } });
        }
      }
    }
    // A going-forward switch: a session started before it reads at the old level.
    cases.push({ conv: { is_private: false, started_at: 1_000 }, membership: { visibility: "full", visibility_history: [{ before: 2_000, visibility: "hidden" }] } });
    cases.push({ conv: { is_private: false, started_at: 3_000 }, membership: { visibility: "hidden", visibility_history: [{ before: 2_000, visibility: "full" }] } });
    let ownerOnlyCount = 0;
    for (const c of cases) {
      const { derived, feed } = await t.run(async (ctx) => {
        const owner = await ctx.db.insert("users", { name: "Owner" } as any);
        await ctx.db.insert("team_memberships", { user_id: owner, team_id: ids.team, role: "member", joined_at: 1, ...c.membership } as any);
        const conv = await ctx.db.insert("conversations", { user_id: owner, team_id: ids.team, agent_type: "claude_code", status: "active", started_at: 5_000, updated_at: 1, message_count: 0, ...c.conv } as any);
        const derived = await isOwnerOnlyRoom(ctx, sessionRoomKey(conv));
        const feed = (await createTeamFeedFilter(ctx as any, ids.team)).isVisible((await ctx.db.get(conv))! as any);
        return { derived, feed };
      });
      expect([c, derived]).toEqual([c, !feed]);
      if (derived) ownerOnlyCount++;
    }
    // Both answers occur, so the table pins the rule rather than one branch.
    expect(ownerOnlyCount).toBeGreaterThan(0);
    expect(ownerOnlyCount).toBeLessThan(cases.length);
  });

  test("once a room turns owner-only, a walk-in seated in it can no longer ring people in; someone rung in still can", async () => {
    const w = await world();
    const { t, as, ids } = w;
    const room = sessionRoomKey(ids.shared);
    const dee = await t.run(async (ctx) => {
      const dee = await ctx.db.insert("users", { name: "Dee", active_team_id: ids.team } as any);
      await ctx.db.insert("team_memberships", { user_id: dee, team_id: ids.team, role: "member", joined_at: 1 } as any);
      return dee;
    });
    await startHuddle(w, room);
    await as(ids.ben).mutation(api.calls.joinRoom, { room_key: room, deliberate: true });
    await as(ids.ana).mutation(api.calls.invite, { room_key: room, to_user: ids.cy });
    const invite = await t.run(async (ctx) => (await ctx.db.query("call_invites").collect()).find((i) => String(i.to_user) === String(ids.cy)));
    await as(ids.cy).mutation(api.calls.respondInvite, { invite_id: invite!._id, accept: true });
    await as(ids.cy).mutation(api.calls.joinRoom, { room_key: room, deliberate: true });
    await t.run(async (ctx) => ctx.db.patch(ids.shared, { is_private: true, team_visibility: "private" } as any));
    await expect(as(ids.ben).mutation(api.calls.invite, { room_key: room, to_user: dee })).rejects.toThrow("Cannot invite");
    await as(ids.cy).mutation(api.calls.invite, { room_key: room, to_user: dee });
  });

  test("a room of one keeps billing the team its seats sit in when its owner switches workspace", async () => {
    const w = await world();
    const { t, as, ids } = w;
    const room = dmRoomKey(ids.ana);
    await as(ids.ana).mutation(api.calls.joinRoom, { room_key: room, deliberate: true });
    await t.run(async (ctx) => {
      const other = await ctx.db.insert("teams", { name: "Other", features: { calls: true } } as any);
      await ctx.db.insert("team_memberships", { user_id: ids.ana, team_id: other, role: "member", joined_at: 1 } as any);
      await ctx.db.patch(ids.ana, { active_team_id: other });
    });
    const auth = await t.run(async (ctx) => authorizeRoom(ctx, ids.ana, room));
    expect(auth.ok && String(auth.teamId)).toBe(String(ids.team));
  });

  test("unlocking does not open an owner-only room", async () => {
    const w = await world();
    const { as, ids } = w;
    for (const room of [dmRoomKey(ids.ana), sessionRoomKey(ids.routed)]) {
      await startHuddle(w, room);
      await as(ids.ana).mutation(api.calls.setRoomLocked, { room_key: room, locked: true });
      await as(ids.ana).mutation(api.calls.setRoomLocked, { room_key: room, locked: false });
      await expect(as(ids.ben).mutation(api.calls.joinRoom, { room_key: room, deliberate: true })).rejects.toThrow("Cannot join room");
      expect((await as(ids.ben).query(api.calls.getLiveRooms, {})).map((r: any) => r.room_key)).not.toContain(room);
    }
  });
});

describe("a scribe handover in an owner-only session huddle", () => {
  /** Ana's phone holds the huddle on her private session; Cy is rung in at a
   *  desktop; the phone hands the seat back and Cy's start takes the run. */
  async function handover(w: World) {
    const { t, as, ids } = w;
    const room = sessionRoomKey(ids.routed);
    const transcriptId = await startHuddle(w, room);
    await as(ids.ana).mutation(api.calls.invite, { room_key: room, to_user: ids.cy });
    const invite = await t.run(async (ctx) => (await ctx.db.query("call_invites").collect()).find((i) => String(i.to_user) === String(ids.cy)));
    await as(ids.cy).mutation(api.calls.respondInvite, { invite_id: invite!._id, accept: true });
    await as(ids.cy).mutation(api.calls.joinRoom, { room_key: room, deliberate: true });
    expect(await as(ids.ana).mutation(api.transcripts.releaseScribe, { room_key: room })).toEqual({ released: true });
    expect((await as(ids.cy).mutation(api.transcripts.start, { room_key: room, auto: true })).role).toBe("scribe");
    await t.run(async (ctx) => ctx.db.patch(transcriptId, { status: "ended", ended_at: Date.now(), summary_status: "pending" }));
    return { room, transcriptId };
  }

  test("the summary reaches the session as its owner, not as the guest who scribed last", async () => {
    const w = await world();
    const { transcriptId } = await handover(w);
    await w.t.mutation(internal.transcripts.setSummary, { transcript_id: transcriptId, summary_status: "done", summary: "We decided things." });
    const sends = await w.t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((f: any) => f.name.includes("deliverToSession") && String(f.args[0].body).includes("We decided things.")),
    );
    expect(sends.map((f: any) => [String(f.args[0].as_user), f.args[0].to])).toEqual([[String(w.ids.ana), String(w.ids.routed)]]);
  });

  test("the owner who handed the seat over and never spoke still reads the record", async () => {
    const w = await world();
    const { transcriptId } = await handover(w);
    expect(await w.as(w.ids.ana).query(api.transcripts.webGetCall, { transcript_id: transcriptId })).not.toBeNull();
    expect((await w.as(w.ids.ana).query(api.transcripts.webListCalls, {})).map((c: any) => c._id)).toContain(transcriptId);
    // The team still cannot.
    expect(await w.as(w.ids.ben).query(api.transcripts.webGetCall, { transcript_id: transcriptId })).toBeNull();
  });

  test("a guest who begins the record still feeds the owner's session as its owner", async () => {
    const w = await world();
    const { t, as, ids } = w;
    const room = sessionRoomKey(ids.routed);
    await as(ids.ana).mutation(api.calls.joinRoom, { room_key: room, deliberate: true });
    await as(ids.ana).mutation(api.calls.invite, { room_key: room, to_user: ids.cy });
    const invite = await t.run(async (ctx) => (await ctx.db.query("call_invites").collect()).find((i) => String(i.to_user) === String(ids.cy)));
    await as(ids.cy).mutation(api.calls.respondInvite, { invite_id: invite!._id, accept: true });
    await as(ids.cy).mutation(api.calls.joinRoom, { room_key: room, deliberate: true });
    // Cy's desktop asks first and begins the record.
    const { transcript_id } = await as(ids.cy).mutation(api.transcripts.start, { room_key: room, auto: true });
    const record = await t.run(async (ctx) => ctx.db.get(transcript_id!));
    expect(String(record?.started_by)).toBe(String(ids.cy));
    // deliverRoutes sends a route's live words as its added_by.
    const own = record?.routes.find((r) => r.kind === "session" && r.target === String(ids.routed));
    expect(String(own?.added_by)).toBe(String(ids.ana));
  });

  test("a stranger to the room learns nothing from releaseScribe", async () => {
    const w = await world();
    const { t, as, ids } = w;
    const room = dmRoomKey(ids.ana);
    const transcriptId = await startHuddle(w, room);
    const outsider = await t.run(async (ctx) => ctx.db.insert("users", { name: "Out" } as any));
    expect(await as(outsider).mutation(api.transcripts.releaseScribe, { room_key: room })).toEqual({ released: false });
    expect(await as(outsider).mutation(api.transcripts.releaseScribe, { room_key: dmRoomKey(outsider) })).toEqual({ released: false });
    expect((await t.run(async (ctx) => ctx.db.get(transcriptId)))?.scribe_open).toBeUndefined();
  });
});

test("a teammate's private huddle stays closed to a session owner who makes the session private afterwards", async () => {
  // The finding-2 case, against the own-route door: Ben's private huddle on
  // Ana's team-visible session withheld the session's own route.
  const w = await world();
  const { t, as, ids } = w;
  const room = sessionRoomKey(ids.shared);
  await as(ids.ben).mutation(api.calls.joinRoom, { room_key: room, deliberate: true, private: true });
  const { transcript_id } = await as(ids.ben).mutation(api.transcripts.start, { room_key: room });
  await t.run(async (ctx) => {
    await ctx.db.insert("transcript_segments", { transcript_id: transcript_id!, seq: 1, speaker_id: String(ids.ben), speaker_name: "Ben", text: "mine", t0: 0, t1: 1000 });
    await ctx.db.patch(transcript_id!, { last_seq: 1 });
    await ctx.db.patch(ids.shared, { is_private: true, team_visibility: "private" } as any);
  });
  await endCall(w, transcript_id);
  expect(await as(ids.ana).query(api.transcripts.webGetCall, { transcript_id: transcript_id! })).toBeNull();
  expect((await as(ids.ana).query(api.transcripts.webListCalls, {})).map((c: any) => c._id)).not.toContain(transcript_id);
});
