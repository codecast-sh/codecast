// A person's voice, for naming them in voice notes
// (docs/architecture/speaker-attribution.md, "Enrollment and consent").
//
// Consent comes first: `users.voice_id_enabled` is off until the person turns
// it on, and with it off nothing about their voice is stored and they are
// never a match candidate. Turning it off, or Delete, removes every sample.
// A sample is readable by its owner alone, and then only as a count and a
// date (myVoiceprint): vectors are read server-side as match candidates
// (candidatesForTeam) and never leave the server.
//
// Samples are CAM++ embeddings from our speech worker (engine C,
// lib/voiceMatch VOICE_ENGINE): enrollFromSpeaker cuts a voice's clean
// stretches out of a recording and embeds them.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { forgetVoice } from "./lib/voiceForget";
import { budgetWindows, centroid, cleanWindows, cosine, ENROLL_SECONDS, MATCH_THRESHOLD, VOICE_ENGINE } from "./lib/voiceMatch";
import { embedWindows } from "./lib/speechWorker";

/** Samples kept per person and engine; the oldest go first past this. */
export const MAX_SAMPLES_PER_ENGINE = 50;

const sourceValidator = v.object({
  transcript_id: v.id("transcripts"),
  key: v.string(),
  kind: v.union(v.literal("assigned"), v.literal("self")),
});

async function requireUser(ctx: any): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  return userId;
}

/** Recordings read per scrub pass. */
const SCRUB_PAGE = 100;

/** The Settings switch. Off forgets the person's voice (lib/voiceForget):
 *  every sample, an engine's copy, and every suggestion naming them. */
export const setVoiceIdEnabled = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await ctx.db.patch(userId, { voice_id_enabled: args.enabled });
    if (!args.enabled) await forgetVoice(ctx, userId);
  },
});

/** What Settings shows about the caller's own samples: how many, how many
 *  seconds of speech, and when the last was added. Never the samples
 *  themselves. The switch is users.voice_id_enabled, read off currentUser. */
export const myVoiceprint = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const rows = await ctx.db
      .query("voiceprints")
      .withIndex("by_user", (q) => q.eq("user_id", userId))
      .collect();
    return {
      count: rows.length,
      seconds: rows.reduce((sum, r) => sum + r.seconds, 0),
      last_added_at: rows.reduce<number | null>((max, r) => (max === null || r.created_at > max ? r.created_at : max), null),
    };
  },
});

/** Delete every sample of the caller's voice, and with them what was
 *  learned from them (lib/voiceForget). The switch stays as it is. */
export const deleteMyVoiceprints = mutation({
  args: {},
  handler: async (ctx) => ({ deleted: await forgetVoice(ctx, await requireUser(ctx)) }),
});

/**
 * Drop every voice-match suggestion naming `user_id` from the recordings of
 * `team_ids`, one page at a time: the voice goes back to unknown
 * (`Speaker N`). A person's word (source "person") stays: it is what a
 * person said, not something learned from the voice.
 */
export const scrubVoiceSuggestions = internalMutation({
  args: { user_id: v.id("users"), team_ids: v.array(v.id("teams")), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const [team, ...rest] = args.team_ids;
    if (!team) return;
    const page = await ctx.db
      .query("transcripts")
      .withIndex("by_team_started", (q) => q.eq("team_id", team))
      .paginate({ cursor: args.cursor, numItems: SCRUB_PAGE });
    for (const t of page.page) {
      if (!t.speakers?.some((s) => s.source === "voice" && s.user_id === args.user_id)) continue;
      await ctx.db.patch(t._id, {
        speakers: t.speakers.map((s) => (s.source === "voice" && s.user_id === args.user_id ? { key: s.key, source: "voice" as const } : s)),
      });
    }
    const next = page.isDone ? { team_ids: rest, cursor: null } : { team_ids: args.team_ids, cursor: page.continueCursor };
    if (next.team_ids.length) await ctx.scheduler.runAfter(0, internal.voiceprints.scrubVoiceSuggestions, { user_id: args.user_id, ...next });
  },
});

/**
 * Delete the copies of a person's voice an engine holds on its side (the
 * `ref` handles of deleted rows). A requirement on any engine that keeps
 * voiceprints itself (engine B, pyannoteAI identify, would): it must offer
 * a delete API, and this calls it, or the engine stores no voiceprint of its
 * own and gets the vectors with each request instead.
 *
 * Engine C keeps no voiceprint of its own (our worker returns vectors and
 * stores nothing), so its rows carry no `ref` and this has nothing to do for
 * them. TODO(pl-1081): when an engine that stores voiceprints is adopted,
 * call its delete for each ref here, retrying until the vendor confirms.
 */
export const forgetEngineRefs = internalAction({
  args: { engine: v.string(), refs: v.array(v.string()) },
  handler: async (): Promise<void> => {},
});

/** The match candidates for a recording on `team_id`: its members who turned
 *  recognition on and have samples of `engine`, each as the centroid of
 *  their vectors (what the matcher compares; a big team's raw samples would
 *  not fit a query result). Server-side only; this is the one read of the
 *  vectors. */
export const candidatesForTeam = internalQuery({
  args: { team_id: v.id("teams"), engine: v.string() },
  handler: async (ctx, args): Promise<Array<{ user_id: Id<"users">; name: string | null; centroid: number[]; samples: number }>> => {
    const members = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id))
      .collect();
    const out: Array<{ user_id: Id<"users">; name: string | null; centroid: number[]; samples: number }> = [];
    const seen = new Set<string>();
    for (const m of members) {
      if (seen.has(String(m.user_id))) continue;
      seen.add(String(m.user_id));
      const user = await ctx.db.get(m.user_id);
      if (!user?.voice_id_enabled) continue;
      const vectors = (
        await ctx.db
          .query("voiceprints")
          .withIndex("by_user_engine", (q) => q.eq("user_id", m.user_id).eq("engine", args.engine))
          .collect()
      ).flatMap((r) => (r.vector?.length ? [r.vector] : []));
      if (!vectors.length) continue;
      out.push({ user_id: m.user_id, name: user.name ?? null, centroid: centroid(vectors), samples: vectors.length });
    }
    return out;
  },
});
/** Store samples of one person's voice. Consent is checked here, at the
 *  write, so a sample computed while it was on and landing after it went off
 *  is dropped. `match_required` (a sample from someone else's assignment)
 *  is a confirmation, never a first sample: dropped when the person has no
 *  samples of this engine yet. Keeps the newest MAX_SAMPLES_PER_ENGINE per
 *  engine. */
export const addSamples = internalMutation({
  args: {
    user_id: v.id("users"),
    engine: v.string(),
    match_required: v.optional(v.boolean()),
    samples: v.array(
      v.object({
        vector: v.optional(v.array(v.float64())),
        ref: v.optional(v.string()),
        seconds: v.number(),
        source: sourceValidator,
      }),
    ),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.user_id);
    if (!user?.voice_id_enabled) return { added: 0 };
    if (args.match_required) {
      const existing = await ctx.db
        .query("voiceprints")
        .withIndex("by_user_engine", (q) => q.eq("user_id", args.user_id).eq("engine", args.engine))
        .first();
      if (!existing) return { added: 0 };
    }
    const now = Date.now();
    let added = 0;
    for (const s of args.samples) {
      if (!s.vector && !s.ref) continue;
      await ctx.db.insert("voiceprints", { user_id: args.user_id, engine: args.engine, ...s, created_at: now });
      added++;
    }
    const rows = await ctx.db
      .query("voiceprints")
      .withIndex("by_user_engine", (q) => q.eq("user_id", args.user_id).eq("engine", args.engine))
      .collect();
    const extra = rows.length - MAX_SAMPLES_PER_ENGINE;
    if (extra > 0) {
      for (const r of [...rows].sort((a, b) => a.created_at - b.created_at).slice(0, extra)) await ctx.db.delete(r._id);
    }
    return { added };
  },
});

/**
 * Learn a voice: voice `key` of a voice note is `user_id`, who has
 * recognition on. Scheduled by transcripts.assignSpeaker / confirmSpeaker
 * ("assigned") and by the batch pass for the owner's solo dictation ("self").
 *
 * Consent: a first sample comes only from the person themselves (naming
 * their own voice, or their solo dictation). Someone else's assignment comes
 * with `match_required`: it adds a sample only when the voice scores at or
 * above the match threshold against the person's existing voiceprint (a
 * confirmation), and addSamples refuses it as a first sample.
 *
 * The voice's clean windows come from the recording's own lines on `key`
 * (60 s at most, longest first), embedded by the worker. A confirmation
 * (`match_required`) stands only when their centroid scores at least the
 * match threshold (0.40) against the person's existing centroid. Nothing is
 * stored when the worker does not answer or answers in another space.
 */
export const enrollFromSpeaker = internalAction({
  args: {
    transcript_id: v.id("transcripts"),
    key: v.string(),
    user_id: v.id("users"),
    kind: v.union(v.literal("assigned"), v.literal("self")),
    match_required: v.boolean(),
  },
  handler: async (ctx, args): Promise<void> => {
    const at: EnrollmentInput | null = await ctx.runQuery(internal.voiceprints.forEnrollment, {
      transcript_id: args.transcript_id,
      user_id: args.user_id,
    });
    if (!at?.audio_url || !at.enabled) return;
    const windows = budgetWindows(cleanWindows(at.turns).get(args.key) ?? [], ENROLL_SECONDS);
    if (!windows.length) return;
    const embedded = await embedWindows(at.audio_url, [{ key: args.key, windows }]);
    if (!embedded || embedded.model !== VOICE_ENGINE) return;
    const samples = windows.flatMap((w, i) => {
      const vector = embedded.vectors[args.key]?.[i];
      return Array.isArray(vector) && vector.length ? [{ vector, seconds: w[1] - w[0] }] : [];
    });
    if (!samples.length) return;
    if (args.match_required) {
      if (!at.existing.length) return;
      if (cosine(centroid(samples.map((s) => s.vector)), centroid(at.existing)) < MATCH_THRESHOLD) return;
    }
    const source = { transcript_id: args.transcript_id, key: args.key, kind: args.kind };
    await ctx.runMutation(internal.voiceprints.addSamples, {
      user_id: args.user_id,
      engine: VOICE_ENGINE,
      match_required: args.match_required,
      samples: samples.map((s) => ({ ...s, source })),
    });
  },
});

type EnrollmentInput = {
  audio_url: string | null;
  enabled: boolean;
  turns: Array<{ key: string; start: number; end: number }>;
  existing: number[][];
};

/** What enrollment reads: the recording's audio, its lines as speaker turns
 *  (seconds), whether the person still has recognition on, and their
 *  existing samples of the engine. */
export const forEnrollment = internalQuery({
  args: { transcript_id: v.id("transcripts"), user_id: v.id("users") },
  handler: async (ctx, args): Promise<EnrollmentInput | null> => {
    const t = await ctx.db.get(args.transcript_id);
    if (!t?.recording_storage_id) return null;
    const user = await ctx.db.get(args.user_id);
    const segs = await ctx.db
      .query("transcript_segments")
      .withIndex("by_transcript_seq", (q) => q.eq("transcript_id", t._id))
      .collect();
    const rows = await ctx.db
      .query("voiceprints")
      .withIndex("by_user_engine", (q) => q.eq("user_id", args.user_id).eq("engine", VOICE_ENGINE))
      .collect();
    return {
      audio_url: await ctx.storage.getUrl(t.recording_storage_id),
      enabled: user?.voice_id_enabled === true,
      turns: segs.map((s) => ({ key: s.speaker_id, start: s.t0 / 1000, end: s.t1 / 1000 })),
      existing: rows.flatMap((r) => (r.vector?.length ? [r.vector] : [])),
    };
  },
});

