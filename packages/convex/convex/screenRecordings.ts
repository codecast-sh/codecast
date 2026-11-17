// A screen recording somebody sends to a session: a video of their screen,
// made while they talked about it, so an agent can see what they meant by
// "this button" instead of reading a bug report about it.
//
// It is a RECORDING CALL (transcripts.ts: a `rec:` key, a short id, a page,
// `cast call`), whose one file is a `call_recordings` row of kind "screen" in
// the private call-recordings bucket. Everything a huddle's screen share has
// therefore applies unchanged: `cast call snap cl-N:3` cuts the frame at a
// line, the call page plays the video beside its transcript, delete and share
// go through the same rules. The only new parts live here:
//
//   begin     the client asks for a place to put the file: the call record is
//             made (ended, since the recording already happened) and a
//             presigned PUT into the bucket comes back.
//   uploaded  the client says the bytes are there. The file is checked, its
//             row written, and its sound transcribed.
//   processUpload  the sound track is copied out of the video without decoding
//             (lib/mp4Audio: a phone video is far over the transcriber's
//             25 MB cap, and Convex has no ffmpeg), read by whisper, and the
//             words written as the recording's segments. finishRecording-
//             Transcript then titles and summarizes it like any recording.
//
// The message that carries it to the agent is an ordinary send whose text
// holds the recording's tag (shared/contracts/screenRecording); the daemon
// expands that tag into timed lines and keyframes when it delivers.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalAction, internalMutation, internalQuery, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { recRoomKey, TRANSCRIBE_MAX_BYTES } from "@codecast/shared/contracts";
import { authorizeRoom } from "./callRooms";
import { verifyApiToken } from "./apiTokens";
import { canAccessConversation } from "./lib/access";
import { beginCallRecord } from "./transcripts";
import { callRecordingCallPrefix, callRecordingGetUrl, callRecordingKey, callRecordingsBucketFromEnv, r2Presign } from "./lib/r2";
import { syncCallVideo, teammateName } from "./lib/callRecordingRuns";
import { extractAudioTrack, Mp4AudioError, urlByteSource } from "./lib/mp4Audio";
import { SEGMENT_WRITE_BATCH, transcribeAudio } from "./lib/recordingTranscription";

/** How long the client has to put the file once it asked: a long recording
 *  on a slow cellular upload. */
const UPLOAD_URL_SECONDS = 60 * 60;

/** The largest file accepted: a long screen recording at a phone's bitrate. */
export const SCREEN_RECORDING_MAX_BYTES = 2 * 1024 * 1024 * 1024;

const VIDEO_TYPES = ["video/mp4", "video/quicktime"];

async function ownScreenRecording(ctx: any, userId: Id<"users">, transcriptId: Id<"transcripts">) {
  const t = await ctx.db.get(transcriptId);
  if (!t || !t.screen_recording || String(t.started_by) !== String(userId)) throw new Error("Screen recording not found");
  return t;
}

const BEGIN_ARGS = {
  // The session it is being sent to: its readers read the recording.
  conversation_id: v.optional(v.string()),
  mime: v.string(),
  duration_ms: v.optional(v.number()),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
};
type BeginArgs = { conversation_id?: string; mime: string; duration_ms?: number; width?: number; height?: number };
type Begun = { transcript_id: Id<"transcripts">; call: string; upload_url: string };

export const begin = mutation({
  args: BEGIN_ARGS,
  handler: async (ctx, args): Promise<Begun> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    return await beginCore(ctx, userId, args);
  },
});

/** The CLI's twin (`cast send --recording`, /cli/screen-recordings/begin). */
export const cliBegin = mutation({
  args: { api_token: v.string(), ...BEGIN_ARGS },
  handler: async (ctx, { api_token, ...args }): Promise<Begun> => {
    const auth = await verifyApiToken(ctx, api_token);
    if (!auth) throw new Error("Unauthorized");
    return await beginCore(ctx, auth.userId, args);
  },
});

async function beginCore(ctx: any, userId: Id<"users">, args: BeginArgs): Promise<Begun> {
  const mime = VIDEO_TYPES.includes(args.mime) ? args.mime : "video/mp4";
  const convId = args.conversation_id ? ctx.db.normalizeId("conversations", args.conversation_id) : null;
  const conv = convId ? await ctx.db.get(convId) : null;
  if (args.conversation_id && (!conv || !(await canAccessConversation(ctx, userId, conv)))) throw new Error("Session not found");
  const bucket = callRecordingsBucketFromEnv();
  if (!bucket) throw new Error("Recording storage is not set up on this server");
  const roomKey = recRoomKey(crypto.randomUUID());
  // `{ rec: true }`: a fresh key nobody has started on belongs to its starter.
  const auth = await authorizeRoom(ctx, userId, roomKey, { rec: true });
  if (!auth.ok) throw new Error(`Cannot record: ${auth.reason}`);
  const id = await beginCallRecord(ctx, { roomKey, teamId: auth.teamId, userId, routes: [], announce: false });
  const t = (await ctx.db.get(id))!;
  const requestedAt = Date.now();
  const r2Key = callRecordingKey({ transcriptId: String(id), kind: "screen", requestedAt });
  // The recording already happened: the record is over the moment it exists.
  await ctx.db.patch(id, {
    status: "ended",
    ended_at: t.started_at + Math.max(0, Math.round(args.duration_ms ?? 0)),
    transcribe_status: "pending",
    summary_status: "pending",
    screen_recording: {
      ...(conv ? { conversation_id: conv._id } : {}),
      r2_key: r2Key,
      requested_at: requestedAt,
      mime,
      ...(args.width ? { width: Math.round(args.width) } : {}),
      ...(args.height ? { height: Math.round(args.height) } : {}),
    },
  });
  const uploadUrl = await r2Presign(bucket, "PUT", r2Key, UPLOAD_URL_SECONDS);
  // A recording picked and never sent is nobody's: it is removed once the
  // person has had a fair while to send it (sweepUnsent).
  if (conv) await ctx.scheduler.runAfter(UNSENT_GRACE_MS, internal.screenRecordings.sweepUnsent, { transcript_id: id });
  return { transcript_id: id, call: t.short_id!, upload_url: uploadUrl };
}

/** How long a picked recording waits to be sent before it is removed: past
 *  any caption somebody is still typing, and past a phone left in a pocket
 *  with the composer open. */
export const UNSENT_GRACE_MS = 6 * 60 * 60_000;

/** Pending messages read back looking for the one that carried it. */
const SENT_SCAN_LIMIT = 500;

/** Was the recording sent: is there a message into its session, written
 *  after the pick, that carries its tag? Every send keeps its pending row
 *  (delivered, injected, failed alike), so the session's own queue answers. */
async function wasSent(ctx: any, t: Doc<"transcripts">): Promise<boolean> {
  const convId = t.screen_recording?.conversation_id;
  if (!convId) return true;
  const needle = `<screen-recording call="${t.short_id}"`;
  let seen = 0;
  for await (const row of ctx.db.query("pending_messages").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", convId)).order("desc")) {
    if (row._creationTime < t.started_at || ++seen > SENT_SCAN_LIMIT) break;
    if (typeof row.content === "string" && row.content.includes(needle)) return true;
  }
  return false;
}

/** Remove a recording entirely: its words, its file row, the record, and
 *  the object in the bucket (on a retrying action of its own). */
async function removeRecording(ctx: any, t: Doc<"transcripts">): Promise<void> {
  const segs = await ctx.db.query("transcript_segments").withIndex("by_transcript_seq", (q: any) => q.eq("transcript_id", t._id)).collect();
  for (const s of segs) await ctx.db.delete(s._id);
  const rows = await ctx.db.query("call_recordings").withIndex("by_transcript", (q: any) => q.eq("transcript_id", t._id)).collect();
  for (const r of rows) await ctx.db.delete(r._id);
  await ctx.db.delete(t._id);
  // The whole call's prefix, now and again after the upload URL has lapsed:
  // a tile removed mid-upload can still land its bytes after this runs.
  const sweep = { keys: [], prefixes: [callRecordingCallPrefix(String(t._id))], attempt: 0 };
  await ctx.scheduler.runAfter(0, internal.callRecordings.deleteObjects, sweep);
  await ctx.scheduler.runAfter(UPLOAD_URL_SECONDS * 1000 + 60_000, internal.callRecordings.deleteObjects, sweep);
}

export const sweepUnsent = internalMutation({
  args: { transcript_id: v.id("transcripts") },
  handler: async (ctx, args): Promise<{ removed: boolean }> => {
    const t = await ctx.db.get(args.transcript_id);
    if (!t?.screen_recording || (await wasSent(ctx, t))) return { removed: false };
    await removeRecording(ctx, t);
    return { removed: true };
  },
});

/** The person took the recording back off the turn before sending it. A
 *  recording that went out stays: it belongs to the conversation now. */
export const discard = mutation({
  args: { transcript_id: v.id("transcripts") },
  handler: async (ctx, args): Promise<{ removed: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const t = await ownScreenRecording(ctx, userId, args.transcript_id);
    if (await wasSent(ctx, t)) return { removed: false };
    await removeRecording(ctx, t);
    return { removed: true };
  },
});

export const uploaded = mutation({
  args: { transcript_id: v.id("transcripts") },
  handler: async (ctx, args): Promise<void> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await uploadedCore(ctx, userId, args.transcript_id);
  },
});

export const cliUploaded = mutation({
  args: { api_token: v.string(), transcript_id: v.id("transcripts") },
  handler: async (ctx, args): Promise<void> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    await uploadedCore(ctx, auth.userId, args.transcript_id);
  },
});

async function uploadedCore(ctx: any, userId: Id<"users">, transcriptId: Id<"transcripts">): Promise<void> {
  const t = await ownScreenRecording(ctx, userId, transcriptId);
  // Once: a second press (a retried upload's echo) finds the work under way.
  if (t.video_runs) return;
  await ctx.scheduler.runAfter(0, internal.screenRecordings.processUpload, { transcript_id: t._id });
}

export const forProcess = internalQuery({
  args: { transcript_id: v.id("transcripts") },
  handler: async (ctx, args) => {
    const t = await ctx.db.get(args.transcript_id);
    if (!t?.screen_recording) return null;
    return {
      r2_key: t.screen_recording.r2_key,
      started_at: t.started_at,
      duration_ms: Math.max(0, (t.ended_at ?? t.started_at) - t.started_at),
    };
  },
});

/** The file is in the bucket: its row, the call's length, and whether it had sound. */
export const markUploaded = internalMutation({
  args: {
    transcript_id: v.id("transcripts"),
    size_bytes: v.number(),
    duration_ms: v.number(),
    no_audio: v.boolean(),
  },
  handler: async (ctx, args) => {
    const t = await ctx.db.get(args.transcript_id);
    if (!t?.screen_recording) return;
    const existing = await ctx.db
      .query("call_recordings")
      .withIndex("by_transcript", (q: any) => q.eq("transcript_id", t._id))
      .first();
    if (!existing) {
      const name = await teammateName(ctx, t.started_by);
      const now = Date.now();
      await ctx.db.insert("call_recordings", {
        transcript_id: t._id,
        room_key: t.room_key,
        team_id: t.team_id,
        kind: "screen",
        status: "ready",
        r2_key: t.screen_recording.r2_key,
        participant_identity: String(t.started_by),
        participant_name: name,
        started_by: t.started_by,
        started_by_name: name,
        requested_at: t.screen_recording.requested_at,
        // The file's time 0 is the call's: every line's offset is its time in the video.
        started_at: t.started_at,
        ended_at: t.started_at + args.duration_ms,
        duration_ms: args.duration_ms,
        size_bytes: args.size_bytes,
        call_short_id: t.short_id,
        call_started_at: t.started_at,
        updated_at: now,
      });
    }
    await ctx.db.patch(t._id, {
      ended_at: t.started_at + args.duration_ms,
      screen_recording: { ...t.screen_recording, ...(args.no_audio ? { no_audio: true } : {}) },
    });
    await syncCallVideo(ctx, t._id);
  },
});

/** The object's size, from a one-byte read (a HEAD would need its own signature). */
async function objectSize(url: string): Promise<number | null> {
  const res = await fetch(url, { headers: { Range: "bytes=0-0" } });
  if (res.status === 404 || res.status === 403) return null;
  const total = res.headers.get("content-range")?.match(/\/(\d+)$/)?.[1];
  await res.body?.cancel();
  if (total) return Number(total);
  const len = res.headers.get("content-length");
  return res.status === 200 && len ? Number(len) : null;
}

export const processUpload = internalAction({
  args: { transcript_id: v.id("transcripts") },
  handler: async (ctx, args): Promise<void> => {
    const row: { r2_key: string; started_at: number; duration_ms: number } | null = await ctx.runQuery(
      internal.screenRecordings.forProcess,
      { transcript_id: args.transcript_id },
    );
    if (!row) return;
    let ok = false;
    try {
      const signed = await callRecordingGetUrl(row.r2_key, "fresh");
      if (!signed) throw new Error("recordings bucket not configured");
      const size = await objectSize(signed.url);
      if (!size) throw new Error("the upload never arrived");
      if (size > SCREEN_RECORDING_MAX_BYTES) throw new Error(`file is ${Math.round(size / 1024 / 1024)} MB`);
      let audio: Awaited<ReturnType<typeof extractAudioTrack>> = null;
      let unreadable = false;
      try {
        audio = await extractAudioTrack(urlByteSource(signed.url, size), { maxBytes: TRANSCRIBE_MAX_BYTES });
      } catch (err) {
        // The video still plays and still shows; only the words are lost.
        if (!(err instanceof Mp4AudioError)) throw err;
        console.error("[screenRecordings] no sound read", err.reason, err.message);
        unreadable = true;
      }
      const durationMs = audio?.durationMs || row.duration_ms;
      await ctx.runMutation(internal.screenRecordings.markUploaded, {
        transcript_id: args.transcript_id,
        size_bytes: size,
        duration_ms: durationMs,
        no_audio: !audio && !unreadable,
      });
      if (!audio) return;
      const gate = { ctx, scope: { row: { table: "transcripts" as const, id: args.transcript_id } } };
      const segments = await transcribeAudio(gate, new Blob([audio.bytes as Uint8Array<ArrayBuffer>], { type: "audio/mp4" }), "recording.m4a", durationMs);
      for (let i = 0; i < segments.length; i += SEGMENT_WRITE_BATCH) {
        await ctx.runMutation(internal.transcripts.appendRecordingSegments, {
          transcript_id: args.transcript_id,
          segments: segments.slice(i, i + SEGMENT_WRITE_BATCH),
        });
      }
      ok = segments.length > 0;
    } catch (err) {
      console.error("[screenRecordings] processing failed", String(err).slice(0, 300));
    } finally {
      await ctx.runMutation(internal.transcripts.finishRecordingTranscript, { transcript_id: args.transcript_id, ok });
    }
  },
});
