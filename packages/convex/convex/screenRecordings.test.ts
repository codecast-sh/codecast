// A screen recording is a message in a session, stored as a recording call:
// whoever can read the session can read it, the team's call sharing never
// reaches it, and it stays out of the call history.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { canReadRoomlessCall } from "./callRooms";
import { canAccessConversation } from "./lib/access";

async function world() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Ann", email: "ann@x.dev" } as any);
    const mate = await ctx.db.insert("users", { name: "Bob", email: "bob@x.dev" } as any);
    const team = await ctx.db.insert("teams", { name: "T", invite_code: "TEAM1234", created_at: 1, features: { calls: true } } as any);
    await ctx.db.insert("team_memberships", { user_id: owner, team_id: team, role: "admin", joined_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: mate, team_id: team, role: "member", joined_at: 1 } as any);
    const conv = (is_private: boolean, short: string) =>
      ctx.db.insert("conversations", {
        user_id: owner, agent_type: "claude_code", session_id: crypto.randomUUID(), started_at: 1, updated_at: 1,
        message_count: 0, is_private, status: "active", team_id: team, short_id: short,
      } as any);
    const privateConv = await conv(true, "jx7priv");
    const sharedConv = await conv(false, "jx7shar");
    const rec = (conversation_id: Id<"conversations">, extra: Record<string, unknown> = {}) =>
      ctx.db.insert("transcripts", {
        room_key: `rec:${crypto.randomUUID()}`, team_id: team, started_by: owner, status: "ended", started_at: Date.now() - 60_000,
        ended_at: Date.now() - 50_000, routes: [], last_seq: 0, short_id: `cl-${Math.floor(Math.random() * 1e6)}`,
        screen_recording: { conversation_id, r2_key: "calls/x/1-screen.mp4", requested_at: 1, mime: "video/mp4" },
        ...extra,
      } as any);
    return {
      owner, mate, privateConv, sharedConv,
      inPrivate: await rec(privateConv, { rec_shared: true }),
      inShared: await rec(sharedConv),
    };
  });
  return { t, ids };
}

describe("screen recording access", () => {
  test("follows the session it was sent to, never the team's call sharing", async () => {
    const { t, ids } = await world();
    await t.run(async (ctx) => {
      for (const [recId, convId] of [[ids.inPrivate, ids.privateConv], [ids.inShared, ids.sharedConv]] as const) {
        const rec = (await ctx.db.get(recId))!;
        const conv = (await ctx.db.get(convId))!;
        expect(await canReadRoomlessCall(ctx, ids.owner, rec)).toBe(true);
        // The teammate reads it exactly when they read the session.
        expect(await canReadRoomlessCall(ctx, ids.mate, rec)).toBe(await canAccessConversation(ctx, ids.mate, conv));
      }
      // The team-visible session lets the teammate in; the private one does not.
      expect(await canReadRoomlessCall(ctx, ids.mate, (await ctx.db.get(ids.inShared))!)).toBe(true);
      // rec_shared would open a voice note to the team; a screen recording in a private session stays shut.
      expect(await canReadRoomlessCall(ctx, ids.mate, (await ctx.db.get(ids.inPrivate))!)).toBe(false);
    });
  });

  test("never in the call history, and still opens by its id", async () => {
    const { t, ids } = await world();
    const as = t.withIdentity({ subject: `${ids.owner}|session` });
    const list = await as.query(api.transcripts.webListCalls, { limit: 50 });
    expect(list.map((c: any) => String(c._id))).not.toContain(String(ids.inShared));
    const one = await as.query(api.transcripts.webGetCall, { transcript_id: ids.inShared });
    expect(one?.screen).toEqual({ width: null, height: null, no_audio: false });
  });
});

describe("unsent screen recordings", () => {
  test("the sweep removes one never sent, with its words and file row, and keeps one that was sent", async () => {
    const { t, ids } = await world();
    const { sent, unsent } = await t.run(async (ctx) => {
      const sent = (await ctx.db.get(ids.inShared))!;
      const unsent = (await ctx.db.get(ids.inPrivate))!;
      for (const rec of [sent, unsent]) {
        await ctx.db.insert("transcript_segments", { transcript_id: rec._id, seq: 1, speaker_id: "mic", speaker_name: "Speaker", text: "this button", t0: 0, t1: 900 } as any);
        await ctx.db.insert("call_recordings", { transcript_id: rec._id, room_key: rec.room_key, team_id: rec.team_id, kind: "screen", status: "ready", r2_key: "calls/x/1-screen.mp4", started_by: ids.owner, requested_at: 1, updated_at: 1 } as any);
      }
      await ctx.db.insert("pending_messages", {
        conversation_id: ids.sharedConv, from_user_id: ids.owner, owner_user_id: ids.owner, status: "delivered", created_at: Date.now(),
        content: `<screen-recording call="${sent.short_id}" id="${sent._id}" duration="0:10">\nA screen recording\n</screen-recording>\n\nfix it`,
      } as any);
      return { sent: sent._id, unsent: unsent._id };
    });
    expect(await t.mutation(internal.screenRecordings.sweepUnsent, { transcript_id: sent })).toEqual({ removed: false });
    expect(await t.mutation(internal.screenRecordings.sweepUnsent, { transcript_id: unsent })).toEqual({ removed: true });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(sent)).not.toBeNull();
      expect(await ctx.db.get(unsent)).toBeNull();
      const left = async (table: "transcript_segments" | "call_recordings", id: any) =>
        (await ctx.db.query(table).collect()).filter((r: any) => String(r.transcript_id) === String(id)).length;
      expect(await left("transcript_segments", unsent)).toBe(0);
      expect(await left("call_recordings", unsent)).toBe(0);
      expect(await left("call_recordings", sent)).toBe(1);
    });
  });
});
