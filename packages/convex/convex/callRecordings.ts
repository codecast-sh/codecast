// Recording a huddle: the whole call as video on LiveKit's servers, kept in the
// private recordings bucket, on the call's record.
//
// The model, the time rule and the words live in
// shared/contracts/callRecordings.ts; what a run is, and how a row moves, in
// lib/callRecordingRuns.ts. This module is the doors and the loop:
//
//   press      startRecording inserts the run's composite row ("starting"),
//              tells the room in its thread, and starts the run's loop, so
//              every client shows the indicator on this round trip and the run
//              is looked at within seconds whatever happens next; an action
//              then asks LiveKit for the room composite and a file per screen
//              being shared.
//   loop       reconcileRun asks LiveKit for the room's running egresses (one
//              ListEgress) and writes what it says onto each file: its time
//              0, its end, length and size, or why it failed. The same look
//              starts a file for a screen share that began mid-run, and stops
//              the run if LiveKit's room has stood empty. It reschedules
//              itself while any file is still being written. LiveKit is the
//              truth; no webhook is needed for any of it. One loop per run:
//              call_recording_loops holds which one is current.
//   stop       stopRecording (anyone in the room), guestStopRecording (a guest
//              in it), the room emptying (calls.leaveRoom), or the record
//              ending (transcripts.endTranscript) all go through
//              stopRoomRecording, and the room is told every time.
//   read       the room's live state (cheap, no clock in it); a call's files
//              with presigned GET URLs minted after canReadCall (stable per
//              window for the call page, fresh and short for the CLI's frame
//              grabs); the public share page's composite, only when somebody
//              chose to share the video with the link.
//   delete     the presser or a team admin removes a run: rows at once, every
//              object under the run's prefix right after, and a line in the
//              room's thread saying who.
//   sweep      a cron restarts a run's loop that stopped looking, and stops any
//              LiveKit egress writing into the bucket that no live row tracks,
//              so nothing can film a room the app says is not being filmed.
//
// Recording is never automatic. A press starts it, every client in the room
// is told (the indicator reads isRoomRecording; the thread gets a line), and
// people who join later read the same state.

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { CALL_RECORDING_URL_WINDOW_MS, guestIdentity, isGuestPresent, isRecordingActive } from "@codecast/shared/contracts";
import { verifyApiToken } from "./apiTokens";
import { authorizeRoom, liveMembers, liveSeat } from "./callRooms";
import { liveTranscriptFor, postEvent } from "./callChat";
import { guestBySecret } from "./callGuests";
import { beginCallRecord, canReadCall, resolveCallRef } from "./transcripts";
import { isTeamAdmin } from "./privacy";
import { displayName } from "./lib/displayNames";
import {
  callRecordingKey,
  callRecordingLiveFramePrefix,
  callRecordingRunPrefixOfKey,
  callRecordingsBucketFromEnv,
  CALL_RECORDINGS_ROOT,
  liveFrameKey,
  r2FreshGetUrl,
  r2ListKeys,
  r2Presign,
  r2StableGetUrl,
  type R2Bucket,
} from "./lib/r2";
import {
  egressS3Upload,
  getEgress,
  listEgress,
  listParticipants,
  livekitConfigFromEnv,
  LivekitApiError,
  roomCompositeEgressRequest,
  startRoomCompositeEgress,
  startTrackCompositeEgress,
  stopEgress,
  trackCompositeEgressRequest,
  type LiveFrameOutput,
  type LivekitEgress,
  type LivekitServerConfig,
} from "./lib/livekitServer";
import {
  activeRoomRecordings,
  announceRecordEnd,
  egressPatch,
  EGRESS_ACCEPT_TIMEOUT_MS,
  huddleKeepers,
  LIVE_FRAME_INTERVAL_S,
  liveRoomRun,
  mayDeleteRun,
  nextPollDelayMs,
  noteRecordedPeople,
  RECORDING_EMPTY_ROOM_STOP_MS,
  RECORDING_LOOP_STALE_MS,
  RECORDING_MAX_RUN_MS,
  RECORDING_POLL_FAST_MS,
  RECORDING_RESTART_COOLDOWN_MS,
  recordingLoop,
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

async function teammateName(ctx: any, userId: Id<"users"> | string): Promise<string> {
  const id = ctx.db.normalizeId("users", String(userId));
  return displayName(id ? await ctx.db.get(id) : null);
}

/** Every file of a call, oldest press first. */
async function callRows(ctx: any, transcriptId: Id<"transcripts">): Promise<RecordingRow[]> {
  return await ctx.db
    .query("call_recordings")
    .withIndex("by_transcript", (q: any) => q.eq("transcript_id", transcriptId))
    .collect();
}

// ── Press and stop ────────────────────────────────────────────────────────

/**
 * Start recording the room the caller is sitting in. Idempotent: a room
 * already recording answers with its run, so two people pressing at once make
 * one recording. A press right after a stop is refused for a moment
 * (RECORDING_RESTART_COOLDOWN_MS): LiveKit is still finishing that file, and
 * every press is a billed egress. A huddle with no record yet (transcription
 * switched off, or the press beat every client's auto start) gets one here,
 * the same way the scribe's start makes it, so a call that is only recorded
 * is still a call.
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
    const justStopped = (await activeRoomRecordings(ctx, args.room_key)).some(
      (r) => r.kind === "composite" && r.status === "stopping" && now - r.updated_at < RECORDING_RESTART_COOLDOWN_MS,
    );
    if (justStopped) throw new Error("Recording just stopped and is still saving. Try again in a few seconds.");

    const record =
      (await liveTranscriptFor(ctx, args.room_key)) ??
      (await ctx.db.get(await beginCallRecord(ctx, { roomKey: args.room_key, teamId: auth.teamId, userId, routes: [], announce: false })))!;
    const file = { transcriptId: String(record._id), kind: "composite" as const, requestedAt: now };
    const id = await ctx.db.insert("call_recordings", {
      transcript_id: record._id,
      room_key: args.room_key,
      team_id: record.team_id,
      kind: "composite",
      status: "starting",
      r2_key: callRecordingKey(file),
      live_frame_key: liveFrameKey(callRecordingLiveFramePrefix(file)),
      started_by: userId,
      requested_at: now,
      updated_at: now,
    });
    // Everyone seated now is in the video, so everyone seated now may watch it.
    const seated = liveMembers(
      await ctx.db
        .query("call_members")
        .withIndex("by_room", (q) => q.eq("room_key", args.room_key))
        .collect(),
      now,
    );
    await noteRecordedPeople(ctx, args.room_key, [userId, ...seated.map((m) => m.user_id)], await ctx.db.get(id));
    await postEvent(ctx, { room_key: args.room_key, team_id: record.team_id, user_id: userId, event: "record_on" });
    // The loop starts with the press, not with LiveKit's answer: whatever
    // happens to startRun (it dies, it hangs), the run is looked at within
    // seconds and a start nobody acknowledged is found or failed.
    await ctx.db.insert("call_recording_loops", { run_id: id, gen: 1, looked_at: now });
    await ctx.scheduler.runAfter(0, internal.callRecordings.startRun, { run_id: id });
    await ctx.scheduler.runAfter(RECORDING_POLL_FAST_MS, internal.callRecordings.reconcileRun, { run_id: id, gen: 1 });
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

/** A guest in the huddle stops its recording: anyone in the room may, guests
 *  included. Proven the way every guest call is (callGuests: the id and the
 *  secret their browser holds), and only while admitted and present. The
 *  thread names them as the guest they are. */
export const guestStopRecording = mutation({
  args: { guest_id: v.string(), secret: v.string() },
  handler: async (ctx, args): Promise<{ stopped: number }> => {
    const guest = await guestBySecret(ctx, args.guest_id, args.secret);
    if (!guest || guest.status !== "admitted" || !isGuestPresent(guest, Date.now())) {
      throw new Error("Only someone in the huddle can stop recording");
    }
    return await stopRoomRecording(ctx, guest.room_key, {
      reason: "pressed",
      stoppedBy: guestIdentity(String(guest._id)),
      guestName: guest.name,
    });
  },
});

// ── Live state ────────────────────────────────────────────────────────────

/** What the room's teammates are told about recording right now, or null
 *  when it is not recording. Nothing in it moves with the clock: it changes
 *  when a run starts, when LiveKit's first frame lands (started_at, once),
 *  and when it stops, so a room full of subscribers is re-pushed three times
 *  a run. An elapsed counter is the client's arithmetic on started_at. This
 *  names a teammate as the team does; a guest is told through callGuests'
 *  own notice, which carries no names and no ids. */
export async function roomRecordingState(ctx: any, roomKey: string) {
  // A run being stopped is no longer recording the room, and LiveKit is
  // still finishing its file: a client may say "saving".
  const run =
    (await liveRoomRun(ctx, roomKey)) ??
    (await activeRoomRecordings(ctx, roomKey)).find((r) => r.kind === "composite" && r.status === "stopping");
  if (!run) return null;
  const call: Doc<"transcripts"> | null = await ctx.db.get(run.transcript_id);
  return {
    status: run.status as "starting" | "recording" | "stopping",
    run_id: run._id,
    transcript_id: run.transcript_id,
    call_short_id: call?.short_id ?? null,
    started_by: { id: String(run.started_by), name: await teammateName(ctx, run.started_by) },
    requested_at: run.requested_at,
    // The file's time 0: when the room began to be filmed, not the press.
    started_at: run.started_at ?? null,
  };
}

/** The room's recording state for anyone who may be in the room (the open
 *  door and an invite grant included: whoever can hear the room is told it is
 *  recorded). `configured` says whether a press could work at all, so a
 *  client can leave the button out rather than offer one that fails. Why a
 *  run ended (a failure, the limit) is a record_off line in the thread. */
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

type Signer = (key: string) => Promise<{ url: string; expiresAt: number }>;

/** Every file of a call, in the order they were pressed for, with what a
 *  reader needs to align them: the call's own started_at (transcript lines
 *  are ms since it) and each file's time 0 (locateCallMoment does the rest).
 *  `sign` mints a finished file's URL (none when the bucket is not set up);
 *  `keys` hands the rows' object keys instead, to a caller that signs on its
 *  own clock (the CLI route) and strips them. An MP4 is uploaded whole when
 *  it ends, so a file still being written has no URL. The caller has already
 *  passed canReadCall. */
export async function callRecordingsCore(ctx: any, call: Doc<"transcripts">, userId: Id<"users">, opts: { sign?: Signer | null; keys?: boolean }) {
  const rows = await callRows(ctx, call._id);
  const byRun = new Map<string, RecordingRow[]>();
  for (const r of rows) byRun.set(runIdOf(r), [...(byRun.get(runIdOf(r)) ?? []), r]);
  const admin = await isTeamAdmin(ctx, userId, call.team_id);
  const names = new Map<string, string>();
  for (const r of rows) if (!names.has(String(r.started_by))) names.set(String(r.started_by), await teammateName(ctx, r.started_by));
  const recordings = [];
  for (const r of rows) {
    const signed = r.status === "ready" && opts.sign ? await opts.sign(r.r2_key) : null;
    recordings.push({
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
      started_by_name: names.get(String(r.started_by))!,
      requested_at: r.requested_at,
      stop_reason: r.stop_reason ?? null,
      error: r.error ?? null,
      url: signed?.url ?? null,
      url_expires_at: signed?.expiresAt ?? null,
      // The button and the mutation ask the same question of the same rows.
      can_delete: mayDeleteRun(String(userId), byRun.get(runIdOf(r)) ?? [r], admin).ok,
      ...(opts.keys ? { r2_key: r.r2_key, live_frame_key: r.live_frame_key ?? null } : {}),
    });
  }
  return {
    transcript_id: String(call._id),
    short_id: call.short_id ?? null,
    call_started_at: call.started_at,
    call_ended_at: call.ended_at ?? null,
    configured: recordingConfigured(),
    // Whether the call's public link (if it has one) shows the video too:
    // what ShareControl says next to the link, and turns on and off.
    share_link: !!call.share_token,
    video_shared: shareIncludesVideo(call),
    recordings,
  };
}

/** The moment a page's URLs are signed at: the window it asked for, held
 *  within one window of now, so a caller can move to the next window a beat
 *  early but can never mint a URL that outlives what it was shown. */
export function signingMoment(urlWindow: number, now: number): number {
  const asked = urlWindow * CALL_RECORDING_URL_WINDOW_MS;
  return Math.min(now + CALL_RECORDING_URL_WINDOW_MS, Math.max(now - CALL_RECORDING_URL_WINDOW_MS, asked));
}

/** The call page's recordings. `call` is a short id (`cl-42`) or full id.
 *  `url_window` is callRecordingUrlWindow(now), and the URLs are signed at
 *  it, so the answer is a pure function of the arguments: a query cache
 *  cannot hand back a URL from a window that has lapsed, and a page moves to
 *  fresh URLs by moving to the next window (four times an hour). */
export const webCallRecordings = query({
  args: { call: v.string(), url_window: v.number() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const t = await resolveCallRef(ctx, userId, args.call);
    if (!t) return null;
    const bucket = callRecordingsBucketFromEnv();
    const at = signingMoment(args.url_window, Date.now());
    return callRecordingsCore(ctx, t, userId, { sign: bucket ? (key) => r2StableGetUrl(bucket, key, at, CALL_RECORDING_URL_WINDOW_MS) : null });
  },
});

/** The CLI's twin (`cast call snap`), read by the /cli/calls/recordings
 *  route: the same files with their keys, which the route signs fresh and
 *  short at request time (signForCli). Null for a call that does not exist or
 *  the caller may not read. */
export const cliCallRecordings = internalQuery({
  args: { api_token: v.string(), call: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    const t = await resolveCallRef(ctx, auth.userId, args.call);
    return t ? callRecordingsCore(ctx, t, auth.userId, { keys: true }) : null;
  },
});

/** The route's answer: every finished file with a URL signed now for ten
 *  minutes (one seek's worth, and useless soon after the access check), and
 *  every file still recording with its live frame, the picture of the call
 *  as it is now (rewritten every LIVE_FRAME_INTERVAL_S). `server_now` lets a
 *  caller on a skewed clock tell "now" from "a moment ago". Keys never leave
 *  the server. */
export async function signForCli(res: Awaited<ReturnType<typeof callRecordingsCore>>) {
  const bucket = callRecordingsBucketFromEnv();
  const now = Date.now();
  const recordings = [];
  for (const r of res.recordings) {
    const { r2_key, live_frame_key, ...rest } = r as typeof r & { r2_key?: string; live_frame_key?: string | null };
    const file = bucket && r.status === "ready" && r2_key ? await r2FreshGetUrl(bucket, r2_key, now) : null;
    const frame = bucket && r.status === "recording" && live_frame_key ? await r2FreshGetUrl(bucket, live_frame_key, now) : null;
    recordings.push({
      ...rest,
      url: file?.url ?? null,
      url_expires_at: file?.expiresAt ?? null,
      live_frame_url: frame?.url ?? null,
    });
  }
  return { ...res, recordings, server_now: now, live_frame_interval_ms: LIVE_FRAME_INTERVAL_S * 1000 };
}

// ── Public share ──────────────────────────────────────────────────────────

/** Does the call's public link show its video? Only when somebody chose it
 *  for this very link (setCallShareVideo): a link made to share a transcript
 *  never starts handing out faces and screens because Record was pressed
 *  later, and a link turned off and on is a new token that starts without. */
export function shareIncludesVideo(call: Pick<Doc<"transcripts">, "share_token" | "share_video_token">): boolean {
  return !!call.share_token && call.share_video_token === call.share_token;
}

/** Include the call's video with its public link, or stop including it. Whoever
 *  may turn the link on may decide this (canReadCall, publicShare's rule for
 *  calls), and only for a link that exists. */
export const setCallShareVideo = mutation({
  args: { call: v.string(), include: v.boolean() },
  handler: async (ctx, args): Promise<{ video_shared: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const t = await resolveCallRef(ctx, userId, args.call);
    if (!t) throw new Error("Not found");
    if (args.include && !t.share_token) throw new Error("Turn on the share link first");
    await ctx.db.patch(t._id, { share_video_token: args.include ? t.share_token : undefined });
    return { video_shared: args.include };
  },
});

/** The finished room recordings a share link shows, oldest first: never a
 *  single person's screen file. */
async function sharedVideoRows(ctx: any, call: Doc<"transcripts">): Promise<RecordingRow[]> {
  if (!shareIncludesVideo(call)) return [];
  return (await callRows(ctx, call._id)).filter((r) => r.kind === "composite" && r.status === "ready" && r.started_at !== undefined);
}

/** The video of a publicly shared call, for its share page: each finished
 *  room recording with its time 0, so the page can follow the transcript. No
 *  names, no ids, no keys: an entry is told apart by its index, and its URL is
 *  this deployment's redirect (/share/call/video), which checks the link
 *  again on every request and answers with a fresh, short URL into the
 *  bucket. So the share query has no clock in it, and turning the link off
 *  stops the video at the next request rather than a window later. The
 *  caller has already resolved the share token. */
export async function sharedCallVideos(ctx: any, call: Doc<"transcripts">) {
  if (!callRecordingsBucketFromEnv()) return [];
  const site = (process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");
  return (await sharedVideoRows(ctx, call)).map((r, i) => ({
    id: `v${i}`,
    started_at: r.started_at!,
    duration_ms: r.duration_ms ?? null,
    url: `${site}/share/call/video?token=${encodeURIComponent(call.share_token!)}&at=${r.started_at}`,
  }));
}

/** The object behind one shared video (the redirect route's lookup): the
 *  finished room recording that began at `at`, under the link's own rule. */
export async function sharedCallVideoKey(ctx: any, call: Doc<"transcripts">, at: number): Promise<string | null> {
  return (await sharedVideoRows(ctx, call)).find((r) => r.started_at === at)?.r2_key ?? null;
}

// ── Delete ────────────────────────────────────────────────────────────────

/**
 * Delete a recording: the whole run the named file belongs to (the room's
 * video and every screen file of that press). Whoever pressed Record may, and
 * so may an admin of the call's team; either must still be able to read the
 * call. A run still being written cannot be deleted (its file lands in the
 * bucket after the stop, and would outlive its row): stop it first. The rows
 * go now, so the call shows it gone on this round trip; every object under
 * the run's prefix goes right after; and the room's thread says who deleted
 * it, so a recording that vanished is explained.
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
    const runRows = (await callRows(ctx, call._id)).filter((r) => runIdOf(r) === runIdOf(row));
    const verdict = mayDeleteRun(String(userId), runRows, await isTeamAdmin(ctx, userId, call.team_id));
    if (!verdict.ok) {
      throw new Error(verdict.reason === "still_recording" ? "Stop the recording before deleting it" : "Only whoever started this recording, or a team admin, can delete it");
    }
    for (const r of runRows) await ctx.db.delete(r._id);
    const loop = await recordingLoop(ctx, runIdOf(row) as Id<"call_recordings">);
    if (loop) await ctx.db.delete(loop._id);
    await scheduleObjectDelete(ctx, runRows, { wholeRun: true });
    await postEvent(ctx, { room_key: call.room_key, team_id: call.team_id, user_id: userId, event: "record_deleted", transcript_id: call._id });
    return { deleted: runRows.length };
  },
});

/** Queue the bucket cleanup for rows that are gone: each row's file and live
 *  frame, and (`wholeRun`) everything under the run's prefix, so an object
 *  LiveKit wrote under a name no row holds (an upload that landed after its
 *  row failed, a partial file) goes with them. Deleting a key that is not
 *  there costs nothing (S3 answers 204), so it is never filtered first. */
async function scheduleObjectDelete(ctx: any, rows: RecordingRow[], opts: { wholeRun: boolean }): Promise<void> {
  const keys = [...new Set(rows.flatMap((r) => [r.r2_key, r.live_frame_key].filter((k): k is string => !!k)))];
  const prefixes = opts.wholeRun ? [...new Set(rows.map((r) => callRecordingRunPrefixOfKey(r.r2_key)).filter((p): p is string => !!p))] : [];
  if (keys.length || prefixes.length) await ctx.scheduler.runAfter(0, internal.callRecordings.deleteObjects, { keys, prefixes, attempt: 0 });
}

/** Remove files from the bucket: the keys named, and every key under each
 *  prefix. A failure (a delete refused, a prefix that could not be listed) is
 *  retried with backoff, and after the last try reported in the logs rather
 *  than lost silently. */
export const deleteObjects = internalAction({
  args: { keys: v.array(v.string()), prefixes: v.optional(v.array(v.string())), attempt: v.number() },
  handler: async (ctx, args) => {
    const bucket = callRecordingsBucketFromEnv();
    if (!bucket) {
      console.error(`[callRecordings] cannot delete ${args.keys.length} object(s): recordings bucket not configured`, args.keys, args.prefixes);
      return;
    }
    const keys = new Set(args.keys);
    const unlisted: string[] = [];
    for (const prefix of args.prefixes ?? []) {
      try {
        for (const k of await r2ListKeys(bucket, prefix)) keys.add(k);
      } catch (err) {
        console.warn(`[callRecordings] could not list ${prefix}:`, err);
        unlisted.push(prefix);
      }
    }
    const failed: string[] = [];
    for (const key of keys) {
      try {
        const res = await fetch(await r2Presign(bucket, "DELETE", key, 300), { method: "DELETE" });
        if (!res.ok && res.status !== 404) failed.push(key);
      } catch {
        failed.push(key);
      }
    }
    if (failed.length === 0 && unlisted.length === 0) return;
    if (args.attempt >= 4) {
      console.error(`[callRecordings] gave up deleting ${failed.length} object(s) and ${unlisted.length} prefix(es)`, failed, unlisted);
      return;
    }
    await ctx.scheduler.runAfter(30_000 * 2 ** args.attempt, internal.callRecordings.deleteObjects, { keys: failed, prefixes: unlisted, attempt: args.attempt + 1 });
  },
});

// ── The loop: internal reads and writes ───────────────────────────────────

/** A run as the actions see it: its composite (null once dropped or
 *  deleted; its screen files, if any, still name it) and every file in it. */
export const runForAction = internalQuery({
  args: { run_id: v.id("call_recordings") },
  handler: async (ctx, args) => await readRun(ctx, args.run_id),
});

async function readRun(ctx: any, runId: Id<"call_recordings">): Promise<{ run: RecordingRow; rows: RecordingRow[] } | null> {
  const head: RecordingRow | null = await ctx.db.get(runId);
  if (!head) return null;
  return { run: head, rows: (await callRows(ctx, head.transcript_id)).filter((r) => runIdOf(r) === String(runId)) };
}

/** The current loop's look begins: null when this loop has been replaced
 *  (the sweep started a newer one) or its run is gone, so it ends quietly;
 *  otherwise the run, with the look stamped where only the sweep reads it. */
export const beginLook = internalMutation({
  args: { run_id: v.id("call_recordings"), gen: v.number() },
  handler: async (ctx, args) => {
    const loop = await recordingLoop(ctx, args.run_id);
    if (!loop || loop.gen !== args.gen) return null;
    const info = await readRun(ctx, args.run_id);
    if (!info) {
      await ctx.db.delete(loop._id);
      return null;
    }
    await ctx.db.patch(loop._id, { looked_at: Date.now() });
    return info;
  },
});

/** The run is finished (nothing left being written): its loop is done. */
export const endLoop = internalMutation({
  args: { run_id: v.id("call_recordings"), gen: v.number() },
  handler: async (ctx, args) => {
    const loop = await recordingLoop(ctx, args.run_id);
    if (loop && loop.gen === args.gen) await ctx.db.delete(loop._id);
  },
});

/** Write LiveKit's view of one egress onto its row (egressPatch decides what
 *  may change). `attach` is the answer to a start request: it records the
 *  egress id, and answers `stop: true` whenever the row no longer wants a
 *  recording (somebody stopped the run while the request was in flight, or
 *  the row was failed because the answer came too late), so the caller stops
 *  what it just started and nothing films a room the app shows as not
 *  filmed. A composite leaving the live states on LiveKit's say (a failure,
 *  LiveKit's own limit) tells the room. */
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
    const status = (patch.status ?? row.status) as RecordingRow["status"];
    const ended = isRecordingActive(row.status) && !isRecordingActive(status);
    const filming = (s: string) => s === "starting" || s === "recording";
    // The live frame is a picture of now: once the file is finished it has
    // nothing left to show, and it goes rather than lingering as the call's
    // last frame.
    if (ended && row.live_frame_key) patch.live_frame_key = undefined;
    if (Object.keys(patch).length) await ctx.db.patch(row._id, { ...patch, updated_at: Date.now() });
    if (ended && row.live_frame_key) await ctx.scheduler.runAfter(0, internal.callRecordings.deleteObjects, { keys: [row.live_frame_key], attempt: 0 });
    // The room stops being filmed on LiveKit's say, not ours (a stop we sent
    // moved the row to "stopping" first, and was told then).
    if (row.kind === "composite" && filming(row.status) && !filming(status)) {
      const reason =
        patch.stop_reason ?? row.stop_reason ?? (egress.status === "limit_reached" ? "limit" : status === "failed" ? "failed" : "huddle_ended");
      await announceRecordEnd(ctx, row, { reason, detail: status === "failed" ? (patch.error ?? row.error) : undefined });
    }
    return { stop: !!args.attach && !filming(status), status };
  },
});

/** A file stopped on purpose before a frame of it was written goes: nothing
 *  was recorded and nothing went wrong. The one exception is a run's
 *  composite while the run still has screen files, which name it as their
 *  run: it stays, as a plain failure, so the run (and the loop that finishes
 *  those files) keeps its head; when its last screen file goes too, so does
 *  it. Whatever LiveKit may have put in the bucket for a dropped file goes
 *  with it. */
async function dropUnrecorded(ctx: any, row: RecordingRow): Promise<void> {
  const runRows = (await callRows(ctx, row.transcript_id)).filter((r) => runIdOf(r) === runIdOf(row));
  const others = runRows.filter((r) => r._id !== row._id);
  if (row.kind === "composite" && others.some((r) => r.kind === "screen")) {
    await ctx.db.patch(row._id, { status: "failed", error: "Stopped before the room's video began.", live_frame_key: undefined, updated_at: Date.now() });
    await scheduleObjectDelete(ctx, [row], { wholeRun: false });
    return;
  }
  await ctx.db.delete(row._id);
  const head = others.find((r) => r.kind === "composite");
  const placeholderLeft = head && head.status === "failed" && head.started_at === undefined && !others.some((r) => r.kind === "screen");
  if (placeholderLeft) await ctx.db.delete(head._id);
  const runGone = row.kind === "composite" || placeholderLeft;
  await scheduleObjectDelete(ctx, placeholderLeft ? [row, head] : [row], { wholeRun: !!runGone });
}

/** A file that cannot be made: LiveKit refused it, never acknowledged it, or
 *  lost it. A row that was being stopped anyway, with nothing written, is
 *  dropped instead (nothing went wrong, nothing was recorded). Either way an
 *  egress LiveKit may still be running for it is told to stop, and a run
 *  whose room video failed while it was filming tells the room why. */
export const failRecording = internalMutation({
  args: { id: v.id("call_recordings"), error: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || !isRecordingActive(row.status)) return;
    if (row.egress_id) await ctx.scheduler.runAfter(0, internal.callRecordings.stopEgresses, { ids: [], egress_ids: [row.egress_id] });
    if (row.status === "stopping" && row.started_at === undefined) {
      await dropUnrecorded(ctx, row);
      return;
    }
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "failed",
      error: args.error,
      stop_reason: row.stop_reason ?? "failed",
      ended_at: row.ended_at ?? (row.started_at !== undefined ? now : undefined),
      live_frame_key: undefined,
      updated_at: now,
    });
    if (row.live_frame_key) await ctx.scheduler.runAfter(0, internal.callRecordings.deleteObjects, { keys: [row.live_frame_key], attempt: 0 });
    if (row.kind === "composite" && row.status !== "stopping") await announceRecordEnd(ctx, row, { reason: "failed", detail: args.error });
  },
});

/** LiveKit forgot an egress twice running (it keeps finished ones only for a
 *  while), and the file it was writing is in the bucket: the recording
 *  finished while nobody was looking. It is ready, with the size the bucket
 *  reports and the end its upload landed at; LiveKit's own file times, if a
 *  look caught them earlier, stay. */
export const settleFromObject = internalMutation({
  args: { id: v.id("call_recordings"), size_bytes: v.optional(v.number()), uploaded_at: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || !isRecordingActive(row.status)) return;
    await ctx.db.patch(row._id, {
      status: "ready",
      stop_reason: row.stop_reason ?? (row.kind === "screen" ? "share_ended" : "huddle_ended"),
      ...(args.size_bytes !== undefined ? { size_bytes: args.size_bytes } : {}),
      ...(row.ended_at === undefined && row.duration_ms === undefined && args.uploaded_at !== undefined ? { ended_at: args.uploaded_at } : {}),
      live_frame_key: undefined,
      updated_at: Date.now(),
    });
    if (row.kind === "composite" && row.status !== "stopping") await announceRecordEnd(ctx, row, { reason: row.stop_reason ?? "huddle_ended" });
  },
});

/** Claim the screen file for one shared track in a run, or null when the run
 *  is no longer recording or the track already has its file (two looks at
 *  the room racing each other start one egress, not two). */
export const claimScreen = internalMutation({
  args: { run_id: v.id("call_recordings"), track_sid: v.string(), identity: v.string(), name: v.string() },
  handler: async (ctx, args): Promise<{ id: Id<"call_recordings">; r2_key: string; live_frame_key: string } | null> => {
    const run = await ctx.db.get(args.run_id);
    if (!run || (run.status !== "starting" && run.status !== "recording")) return null;
    const taken = await ctx.db
      .query("call_recordings")
      .withIndex("by_transcript", (q) => q.eq("transcript_id", run.transcript_id))
      .filter((q) => q.and(q.eq(q.field("run_id"), run._id), q.eq(q.field("track_sid"), args.track_sid)))
      .first();
    if (taken) return null;
    const now = Date.now();
    const file = { transcriptId: String(run.transcript_id), kind: "screen" as const, requestedAt: run.requested_at, trackSid: args.track_sid };
    const r2_key = callRecordingKey(file);
    const live_frame_key = liveFrameKey(callRecordingLiveFramePrefix(file));
    const id = await ctx.db.insert("call_recordings", {
      transcript_id: run.transcript_id,
      room_key: run.room_key,
      team_id: run.team_id,
      kind: "screen",
      status: "starting",
      r2_key,
      live_frame_key,
      track_sid: args.track_sid,
      participant_identity: args.identity,
      participant_name: args.name || undefined,
      run_id: run._id,
      started_by: run.started_by,
      requested_at: now,
      updated_at: now,
    });
    return { id, r2_key, live_frame_key };
  },
});

/** Stop one run from inside its loop: the room stood empty, the run outlived
 *  any meeting, or its room video ended while screens still record. Scoped to
 *  the run, so an old run's loop never ends somebody's newer press. */
export const stopRun = internalMutation({
  args: { room_key: v.string(), run_id: v.string(), reason: callRecordingStopReasonValidator },
  handler: async (ctx, args) => {
    return await stopRoomRecording(ctx, args.room_key, { reason: args.reason, runId: args.run_id });
  },
});

// ── The loop: actions ─────────────────────────────────────────────────────

function startErrorMessage(err: unknown): string {
  if (err instanceof LivekitApiError) {
    if (err.status === 401 || err.status === 403) return "LiveKit refused this server's credentials, so the recording could not start.";
    if (err.code === "resource_exhausted") return "LiveKit has no recording capacity free right now. Try again in a minute.";
    return `LiveKit could not start the recording (${err.code ?? err.status}).`;
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "LiveKit did not answer the request to start recording.";
  return `The recording could not start: ${err instanceof Error ? err.message : String(err)}`;
}

/** The live frame output for a file, or nothing for a row without one. */
function liveFrameFor(row: { live_frame_key?: string | null }, size?: { width: number; height: number } | null): LiveFrameOutput | undefined {
  if (!row.live_frame_key) return undefined;
  return { prefix: row.live_frame_key.replace(/\.jpeg$/, ""), intervalSeconds: LIVE_FRAME_INTERVAL_S, ...(size ? { width: size.width, height: size.height } : {}) };
}

/** The room's running egresses, or null when LiveKit could not be asked. */
async function roomEgresses(cfg: LivekitServerConfig, roomKey: string): Promise<LivekitEgress[] | null> {
  try {
    return await listEgress(cfg, { room: roomKey, active: true });
  } catch (err) {
    console.warn(`[callRecordings] could not list egresses for ${roomKey}:`, err);
    return null;
  }
}

/** A start whose answer never reached us (the request timed out, the action
 *  died, the response was lost) may still have started an egress. Look for
 *  it by the path it was asked to write, which is the row's own key: found,
 *  it is attached (and stopped if the row no longer wants it); not found,
 *  the row fails. If LiveKit cannot even be asked, the row fails all the
 *  same, and the sweep stops whatever egress turns up with no row. */
async function adoptOrFail(ctx: any, cfg: LivekitServerConfig, row: RecordingRow, running: LivekitEgress[] | null, error: string): Promise<void> {
  const egress = running?.find((e) => e.paths.includes(row.r2_key));
  if (egress) {
    const applied = await ctx.runMutation(internal.callRecordings.applyEgress, { id: row._id, egress, attach: true });
    if (applied.stop) await stopEgress(cfg, egress.egressId).catch((err) => console.warn(`[callRecordings] stop failed for ${egress.egressId}:`, err));
    return;
  }
  await ctx.runMutation(internal.callRecordings.failRecording, { id: row._id, error });
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
    const claim: { id: Id<"call_recordings">; r2_key: string; live_frame_key: string } | null = await ctx.runMutation(internal.callRecordings.claimScreen, {
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
        trackCompositeEgressRequest({
          room: run.room_key,
          videoTrackSid: share.trackSid,
          filepath: claim.r2_key,
          upload: egressS3Upload(bucket),
          ...(advanced ? { advanced } : {}),
          // At the share's own size: a frame of a screen is for reading it.
          liveFrame: liveFrameFor(claim, advanced),
        }),
      );
      const applied = await ctx.runMutation(internal.callRecordings.applyEgress, { id: claim.id, egress, attach: true });
      if (applied.stop) await stopEgress(cfg, egress.egressId);
    } catch (err) {
      const row: RecordingRow | null = await ctx.runQuery(internal.callRecordings.getRow, { id: claim.id });
      if (row) await adoptOrFail(ctx, cfg, row, await roomEgresses(cfg, run.room_key), startErrorMessage(err));
    }
  }
}

/** The press, carried out: ask LiveKit for the room composite, then for a
 *  file per screen already being shared. The run's loop was started by the
 *  press and needs nothing from here. */
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
    if (run.status !== "starting") {
      // Stopped before LiveKit was even asked: nothing to start (a stopping
      // row with nothing written is dropped). A failed one is already told.
      if (run.status === "stopping") await ctx.runMutation(internal.callRecordings.failRecording, { id: run._id, error: "Stopped before it began." });
      return;
    }
    try {
      const egress = await startRoomCompositeEgress(cfg, roomCompositeEgressRequest({ room: run.room_key, filepath: run.r2_key, upload: egressS3Upload(bucket), liveFrame: liveFrameFor(run) }));
      const applied = await ctx.runMutation(internal.callRecordings.applyEgress, { id: run._id, egress, attach: true });
      if (applied.stop) await stopEgress(cfg, egress.egressId);
    } catch (err) {
      await adoptOrFail(ctx, cfg, run, await roomEgresses(cfg, run.room_key), startErrorMessage(err));
      return;
    }
    try {
      await recordNewShares(ctx, cfg, bucket, run, info.rows, await listParticipants(cfg, run.room_key));
    } catch (err) {
      // The room's video is recording; a screen file missed here is picked
      // up by the loop's next look.
      console.warn(`[callRecordings] screen look failed for ${run._id}:`, err);
    }
  },
});

/** LiveKit answered "no such egress" for a file twice running. If its object
 *  is in the bucket, the file finished while nobody looked (LiveKit keeps
 *  finished egresses only for a while): settle it as ready. If not, it is
 *  lost: stop it in case LiveKit is still writing it after all, and fail
 *  the row with words that say so. */
async function settleLost(ctx: any, cfg: LivekitServerConfig, bucket: R2Bucket, row: RecordingRow): Promise<void> {
  try {
    const head = await fetch(await r2Presign(bucket, "HEAD", row.r2_key, 60), { method: "HEAD" });
    if (head.ok) {
      const size = Number(head.headers.get("content-length"));
      const modified = Date.parse(head.headers.get("last-modified") ?? "");
      await ctx.runMutation(internal.callRecordings.settleFromObject, {
        id: row._id,
        ...(Number.isFinite(size) && size > 0 ? { size_bytes: size } : {}),
        ...(Number.isFinite(modified) ? { uploaded_at: modified } : {}),
      });
      return;
    }
    if (head.status !== 404) return; // The bucket could not say: ask again next look.
  } catch (err) {
    console.warn(`[callRecordings] could not check ${row.r2_key}:`, err);
    return;
  }
  if (row.egress_id) await stopEgress(cfg, row.egress_id).catch(() => null);
  await ctx.runMutation(internal.callRecordings.failRecording, { id: row._id, error: "LiveKit lost track of this recording before it finished." });
}

/**
 * One look at a run: bring every file's row up to date with LiveKit, start a
 * file for a new screen share, stop the run when LiveKit's room has stood
 * empty of teammates (a tab that died never leaves) or the run has outlived
 * any meeting, and stop the screen files of a run whose composite has ended.
 * Then, if this is the run's loop (`gen`), look again while anything is still
 * being written; a one off look (`once`: a screen share just began) never
 * reschedules. `empty_since` carries the first look that found nobody, so a
 * blip between two people is not mistaken for an empty room; `missing` the
 * egresses LiveKit did not know on the last look, since one empty answer is
 * not proof that a file is gone.
 */
export const reconcileRun = internalAction({
  args: {
    run_id: v.id("call_recordings"),
    gen: v.optional(v.number()),
    once: v.optional(v.boolean()),
    empty_since: v.optional(v.number()),
    missing: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const looping = args.gen !== undefined && !args.once;
    const info: { run: RecordingRow; rows: RecordingRow[] } | null = looping
      ? await ctx.runMutation(internal.callRecordings.beginLook, { run_id: args.run_id, gen: args.gen! })
      : await ctx.runQuery(internal.callRecordings.runForAction, { run_id: args.run_id });
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
    const active = info.rows.filter((r) => isRecordingActive(r.status));
    // One question answers for every file still running; only a file that
    // has left LiveKit's running list is asked for by id, for its result.
    const running = active.length ? await roomEgresses(cfg, info.run.room_key) : [];
    const byId = new Map((running ?? []).map((e) => [e.egressId, e]));
    const missing: string[] = [];
    for (const row of active) {
      if (!row.egress_id) {
        if (now - row.requested_at > EGRESS_ACCEPT_TIMEOUT_MS && running) {
          await adoptOrFail(ctx, cfg, row, running, "LiveKit never started this recording.");
        }
        continue;
      }
      let egress: LivekitEgress | null = byId.get(row.egress_id) ?? null;
      if (!egress) {
        try {
          egress = await getEgress(cfg, row.egress_id);
        } catch (err) {
          // LiveKit unreachable for a moment: the next look tries again.
          console.warn(`[callRecordings] could not read egress ${row.egress_id}:`, err);
          continue;
        }
      }
      if (!egress) {
        if (args.missing?.includes(row.egress_id)) await settleLost(ctx, cfg, bucket, row);
        else missing.push(row.egress_id);
        continue;
      }
      const applied = await ctx.runMutation(internal.callRecordings.applyEgress, { id: row._id, egress });
      // A stop that LiveKit has not acted on after a while is asked again.
      if (applied.status === "stopping" && (egress.status === "starting" || egress.status === "active") && now - row.updated_at > STOP_RETRY_MS) {
        await stopEgress(cfg, row.egress_id).catch((err) => console.warn(`[callRecordings] stop retry failed for ${row.egress_id}:`, err));
      }
    }

    const fresh: { run: RecordingRow; rows: RecordingRow[] } | null = await ctx.runQuery(internal.callRecordings.runForAction, { run_id: args.run_id });
    if (!fresh) {
      if (looping) await ctx.runMutation(internal.callRecordings.endLoop, { run_id: args.run_id, gen: args.gen! });
      return;
    }
    const { run, rows } = fresh;
    const stop = (reason: "huddle_ended" | "limit" | "failed" | "share_ended" | "pressed") =>
      ctx.runMutation(internal.callRecordings.stopRun, { room_key: run.room_key, run_id: String(run._id), reason });
    let emptySince: number | undefined;
    let stopped = false;
    if (run.status === "starting" || run.status === "recording") {
      try {
        const participants = await listParticipants(cfg, run.room_key);
        if (huddleKeepers(participants).length === 0) {
          emptySince = args.empty_since ?? now;
          if (now - emptySince >= RECORDING_EMPTY_ROOM_STOP_MS) {
            await stop("huddle_ended");
            stopped = true;
          }
        } else if (now - run.requested_at > RECORDING_MAX_RUN_MS) {
          await stop("limit");
          stopped = true;
        } else {
          await recordNewShares(ctx, cfg, bucket, run, rows, participants);
        }
      } catch (err) {
        console.warn(`[callRecordings] room look failed for ${run.room_key}:`, err);
      }
    } else if (!isRecordingActive(run.status) && rows.some((r) => r.kind === "screen" && (r.status === "starting" || r.status === "recording"))) {
      // The room's video ended on its own (LiveKit's limit, a failure): its
      // screen files end with it.
      await stop(run.stop_reason ?? "failed");
      stopped = true;
    }

    if (!looping) return;
    const delay = stopped || emptySince !== undefined ? RECORDING_POLL_FAST_MS : nextPollDelayMs(rows);
    if (delay === null) {
      await ctx.runMutation(internal.callRecordings.endLoop, { run_id: args.run_id, gen: args.gen! });
      return;
    }
    await ctx.scheduler.runAfter(delay, internal.callRecordings.reconcileRun, {
      run_id: args.run_id,
      gen: args.gen,
      ...(emptySince !== undefined ? { empty_since: emptySince } : {}),
      ...(missing.length ? { missing } : {}),
    });
  },
});

/** Ask LiveKit to stop these files (stopRoomRecording has already marked
 *  them). A file whose egress is not known yet is stopped when LiveKit
 *  answers its start (applyEgress's `stop`); one that already ended answers
 *  null, which is fine. The loop writes the finished files. `egress_ids`
 *  stops egresses whose rows failed or went (failRecording): best effort,
 *  nothing to write back. */
export const stopEgresses = internalAction({
  args: { ids: v.array(v.id("call_recordings")), egress_ids: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const cfg = livekitConfigFromEnv();
    if (!cfg) return;
    for (const egressId of args.egress_ids ?? []) {
      await stopEgress(cfg, egressId).catch((err) => console.warn(`[callRecordings] stop failed for ${egressId}:`, err));
    }
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

// ── The sweep ─────────────────────────────────────────────────────────────

/** Every run LiveKit is still working on has a loop looking at it. An action
 *  can die (a deploy, a crash between two lines) or hang, and a run with no
 *  loop would read "recording" forever. A run whose loop has not looked for
 *  RECORDING_LOOP_STALE_MS gets a new loop with the next generation, which
 *  retires the old one if it ever wakes. */
export const restartStaleLoops = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const runs = new Map<string, number>();
    for (const status of ["starting", "recording", "stopping"] as const) {
      const rows = await ctx.db
        .query("call_recordings")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
      for (const r of rows) runs.set(runIdOf(r), Math.min(runs.get(runIdOf(r)) ?? Infinity, r.requested_at));
    }
    let restarted = 0;
    for (const [run, requestedAt] of runs) {
      const id = ctx.db.normalizeId("call_recordings", run);
      if (!id) continue;
      const loop = await recordingLoop(ctx, id);
      if (now - (loop?.looked_at ?? requestedAt) < RECORDING_LOOP_STALE_MS) continue;
      const gen = (loop?.gen ?? 0) + 1;
      if (loop) await ctx.db.patch(loop._id, { gen, looked_at: now });
      else await ctx.db.insert("call_recording_loops", { run_id: id, gen, looked_at: now });
      await ctx.scheduler.runAfter(0, internal.callRecordings.reconcileRun, { run_id: id, gen });
      restarted++;
    }
    return { runs: runs.size, restarted };
  },
});

/** What the app believes LiveKit is writing: every live row's egress and path. */
export const trackedEgresses = internalQuery({
  args: {},
  handler: async (ctx) => {
    const egressIds: string[] = [];
    const paths: string[] = [];
    for (const status of ["starting", "recording", "stopping"] as const) {
      for (const r of await ctx.db
        .query("call_recordings")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect()) {
        if (r.egress_id) egressIds.push(r.egress_id);
        paths.push(r.r2_key);
      }
    }
    return { egressIds, paths };
  },
});

/** The cron backstop (crons.ts), every two minutes: restart loops that went
 *  quiet, then stop every egress LiveKit is running into our recordings
 *  bucket that no live row tracks (by id or by the path it writes). Such an
 *  egress is a room being filmed while the app shows it is not: its row
 *  failed before the start was answered, or the answer was lost. The list is
 *  read before the rows, so an egress started after it was taken cannot be
 *  mistaken for one with no row. */
export const sweepRecordings = internalAction({
  args: {},
  handler: async (ctx): Promise<{ runs: number; restarted: number; orphans: number }> => {
    const loops: { runs: number; restarted: number } = await ctx.runMutation(internal.callRecordings.restartStaleLoops, {});
    const cfg = livekitConfigFromEnv();
    if (!cfg) return { ...loops, orphans: 0 };
    let live: LivekitEgress[];
    try {
      live = await listEgress(cfg, { active: true });
    } catch (err) {
      console.warn("[callRecordings] sweep could not list egresses:", err);
      return { ...loops, orphans: 0 };
    }
    const ours = live.filter((e) => e.paths.some((p) => p.startsWith(CALL_RECORDINGS_ROOT)));
    if (ours.length === 0) return { ...loops, orphans: 0 };
    const tracked: { egressIds: string[]; paths: string[] } = await ctx.runQuery(internal.callRecordings.trackedEgresses, {});
    const ids = new Set(tracked.egressIds);
    const paths = new Set(tracked.paths);
    let orphans = 0;
    for (const e of ours) {
      if (ids.has(e.egressId) || e.paths.some((p) => paths.has(p))) continue;
      orphans++;
      console.warn(`[callRecordings] stopping egress ${e.egressId} in ${e.roomName}: no live recording tracks it`);
      await stopEgress(cfg, e.egressId).catch((err) => console.warn(`[callRecordings] could not stop orphan ${e.egressId}:`, err));
    }
    return { ...loops, orphans };
  },
});

export const getRow = internalQuery({
  args: { id: v.id("call_recordings") },
  handler: async (ctx, args) => await ctx.db.get(args.id),
});
