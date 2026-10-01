// Recording a huddle: the whole call as video on LiveKit's servers, kept in the
// private recordings bucket, on the call's record.
//
// The model, the time rule and the words live in
// shared/contracts/callRecordings.ts; what a run is, and how a row moves, in
// lib/callRecordingRuns.ts. This module is the doors and the loop:
//
//   press      startRecording inserts the run's composite row ("starting") and
//              tells the room in its thread, so every client shows the
//              indicator on this round trip; an action then asks LiveKit for
//              the room composite and a file per screen being shared.
//   loop       reconcileRun polls LiveKit for each file of the run (ListEgress
//              by id) and writes what it says: the file's time 0, its end,
//              length and size, or why it failed. The same look starts a file
//              for a screen share that began mid-run, and stops the run if
//              LiveKit's room has stood empty. It reschedules itself while any
//              file is still being written. LiveKit is the truth; no webhook
//              is needed for any of it.
//   stop       stopRecording (anyone in the room), the room emptying
//              (calls.leaveRoom), or the record ending (transcripts.endTranscript)
//              all go through stopRoomRecording.
//   read       the room's live state (cheap, no clock in it), a call's files
//              with presigned GET URLs minted after canReadCall, the same for
//              the CLI's frame grabs, and the public share page's composite
//              after its token.
//   delete     the presser or the call's owner removes a run: rows at once,
//              objects in the bucket right after.
//
// Recording is never automatic. A press starts it, every client in the room
// is told (the indicator reads isRoomRecording; the thread gets a line), and
// people who join later read the same state.

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { CALL_RECORDING_URL_WINDOW_MS, isRecordingActive } from "@codecast/shared/contracts";
import { verifyApiToken } from "./apiTokens";
import { authorizeRoom, liveSeat } from "./callRooms";
import { liveTranscriptFor, postEvent } from "./callChat";
import { beginCallRecord, canReadCall, resolveCallRef } from "./transcripts";
import { callRecordingKey, callRecordingsBucketFromEnv, r2Presign, r2StableGetUrl, type R2Bucket } from "./lib/r2";
import {
  egressS3Upload,
  getEgress,
  listParticipants,
  livekitConfigFromEnv,
  LivekitApiError,
  roomCompositeEgressRequest,
  startRoomCompositeEgress,
  startTrackCompositeEgress,
  stopEgress,
  trackCompositeEgressRequest,
  type LivekitEgress,
  type LivekitServerConfig,
} from "./lib/livekitServer";
import {
  activeRoomRecordings,
  egressPatch,
  EGRESS_ACCEPT_TIMEOUT_MS,
  liveRoomRun,
  mayDeleteRun,
  nextPollDelayMs,
  peopleInRoom,
  RECORDING_EMPTY_ROOM_STOP_MS,
  RECORDING_MAX_RUN_MS,
  RECORDING_POLL_FAST_MS,
  runIdOf,
  screenEncoding,
  screenSharesToRecord,
  STOP_RETRY_MS,
  stopRoomRecording,
} from "./lib/callRecordingRuns";
import { callRecordingStopReasonValidator } from "./lib/callValidators";

type RecordingRow = Doc<"call_recordings">;

/** Recording needs two things this deployment may lack: LiveKit's server
 *  credentials and the private bucket. Said before a press does anything. */
function recordingConfigured(): boolean {
  return livekitConfigFromEnv() !== null && callRecordingsBucketFromEnv() !== null;
}

async function personName(ctx: any, userId: Id<"users"> | string): Promise<string> {
  const id = ctx.db.normalizeId("users", String(userId));
  const u = id ? await ctx.db.get(id) : null;
  return u?.name ?? u?.email ?? "Someone";
}

// ── Press and stop ────────────────────────────────────────────────────────

/**
 * Start recording the room the caller is sitting in. Idempotent: a room
 * already recording answers with its run, so two people pressing at once make
 * one recording. A huddle with no record yet (transcription switched off, or
 * the press beat every client's auto start) gets one here, the same way the
 * scribe's start makes it, so a call that is only recorded is still a call.
 */
export const startRecording = mutation({
  args: { room_key: v.string() },
  handler: async (ctx, args): Promise<{ recording_id: Id<"call_recordings">; transcript_id: Id<"transcripts">; existing: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const auth = await authorizeRoom(ctx, userId, args.room_key);
    if (!auth.ok) throw new Error(`Cannot record this room: ${auth.reason}`);
    const now = Date.now();
    // A person IN the huddle, deliberately (a prewarm row is not a seat):
    // recording is something the room does to itself, never something done
    // to it from outside.
    if (!(await liveSeat(ctx, userId, args.room_key, now))) throw new Error("Only someone in the huddle can start recording");
    if (!recordingConfigured()) throw new Error("Recording is not set up on this server");

    const running = await liveRoomRun(ctx, args.room_key);
    if (running) return { recording_id: running._id, transcript_id: running.transcript_id, existing: true };

    const record =
      (await liveTranscriptFor(ctx, args.room_key)) ??
      (await ctx.db.get(await beginCallRecord(ctx, { roomKey: args.room_key, teamId: auth.teamId, userId, routes: [], announce: false })))!;
    const id = await ctx.db.insert("call_recordings", {
      transcript_id: record._id,
      room_key: args.room_key,
      team_id: record.team_id,
      kind: "composite",
      status: "starting",
      r2_key: callRecordingKey({ transcriptId: String(record._id), kind: "composite", requestedAt: now }),
      started_by: userId,
      requested_at: now,
      updated_at: now,
    });
    await postEvent(ctx, { room_key: args.room_key, team_id: record.team_id, user_id: userId, event: "record_on" });
    await ctx.scheduler.runAfter(0, internal.callRecordings.startRun, { run_id: id });
    return { recording_id: id, transcript_id: record._id, existing: false };
  },
});

/** Stop the room's recording. Anyone in the huddle may, and so may whoever
 *  pressed Record from wherever they are now (they left the call and want it
 *  off): a recording is everyone's to end. */
export const stopRecording = mutation({
  args: { room_key: v.string() },
  handler: async (ctx, args): Promise<{ stopped: number }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const auth = await authorizeRoom(ctx, userId, args.room_key);
    if (!auth.ok) throw new Error(`Cannot stop this recording: ${auth.reason}`);
    const run = await liveRoomRun(ctx, args.room_key);
    const seated = await liveSeat(ctx, userId, args.room_key, Date.now());
    if (!seated && !(run && String(run.started_by) === String(userId))) {
      throw new Error("Only someone in the huddle can stop recording");
    }
    return await stopRoomRecording(ctx, args.room_key, { reason: "pressed", stoppedBy: String(userId), announceAs: userId });
  },
});

// ── Live state ────────────────────────────────────────────────────────────

/** What the room is told about recording right now, or null when it is not
 *  recording. Nothing in it moves with the clock: it changes when a run
 *  starts, when LiveKit's first frame lands (started_at, once), and when it
 *  stops, so a room full of subscribers is re-pushed three times a run. An
 *  elapsed counter is the client's arithmetic on started_at. */
export async function roomRecordingState(ctx: any, roomKey: string) {
  const run = await liveRoomRun(ctx, roomKey);
  if (run) {
    const call: Doc<"transcripts"> | null = await ctx.db.get(run.transcript_id);
    return {
      status: run.status as "starting" | "recording",
      run_id: run._id,
      transcript_id: run.transcript_id,
      call_short_id: call?.short_id ?? null,
      started_by: { id: String(run.started_by), name: await personName(ctx, run.started_by) },
      requested_at: run.requested_at,
      // The file's time 0: when the room began to be filmed, not the press.
      started_at: run.started_at ?? null,
    };
  }
  // Stopped, and LiveKit is still finishing the file: the room is no longer
  // recorded, and a client may say "saving".
  const finishing = (await activeRoomRecordings(ctx, roomKey)).find((r) => r.kind === "composite" && r.status === "stopping");
  if (!finishing) return null;
  return {
    status: "stopping" as const,
    run_id: finishing._id,
    transcript_id: finishing.transcript_id,
    call_short_id: ((await ctx.db.get(finishing.transcript_id)) as Doc<"transcripts"> | null)?.short_id ?? null,
    started_by: { id: String(finishing.started_by), name: await personName(ctx, finishing.started_by) },
    requested_at: finishing.requested_at,
    started_at: finishing.started_at ?? null,
  };
}

/** The room's recording state for anyone who may be in the room (the open
 *  door and an invite grant included: whoever can hear the room is told it is
 *  recorded). `configured` says whether a press could work at all, so a
 *  client can leave the button out rather than offer one that fails. */
export const getRoomRecording = query({
  args: { room_key: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    if (!(await authorizeRoom(ctx, userId, args.room_key)).ok) return null;
    return { configured: recordingConfigured(), live: await roomRecordingState(ctx, args.room_key) };
  },
});

// ── A call's files ────────────────────────────────────────────────────────

/** One file as a reader sees it. `url` is present only for a finished file:
 *  an MP4 is uploaded whole when it ends, so a file still being written has
 *  nothing in the bucket yet. */
async function shapeRecording(
  ctx: any,
  r: RecordingRow,
  opts: { bucket: R2Bucket | null; now: number; userId: Id<"users"> | null; call: Doc<"transcripts">; runs: Map<string, RecordingRow> },
) {
  const signed = r.status === "ready" && opts.bucket ? await r2StableGetUrl(opts.bucket, r.r2_key, opts.now, CALL_RECORDING_URL_WINDOW_MS) : null;
  const run = opts.runs.get(runIdOf(r)) ?? r;
  return {
    _id: String(r._id),
    run_id: runIdOf(r),
    kind: r.kind,
    status: r.status,
    started_at: r.started_at ?? null,
    ended_at: r.ended_at ?? null,
    duration_ms: r.duration_ms ?? null,
    size_bytes: r.size_bytes ?? null,
    participant_identity: r.participant_identity ?? null,
    participant_name: r.participant_name ?? null,
    started_by: String(r.started_by),
    started_by_name: await personName(ctx, r.started_by),
    requested_at: r.requested_at,
    stop_reason: r.stop_reason ?? null,
    error: r.error ?? null,
    url: signed?.url ?? null,
    url_expires_at: signed?.expiresAt ?? null,
    can_delete: !!opts.userId && !isRecordingActive(run.status) && mayDeleteRun(String(opts.userId), run, opts.call),
  };
}

/** Every file of a call, in the order they were pressed for, with what a
 *  reader needs to align them: the call's own started_at (transcript lines
 *  are ms since it) and each file's time 0 (locateCallMoment does the rest).
 *  The caller has already passed canReadCall. */
export async function callRecordingsCore(ctx: any, call: Doc<"transcripts">, userId: Id<"users"> | null) {
  const rows: RecordingRow[] = await ctx.db
    .query("call_recordings")
    .withIndex("by_transcript", (q: any) => q.eq("transcript_id", call._id))
    .collect();
  const runs = new Map(rows.filter((r) => r.kind === "composite").map((r) => [String(r._id), r]));
  const opts = { bucket: callRecordingsBucketFromEnv(), now: Date.now(), userId, call, runs };
  return {
    transcript_id: String(call._id),
    short_id: call.short_id ?? null,
    call_started_at: call.started_at,
    call_ended_at: call.ended_at ?? null,
    configured: recordingConfigured(),
    recordings: await Promise.all(rows.map((r) => shapeRecording(ctx, r, opts))),
  };
}

/** The call page's recordings. `call` is a short id (`cl-42`) or full id.
 *  `url_window` is callRecordingUrlWindow(now): it is not read, it only makes
 *  a new window a new subscription so URLs are re-signed before they lapse
 *  (a query cannot notice time passing on its own). */
export const webCallRecordings = query({
  args: { call: v.string(), url_window: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const t = await resolveCallRef(ctx, userId, args.call);
    return t ? callRecordingsCore(ctx, t, userId) : null;
  },
});

/** The CLI's twin (`cast call snap`): the same files and URLs, behind an API
 *  token. Null for a call that does not exist or the caller may not read. */
export const cliCallRecordings = query({
  args: { api_token: v.string(), call: v.string(), url_window: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    const t = await resolveCallRef(ctx, auth.userId, args.call);
    return t ? callRecordingsCore(ctx, t, auth.userId) : null;
  },
});

/** The composite video of a publicly shared call, for its share page: only
 *  finished room recordings (never a single person's screen file, never a
 *  name or id), each with its time 0 so the page can follow the transcript.
 *  The caller has already resolved the share token. */
export async function sharedCallVideos(ctx: any, call: Doc<"transcripts">) {
  const bucket = callRecordingsBucketFromEnv();
  if (!bucket) return [];
  const rows: RecordingRow[] = await ctx.db
    .query("call_recordings")
    .withIndex("by_transcript", (q: any) => q.eq("transcript_id", call._id))
    .collect();
  const now = Date.now();
  const out = [];
  for (const r of rows) {
    if (r.kind !== "composite" || r.status !== "ready" || r.started_at === undefined) continue;
    const signed = await r2StableGetUrl(bucket, r.r2_key, now, CALL_RECORDING_URL_WINDOW_MS);
    out.push({ id: String(r._id), started_at: r.started_at, duration_ms: r.duration_ms ?? null, url: signed.url, url_expires_at: signed.expiresAt });
  }
  return out;
}

// ── Delete ────────────────────────────────────────────────────────────────

/**
 * Delete a recording: the whole run the named file belongs to (the room's
 * video and every screen file of that press). Whoever pressed Record may, and
 * so may the call's owner; both must still be able to read the call. A run
 * still being written cannot be deleted (its file lands in the bucket after
 * the stop, and would outlive its row): stop it first. The rows go now, so
 * the call shows it gone on this round trip; the objects go right after.
 */
export const deleteRecording = mutation({
  args: { recording_id: v.string() },
  handler: async (ctx, args): Promise<{ deleted: number }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const id = ctx.db.normalizeId("call_recordings", args.recording_id);
    const row = id ? await ctx.db.get(id) : null;
    const call = row ? await ctx.db.get(row.transcript_id) : null;
    // One error for "no row" and "not yours to read", so a probe learns nothing.
    if (!row || !call || !(await canReadCall(ctx, userId, call))) throw new Error("Recording not found");
    const runRows = (
      await ctx.db
        .query("call_recordings")
        .withIndex("by_transcript", (q) => q.eq("transcript_id", call._id))
        .collect()
    ).filter((r) => runIdOf(r) === runIdOf(row));
    const run = runRows.find((r) => r.kind === "composite") ?? row;
    if (!mayDeleteRun(String(userId), run, call)) throw new Error("Only whoever started this recording, or the call's owner, can delete it");
    if (runRows.some((r) => isRecordingActive(r.status))) throw new Error("Stop the recording before deleting it");
    for (const r of runRows) await ctx.db.delete(r._id);
    const keys = runRows.filter((r) => r.status === "ready" || r.started_at !== undefined).map((r) => r.r2_key);
    if (keys.length) await ctx.scheduler.runAfter(0, internal.callRecordings.deleteObjects, { keys, attempt: 0 });
    return { deleted: runRows.length };
  },
});

/** Remove files from the bucket. A delete of a key that is not there is a
 *  success (S3 answers 204 either way); a failure is retried with backoff,
 *  and after the last try the key is reported in the logs rather than lost
 *  silently. */
export const deleteObjects = internalAction({
  args: { keys: v.array(v.string()), attempt: v.number() },
  handler: async (_ctx, args) => {
    const bucket = callRecordingsBucketFromEnv();
    if (!bucket) {
      console.error(`[callRecordings] cannot delete ${args.keys.length} object(s): recordings bucket not configured`, args.keys);
      return;
    }
    const failed: string[] = [];
    for (const key of args.keys) {
      try {
        const res = await fetch(await r2Presign(bucket, "DELETE", key, 300), { method: "DELETE" });
        if (!res.ok && res.status !== 404) failed.push(key);
      } catch {
        failed.push(key);
      }
    }
    if (failed.length === 0) return;
    if (args.attempt >= 4) {
      console.error(`[callRecordings] gave up deleting ${failed.length} object(s)`, failed);
      return;
    }
    await _ctx.scheduler.runAfter(30_000 * 2 ** args.attempt, internal.callRecordings.deleteObjects, { keys: failed, attempt: args.attempt + 1 });
  },
});

// ── The loop: internal reads and writes ───────────────────────────────────

/** A run as the actions see it: its composite (null once dropped), every file
 *  in it, and whether the call's record is still live. */
export const runForAction = internalQuery({
  args: { run_id: v.id("call_recordings") },
  handler: async (ctx, args) => {
    const head = await ctx.db.get(args.run_id);
    if (!head) {
      // The composite was dropped (stopped before a frame) or deleted; its
      // screen files, if any, still name it.
      return null;
    }
    const rows = (
      await ctx.db
        .query("call_recordings")
        .withIndex("by_transcript", (q) => q.eq("transcript_id", head.transcript_id))
        .collect()
    ).filter((r) => runIdOf(r) === String(args.run_id));
    return { run: head, rows };
  },
});

/** Write LiveKit's view of one egress onto its row (egressPatch decides what
 *  may change). `attach` is the answer to the start request: it records the
 *  egress id, and answers `stop: true` when somebody stopped the run while
 *  the request was in flight, so the caller stops what it just started. */
export const applyEgress = internalMutation({
  args: { id: v.id("call_recordings"), egress: v.any(), attach: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ stop: boolean; status: string | null }> => {
    const row = await ctx.db.get(args.id);
    if (!row) return { stop: !!args.attach, status: null };
    const egress = args.egress as LivekitEgress;
    const result = egressPatch(row, egress);
    if (result.drop) {
      await dropUnrecorded(ctx, row);
      return { stop: false, status: null };
    }
    const patch: Partial<RecordingRow> = { ...result.patch };
    if (args.attach && !row.egress_id && egress.egressId) patch.egress_id = egress.egressId;
    const now = Date.now();
    if (Object.keys(patch).length) await ctx.db.patch(row._id, { ...patch, polled_at: now, updated_at: now });
    // Nothing changed: the loop still says it looked, once a minute, which is
    // what tells sweepStaleRecordings this run's loop is alive. Not on every
    // look, because every write re-runs whatever reads the row.
    else if (now - (row.polled_at ?? row.requested_at) >= POLL_STAMP_MS) await ctx.db.patch(row._id, { polled_at: now });
    return { stop: !!args.attach && row.status === "stopping", status: (patch.status ?? row.status) as string };
  },
});

/** How often a loop that finds nothing new still stamps that it looked. */
const POLL_STAMP_MS = 60_000;

/** A file stopped on purpose before a second of it was written goes: nothing
 *  was recorded and nothing went wrong. The one exception is a run's
 *  composite while the run still has screen files, which name it as their
 *  run: it stays, as a plain failure, so the run (and the loop that finishes
 *  those files) keeps its head. */
async function dropUnrecorded(ctx: any, row: RecordingRow): Promise<void> {
  if (row.kind === "composite") {
    const others = await ctx.db
      .query("call_recordings")
      .withIndex("by_transcript", (q: any) => q.eq("transcript_id", row.transcript_id))
      .filter((q: any) => q.eq(q.field("run_id"), row._id))
      .first();
    if (others) {
      await ctx.db.patch(row._id, { status: "failed", error: "Stopped before the room's video began.", updated_at: Date.now() });
      return;
    }
  }
  await ctx.db.delete(row._id);
}

/** A file that cannot be made: LiveKit refused it, never acknowledged it, or
 *  forgot it. A row that was being stopped anyway, with nothing written, is
 *  dropped instead (nothing went wrong, nothing was recorded). */
export const failRecording = internalMutation({
  args: { id: v.id("call_recordings"), error: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || !isRecordingActive(row.status)) return;
    if (row.status === "stopping" && row.started_at === undefined) {
      await dropUnrecorded(ctx, row);
      return;
    }
    const now = Date.now();
    await ctx.db.patch(row._id, { status: "failed", error: args.error, stop_reason: row.stop_reason ?? "failed", ended_at: row.ended_at ?? (row.started_at !== undefined ? now : undefined), updated_at: now });
  },
});

/** Claim the screen file for one shared track in a run, or null when the run
 *  is no longer recording or the track already has its file (two looks at
 *  the room racing each other start one egress, not two). */
export const claimScreen = internalMutation({
  args: { run_id: v.id("call_recordings"), track_sid: v.string(), identity: v.string(), name: v.string() },
  handler: async (ctx, args): Promise<{ id: Id<"call_recordings">; r2_key: string } | null> => {
    const run = await ctx.db.get(args.run_id);
    if (!run || (run.status !== "starting" && run.status !== "recording")) return null;
    const taken = await ctx.db
      .query("call_recordings")
      .withIndex("by_transcript", (q) => q.eq("transcript_id", run.transcript_id))
      .filter((q) => q.and(q.eq(q.field("run_id"), run._id), q.eq(q.field("track_sid"), args.track_sid)))
      .first();
    if (taken) return null;
    const now = Date.now();
    const r2_key = callRecordingKey({ transcriptId: String(run.transcript_id), kind: "screen", requestedAt: run.requested_at, trackSid: args.track_sid });
    const id = await ctx.db.insert("call_recordings", {
      transcript_id: run.transcript_id,
      room_key: run.room_key,
      team_id: run.team_id,
      kind: "screen",
      status: "starting",
      r2_key,
      track_sid: args.track_sid,
      participant_identity: args.identity,
      participant_name: args.name || undefined,
      run_id: run._id,
      started_by: run.started_by,
      requested_at: now,
      updated_at: now,
    });
    return { id, r2_key };
  },
});

/** Stop the room's recording from inside the loop: the room stood empty, or
 *  the run outlived any meeting. */
export const stopRoom = internalMutation({
  args: { room_key: v.string(), reason: callRecordingStopReasonValidator },
  handler: async (ctx, args) => {
    return await stopRoomRecording(ctx, args.room_key, { reason: args.reason });
  },
});

// ── The loop: actions ─────────────────────────────────────────────────────

function startErrorMessage(err: unknown): string {
  if (err instanceof LivekitApiError) {
    if (err.status === 401 || err.status === 403) return "LiveKit refused this server's credentials, so the recording could not start.";
    if (err.code === "resource_exhausted") return "LiveKit has no recording capacity free right now. Try again in a minute.";
    return `LiveKit could not start the recording (${err.code ?? err.status}).`;
  }
  return `The recording could not start: ${err instanceof Error ? err.message : String(err)}`;
}

/** Ask LiveKit for a file for every screen in the room that has none in this
 *  run yet. Each file is claimed before it is requested, so a nudge from a
 *  heartbeat and the loop's own beat never start the same one twice. */
async function recordNewShares(
  ctx: any,
  cfg: LivekitServerConfig,
  bucket: R2Bucket,
  run: RecordingRow,
  rows: RecordingRow[],
  participants: Awaited<ReturnType<typeof listParticipants>>,
): Promise<void> {
  for (const share of screenSharesToRecord(participants, rows)) {
    const claim: { id: Id<"call_recordings">; r2_key: string } | null = await ctx.runMutation(internal.callRecordings.claimScreen, {
      run_id: run._id,
      track_sid: share.trackSid,
      identity: share.identity,
      name: share.name,
    });
    if (!claim) continue;
    const advanced = screenEncoding(share);
    try {
      const egress = await startTrackCompositeEgress(
        cfg,
        trackCompositeEgressRequest({ room: run.room_key, videoTrackSid: share.trackSid, filepath: claim.r2_key, upload: egressS3Upload(bucket), ...(advanced ? { advanced } : {}) }),
      );
      const applied = await ctx.runMutation(internal.callRecordings.applyEgress, { id: claim.id, egress, attach: true });
      if (applied.stop) await stopEgress(cfg, egress.egressId);
    } catch (err) {
      await ctx.runMutation(internal.callRecordings.failRecording, { id: claim.id, error: startErrorMessage(err) });
    }
  }
}

/** The press, carried out: ask LiveKit for the room composite, then for a
 *  file per screen already being shared, then hand the run to the loop. */
export const startRun = internalAction({
  args: { run_id: v.id("call_recordings") },
  handler: async (ctx, args) => {
    const info = await ctx.runQuery(internal.callRecordings.runForAction, { run_id: args.run_id });
    if (!info || info.run.egress_id) return;
    const { run } = info;
    const cfg = livekitConfigFromEnv();
    const bucket = callRecordingsBucketFromEnv();
    if (!cfg || !bucket) {
      await ctx.runMutation(internal.callRecordings.failRecording, { id: run._id, error: "Recording is not set up on this server." });
      return;
    }
    // Stopped before LiveKit was even asked: nothing to start.
    if (run.status === "stopping") {
      await ctx.runMutation(internal.callRecordings.failRecording, { id: run._id, error: "Stopped before it began." });
      return;
    }
    try {
      const egress = await startRoomCompositeEgress(cfg, roomCompositeEgressRequest({ room: run.room_key, filepath: run.r2_key, upload: egressS3Upload(bucket) }));
      const applied = await ctx.runMutation(internal.callRecordings.applyEgress, { id: run._id, egress, attach: true });
      if (applied.stop) await stopEgress(cfg, egress.egressId);
    } catch (err) {
      await ctx.runMutation(internal.callRecordings.failRecording, { id: run._id, error: startErrorMessage(err) });
      return;
    }
    try {
      await recordNewShares(ctx, cfg, bucket, run, info.rows, await listParticipants(cfg, run.room_key));
    } catch (err) {
      // The room's video is recording; a screen file missed here is picked
      // up by the loop's next look.
      console.warn(`[callRecordings] screen look failed for ${run._id}:`, err);
    }
    await ctx.scheduler.runAfter(RECORDING_POLL_FAST_MS, internal.callRecordings.reconcileRun, { run_id: run._id });
  },
});

/**
 * One look at a run: bring every file's row up to date with LiveKit, start a
 * file for a new screen share, stop the run when LiveKit's room has stood
 * empty (a tab that died never leaves) or the run has outlived any meeting,
 * and stop the screen files of a run whose composite has ended. Then, unless
 * this was a one off nudge (`once`), look again while anything is still being
 * written. `empty_since` carries the first look that found nobody, so a blip
 * between two people is not mistaken for an empty room.
 */
export const reconcileRun = internalAction({
  args: { run_id: v.id("call_recordings"), once: v.optional(v.boolean()), empty_since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const info = await ctx.runQuery(internal.callRecordings.runForAction, { run_id: args.run_id });
    if (!info) return;
    const cfg = livekitConfigFromEnv();
    const bucket = callRecordingsBucketFromEnv();
    if (!cfg || !bucket) {
      for (const r of info.rows.filter((r) => isRecordingActive(r.status))) {
        await ctx.runMutation(internal.callRecordings.failRecording, { id: r._id, error: "Recording is not set up on this server." });
      }
      return;
    }
    const now = Date.now();
    for (const row of info.rows) {
      if (!isRecordingActive(row.status)) continue;
      if (!row.egress_id) {
        if (now - row.requested_at > EGRESS_ACCEPT_TIMEOUT_MS) {
          await ctx.runMutation(internal.callRecordings.failRecording, { id: row._id, error: "LiveKit never started this recording." });
        }
        continue;
      }
      let egress: LivekitEgress | null;
      try {
        egress = await getEgress(cfg, row.egress_id);
      } catch (err) {
        // LiveKit unreachable for a moment: the next look tries again. The
        // loop is alive all the same, and says so, or the sweep would start
        // a second one for every few minutes LiveKit is down.
        console.warn(`[callRecordings] could not read egress ${row.egress_id}:`, err);
        await ctx.runMutation(internal.callRecordings.stampLooked, { id: row._id });
        continue;
      }
      if (!egress) {
        await ctx.runMutation(internal.callRecordings.failRecording, { id: row._id, error: "LiveKit lost track of this recording before it finished." });
        continue;
      }
      const applied = await ctx.runMutation(internal.callRecordings.applyEgress, { id: row._id, egress });
      // A stop that LiveKit has not acted on after a while is asked again.
      if (applied.status === "stopping" && (egress.status === "starting" || egress.status === "active") && now - row.updated_at > STOP_RETRY_MS) {
        await stopEgress(cfg, row.egress_id).catch((err) => console.warn(`[callRecordings] stop retry failed for ${row.egress_id}:`, err));
      }
    }

    const fresh = await ctx.runQuery(internal.callRecordings.runForAction, { run_id: args.run_id });
    if (!fresh) return;
    const { run, rows } = fresh;
    let emptySince: number | undefined;
    if (run.status === "starting" || run.status === "recording") {
      try {
        const participants = await listParticipants(cfg, run.room_key);
        if (peopleInRoom(participants).length === 0) {
          emptySince = args.empty_since ?? now;
          if (now - emptySince >= RECORDING_EMPTY_ROOM_STOP_MS) {
            await ctx.runMutation(internal.callRecordings.stopRoom, { room_key: run.room_key, reason: "huddle_ended" });
          }
        } else if (now - run.requested_at > RECORDING_MAX_RUN_MS) {
          await ctx.runMutation(internal.callRecordings.stopRoom, { room_key: run.room_key, reason: "limit" });
        } else {
          await recordNewShares(ctx, cfg, bucket, run, rows, participants);
        }
      } catch (err) {
        console.warn(`[callRecordings] room look failed for ${run.room_key}:`, err);
      }
    } else if (!isRecordingActive(run.status) && rows.some((r) => r.kind === "screen" && (r.status === "starting" || r.status === "recording"))) {
      // The room's video ended on its own (LiveKit's limit, a failure): its
      // screen files end with it.
      await ctx.runMutation(internal.callRecordings.stopRoom, { room_key: run.room_key, reason: run.stop_reason ?? "failed" });
    }

    if (args.once) return;
    const after = await ctx.runQuery(internal.callRecordings.runForAction, { run_id: args.run_id });
    const delay = after ? nextPollDelayMs(after.rows) : null;
    if (delay !== null) {
      await ctx.scheduler.runAfter(emptySince !== undefined ? RECORDING_POLL_FAST_MS : delay, internal.callRecordings.reconcileRun, {
        run_id: args.run_id,
        ...(emptySince !== undefined ? { empty_since: emptySince } : {}),
      });
    }
  },
});

/** Ask LiveKit to stop these files (stopRoomRecording has already marked
 *  them). A file whose egress is not known yet is stopped by startRun when
 *  LiveKit answers; one that already ended answers null, which is fine. The
 *  loop writes the finished files. */
export const stopEgresses = internalAction({
  args: { ids: v.array(v.id("call_recordings")) },
  handler: async (ctx, args) => {
    const cfg = livekitConfigFromEnv();
    if (!cfg) return;
    for (const id of args.ids) {
      const row: RecordingRow | null = await ctx.runQuery(internal.callRecordings.getRow, { id });
      if (!row?.egress_id) continue;
      try {
        const egress = await stopEgress(cfg, row.egress_id);
        if (egress) await ctx.runMutation(internal.callRecordings.applyEgress, { id, egress });
      } catch (err) {
        // Asked again by the loop after STOP_RETRY_MS.
        console.warn(`[callRecordings] stop failed for ${row.egress_id}:`, err);
      }
    }
  },
});

/** How long a run may go without its loop looking before the sweep restarts
 *  the loop. A loop stamps at least once a minute (POLL_STAMP_MS). */
export const RECORDING_LOOP_STALE_MS = 3 * 60_000;

/** Cron backstop: every run LiveKit is still working on has a loop looking at
 *  it. An action can die (a deploy, a crash between two lines), and a run
 *  with no loop would read "recording" forever. A run whose newest look is
 *  older than RECORDING_LOOP_STALE_MS gets a fresh loop. */
export const sweepStaleRecordings = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const lastLook = new Map<string, number>();
    for (const status of ["starting", "recording", "stopping"] as const) {
      const rows = await ctx.db
        .query("call_recordings")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
      for (const r of rows) {
        const run = runIdOf(r);
        lastLook.set(run, Math.max(lastLook.get(run) ?? 0, r.polled_at ?? r.requested_at));
      }
    }
    let restarted = 0;
    for (const [run, at] of lastLook) {
      if (now - at < RECORDING_LOOP_STALE_MS) continue;
      const id = ctx.db.normalizeId("call_recordings", run);
      if (!id) continue;
      await ctx.scheduler.runAfter(0, internal.callRecordings.reconcileRun, { run_id: id });
      restarted++;
    }
    return { runs: lastLook.size, restarted };
  },
});

export const stampLooked = internalMutation({
  args: { id: v.id("call_recordings") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    const now = Date.now();
    if (row && now - (row.polled_at ?? row.requested_at) >= POLL_STAMP_MS) await ctx.db.patch(row._id, { polled_at: now });
  },
});

export const getRow = internalQuery({
  args: { id: v.id("call_recordings") },
  handler: async (ctx, args) => await ctx.db.get(args.id),
});
