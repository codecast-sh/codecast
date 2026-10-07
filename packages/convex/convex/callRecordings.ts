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
//              room's thread saying who. A deleted team's recordings all go
//              once its restore window passes (purgeTeamRecordings).
//   sweep      a cron restarts a run's loop that stopped looking, and stops any
//              LiveKit egress writing into the bucket that no live row tracks,
//              so nothing can film a room the app says is not being filmed.
//
// Recording is never automatic. A press starts it, every client in the room
// is told (the indicator reads isRoomRecording; the thread gets a line), and
// people who join later read the same state.

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { CALL_RECORDING_URL_WINDOW_MS, FRAME_SHARE_REFUSED_WORDS, type CallRecordingStopReason, callSpeakerName, guestIdFromIdentity, guestIdentity, isGuestPresent, isRecordingActive, isRecordingFilming, recordingCooling, shareIncludesVideo } from "@codecast/shared/contracts";
import { callRefId } from "@codecast/shared/entities";
import { verifyApiToken } from "./apiTokens";
import { sha256Hex } from "./lib/hash";
import { authorizeRoom, isRoomTranscribeOff, liveMembers, liveSeat, readRoomState } from "./callRooms";
import { liveTranscriptFor, postEvent } from "./callChat";
import { guestBySecret } from "./callGuests";
import { beginCallRecord, canReadCall, HUDDLE_GRACE_MS, resolveCallRef } from "./transcripts";
import { isTeamAdmin } from "./privacy";
import { nextShortId } from "./counters";
import {
  callRecordingKey,
  callRecordingLiveFramePrefix,
  callRecordingRunPrefixOfKey,
  callRecordingManifestKey,
  callRecordingsBucketFromEnv,
  CALL_RECORDINGS_ROOT,
  callRecordingSigner,
  liveFrameKey,
  r2ListKeys,
  r2ListObjects,
  r2Presign,
  type CallRecordingSigner,
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
  egressMovesRow,
  endsByItself,
  selfEndReason,
  deleteFrameShare,
  deleteFrameShares,
  deleteCallFrameShares,
  callTeamRetired,
  egressPatch,
  EGRESS_ACCEPT_TIMEOUT_MS,
  ACTIVE_STATUSES,
  EGRESS_BEGIN_TIMEOUT_MS,
  EGRESS_BUSY_MESSAGE,
  type RecordingFailure,
  huddleKeepers,
  LIVE_FRAME_INTERVAL_S,
  liveRoomRun,
  mayDeleteRun,
  nextPollDelayMs,
  noteRecordedPeople,
  purgeCallRecordings,
  emptyRoomStopDue,
  RECORDING_LOOP_STALE_MS,
  RECORDING_MAX_RUN_MS,
  RECORDING_ORPHAN_WINDOW_MS,
  RECORDING_POLL_FAST_MS,
  RECORDING_OUTAGE_TTL_MS,
  RECORDING_MINUTES_SPENT_MESSAGE,
  EGRESS_UNREACHABLE_FAIL_MS,
  forgetRecordingOutage,
  isMinutesSpentText,
  mayShareFrame,
  mayShareVideo,
  noteRecordingOutage,
  plainStoredError,
  recordingOutage,
  sharedVideoRuns,
  stopRequestedAt,
  saveOverdue,
  mayLandLate,
  recordingConfigured,
  recordingLoop,
  restampRunShare,
  runVideoShared,
  runIdOf,
  filmedSpan,
  screenEncoding,
  screenSharesToRecord,
  screenStartRetryable,
  COMPOSITE_RETRY_GAP_MS,
  START_RETRY_LIMIT,
  STOP_RETRY_MS,
  stopRoomRecording,
  syncCallVideo,
  runStarterName,
  teammateName,
} from "./lib/callRecordingRuns";
import { callRecordingErrorKindValidator, callRecordingStopReasonValidator } from "./lib/callValidators";

type RecordingRow = Doc<"call_recordings">;

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
    // LiveKit refused for spent minutes a moment ago: refuse here, before
    // the room is told anything (lib/callRecordingRuns recordingOutage). The
    // presser reads the reason; nobody else hears a chime for nothing.
    const outage = await recordingOutage(ctx);
    if (outage && now - outage.since < RECORDING_OUTAGE_TTL_MS) throw new Error(outage.reason);
    const justStopped = (await activeRoomRecordings(ctx, args.room_key)).some(
      (r) => r.kind === "composite" && recordingCooling(r.status, stopRequestedAt(r), now),
    );
    if (justStopped) throw new Error("Recording just stopped and is still saving. Try again in a few seconds.");

    const record =
      (await liveTranscriptFor(ctx, args.room_key)) ??
      (await ctx.db.get(
        await beginCallRecord(ctx, {
          roomKey: args.room_key,
          teamId: auth.teamId,
          userId,
          routes: [],
          announce: false,
          // Filming a room that switched transcription off must not feed
          // (and so summon) its session's agent: the route waits for
          // transcription to come back on (transcripts.ensureOwnRoute).
          ownRoute: !(await isRoomTranscribeOff(ctx, args.room_key)),
          // The presser owns the record but is no scribe: on a phone they
          // never will be, and holding the seat would leave every other
          // client observing a transcript nobody writes.
          scribeOpen: true,
        }),
      ))!;
    // The live notice names the call by its short id and reads it off the
    // run, never the record (roomRecordingState): a record older than short
    // ids gets its own now, by the same counter every new record takes.
    let shortId = record.short_id;
    if (!shortId) {
      shortId = await nextShortId(ctx.db, "cl");
      await ctx.db.patch(record._id, { short_id: shortId });
    }
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
      started_by_name: await teammateName(ctx, userId),
      requested_at: now,
      call_short_id: shortId,
      call_started_at: record.started_at,
      video_shared: runVideoShared(record, { requested_at: now }),
      updated_at: now,
    });
    await syncCallVideo(ctx, record._id);
    // Everyone seated now is in the video, so everyone seated now may watch
    // the call: all of it (canReadCall's recorded_people door), every run and
    // the transcript, not only the stretch they sat through.
    const seated = liveMembers(
      await ctx.db
        .query("call_members")
        .withIndex("by_room", (q) => q.eq("room_key", args.room_key))
        .collect(),
      now,
    );
    await noteRecordedPeople(ctx, args.room_key, [userId, ...seated.map((m) => m.user_id)], await ctx.db.get(id));
    await postEvent(ctx, { room_key: args.room_key, team_id: record.team_id, user_id: userId, event: "record_on", run_id: String(id) });
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
 *  off): a recording is everyone's to end. `run_id` is the run the person was
 *  looking at when they pressed: a Stop rides a durable outbox and may land
 *  late, after that run ended and somebody started another, which it must
 *  not end. Scoped to that run, a run already ended leaves the press nothing
 *  to stop. A client that sends none stops whatever runs. */
export const stopRecording = mutation({
  args: { room_key: v.string(), run_id: v.optional(v.string()) },
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
    return await stopRoomRecording(ctx, args.room_key, { reason: "pressed", stoppedBy: String(userId), announceAs: userId, runId: args.run_id });
  },
});

/** A guest in the huddle stops its recording: anyone in the room may, guests
 *  included. Proven the way every guest call is (callGuests: the id and the
 *  secret their browser holds), and only while admitted and present. The
 *  thread names them as the guest they are. */
export const guestStopRecording = mutation({
  args: { guest_id: v.string(), secret: v.string(), run_id: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ stopped: number }> => {
    const guest = await guestBySecret(ctx, args.guest_id, args.secret);
    if (!guest || guest.status !== "admitted" || !isGuestPresent(guest, Date.now())) {
      throw new Error("Only someone in the huddle can stop recording");
    }
    return await stopRoomRecording(ctx, guest.room_key, {
      reason: "pressed",
      stoppedBy: guestIdentity(String(guest._id)),
      guestName: guest.name,
      runId: args.run_id,
    });
  },
});

// ── Live state ────────────────────────────────────────────────────────────

/** Who a LiveKit identity is, as the room knew them: a guest by the name the
 *  room let in (marked as a guest), anyone else by their teammate name. */
async function identityName(ctx: any, roomKey: string, identity: string): Promise<string> {
  const guestId = guestIdFromIdentity(identity);
  if (!guestId) return await teammateName(ctx, identity);
  const id = ctx.db.normalizeId("call_guests", guestId);
  const guest = id ? await ctx.db.get(id) : null;
  return callSpeakerName(identity, guest && guest.room_key === roomKey ? guest.name : null);
}

/** How the room's last run ended: the composite most recently pressed for
 *  among those no longer filming (being finished, finished, or failed), with
 *  what a notice needs to say it truthfully. A run that failed or never began
 *  left no video, and one somebody stopped is said with their name. Where
 *  the video went rides along (the call, its short id, and where in the call
 *  the file begins), so the notice can name the call and open it at the
 *  run; all three come off the run row, never the call record, which moves
 *  with every transcript line. No clock here (a query reading the time would
 *  not re-run as it passes): a client matches it to the run it saw end. */
export async function roomRecordingEnd(ctx: any, roomKey: string) {
  let last: RecordingRow | null = null;
  for (const status of ["stopping", "ready", "failed"] as const) {
    const rows: RecordingRow[] = await ctx.db
      .query("call_recordings")
      .withIndex("by_room_status", (q: any) => q.eq("room_key", roomKey).eq("status", status))
      .order("desc")
      .take(8);
    for (const r of rows) if (r.kind === "composite" && (!last || r.requested_at > last.requested_at)) last = r;
  }
  if (!last) return null;
  return {
    run_id: String(last._id),
    status: last.status as "stopping" | "ready" | "failed",
    stop_reason: last.stop_reason ?? null,
    error: plainStoredError(last.error),
    stopped_by: last.stopped_by ? { id: last.stopped_by, name: await identityName(ctx, roomKey, last.stopped_by) } : null,
    // Whose recording it was, and whether its video was lost while it saved
    // after a stop the room was already told of: its presser is owed a word
    // that the video is gone (roomRecordingEnd's owedStopNotice).
    started_by: String(last.started_by),
    lost: mayLandLate(last),
    transcript_id: String(last.transcript_id),
    short_id: last.call_short_id ?? null,
    at_ms: last.started_at != null && last.call_started_at != null ? Math.max(0, last.started_at - last.call_started_at) : null,
  };
}

/** How the room's last run ended, alone: what the room's stop notice
 *  subscribes to. Its read set is the room's ended runs, so it re-runs
 *  only while a run ends and its file lands, never with the live run or
 *  the transcript. Gated
 *  like the room itself (authorizeRoom). */
export const getRoomRecordingEnd = query({
  args: { room_key: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    if (!(await authorizeRoom(ctx, userId, args.room_key)).ok) return null;
    return await roomRecordingEnd(ctx, args.room_key);
  },
});

// ── A call's files ────────────────────────────────────────────────────────

/** The object keys a `keys: true` caller is handed beside each file. */
type FileKeys = { r2_key: string; live_frame_key: string | null };

/** Every file of a call, in the order they were pressed for, with what a
 *  reader needs to align them: the call's own started_at (transcript lines
 *  are ms since it) and each file's time 0 (locateCallMoment does the rest).
 *  `sign` mints a finished file's URL (none when the bucket is not set up);
 *  `keys` hands the rows' object keys instead, to a caller that signs on its
 *  own clock (the CLI route) and strips them. An MP4 is uploaded whole when
 *  it ends, so a file still being written has no URL. The caller has already
 *  passed canReadCall. `liveWatch` (with `keys`) says whether the caller may
 *  also have the live frame's key (mayWatchLive). */
export async function callRecordingsCore<K extends boolean = false>(
  ctx: any,
  call: Doc<"transcripts">,
  userId: Id<"users">,
  opts: { sign?: CallRecordingSigner | null; keys?: K; liveWatch?: boolean },
) {
  const rows = await callRows(ctx, call._id);
  const byRun = new Map<string, RecordingRow[]>();
  for (const r of rows) byRun.set(runIdOf(r), [...(byRun.get(runIdOf(r)) ?? []), r]);
  const admin = await isTeamAdmin(ctx, userId, call.team_id);
  const names = new Map<string, string>();
  for (const r of rows) if (!names.has(String(r.started_by))) names.set(String(r.started_by), await runStarterName(ctx, r));
  const recordings = [];
  for (const r of rows) {
    const signed = r.status === "ready" && opts.sign ? await opts.sign(r.r2_key) : null;
    const view = {
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
      error: plainStoredError(r.error),
      url: signed?.url ?? null,
      url_expires_at: signed?.expiresAt ?? null,
      // The button and the mutation ask the same question of the same rows.
      can_delete: mayDeleteRun(String(userId), byRun.get(runIdOf(r)) ?? [r], admin).ok,
    };
    // The keys ride only with `keys: true`, and the type says so: a caller
    // that asked for them reads them without a cast, any other cannot.
    const keys: FileKeys | null = opts.keys ? { r2_key: r.r2_key, live_frame_key: (opts.liveWatch && r.live_frame_key) || null } : null;
    recordings.push((keys ? { ...view, ...keys } : view) as typeof view & (K extends true ? FileKeys : unknown));
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
    // Room videos finished after the video was put on the link, which the
    // link does not show until somebody includes them (sharedVideoRuns).
    video_later: shareIncludesVideo(call) ? sharedVideoRuns(rows, call.share_video_through).later.length : 0,
    // Whether this viewer may put the video on the link (mayShareVideo), so
    // the switch says who can rather than failing on the press.
    can_share_video: mayShareVideo(String(userId), publishableComposites(rows), admin),
    // The pictures of this call on public links, each with a way down.
    frame_shares: await callFrameSharesView(ctx, call, rows),
    // Whether the live frames were handed over (the CLI's refusal says why
    // when they were not); only asked with `keys`.
    ...(opts.keys ? { live_watch: !!opts.liveWatch } : {}),
    recordings,
  };
}

/**
 * Who may see a call as it is NOW, through the live frame LiveKit rewrites
 * every few seconds while it records. Reading the call (canReadCall) is not
 * enough: in a channel huddle that is every channel member, and a live frame
 * polled from outside would let them watch the room, screens and guests'
 * faces included, without a face, a presence entry or a line in the thread
 * telling anyone. The room agreed to a video it can watch later, not to
 * unseen watchers now. So the live picture is for someone sitting in the room
 * (whom the room sees), or the owner of a session the call is feeding live
 * (call_agent_feeds: an agent the room added, whose answers are in the
 * thread). Everyone else waits for the saved file, like the call page does.
 */
export async function mayWatchLive(ctx: any, userId: Id<"users">, call: Doc<"transcripts">, now: number = Date.now()): Promise<boolean> {
  if (await liveSeat(ctx, userId, call.room_key, now)) return true;
  const feeds = await ctx.db
    .query("call_agent_feeds")
    .withIndex("by_transcript", (q: any) => q.eq("transcript_id", call._id))
    .collect();
  for (const feed of feeds) {
    const conv = await ctx.db.get(feed.conversation_id);
    if (conv && String(conv.user_id) === String(userId)) return true;
  }
  return false;
}

/** How far ahead of the server's clock a page may ask to be signed: enough
 *  for a client whose clock runs a little fast, or that moves to the next
 *  window a beat early, and no more. */
export const SIGNING_LEAD_MS = 60_000;

/** The moment a page's URLs are signed at: the window it asked for, no more
 *  than one window behind now and SIGNING_LEAD_MS ahead. A URL is signed at
 *  its window's start and lives two windows (lib/r2 stableSigningWindow), so
 *  nothing minted here works later than now + 2 windows + the lead, which is
 *  how late a revocation can land, and nothing carries a signing date far
 *  enough ahead for the bucket to refuse it as not valid yet. */
export function signingMoment(urlWindow: number, now: number): number {
  const asked = urlWindow * CALL_RECORDING_URL_WINDOW_MS;
  return Math.min(now + SIGNING_LEAD_MS, Math.max(now - CALL_RECORDING_URL_WINDOW_MS, asked));
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
    const at = signingMoment(args.url_window, Date.now());
    return callRecordingsCore(ctx, t, userId, { sign: callRecordingSigner({ stable: { at, windowMs: CALL_RECORDING_URL_WINDOW_MS } }) });
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
    if (!t) return null;
    return callRecordingsCore(ctx, t, auth.userId, { keys: true, liveWatch: await mayWatchLive(ctx, auth.userId, t) });
  },
});

/** The route's answer: every finished file with a URL signed now for ten
 *  minutes (one seek's worth, and useless soon after the access check), and
 *  every file still recording with its live frame, the picture of the call
 *  as it is now (rewritten every LIVE_FRAME_INTERVAL_S), when the caller may
 *  watch it live (mayWatchLive; `live_watch` says which). `server_now` lets a
 *  caller on a skewed clock tell "now" from "a moment ago". Keys never leave
 *  the server. */
export async function signForCli(res: Awaited<ReturnType<typeof callRecordingsCore<true>>>) {
  const sign = callRecordingSigner("fresh");
  const now = Date.now();
  const recordings = [];
  for (const r of res.recordings) {
    const { r2_key, live_frame_key, ...rest } = r;
    const file = sign && r.status === "ready" && r2_key ? await sign(r2_key) : null;
    const frame = sign && r.status === "recording" && live_frame_key ? await sign(live_frame_key) : null;
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

/** The room videos a press of "include the video" would put on the link:
 *  every room video of the call that is, or will be, a file (a failed run
 *  publishes nothing). Who pressed each is what mayShareVideo asks. */
function publishableComposites(rows: RecordingRow[]): RecordingRow[] {
  return rows.filter((r) => r.kind === "composite" && r.status !== "failed");
}

/** Include the call's video with its public link, or stop including it, only
 *  for a link that exists. Taking it off needs only what reading the call
 *  needs. Putting it on publishes faces and screens to anyone with the link,
 *  so it takes the authority deleting does (mayShareVideo): whoever pressed
 *  Record for every room video it would publish, or a team admin. It covers
 *  the room videos pressed for until now (`share_video_through`): a run
 *  recorded later is not public until somebody includes it, and pressing
 *  include again moves the cutoff to now. */
export const setCallShareVideo = mutation({
  args: { call: v.string(), include: v.boolean() },
  handler: async (ctx, args): Promise<{ video_shared: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const t = await resolveCallRef(ctx, userId, args.call);
    if (!t) throw new Error("Not found");
    // Putting faces and screens on the open web, or taking them off, is
    // news to the people filmed, the way a picture of them is
    // (cliNoteFrameShare): a line in the room's thread, once per change.
    const tell = (event: "video_shared" | "video_unshared", span?: { from_ms: number; to_ms: number } | null) =>
      postEvent(ctx, { room_key: t.room_key, team_id: t.team_id, user_id: userId, event, transcript_id: t._id, ...(span ? { span } : {}) });
    const wasShared = shareIncludesVideo(t);
    if (!args.include) {
      await ctx.db.patch(t._id, { share_video_token: undefined, share_video_through: undefined });
      await restampRunShare(ctx, { ...t, share_video_token: undefined, share_video_through: undefined });
      if (wasShared) await tell("video_unshared");
      return { video_shared: false };
    }
    if (!t.share_token) throw new Error("Turn on the share link first");
    const rows = await callRows(ctx, t._id);
    const publishable = publishableComposites(rows);
    if (!mayShareVideo(String(userId), publishable, await isTeamAdmin(ctx, userId, t.team_id))) {
      throw new Error("Only whoever recorded this call, or a team admin, can put its video on the public link");
    }
    const through = Date.now();
    await ctx.db.patch(t._id, { share_video_token: t.share_token, share_video_through: through });
    await restampRunShare(ctx, { ...t, share_video_token: t.share_token, share_video_through: through });
    // Pressed again, it moves the cutoff to now: news only when that puts a
    // run on the link that was not on it (one pressed for since the last
    // choice, finished or still filming).
    const prior = t.share_video_through;
    const widened = publishable.some((r) => prior != null && r.requested_at >= prior && r.requested_at < through);
    if (!wasShared || widened) await tell("video_shared", filmedSpan(sharedVideoRuns(rows, through).shared, t.started_at));
    return { video_shared: true };
  },
});

/** The finished room recordings a share link shows, oldest first: never a
 *  single person's screen file. None while the call's team is deleted
 *  (callTeamRetired, the same rule that hides the link's words): the public
 *  link stops serving its video at once rather than for the whole restore
 *  window (purgeTeamRecordings removes the files when it ends; a restore
 *  brings the link back as it was). */
async function sharedVideoRows(ctx: any, call: Doc<"transcripts">): Promise<RecordingRow[]> {
  if (!shareIncludesVideo(call)) return [];
  if (await callTeamRetired(ctx, call)) return [];
  return sharedVideoRuns(await callRows(ctx, call._id), call.share_video_through).shared;
}

/** Where the redirect lives: under /cli/, the prefix the proxy in front of
 *  prod forwards to HTTP actions today (http.ts). */
export const SHARED_CALL_VIDEO_PATH = "/cli/share/call/video";

/** The video of a publicly shared call, for its share page: each finished
 *  room recording with its time 0, so the page can follow the transcript. No
 *  names, no ids, no keys: an entry is told apart by its time 0 (stable when
 *  an earlier run is deleted), and its URL is this deployment's redirect
 *  (SHARED_CALL_VIDEO_PATH), which checks the link again on every request
 *  and answers with a fresh, short URL into the bucket. So the share query
 *  has no clock in it, and turning the link off
 *  stops the video at the next request rather than a window later. The
 *  caller has already resolved the share token. */
export async function sharedCallVideos(ctx: any, call: Doc<"transcripts">) {
  if (!callRecordingsBucketFromEnv()) return [];
  const site = (process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");
  return (await sharedVideoRows(ctx, call)).map((r) => ({
    id: `v${r.started_at}`,
    started_at: r.started_at!,
    duration_ms: r.duration_ms ?? null,
    url: `${site}${SHARED_CALL_VIDEO_PATH}?token=${encodeURIComponent(call.share_token!)}&at=${r.started_at}`,
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
    const out = await deleteRecordingRun(ctx, userId, args.recording_id);
    if (!out.ok) throw new Error(out.message);
    return { deleted: out.deleted };
  },
});

export type DeleteRecordingOutcome =
  | { ok: true; deleted: number }
  | { ok: false; code: "NOT_FOUND" | "STILL_RECORDING" | "FORBIDDEN"; message: string };

/** deleteRecording's work, its refusals answered rather than thrown, so the
 *  store's receipt-backed delete (dispatch deleteCallRecording) can record a
 *  refusal as the command's outcome and roll the run back on the client. */
export async function deleteRecordingRun(ctx: any, userId: Id<"users">, recordingId: string): Promise<DeleteRecordingOutcome> {
  const id = ctx.db.normalizeId("call_recordings", recordingId);
  const row = id ? await ctx.db.get(id) : null;
  const call = row ? await ctx.db.get(row.transcript_id) : null;
  // One error for "no row" and "not yours to read", so a probe learns nothing.
  if (!row || !call || !(await canReadCall(ctx, userId, call))) return { ok: false, code: "NOT_FOUND", message: "Recording not found" };
  const runRows = (await callRows(ctx, call._id)).filter((r) => runIdOf(r) === runIdOf(row));
  const verdict = mayDeleteRun(String(userId), runRows, await isTeamAdmin(ctx, userId, call.team_id));
  if (!verdict.ok) {
    return verdict.reason === "still_recording"
      ? { ok: false, code: "STILL_RECORDING", message: "Stop the recording before deleting it" }
      : { ok: false, code: "FORBIDDEN", message: "Only whoever started this recording, or a team admin, can delete it" };
  }
  for (const r of runRows) {
    await deleteFrameShares(ctx, r._id);
    await ctx.db.delete(r._id);
  }
  const loop = await recordingLoop(ctx, runIdOf(row) as Id<"call_recordings">);
  if (loop) await ctx.db.delete(loop._id);
  await scheduleObjectDelete(ctx, runRows, { wholeRun: true });
  await syncCallVideo(ctx, call._id);
  const span = filmedSpan(runRows, call.started_at);
  await postEvent(ctx, {
    room_key: call.room_key,
    team_id: call.team_id,
    user_id: userId,
    event: "record_deleted",
    transcript_id: call._id,
    run_id: runIdOf(row),
    ...(span ? { span } : {}),
  });
  return { ok: true, deleted: runRows.length };
}

/** The kinds of picture a shared frame may be: what ffmpeg writes (PNG) and
 *  what the CLI's size ladder re-encodes an oversized one to (JPEG), each
 *  known by its first bytes. The object is served publicly under the type it
 *  is stored with, so nothing else is stored under an image's name. */
const FRAME_SHARE_TYPES: { type: string; magic: number[] }[] = [
  { type: "image/png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
];
/** Larger than any frame the CLI sends (it downscales past 5 MB). */
const FRAME_SHARE_MAX_BYTES = 8 * 1024 * 1024;

export function frameShareType(bytes: Uint8Array): string | null {
  return FRAME_SHARE_TYPES.find((t) => t.magic.every((b, i) => bytes[i] === b))?.type ?? null;
}

/** The recording file a CLI caller may share a frame of: the row and its call,
 *  when the token's user can read the call (one answer for "no row" and "not
 *  yours", as everywhere else) and may publish a picture of it
 *  (mayShareFrame: putting a frame on a public link takes the authority
 *  putting the video there does, or the screen being the caller's own). A
 *  reader without it is refused in words that say who can (the CLI adds the
 *  access-checked alternative: cite the moment). */
async function frameShareTarget(ctx: any, apiToken: string, recordingId: string) {
  const auth = await verifyApiToken(ctx, apiToken);
  if (!auth) throw new Error("Unauthorized");
  const id = ctx.db.normalizeId("call_recordings", recordingId);
  const row = id ? await ctx.db.get(id) : null;
  const call = row ? await ctx.db.get(row.transcript_id) : null;
  if (!row || !call || !(await canReadCall(ctx, auth.userId, call))) throw new Error("Recording not found");
  const runRows = (await callRows(ctx, call._id)).filter((r) => runIdOf(r) === runIdOf(row));
  if (!mayShareFrame(String(auth.userId), row, runRows, await isTeamAdmin(ctx, auth.userId, call.team_id))) {
    throw new ConvexError({ code: "FORBIDDEN", message: FRAME_SHARE_REFUSED_WORDS });
  }
  return { row, call, userId: auth.userId as Id<"users"> };
}

async function frameSharesOf(ctx: any, recordingId: Id<"call_recordings">) {
  return await ctx.db
    .query("call_frame_shares")
    .withIndex("by_recording", (q: any) => q.eq("recording_id", recordingId))
    .collect();
}

/** Before anything is stored: the caller may share from this file, and the
 *  same picture already shared from it (by content) is answered with its
 *  object, so a frame shared twice is one image and one link. */
export const frameShareCheck = internalQuery({
  args: { api_token: v.string(), recording_id: v.string(), sha256: v.string() },
  handler: async (ctx, args): Promise<{ storage_id: Id<"_storage"> | null }> => {
    const { row } = await frameShareTarget(ctx, args.api_token, args.recording_id);
    const same = (await frameSharesOf(ctx, row._id)).find((s: any) => s.sha256 === args.sha256);
    return { storage_id: same?.storage_id ?? null };
  },
});

/** Record a frame the share action itself just stored, tied to the file it
 *  was taken from so deleting the recording deletes the image
 *  (deleteFrameShares). Internal on purpose: the storage id only ever comes
 *  from ctx.storage.store in cliShareFrame, never from a client, because
 *  deleting the run deletes whatever object a row names. Access is asked
 *  again here, since it may have changed while the bytes were stored. */
export const cliNoteFrameShare = internalMutation({
  args: { api_token: v.string(), recording_id: v.string(), storage_id: v.id("_storage"), sha256: v.string(), at_ms: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const { row, call, userId } = await frameShareTarget(ctx, args.api_token, args.recording_id);
    const existing = await frameSharesOf(ctx, row._id);
    if (!existing.some((s: any) => s.storage_id === args.storage_id)) {
      await ctx.db.insert("call_frame_shares", {
        recording_id: row._id,
        transcript_id: call._id,
        storage_id: args.storage_id,
        sha256: args.sha256,
        user_id: userId,
        created_at: Date.now(),
        ...(args.at_ms !== undefined ? { at_ms: Math.max(0, Math.round(args.at_ms)) } : {}),
      });
      // The room hears that a picture of it went public: a line in its
      // thread, with the moment, so the people in the call (and anyone who
      // reads it later) see it happened, and the call page lists it with a
      // way to take it down (webCallRecordings `frame_shares`).
      await postEvent(ctx, {
        room_key: call.room_key,
        team_id: call.team_id,
        user_id: userId,
        event: "frame_shared",
        transcript_id: call._id,
        run_id: runIdOf(row),
        ...(args.at_ms !== undefined ? { detail: callRefId(call.short_id ?? String(call._id), undefined, Math.max(0, Math.round(args.at_ms))) } : {}),
      });
    }
    return { ok: true };
  },
});

/** The pictures of a call shared by link, newest first, for its page (under
 *  the share control, each with a way to take it down). Each names the
 *  moment and the view it shows, who shared it, and its public URL, which is
 *  what anyone holding the link sees. */
async function callFrameSharesView(ctx: any, call: Doc<"transcripts">, rows: RecordingRow[]) {
  const shares = await ctx.db
    .query("call_frame_shares")
    .withIndex("by_transcript", (q: any) => q.eq("transcript_id", call._id))
    .collect();
  const files = new Map(rows.map((r) => [String(r._id), r]));
  const names = new Map<string, string>();
  const out = [];
  for (const s of shares.sort((a: any, b: any) => b.created_at - a.created_at)) {
    const file = files.get(String(s.recording_id));
    if (!names.has(String(s.user_id))) names.set(String(s.user_id), await teammateName(ctx, s.user_id));
    out.push({
      _id: String(s._id),
      recording_id: String(s.recording_id),
      kind: file?.kind ?? null,
      participant_identity: file?.participant_identity ?? null,
      participant_name: file?.participant_name ?? null,
      at_ms: s.at_ms ?? null,
      url: (await ctx.storage.getUrl(s.storage_id)) ?? null,
      shared_by: String(s.user_id),
      shared_by_name: names.get(String(s.user_id))!,
      created_at: s.created_at,
    });
  }
  return out;
}

/** Take a picture off its public link. Anyone who may read the call may: it
 *  makes the call less public, as taking the video off the link does. A
 *  picture already gone is acknowledged, so a second press (or another
 *  window's) is not an error. */
export async function deleteFrameShareFor(ctx: any, userId: Id<"users">, shareId: string): Promise<{ deleted: boolean }> {
  const id = ctx.db.normalizeId("call_frame_shares", shareId);
  const share = id ? await ctx.db.get(id) : null;
  if (!share) return { deleted: false };
  const call = await ctx.db.get(share.transcript_id);
  if (!call || !(await canReadCall(ctx, userId, call))) return { deleted: false };
  await deleteFrameShare(ctx, share);
  return { deleted: true };
}

export const deleteCallFrameShare = mutation({
  args: { share_id: v.string() },
  handler: async (ctx, args): Promise<{ deleted: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    return await deleteFrameShareFor(ctx, userId, args.share_id);
  },
});

/**
 * `cast call snap --share`: store one frame as a public image, tied to the
 * recording file it came from. The CLI sends the picture itself (base64 in
 * the JSON body) rather than a storage id from `cast image`, because a
 * `_storage` object has no owner: a share row naming someone else's object
 * (an attachment, an avatar, a session's image the CLI's upload cache
 * reused) would let deleting the recording destroy it. Here the only id a
 * row can hold is one this action just created.
 */
export const cliShareFrame = internalAction({
  args: { api_token: v.string(), recording_id: v.string(), image_base64: v.string(), at_ms: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ url: string; storage_id: string }> => {
    const bytes = Uint8Array.from(atob(args.image_base64), (c) => c.charCodeAt(0));
    if (bytes.length > FRAME_SHARE_MAX_BYTES) throw new Error(`Frame too large to share (${(bytes.length / 1e6).toFixed(1)} MB)`);
    const type = frameShareType(bytes);
    if (!type) throw new Error("A shared frame must be a PNG or JPEG");
    const sha256 = await sha256Hex(bytes);
    const known = await ctx.runQuery(internal.callRecordings.frameShareCheck, { api_token: args.api_token, recording_id: args.recording_id, sha256 });
    let storageId = known.storage_id;
    if (!storageId) {
      const stored = await ctx.storage.store(new Blob([bytes], { type }));
      try {
        await ctx.runMutation(internal.callRecordings.cliNoteFrameShare, {
          api_token: args.api_token,
          recording_id: args.recording_id,
          storage_id: stored,
          sha256,
          ...(args.at_ms !== undefined ? { at_ms: args.at_ms } : {}),
        });
      } catch (err) {
        // Refused between the check and the write (access lost, the run
        // deleted): the object would belong to nothing, so it goes.
        await ctx.storage.delete(stored).catch(() => {});
        throw err;
      }
      storageId = stored;
    }
    const url = await ctx.storage.getUrl(storageId);
    if (!url) throw new Error("Could not resolve the shared frame's URL");
    return { url, storage_id: String(storageId) };
  },
});

/** Queue the bucket cleanup for rows that are gone: each row's file, live
 *  frame and LiveKit's manifest for it (which names the room and who was in
 *  it, so it goes with the video), and (`wholeRun`) everything under the
 *  run's prefix, so an object
 *  LiveKit wrote under a name no row holds (an upload that landed after its
 *  row failed, a partial file) goes with them. Deleting a key that is not
 *  there costs nothing (S3 answers 204), so it is never filtered first. */
async function scheduleObjectDelete(ctx: any, rows: RecordingRow[], opts: { wholeRun: boolean }): Promise<void> {
  const keys = [
    ...new Set(rows.flatMap((r) => [r.r2_key, r.live_frame_key, callRecordingManifestKey(r.r2_key, r.egress_id)].filter((k): k is string => !!k))),
  ];
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

// ── A deleted team's recordings ───────────────────────────────────────────

/** A call still being filmed when its turn comes waits this long and is
 *  looked at again: deleting its rows would stop the loop tracking an egress
 *  that is still uploading under the call's prefix. */
const PURGE_ACTIVE_RETRY_MS = 60 * 60 * 1000;

const PURGE_PAGE = 25;

/** The sweep teams.retireTeam schedules: every call record the team filed,
 *  a page at a time, each call's recordings purged. A team restored before
 *  this runs keeps everything. A call still recording is skipped and the
 *  sweep comes back for it, so nothing filmed is left behind.
 *
 *  `frames` is the first pass, scheduled at the delete itself: only the
 *  pictures shared from the team's calls, which are public storage URLs no
 *  check stands in front of, so they cannot wait out the restore window the
 *  way the private files do (the transcript and video links stop serving at
 *  once by callTeamRetired). A restore does not bring them back. */
export const purgeTeamRecordings = internalMutation({
  // `skipped`: a call earlier in this pass was still recording.
  args: {
    team_id: v.id("teams"),
    cursor: v.optional(v.union(v.string(), v.null())),
    skipped: v.optional(v.boolean()),
    frames: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ purged: number; waiting: number; done: boolean }> => {
    const team = await ctx.db.get(args.team_id);
    if (!team || !team.deleted_at) return { purged: 0, waiting: 0, done: true };
    const page = await ctx.db
      .query("transcripts")
      .withIndex("by_team_started", (q) => q.eq("team_id", args.team_id))
      .paginate({ cursor: args.cursor ?? null, numItems: PURGE_PAGE });
    if (args.frames) {
      let taken = 0;
      for (const call of page.page) taken += await deleteCallFrameShares(ctx, call._id);
      if (!page.isDone) {
        await ctx.scheduler.runAfter(0, internal.callRecordings.purgeTeamRecordings, { team_id: args.team_id, cursor: page.continueCursor, frames: true });
      }
      return { purged: taken, waiting: 0, done: page.isDone };
    }
    let purged = 0, waiting = 0;
    for (const call of page.page) {
      const n = await purgeCallRecordings(ctx, call._id);
      if (n === null) waiting++;
      else purged += n;
    }
    const skipped = !!args.skipped || waiting > 0;
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.callRecordings.purgeTeamRecordings, { team_id: args.team_id, cursor: page.continueCursor, skipped });
    } else if (skipped) {
      // A fresh pass later, rather than one timer per waiting call: calls
      // already purged cost the next pass a read each and nothing more.
      await ctx.scheduler.runAfter(PURGE_ACTIVE_RETRY_MS, internal.callRecordings.purgeTeamRecordings, { team_id: args.team_id });
    }
    return { purged, waiting, done: page.isDone };
  },
});

/** One pass that writes `video_runs` onto every call that has recording
 *  rows (syncCallVideo), a page of rows at a time. Calls from before the
 *  count, and calls whose only run was deleted, read as unfilmed without it:
 *  absent is zero. Run once after the deploy that added the field:
 *  packages/convex/run.sh callRecordings:backfillCallVideo '{}' */
export const backfillCallVideo = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args): Promise<{ calls: number; done: boolean }> => {
    const page = await ctx.db.query("call_recordings").paginate({ cursor: args.cursor ?? null, numItems: 200 });
    const calls = new Set(page.page.map((r) => r.transcript_id));
    for (const id of calls) await syncCallVideo(ctx, id);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.callRecordings.backfillCallVideo, { cursor: page.continueCursor });
    return { calls: calls.size, done: page.isDone };
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
  args: {
    id: v.id("call_recordings"),
    egress: v.any(),
    attach: v.optional(v.boolean()),
    /** Why a room video LiveKit closed by itself stopped, as the look that
     *  saw it close read the room (selfEndReason). */
    ended_because: v.optional(callRecordingStopReasonValidator),
  },
  handler: async (ctx, args): Promise<{ stop: boolean; status: string | null }> => {
    const row = await ctx.db.get(args.id);
    if (!row) return { stop: !!args.attach, status: null };
    const egress = args.egress as LivekitEgress;
    const result = egressPatch(row, egress, args.ended_because);
    if (result.drop) {
      await dropUnrecorded(ctx, row);
      return { stop: false, status: null };
    }
    const patch: Partial<RecordingRow> = { ...result.patch };
    if (args.attach && !row.egress_id && egress.egressId) patch.egress_id = egress.egressId;
    // LiveKit took an egress: whatever outage was remembered is over.
    if (args.attach && egress.egressId) await forgetRecordingOutage(ctx);
    const status = (patch.status ?? row.status) as RecordingRow["status"];
    if (patch.error) {
      // The row carries plain words (plainEgressError); LiveKit's own text,
      // with whatever endpoint or request id it quotes, goes to the logs.
      const raw = egress.error ?? "";
      console.warn(`[callRecordings] egress ${egress.egressId} for ${row._id} failed: ${raw}`);
      // LiveKit ended a running file because the plan ran out of minutes:
      // every press from now on would meet the same refusal, so it is
      // remembered exactly as a refused start is.
      if (patch.error_kind === "minutes_spent") await noteRecordingOutage(ctx, patch.error);
    }
    const ended = isRecordingActive(row.status) && !isRecordingActive(status);
    if (ended) Object.assign(patch, await retireLiveFrame(ctx, row));
    if (Object.keys(patch).length) await ctx.db.patch(row._id, { ...patch, updated_at: Date.now() });
    if ((status === "failed") !== (row.status === "failed")) await syncCallVideo(ctx, row.transcript_id);
    // The room stops being filmed on LiveKit's say, not ours (a stop we sent
    // moved the row to "stopping" first, and was told then).
    if (row.kind === "composite" && isRecordingFilming(row.status) && !isRecordingFilming(status)) {
      const reason =
        patch.stop_reason ?? row.stop_reason ?? (egress.status === "limit_reached" ? "limit" : status === "failed" ? "failed" : "ended");
      await announceRecordEnd(ctx, row, { reason, detail: status === "failed" ? (patch.error ?? row.error) : undefined });
    }
    // A stopped run whose video then failed to save: the room was told it
    // was saving, so it is told again that it is gone.
    if (row.kind === "composite" && row.status === "stopping" && status === "failed" && (patch.started_at ?? row.started_at) !== undefined) {
      await announceRecordLost(ctx, row, patch.error ?? row.error);
    }
    return { stop: !!args.attach && !isRecordingFilming(status), status };
  },
});

/** A row is leaving the live states: its live frame goes with it. The frame
 *  is a picture of now, and once the file is finished (or lost) it has
 *  nothing left to show, so it never lingers in the bucket as the call's last
 *  frame. Returns the field to write onto the row; every path that ends a
 *  row (LiveKit's answer, a failure, a file settled from the bucket) takes
 *  it, so none of them can forget the object. */
async function retireLiveFrame(ctx: any, row: RecordingRow): Promise<Partial<RecordingRow>> {
  if (!row.live_frame_key) return {};
  await ctx.scheduler.runAfter(0, internal.callRecordings.deleteObjects, { keys: [row.live_frame_key], attempt: 0 });
  return { live_frame_key: undefined };
}

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
    await syncCallVideo(ctx, row.transcript_id);
    return;
  }
  await ctx.db.delete(row._id);
  const head = others.find((r) => r.kind === "composite");
  const placeholderLeft = head && head.status === "failed" && head.started_at === undefined && !others.some((r) => r.kind === "screen");
  if (placeholderLeft) await ctx.db.delete(head._id);
  const runGone = row.kind === "composite" || placeholderLeft;
  await scheduleObjectDelete(ctx, placeholderLeft ? [row, head] : [row], { wholeRun: !!runGone });
  await syncCallVideo(ctx, row.transcript_id);
}

/** Tell the room a stopped run's video was lost while it saved
 *  (announceRecordEnd `lost`): the presser owns the line, as with any end
 *  nobody pressed, and the plain words say what went wrong. */
async function announceRecordLost(ctx: any, row: RecordingRow, error: string | undefined): Promise<void> {
  await announceRecordEnd(ctx, row, { reason: "failed", detail: plainStoredError(error) ?? undefined, lost: true });
}

/** A file that cannot be made: LiveKit refused it, never acknowledged it, or
 *  lost it. A row that was being stopped anyway, with nothing written, is
 *  dropped instead (nothing went wrong, nothing was recorded). Either way an
 *  egress LiveKit may still be running for it is told to stop, and a run
 *  whose room video failed while it was filming tells the room why. */
export const failRecording = internalMutation({
  // A "minutes_spent" failure is one every later press would meet too: it is
  // remembered, so they are refused before the room hears. `outage` says the
  // same for an action still running code from before error_kind.
  args: { id: v.id("call_recordings"), error: v.string(), error_kind: v.optional(callRecordingErrorKindValidator), outage: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const kind = args.error_kind ?? (args.outage ? "minutes_spent" : undefined);
    if (kind === "minutes_spent") await noteRecordingOutage(ctx, args.error);
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
      error_kind: kind,
      stop_reason: row.stop_reason ?? "failed",
      // A stopped file filmed up to its stop, not up to the moment its save
      // was given up on.
      ended_at: row.ended_at ?? (row.started_at === undefined ? undefined : row.status === "stopping" ? stopRequestedAt(row) : now),
      ...(await retireLiveFrame(ctx, row)),
      updated_at: now,
    });
    await syncCallVideo(ctx, row.transcript_id);
    if (row.kind !== "composite") return;
    // A stopped run was already told as saving (and one with nothing written
    // was dropped above): its loss is a line of its own.
    if (row.status === "stopping") await announceRecordLost(ctx, row, args.error);
    else await announceRecordEnd(ctx, row, { reason: "failed", detail: args.error });
  },
});

/** The remembered outage lapses (noteRecordingOutage schedules this): the
 *  next press asks LiveKit again. A newer stamp is left alone. */
export const clearRecordingOutage = internalMutation({
  args: { since: v.number() },
  handler: async (ctx, args) => {
    await forgetRecordingOutage(ctx, args.since);
  },
});

/** LiveKit forgot an egress twice running (it keeps finished ones only for a
 *  while), and the file it was writing is in the bucket: the recording
 *  finished while nobody was looking. It is ready, with the size the bucket
 *  reports and the end its upload landed at; LiveKit's own file times, if a
 *  look caught them earlier, stay. `late` is the bucket sweep finding the
 *  file of a row that already gave up on its save (mayLandLate): the upload
 *  outlasted every ceiling, and the video is there after all. */
export const settleFromObject = internalMutation({
  args: { id: v.id("call_recordings"), size_bytes: v.optional(v.number()), uploaded_at: v.optional(v.number()), late: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || !(isRecordingActive(row.status) || (args.late && mayLandLate(row)))) return;
    const stopReason = row.stop_reason ?? (row.kind === "screen" ? "share_ended" : "ended");
    await ctx.db.patch(row._id, {
      status: "ready",
      stop_reason: stopReason,
      error: undefined,
      error_kind: undefined,
      ...(args.size_bytes !== undefined ? { size_bytes: args.size_bytes } : {}),
      ...(row.ended_at === undefined && row.duration_ms === undefined && args.uploaded_at !== undefined ? { ended_at: args.uploaded_at } : {}),
      ...(await retireLiveFrame(ctx, row)),
      updated_at: Date.now(),
    });
    // A late landing turns a failed file back into video.
    if (row.status === "failed") await syncCallVideo(ctx, row.transcript_id);
    // Only a run still filming is news to the room: a stop already told it.
    if (row.kind === "composite" && isRecordingFilming(row.status)) await announceRecordEnd(ctx, row, { reason: stopReason });
  },
});

/** Claim the screen file for one shared track in a run, or null when the run
 *  is no longer recording or the track already has its file (two looks at
 *  the room racing each other start one egress, not two). A file whose start
 *  failed in a way worth another try (screenStartRetryable) is claimed again
 *  on its own row, under a new object name, so an egress from the failed try
 *  that turns up late is never taken for this one. */
export const claimScreen = internalMutation({
  args: { run_id: v.id("call_recordings"), track_sid: v.string(), identity: v.string(), name: v.string() },
  handler: async (ctx, args): Promise<{ id: Id<"call_recordings">; r2_key: string } | null> => {
    const run = await ctx.db.get(args.run_id);
    if (!run || !isRecordingFilming(run.status)) return null;
    const taken = await ctx.db
      .query("call_recordings")
      .withIndex("by_transcript", (q) => q.eq("transcript_id", run.transcript_id))
      .filter((q) => q.and(q.eq(q.field("run_id"), run._id), q.eq(q.field("track_sid"), args.track_sid)))
      .first();
    const now = Date.now();
    if (taken) {
      if (!screenStartRetryable(taken, now)) return null;
      const attempt = (taken.start_attempts ?? 1) + 1;
      const retryKey = callRecordingKey({
        transcriptId: String(run.transcript_id),
        kind: "screen",
        requestedAt: run.requested_at,
        trackSid: `${args.track_sid}-try${attempt}`,
      });
      await ctx.db.patch(taken._id, {
        status: "starting",
        r2_key: retryKey,
        start_attempts: attempt,
        requested_at: now,
        egress_id: undefined,
        error: undefined,
        stop_reason: undefined,
        ended_at: undefined,
        updated_at: now,
      });
      await syncCallVideo(ctx, run.transcript_id);
      return { id: taken._id, r2_key: retryKey };
    }
    const file = { transcriptId: String(run.transcript_id), kind: "screen" as const, requestedAt: run.requested_at, trackSid: args.track_sid };
    const r2_key = callRecordingKey(file);
    // No live frame for a screen file. LiveKit will not start a track
    // composite asked for an MP4 and pictures together: it sits in
    // "starting" until stopped ("Stop called before pipeline could start"),
    // while either output alone starts in seconds (probed 2026-10-02, 0 of 4
    // runs with both, 4 of 4 with one). The file is what a screen is
    // recorded for; a live picture of the call comes from the room's file,
    // which shows the share too.
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
      started_by_name: run.started_by_name,
      requested_at: now,
      updated_at: now,
    });
    await syncCallVideo(ctx, run.transcript_id);
    return { id, r2_key };
  },
});

/** A room video LiveKit refused for want of capacity: mark it to be asked
 *  again in COMPOSITE_RETRY_GAP_MS, if it still wants a file and another try
 *  fits START_RETRY_LIMIT and the accept window. Answers whether it did; a
 *  no means the caller fails the row as before. */
export const deferStart = internalMutation({
  args: { id: v.id("call_recordings") },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db.get(args.id);
    if (!row || row.status !== "starting" || row.egress_id) return false;
    const now = Date.now();
    if ((row.start_attempts ?? 1) >= START_RETRY_LIMIT) return false;
    if (now + COMPOSITE_RETRY_GAP_MS - row.requested_at >= EGRESS_ACCEPT_TIMEOUT_MS) return false;
    // Not a field any reader shows: the row's updated_at stays.
    await ctx.db.patch(row._id, { retry_after: now + COMPOSITE_RETRY_GAP_MS });
    return true;
  },
});

/** The loop found a deferred room video due: claim the retry (so two looks
 *  never ask twice) and ask LiveKit again. */
export const retryStart = internalMutation({
  args: { id: v.id("call_recordings") },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db.get(args.id);
    if (!row || row.status !== "starting" || row.egress_id || row.retry_after === undefined || Date.now() < row.retry_after) return false;
    await ctx.db.patch(row._id, { retry_after: undefined, start_attempts: (row.start_attempts ?? 1) + 1 });
    await ctx.scheduler.runAfter(0, internal.callRecordings.startRun, { run_id: row._id });
    return true;
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

// LiveKit answers resource_exhausted for two different things: no egress
// worker free this minute, and the project's egress minutes used up for its
// billing period ("egress minutes exceeded"). The first passes on its own; the
// second fails every press until someone raises the plan, so "try again in a
// minute" would send the room round in circles.
export function startFailure(err: unknown): Required<RecordingFailure> {
  if (err instanceof LivekitApiError) {
    if (err.status === 401 || err.status === 403) return { error: "LiveKit refused this server's credentials, so the recording could not start.", kind: "credentials" };
    if (egressMinutesSpent(err)) return { error: RECORDING_MINUTES_SPENT_MESSAGE, kind: "minutes_spent" };
    if (egressCapacityBusy(err)) return { error: EGRESS_BUSY_MESSAGE, kind: "busy" };
    return { error: `LiveKit could not start the recording (${err.code ?? err.status}).`, kind: "livekit" };
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return { error: "LiveKit did not answer the request to start recording.", kind: "livekit" };
  // Anything else is this server's own fault, and its text (a stack's
  // message, a URL) is for the logs, not the room.
  console.warn("[callRecordings] recording start failed:", err);
  return { error: "The recording could not start because of an error on this server.", kind: "server" };
}

/** Is this LiveKit's "egress minutes used up for the billing period"? The
 *  refusal worth remembering (lib/callRecordingRuns recordingOutage): it
 *  holds for every press until someone raises the plan. */
export function egressMinutesSpent(err: unknown): boolean {
  return err instanceof LivekitApiError && err.code === "resource_exhausted" && isMinutesSpentText(err.message);
}

/** Is this the refusal that passes on its own: no egress worker free this
 *  minute? Worth asking again a little later (START_RETRY_LIMIT), where a
 *  plan out of minutes never is. */
export function egressCapacityBusy(err: unknown): boolean {
  return err instanceof LivekitApiError && err.code === "resource_exhausted" && !egressMinutesSpent(err);
}

/** The live frame output for a file, or nothing for a row without one. */
function liveFrameFor(row: { live_frame_key?: string | null }): LiveFrameOutput | undefined {
  if (!row.live_frame_key) return undefined;
  return { prefix: row.live_frame_key.replace(/\.jpeg$/, ""), intervalSeconds: LIVE_FRAME_INTERVAL_S };
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
async function adoptOrFail(
  ctx: any,
  cfg: LivekitServerConfig,
  row: RecordingRow,
  running: LivekitEgress[] | null,
  failure: RecordingFailure,
): Promise<void> {
  const egress = running?.find((e) => e.paths.includes(row.r2_key));
  if (egress) {
    const applied = await ctx.runMutation(internal.callRecordings.applyEgress, { id: row._id, egress, attach: true });
    if (applied.stop) await stopEgress(cfg, egress.egressId).catch((err) => console.warn(`[callRecordings] stop failed for ${egress.egressId}:`, err));
    return;
  }
  await ctx.runMutation(internal.callRecordings.failRecording, { id: row._id, error: failure.error, ...(failure.kind ? { error_kind: failure.kind } : {}) });
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
        trackCompositeEgressRequest({
          room: run.room_key,
          videoTrackSid: share.trackSid,
          filepath: claim.r2_key,
          upload: egressS3Upload(bucket),
          ...(advanced ? { advanced } : {}),
        }),
      );
      const applied = await ctx.runMutation(internal.callRecordings.applyEgress, { id: claim.id, egress, attach: true });
      if (applied.stop) await stopEgress(cfg, egress.egressId);
    } catch (err) {
      const row: RecordingRow | null = await ctx.runQuery(internal.callRecordings.getRow, { id: claim.id });
      if (row) await adoptOrFail(ctx, cfg, row, await roomEgresses(cfg, run.room_key), startFailure(err));
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
      // No capacity this minute: the run stays "starting" and its loop asks
      // again shortly (deferStart), so the room hears one "recording" and no
      // failure in between. Spent minutes, or retries used up, fail it.
      if (egressCapacityBusy(err) && (await ctx.runMutation(internal.callRecordings.deferStart, { id: run._id }))) return;
      await adoptOrFail(ctx, cfg, run, await roomEgresses(cfg, run.room_key), startFailure(err));
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

/** Is a file in the bucket? Its size and upload time when it is (the facts
 *  settleFromObject takes), false when it is not, null when the bucket could
 *  not say. */
async function objectLanded(bucket: R2Bucket, key: string): Promise<{ size_bytes?: number; uploaded_at?: number } | false | null> {
  try {
    const head = await fetch(await r2Presign(bucket, "HEAD", key, 60), { method: "HEAD" });
    if (head.status === 404) return false;
    if (!head.ok) return null;
    const size = Number(head.headers.get("content-length"));
    const modified = Date.parse(head.headers.get("last-modified") ?? "");
    return {
      ...(Number.isFinite(size) && size > 0 ? { size_bytes: size } : {}),
      ...(Number.isFinite(modified) ? { uploaded_at: modified } : {}),
    };
  } catch (err) {
    console.warn(`[callRecordings] could not check ${key}:`, err);
    return null;
  }
}

/** LiveKit cannot finish a file for us: it answered "no such egress" twice
 *  running, or a stop has gone unfinished past its ceiling (saveOverdue). If
 *  the object is in the bucket, the file finished while nobody looked
 *  (LiveKit keeps finished egresses only for a while, and an upload can land
 *  without LiveKit saying so): settle it as ready. If not, it is lost: stop
 *  it in case LiveKit is still writing it after all, and fail the row with
 *  `error`, words that say which of the two happened. */
async function settleLost(ctx: any, cfg: LivekitServerConfig, bucket: R2Bucket, row: RecordingRow, error: string): Promise<void> {
  const landed = await objectLanded(bucket, row.r2_key);
  if (landed) {
    await ctx.runMutation(internal.callRecordings.settleFromObject, { id: row._id, ...landed });
    return;
  }
  if (landed === null) return; // The bucket could not say: ask again next look.
  if (row.egress_id) await stopEgress(cfg, row.egress_id).catch(() => null);
  await ctx.runMutation(internal.callRecordings.failRecording, { id: row._id, error });
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
    // Whether this look wrote anything. A run that simply keeps recording
    // writes nothing (each file's patch from LiveKit is empty), and then the
    // rows this look began with are still the rows: no second read.
    let wrote = false;
    for (const row of active) {
      if (!row.egress_id) {
        if (row.retry_after !== undefined && row.status === "stopping") {
          // Stopped while waiting for its retry: LiveKit was never running
          // it, so there is nothing to wait for (a stopping row with nothing
          // written is dropped).
          wrote = true;
          await ctx.runMutation(internal.callRecordings.failRecording, { id: row._id, error: "Stopped before it began." });
        } else if (row.retry_after !== undefined && now >= row.retry_after && now - row.requested_at <= EGRESS_ACCEPT_TIMEOUT_MS) {
          // A room video refused for want of capacity, due to be asked again.
          await ctx.runMutation(internal.callRecordings.retryStart, { id: row._id });
        } else if (now - row.requested_at > EGRESS_ACCEPT_TIMEOUT_MS && running) {
          wrote = true;
          // Retried and never taken: LiveKit had no capacity all along.
          await adoptOrFail(
            ctx,
            cfg,
            row,
            running,
            row.start_attempts ? { error: EGRESS_BUSY_MESSAGE, kind: "busy" } : { error: "LiveKit never started this recording.", kind: "livekit" },
          );
        } else if (now - row.requested_at > EGRESS_UNREACHABLE_FAIL_MS) {
          wrote = true;
          // LiveKit cannot even be asked, for long enough that the room must
          // stop being told it is filmed. An egress that did start anyway is
          // stopped by the sweep, which finds it with no live row.
          await ctx.runMutation(internal.callRecordings.failRecording, { id: row._id, error: "LiveKit could not be reached to start this recording." });
        }
        continue;
      }
      let egress: LivekitEgress | null = byId.get(row.egress_id) ?? null;
      let unasked = false;
      if (!egress) {
        try {
          egress = await getEgress(cfg, row.egress_id);
        } catch (err) {
          // LiveKit unreachable for a moment: the next look tries again.
          console.warn(`[callRecordings] could not read egress ${row.egress_id}:`, err);
          unasked = true;
        }
      }
      // A stop LiveKit has not finished long after it was asked. One LiveKit
      // is visibly finishing is a long upload and gets the longer ceiling
      // (saveOverdue); one it ignored or forgot is stuck. The bucket decides
      // whether the file landed anyway.
      if (saveOverdue(row, unasked ? undefined : egress, now)) {
        wrote = true;
        await settleLost(ctx, cfg, bucket, row, "LiveKit never finished saving this recording.");
        continue;
      }
      if (unasked) continue;
      if (!egress) {
        if (args.missing?.includes(row.egress_id)) {
          wrote = true;
          await settleLost(ctx, cfg, bucket, row, "LiveKit lost track of this recording before it finished.");
        } else missing.push(row.egress_id);
        continue;
      }
      // The patch is pure: an egress that moved nothing on its row (the
      // steady state of a run that is recording) costs no mutation. Status
      // changes, and with them the live frame's retirement and the room's
      // notice, all ride a non-empty patch.
      const moved = egressMovesRow(row, egress);
      if (moved) wrote = true;
      // The room's video closed with nobody asking: say why from how the
      // room looks now, so the thread never reads a bare "stopped" when
      // the room had emptied or the huddle had ended.
      const ended_because = moved && endsByItself(row, egress) ? selfEndReason(await ctx.runQuery(internal.callRecordings.roomSeats, { room_key: row.room_key })) : undefined;
      const applied = moved
        ? await ctx.runMutation(internal.callRecordings.applyEgress, { id: row._id, egress, ...(ended_because ? { ended_because } : {}) })
        : { status: row.status };
      if (applied.status === "starting" && egress.status === "starting" && now - row.requested_at > EGRESS_BEGIN_TIMEOUT_MS) {
        wrote = true;
        await ctx.runMutation(internal.callRecordings.failRecording, { id: row._id, error: "LiveKit accepted this recording but never began writing it." });
        continue;
      }
      // A stop that LiveKit has not acted on after a while is asked again.
      if (applied.status === "stopping" && (egress.status === "starting" || egress.status === "active") && now - row.updated_at > STOP_RETRY_MS) {
        await stopEgress(cfg, row.egress_id).catch((err) => console.warn(`[callRecordings] stop retry failed for ${row.egress_id}:`, err));
      }
    }

    const fresh: { run: RecordingRow; rows: RecordingRow[] } | null = wrote
      ? await ctx.runQuery(internal.callRecordings.runForAction, { run_id: args.run_id })
      : info;
    if (!fresh) {
      if (looping) await ctx.runMutation(internal.callRecordings.endLoop, { run_id: args.run_id, gen: args.gen! });
      return;
    }
    const { run, rows } = fresh;
    const stop = (reason: CallRecordingStopReason) =>
      ctx.runMutation(internal.callRecordings.stopRun, { room_key: run.room_key, run_id: String(run._id), reason });
    let emptySince: number | undefined;
    let stopped = false;
    if (isRecordingFilming(run.status)) {
      try {
        const participants = await listParticipants(cfg, run.room_key);
        // Empty on both clocks (RECORDING_EMPTY_ROOM_STOP_MS): no teammate in
        // LiveKit's room, and no teammate's seat lease live. A teammate
        // mid reconnect is gone from the first and still in the second.
        const seats: { held: boolean; emptied_at: number | null } | null =
          huddleKeepers(participants).length === 0 ? await ctx.runQuery(internal.callRecordings.roomSeats, { room_key: run.room_key }) : null;
        if (seats && !seats.held) {
          emptySince = args.empty_since ?? now;
          if (emptyRoomStopDue(emptySince, now, seats.emptied_at)) {
            await stop("room_empty");
            stopped = true;
          }
        } else if (now - run.requested_at > RECORDING_MAX_RUN_MS) {
          await stop("limit");
          stopped = true;
        } else if (run.egress_id && run.retry_after === undefined) {
          // Screen files only once LiveKit took the room's video, as startRun
          // does: while the room video waits out a capacity refusal for its
          // retry, a screen file would take the very slot it is waiting for.
          await recordNewShares(ctx, cfg, bucket, run, rows, participants);
        }
      } catch (err) {
        console.warn(`[callRecordings] room look failed for ${run.room_key}:`, err);
      }
    } else if (!isRecordingActive(run.status) && rows.some((r) => r.kind === "screen" && isRecordingFilming(r.status))) {
      // The room's video ended on its own (LiveKit's limit, a failure): its
      // screen files end with it.
      await stop(run.stop_reason ?? "failed");
      stopped = true;
    }

    if (!looping) return;
    const delay = stopped || emptySince !== undefined ? RECORDING_POLL_FAST_MS : nextPollDelayMs(rows, Date.now());
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
    for (const status of ACTIVE_STATUSES) {
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
    // Whether LiveKit could be filming something no row tracks: only a live
    // row or a recent press can have left such an egress.
    const newest = runs.size
      ? null
      : await ctx.db.query("call_recordings").withIndex("by_requested").order("desc").first();
    const recent = runs.size > 0 || (!!newest && now - newest.requested_at < RECORDING_ORPHAN_WINDOW_MS);
    return { runs: runs.size, restarted, recent };
  },
});

/** What the app believes LiveKit is writing: every live row's egress and path. */
export const trackedEgresses = internalQuery({
  args: {},
  handler: async (ctx) => {
    const egressIds: string[] = [];
    const paths: string[] = [];
    for (const status of ACTIVE_STATUSES) {
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
    const { recent, ...loops }: { runs: number; restarted: number; recent: boolean } = await ctx.runMutation(
      internal.callRecordings.restartStaleLoops,
      {},
    );
    const cfg = livekitConfigFromEnv();
    // Nothing pressed lately: nothing LiveKit runs can be ours untracked,
    // and an idle deployment spends no LiveKit request every two minutes.
    if (!cfg || !recent) return { ...loops, orphans: 0 };
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

// ── Orphaned objects ──────────────────────────────────────────────────────

/** How old an object must be before the orphan sweep may judge it: a file is
 *  written before LiveKit reports it, and a row inserted after the listing
 *  was taken must not lose its object. */
export const ORPHAN_OBJECT_GRACE_MS = 6 * 60 * 60 * 1000;

/** Rows read per page of the walk below. call_recordings is never pruned
 *  (a run is a composite plus up to MAX_SCREEN_FILES_PER_RUN screen files),
 *  so one query over the whole table would one day pass Convex's read limits
 *  and the sweep would throw every night from then on. */
export const ACCOUNTED_PAGE_ROWS = 1000;

type LateFile = { id: Id<"call_recordings">; r2_key: string };
type AccountedPage = { keys: string[]; prefixes: string[]; late?: LateFile[]; continueCursor: string; isDone: boolean };

/** What one page of rows accounts for in the bucket: every row's file and
 *  live frame, and every run prefix that still has a row (a run's other
 *  objects, a file LiveKit renamed). `late` names the files whose rows gave
 *  up on a save that may still land (mayLandLate), for the sweep to look
 *  for in its listing. walkAccountedRecordingObjects reads every page. */
export const accountedRecordingObjects = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), numItems: v.number() },
  handler: async (ctx, args): Promise<AccountedPage> => {
    const page = await ctx.db.query("call_recordings").paginate({ cursor: args.cursor, numItems: args.numItems });
    const keys = new Set<string>();
    const prefixes = new Set<string>();
    const late: LateFile[] = [];
    for (const r of page.page) {
      if (mayLandLate(r)) late.push({ id: r._id, r2_key: r.r2_key });
      keys.add(r.r2_key);
      if (r.live_frame_key) keys.add(r.live_frame_key);
      const prefix = callRecordingRunPrefixOfKey(r.r2_key);
      if (prefix) prefixes.add(prefix);
    }
    return { keys: [...keys], prefixes: [...prefixes], late, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

/** Every page of accountedRecordingObjects, merged. A row inserted while the
 *  walk is under way can only make the sweep keep more (the listing was
 *  taken first), and ORPHAN_OBJECT_GRACE_MS covers an object whose row lands
 *  after the walk passed its place. `page` runs the query (ctx.runQuery in
 *  the sweep, the test backend in tests). */
export async function walkAccountedRecordingObjects(
  page: (args: { cursor: string | null; numItems: number }) => Promise<AccountedPage>,
  numItems: number = ACCOUNTED_PAGE_ROWS,
): Promise<{ keys: string[]; prefixes: string[]; late: LateFile[] }> {
  const keys = new Set<string>();
  const prefixes = new Set<string>();
  const late: LateFile[] = [];
  let cursor: string | null = null;
  for (;;) {
    const p: AccountedPage = await page({ cursor, numItems });
    for (const k of p.keys) keys.add(k);
    for (const x of p.prefixes) prefixes.add(x);
    late.push(...(p.late ?? []));
    if (p.isDone) break;
    cursor = p.continueCursor;
  }
  return { keys: [...keys], prefixes: [...prefixes], late };
}

/** The objects to delete from a listing: anything past the grace that no row
 *  accounts for, and every LiveKit manifest past it (a JSON naming the room
 *  and its people, which no reader uses; new egresses no longer write one,
 *  lib/livekitServer mp4Output). Pure, for the test. */
export function orphanedRecordingObjects(
  objects: ReadonlyArray<{ key: string; lastModified: number }>,
  accounted: { keys: readonly string[]; prefixes: readonly string[] },
  now: number,
): string[] {
  const keys = new Set(accounted.keys);
  const manifest = /^calls\/[^/]+\/EG_[A-Za-z0-9]+\.json$/;
  return objects
    .filter((o) => Number.isFinite(o.lastModified) && now - o.lastModified >= ORPHAN_OBJECT_GRACE_MS)
    .filter((o) => manifest.test(o.key) || (!keys.has(o.key) && !accounted.prefixes.some((p) => o.key.startsWith(p))))
    .map((o) => o.key);
}

/** The daily cron (crons.ts): list the recordings bucket, then read the rows
 *  page by page, and delete what the rows do not account for. Listing first means a row
 *  written after the listing can only make the sweep keep more, and the
 *  grace covers an object whose row is about to be written. Also the one way
 *  to clear what runs deleted before manifests were turned off left behind:
 *  run it by hand once (packages/convex/run.sh) rather than waiting a day.
 *  On the way it settles every file whose save landed after its row gave up
 *  (mayLandLate) as ready: the row kept the object from deletion, and this
 *  is what lets a reader see it. */
export const sweepRecordingObjects = internalAction({
  args: {},
  handler: async (ctx): Promise<{ listed: number; deleted: number; landed: number }> => {
    const bucket = callRecordingsBucketFromEnv();
    if (!bucket) return { listed: 0, deleted: 0, landed: 0 };
    const objects = await r2ListObjects(bucket, CALL_RECORDINGS_ROOT, 100_000);
    const accounted = await walkAccountedRecordingObjects((args) => ctx.runQuery(internal.callRecordings.accountedRecordingObjects, args));
    const orphans = orphanedRecordingObjects(objects, accounted, Date.now());
    if (orphans.length) {
      console.warn(`[callRecordings] deleting ${orphans.length} orphaned recording object(s)`);
      await ctx.scheduler.runAfter(0, internal.callRecordings.deleteObjects, { keys: orphans, attempt: 0 });
    }
    const listed = new Set(objects.map((o) => o.key));
    let landed = 0;
    for (const file of accounted.late.filter((f) => listed.has(f.r2_key))) {
      const facts = await objectLanded(bucket, file.r2_key);
      if (!facts) continue;
      console.warn(`[callRecordings] ${file.r2_key} landed after its save was given up: settling it as ready`);
      await ctx.runMutation(internal.callRecordings.settleFromObject, { id: file.id, ...facts, late: true });
      landed++;
    }
    return { listed: objects.length, deleted: orphans.length, landed };
  },
});

/** Does any teammate hold a live seat in the room (the lease huddleAlive
 *  reads, without its grace)? The seat half of the empty-room rule. With it,
 *  when the last teammate left on purpose inside the huddle's grace
 *  (emptyRoomStopDue holds the recording longer for that). */
export const roomSeats = internalQuery({
  args: { room_key: v.string() },
  handler: async (ctx, args): Promise<{ held: boolean; emptied_at: number | null; huddle_live: boolean }> => {
    const now = Date.now();
    const seats = await ctx.db
      .query("call_members")
      .withIndex("by_room", (q) => q.eq("room_key", args.room_key))
      .collect();
    const emptiedAt: number | undefined = (await readRoomState(ctx, args.room_key))?.emptied_at;
    return {
      held: liveMembers(seats, now).length > 0,
      emptied_at: emptiedAt !== undefined && now - emptiedAt < HUDDLE_GRACE_MS ? emptiedAt : null,
      // The huddle's call record still open (selfEndReason).
      huddle_live: (await liveTranscriptFor(ctx, args.room_key)) !== null,
    };
  },
});

export const getRow = internalQuery({
  args: { id: v.id("call_recordings") },
  handler: async (ctx, args) => await ctx.db.get(args.id),
});
