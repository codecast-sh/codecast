// A screen recording is a message in a session, stored as a recording call:
// whoever can read the session can read it, the team's call sharing never
// reaches it, and it stays out of the call history.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
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
