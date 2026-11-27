// One Scribe per call: inviteScribe claims the call's slot atomically, only
// the claimer seats the agent (addRoute with role "scribe"), a claim whose
// agent never lands stops holding the slot, and anyone in the call may show
// Scribe out.
import { afterEach, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { dmRoomKey, HUDDLE_REBRIEF_EVERY, HUDDLE_REPLY_NOTE, HUDDLE_WORK_NOTE, SCRIBE_CLAIM_TTL_MS, SCRIBE_REMINDER, scribeStatus } from "@codecast/shared/contracts";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { internal } from "./_generated/api";

setDefaultTimeout(60_000);

const api = anyApi as any;

const backends: any[] = [];
afterEach(async () => {
  setSystemTime();
  for (const t of backends.splice(0)) await t.finishAllScheduledFunctions?.(() => {}).catch?.(() => {});
});

async function seed() {
  const t = convexTest(schema, allModules);
  backends.push(t);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "T", created_at: now, invite_code: "x", features: { calls: true } } as any);
    const other = await ctx.db.insert("teams", { name: "O", created_at: now, invite_code: "y", features: { calls: true } } as any);
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
    const ben = await ctx.db.insert("users", { name: "Ben" } as any);
    const cat = await ctx.db.insert("users", { name: "Cat" } as any);
    for (const u of [ana, ben]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: now } as any);
    await ctx.db.insert("team_memberships", { user_id: cat, team_id: other, role: "member", joined_at: now } as any);
    const room = dmRoomKey(String(ana), String(ben));
    for (const [u, name] of [[ana, "Ana"], [ben, "Ben"]] as const) {
      await ctx.db.insert("call_members", { room_key: room, team_id: team, user_id: u, user_name: name, joined_at: now, last_seen: now, muted: false, camera: false, sharing: false } as any);
    }
    const call = await ctx.db.insert("transcripts", {
      room_key: room, team_id: team, started_by: ana, status: "live", started_at: now, routes: [], last_seq: 0, short_id: "cl-9",
    } as any);
    const session = (user_id: any, sid: string) =>
      ctx.db.insert("conversations", {
        user_id, team_id: team, is_private: false, git_root: "/repo", agent_type: "claude_code", session_id: sid,
        started_at: now, updated_at: now, message_count: 0, status: "active",
      } as any);
    return { team, ana, ben, cat, room, call, anaAgent: await session(ana, "scribe-ana"), benAgent: await session(ben, "scribe-ben") };
  });
  const as = (u: string) => t.withIdentity({ subject: `${u}|test` });
  const call = () => t.run(async (ctx: any) => await ctx.db.get(ids.call));
  const feeds = () => t.run(async (ctx: any) => await ctx.db.query("call_agent_feeds").collect());
  const seat = (u: string, conversation: string, claim: number) =>
    as(u).mutation(api.transcripts.addRoute, {
      transcript_id: ids.call, kind: "session", target: conversation, mode: "live", face: false, role: "scribe", claim,
    });
  return { t, ...ids, as, call, feeds, seat };
}

test("two people inviting at once yield one claim and one Scribe", async () => {
  const { ana, ben, room, anaAgent, as, call, feeds, seat } = await seed();
  const answers = await Promise.all([
    as(String(ana)).mutation(api.transcripts.inviteScribe, { room_key: room }),
    as(String(ben)).mutation(api.transcripts.inviteScribe, { room_key: room }),
  ]);
  const won = answers.filter((a: any) => a.claimed);
  expect(won).toHaveLength(1);
  expect(answers.find((a: any) => !a.claimed)).toEqual({ claimed: false, existing: "joining" });

  const winner = answers[0].claimed ? ana : ben;
  await seat(String(winner), String(anaAgent), won[0].claim_id);
  const after = await call();
  expect(after.scribe_claim).toBeUndefined();
  expect(after.routes).toEqual([
    expect.objectContaining({ kind: "session", target: String(anaAgent), mode: "live", face: false, role: "scribe" }),
  ]);
  const rows = await feeds();
  expect(rows).toHaveLength(1);
  expect(rows[0].face).toBe(false);

  // A third invite finds Scribe listening and claims nothing.
  expect(await as(String(ana)).mutation(api.transcripts.inviteScribe, { room_key: room })).toEqual({ claimed: false, existing: "listening" });
  const live = await as(String(ben)).query(api.transcripts.getLive, { room_key: room });
  expect(live.routes[0].role).toBe("scribe");
  expect(live.scribe_claim).toBeNull();
});

test("only the claim's holder seats Scribe", async () => {
  const { ana, ben, room, benAgent, as, seat, call } = await seed();
  const claim = await as(String(ana)).mutation(api.transcripts.inviteScribe, { room_key: room });
  await expect(seat(String(ben), String(benAgent), claim.claim_id)).rejects.toThrow(/no longer holds/);
  await expect(seat(String(ana), String(benAgent), claim.claim_id + 1)).rejects.toThrow(/no longer holds/);
  expect((await call()).routes).toEqual([]);
});

test("a claim whose agent never landed expires, and a later invite takes the slot", async () => {
  const { ana, ben, room, anaAgent, benAgent, as, seat, call } = await seed();
  const start = Date.now();
  const first = await as(String(ana)).mutation(api.transcripts.inviteScribe, { room_key: room });
  setSystemTime(start + SCRIBE_CLAIM_TTL_MS - 1);
  expect(await as(String(ben)).mutation(api.transcripts.inviteScribe, { room_key: room })).toEqual({ claimed: false, existing: "joining" });

  setSystemTime(start + SCRIBE_CLAIM_TTL_MS + 1);
  const second = await as(String(ben)).mutation(api.transcripts.inviteScribe, { room_key: room });
  expect(second.claimed).toBe(true);
  // The first inviter's agent landing late cannot take the slot back.
  await expect(seat(String(ana), String(anaAgent), first.claim_id)).rejects.toThrow(/no longer holds/);
  await seat(String(ben), String(benAgent), second.claim_id);
  expect((await call()).routes.map((r: any) => r.target)).toEqual([String(benAgent)]);
});

test("giving back a failed claim frees the slot without touching someone else's", async () => {
  const { ana, ben, room, as, call } = await seed();
  const start = Date.now();
  const mine = await as(String(ana)).mutation(api.transcripts.inviteScribe, { room_key: room });
  await as(String(ana)).mutation(api.transcripts.removeScribe, { room_key: room, claim: mine.claim_id });
  expect((await call()).scribe_claim).toBeUndefined();

  const bens = await as(String(ben)).mutation(api.transcripts.inviteScribe, { room_key: room });
  setSystemTime(start + 5);
  await as(String(ana)).mutation(api.transcripts.removeScribe, { room_key: room, claim: mine.claim_id });
  expect((await call()).scribe_claim?.at).toBe(bens.claim_id);
});

test("anyone in the call removes Scribe: its route and feed go, and the removal is on record", async () => {
  const { ana, ben, room, anaAgent, as, seat, call, feeds } = await seed();
  const claim = await as(String(ana)).mutation(api.transcripts.inviteScribe, { room_key: room });
  await seat(String(ana), String(anaAgent), claim.claim_id);
  expect(await feeds()).toHaveLength(1);

  await as(String(ben)).mutation(api.transcripts.removeScribe, { room_key: room });
  const after = await call();
  expect(after.routes).toEqual([]);
  expect(after.scribe_claim).toEqual({ by: ben, at: expect.any(Number), removed: true });
  expect(await feeds()).toEqual([]);
  // Every client reads it as gone, and the removal as such.
  const live = await as(String(ana)).query(api.transcripts.getLive, { room_key: room });
  expect(live.scribe_claim).toEqual({ by: String(ben), at: after.scribe_claim.at, removed: true });
  expect(scribeStatus(live, Date.now())).toBe("absent");
});

test("after a removal, automatic invites are refused for the call; a person's invite brings Scribe back", async () => {
  const { ana, ben, room, anaAgent, benAgent, as, seat, call } = await seed();
  const first = await as(String(ana)).mutation(api.transcripts.inviteScribe, { room_key: room, auto: true });
  expect(first.claimed).toBe(true);
  await seat(String(ana), String(anaAgent), first.claim_id);
  await as(String(ben)).mutation(api.transcripts.removeScribe, { room_key: room });

  // Ana reloads, or Ben joins late with the setting on: both refused.
  expect(await as(String(ana)).mutation(api.transcripts.inviteScribe, { room_key: room, auto: true })).toEqual({ claimed: false, existing: "removed" });
  expect(await as(String(ben)).mutation(api.transcripts.inviteScribe, { room_key: room, auto: true })).toEqual({ claimed: false, existing: "removed" });
  // Even past the claim's lifetime.
  setSystemTime(Date.now() + SCRIBE_CLAIM_TTL_MS + 1000);
  expect((await as(String(ana)).mutation(api.transcripts.inviteScribe, { room_key: room, auto: true })).claimed).toBe(false);
  // The old claim's agent cannot sit in the removed slot.
  await expect(seat(String(ana), String(anaAgent), first.claim_id)).rejects.toThrow(/no longer holds/);

  // A press: the removal clears and Scribe joins.
  const manual = await as(String(ben)).mutation(api.transcripts.inviteScribe, { room_key: room });
  expect(manual.claimed).toBe(true);
  expect((await call()).scribe_claim).toEqual({ by: ben, at: manual.claim_id });
  await seat(String(ben), String(benAgent), manual.claim_id);
  expect((await call()).routes).toEqual([expect.objectContaining({ target: String(benAgent), role: "scribe" })]);
});

test("an automatic invite with nobody having removed Scribe claims as usual", async () => {
  const { ana, room, as } = await seed();
  expect((await as(String(ana)).mutation(api.transcripts.inviteScribe, { room_key: room, auto: true })).claimed).toBe(true);
});

test("someone outside the call can neither invite nor remove Scribe", async () => {
  const { ana, cat, room, as, call } = await seed();
  await expect(as(String(cat)).mutation(api.transcripts.inviteScribe, { room_key: room })).rejects.toThrow(/Not in this huddle/);
  await as(String(ana)).mutation(api.transcripts.inviteScribe, { room_key: room });
  await expect(as(String(cat)).mutation(api.transcripts.removeScribe, { room_key: room })).rejects.toThrow(/Not in this huddle/);
  expect((await call()).scribe_claim).toBeDefined();
});

test("Scribe's chunks carry its own header, on the first chunk and on a rebrief", async () => {
  const { t, ana, room, anaAgent, as, seat, call } = await seed();
  const claim = await as(String(ana)).mutation(api.transcripts.inviteScribe, { room_key: room });
  await seat(String(ana), String(anaAgent), claim.claim_id);
  const call0 = (await call())._id;
  const say = (seq: number) =>
    t.run(async (ctx: any) => {
      await ctx.db.insert("transcript_segments", { transcript_id: call0, seq, speaker_id: String(ana), speaker_name: "Ana", text: `point ${seq}`, t0: seq, t1: seq + 1 } as any);
      await ctx.db.patch(call0, { last_seq: seq });
    });
  const deliver = () => t.action(internal.transcripts.deliverRoutes, { transcript_id: call0, include_after_routes: true });
  const lastBody = async () =>
    t.run(async (ctx: any) => {
      const rows = await ctx.db.query("pending_messages").collect();
      return rows.filter((r: any) => String(r.conversation_id) === String(anaAgent)).at(-1)?.content as string;
    });
  const scribeOnly = (body: string) => {
    expect(body).toContain("Huddle transcript (live).");
    expect(body).toContain(SCRIBE_REMINDER);
    expect(body).not.toContain(HUDDLE_WORK_NOTE);
    expect(body).not.toContain(HUDDLE_REPLY_NOTE);
    expect(body).not.toContain("cast publish");
  };

  await say(1);
  await deliver();
  scribeOnly(await lastBody());

  // The chunk a rebrief falls on.
  await t.run(async (ctx: any) => {
    const c = await ctx.db.get(call0);
    await ctx.db.patch(call0, { routes: c.routes.map((r: any) => ({ ...r, briefed_chunks: HUDDLE_REBRIEF_EVERY })) });
  });
  await say(2);
  await deliver();
  const rebrief = await lastBody();
  expect(rebrief).toContain("point 2");
  scribeOnly(rebrief);
});

test("Scribe never gets a face", async () => {
  const { ana, room, anaAgent, as, call, feeds } = await seed();
  const claim = await as(String(ana)).mutation(api.transcripts.inviteScribe, { room_key: room });
  // Seated without the face flag: still faceless.
  await as(String(ana)).mutation(api.transcripts.addRoute, {
    transcript_id: (await call())._id, kind: "session", target: String(anaAgent), mode: "live", role: "scribe", claim: claim.claim_id,
  });
  expect((await feeds())[0].face).toBe(false);
  await expect(
    as(String(ana)).mutation(api.transcripts.setAgentFace, { transcript_id: (await call())._id, target: String(anaAgent), face: true }),
  ).rejects.toThrow(/Scribe has no face/);
  expect((await feeds())[0].face).toBe(false);
});
