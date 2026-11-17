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
import { enqueuePendingMessage } from "./pendingMessages";
import { PROCESSING_LEASE_MS, SCREEN_RECORDINGS_PER_HOUR } from "./screenRecordings";

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
        room_key: `rec:${crypto.randomUUID()}`, team_id: team, started_by: owner, status: "ended", started_at: Date.now() - 60_000, transcribe_status: "pending",
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
    expect(one?.screen).toEqual({ width: null, height: null, no_audio: false, conversation_id: String(ids.sharedConv) });
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
      await enqueuePendingMessage(ctx as any, (await ctx.db.get(ids.sharedConv))!, ids.owner, {
        content: `<screen-recording call="${sent.short_id}" id="${sent._id}" duration="0:10">\nA screen recording\n</screen-recording>\n\nfix it`,
      });
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

describe("processing a recording", () => {
  test("a second `uploaded` (a retry, a second client) never transcribes it twice", async () => {
    const { t, ids } = await world();
    const as = t.withIdentity({ subject: `${ids.owner}|session` });
    await as.mutation(api.screenRecordings.uploaded, { transcript_id: ids.inShared });
    await as.mutation(api.screenRecordings.uploaded, { transcript_id: ids.inShared });
    const scheduled = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f: any) => f.name.includes("processUpload")));
    expect(scheduled).toHaveLength(1);
  });
});

describe("sent is a mark, not a search", () => {
  test("queuing the message that carries the tag marks the recording sent, however busy the session gets after", async () => {
    const { t, ids } = await world();
    const sent = await t.run(async (ctx) => {
      const rec = (await ctx.db.get(ids.inShared))!;
      const conv = (await ctx.db.get(ids.sharedConv))!;
      await enqueuePendingMessage(ctx as any, conv, ids.owner, { content: `<screen-recording call="${rec.short_id}" id="${rec._id}" duration="0:10">\nA screen recording\n</screen-recording>\n\nfix it` });
      // A busy session: far more messages after it than any scan would read.
      for (let i = 0; i < 600; i++) {
        await ctx.db.insert("pending_messages", { conversation_id: conv._id, from_user_id: ids.owner, owner_user_id: ids.owner, status: "delivered", created_at: Date.now(), content: `line ${i}` } as any);
      }
      return rec._id;
    });
    expect(await t.run(async (ctx) => (await ctx.db.get(sent))!.screen_recording?.sent_at)).toBeGreaterThan(0);
    expect(await t.mutation(internal.screenRecordings.sweepUnsent, { transcript_id: sent })).toEqual({ removed: false });
  });

  test("a teammate's message naming the recording does not mark it sent", async () => {
    const { t, ids } = await world();
    const rec = await t.run(async (ctx) => {
      const r = (await ctx.db.get(ids.inShared))!;
      const conv = (await ctx.db.get(ids.sharedConv))!;
      await enqueuePendingMessage(ctx as any, conv, ids.mate, { content: `<screen-recording call="${r.short_id}" id="${r._id}" duration="0:10">\nx\n</screen-recording>` });
      return r._id;
    });
    expect(await t.run(async (ctx) => (await ctx.db.get(rec))!.screen_recording?.sent_at ?? null)).toBeNull();
  });
});

describe("rate", () => {
  test("a person can open only so many screen recordings an hour", async () => {
    const { t, ids } = await world();
    await t.run(async (ctx) => {
      for (let i = 0; i < SCREEN_RECORDINGS_PER_HOUR; i++) {
        await ctx.db.insert("transcripts", {
          room_key: `rec:${crypto.randomUUID()}`, team_id: (await ctx.db.get(ids.sharedConv))!.team_id, started_by: ids.owner, status: "ended",
          started_at: Date.now() - 1000, routes: [], last_seq: 0, screen_recording: { r2_key: "k", requested_at: 1, mime: "video/mp4" },
        } as any);
      }
    });
    const as = t.withIdentity({ subject: `${ids.owner}|session` });
    await expect(as.mutation(api.screenRecordings.begin, { conversation_id: String(ids.sharedConv), mime: "video/mp4", size_bytes: 1000 })).rejects.toThrow(/an hour/);
  });
});

describe("begin", () => {
  const env = { R2_ENDPOINT: "https://r2.example", CALL_REC_R2_BUCKET: "recs", CALL_REC_R2_ACCESS_KEY_ID: "id", CALL_REC_R2_SECRET_ACCESS_KEY: "secret" };
  const withEnv = async <T>(fn: () => Promise<T>) => {
    const was = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try { return await fn(); } finally { for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  };

  test("signs the upload for the exact length, and refuses one past the cap", async () => {
    const { t, ids } = await world();
    const as = t.withIdentity({ subject: `${ids.owner}|session` });
    await withEnv(async () => {
      const begun = await as.mutation(api.screenRecordings.begin, { conversation_id: String(ids.sharedConv), mime: "video/quicktime", size_bytes: 219_175 });
      expect(new URL(begun.upload_url).searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;host");
      await expect(as.mutation(api.screenRecordings.begin, { mime: "video/mp4", size_bytes: 3 * 1024 * 1024 * 1024 })).rejects.toThrow(/up to/);
    });
  });

  test("a recording opened without a session is swept too, and a stalled upload is probed", async () => {
    const { t, ids } = await world();
    const as = t.withIdentity({ subject: `${ids.owner}|session` });
    await withEnv(() => as.mutation(api.screenRecordings.begin, { mime: "video/mp4", size_bytes: 1000 }));
    const names = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((f: any) => f.name));
    expect(names.some((n: string) => n.includes("sweepUnsent"))).toBe(true);
    expect(names.some((n: string) => n.includes("probeUpload"))).toBe(true);
  });
});

describe("the processing mark is a lease", () => {
  const scheduledCount = (t: any) => t.run(async (ctx: any) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f: any) => f.name.includes("processUpload")).length);
  const setMark = (t: any, id: any, patch: Record<string, unknown>) => t.run(async (ctx: any) => {
    const r = (await ctx.db.get(id))!;
    await ctx.db.patch(id, { ...patch, screen_recording: { ...r.screen_recording, ...(patch.screen_recording as object) } });
  });

  test("a job that died without a result is run again once its lease is old; a live or finished one is not", async () => {
    const { t, ids } = await world();
    const as = t.withIdentity({ subject: `${ids.owner}|session` });
    // Taken a minute ago, no result: the job may still be running.
    await setMark(t, ids.inShared, { transcribe_status: "pending", screen_recording: { processing_at: Date.now() - 60_000 } });
    await as.mutation(api.screenRecordings.uploaded, { transcript_id: ids.inShared });
    expect(await scheduledCount(t)).toBe(0);
    // Taken long ago, still no result (its file row may even be written): it died.
    await setMark(t, ids.inShared, { video_runs: 1, screen_recording: { processing_at: Date.now() - PROCESSING_LEASE_MS - 1000 } });
    await as.mutation(api.screenRecordings.uploaded, { transcript_id: ids.inShared });
    expect(await scheduledCount(t)).toBe(1);
    // Finished: never again, however old the mark.
    await setMark(t, ids.inPrivate, { transcribe_status: "done", screen_recording: { processing_at: Date.now() - PROCESSING_LEASE_MS - 1000 } });
    await as.mutation(api.screenRecordings.uploaded, { transcript_id: ids.inPrivate });
    expect(await scheduledCount(t)).toBe(1);
  });
});

test("a retried job starts from no words, so a dead job's lines are not doubled", async () => {
  const { t, ids } = await world();
  await t.run(async (ctx) => {
    await ctx.db.insert("transcript_segments", { transcript_id: ids.inShared, seq: 1, speaker_id: "mic", speaker_name: "Speaker", text: "half written", t0: 0, t1: 900 } as any);
    await ctx.db.patch(ids.inShared, { last_seq: 1 });
  });
  await t.mutation(internal.screenRecordings.clearWords, { transcript_id: ids.inShared });
  await t.run(async (ctx) => {
    expect((await ctx.db.query("transcript_segments").collect()).filter((s: any) => String(s.transcript_id) === String(ids.inShared))).toHaveLength(0);
    expect((await ctx.db.get(ids.inShared))!.last_seq).toBe(0);
  });
});
