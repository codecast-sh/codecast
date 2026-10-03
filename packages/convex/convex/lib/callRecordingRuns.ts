// A call recording's runs: the rules for moving a `call_recordings` row
// through its life, and the few database helpers the huddle lifecycle needs
// (calls.ts stops a recording when the room empties, transcripts.ts when the
// record ends, the heartbeat nudges it when a screen share starts, a deleted
// team's sweep purges a call's recordings).
//
// A RUN is one press of Record: a composite row (the room as people saw it)
// and a screen row per screen shared while it ran. A screen row names its run
// in `run_id`; a composite row is its own run. Stopping stops the whole run,
// deleting deletes the whole run, and a screen share that starts mid-run gets
// its own row in the same run.
//
// These helpers live here rather than in callRecordings.ts so calls.ts and
// transcripts.ts can reach them without importing callRecordings.ts, which
// imports transcripts.ts for the call record: the cycle stays out of the
// graph instead of being survived at load.
//
// The pure half (everything that takes rows and returns a verdict) is what
// callRecordingRuns.test.ts pins: which shares get a file, how LiveKit's view
// of an egress lands on a row without ever moving it backwards, how often the
// reconciler looks, and who may delete.

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import {
  callParticipantKind,
  isRecordingActive,
  RECORDING_RESTART_COOLDOWN_MS,
  shareIncludesVideo,
  type CallRecordingStatus,
  type CallRecordingStopReason,
} from "@codecast/shared/contracts";
import { livekitConfigFromEnv, recordingFieldsFromEgress, type LivekitEgress, type LivekitParticipant, screenShareTracks } from "./livekitServer";
import { callRecordingCallPrefix, callRecordingsBucketFromEnv } from "./r2";
import { displayName } from "./displayNames";
import { postEvent } from "../callChat";

type RecordingRow = Doc<"call_recordings">;

// ── Timing ────────────────────────────────────────────────────────────────

/** How often the reconciler looks while something is changing (an egress
 *  starting, a stop being written out, the room standing empty) and while a
 *  run simply records. A look is two small LiveKit requests, so the fast
 *  beat is cheap; the slow one is the steady state of a long call, so it is
 *  slow on purpose. What is latency sensitive is told sooner by other means:
 *  calls.heartbeat nudges a look when a teammate's share starts, and a
 *  teammate leaving goes through calls.leaveRoom. The slow beat bounds how
 *  late a share nobody nudged for (a guest's) gets its own file. */
export const RECORDING_POLL_FAST_MS = 3_000;
export const RECORDING_POLL_MS = 20_000;

/** A row LiveKit never acknowledged: the action that asks for the egress died
 *  between the insert and the answer. Past this it is failed, not pending. */
export const EGRESS_ACCEPT_TIMEOUT_MS = 60_000;

/** A row LiveKit never acknowledged while LiveKit itself could not be asked
 *  (ListEgress failing too, so nothing can be adopted by its path). Past this
 *  it fails anyway: the room is not left showing a red mark, and guests held
 *  at the door, for a recording that does not exist. The sweep stops an
 *  egress that turns up later with no live row. */
export const EGRESS_UNREACHABLE_FAIL_MS = 3 * EGRESS_ACCEPT_TIMEOUT_MS;

/** A file we asked LiveKit to stop that is still not finished after this:
 *  its upload is stuck. The bucket is asked whether the file landed anyway
 *  (it is then ready); otherwise the row fails, so a stuck save never holds
 *  the room's "saving" mark, or a later huddle's Record button, for good. An
 *  hour of call uploads in a few minutes; twenty is far past a slow one. */
export const EGRESS_SAVE_TIMEOUT_MS = 20 * 60_000;

/** How long a refusal for spent recording minutes is remembered
 *  (noteRecordingOutage): presses meanwhile are refused before they tell the
 *  room anything, and the button says why. Past it the next press asks
 *  LiveKit again, and any egress LiveKit accepts clears it at once. */
export const RECORDING_OUTAGE_TTL_MS = 60 * 60_000;

/** A file LiveKit acknowledged but never began writing. A healthy egress
 *  goes active in seconds; one that has not after this will not (a track
 *  composite asked for an MP4 and pictures together sat in "starting" for
 *  twelve minutes, 2026-10-02). It is failed and stopped, so the call says
 *  the file is missing and why instead of the row vanishing when the run
 *  ends with nothing written. */
export const EGRESS_BEGIN_TIMEOUT_MS = 120_000;

/** A row we asked LiveKit to stop that still is not finished after this is
 *  asked again; a stop request can be lost like any other. */
export const STOP_RETRY_MS = 30_000;

/** How long the room must stand empty of teammates on BOTH clocks before the
 *  run is stopped: LiveKit's participant list holds no keeper, and no seat
 *  lease is live (call_members). Either alone lies for a while: a teammate
 *  whose network dropped leaves LiveKit's list mid reconnect while their
 *  seat stays live, and a tab that died without leaving keeps its seat until
 *  the lease lapses (CALL_MEMBER_STALE_MS). Requiring both means a reconnect
 *  never cuts the video, and a dead tab still stops it within about this
 *  plus the lease. The last teammate leaving on purpose does not stop it at
 *  once either (calls.leaveRoom: a reload is a leave and a join); this is the
 *  stop, unless the huddle's record ends first. */
export const RECORDING_EMPTY_ROOM_STOP_MS = 30_000;

/** A run that is still recording after this was forgotten by everyone: stop
 *  it. LiveKit has its own ceiling (limit_reached), this is ours, well under
 *  it, so the reason a person reads is ours too. */
export const RECORDING_MAX_RUN_MS = 6 * 60 * 60 * 1000;

/** How far back a press can have left an egress nobody tracks (a row failed
 *  before LiveKit's answer, an answer lost). The sweep asks LiveKit for
 *  untracked egresses only when some press is this recent or some row is
 *  still live: an egress cannot outlive LiveKit's own ceiling, which sits
 *  well inside this, so a deployment nobody has recorded on in a day asks
 *  LiveKit nothing. */
export const RECORDING_ORPHAN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How often a recording's live frame (r2.callRecordingLiveFramePrefix) is
 *  rewritten while it records: "the screen right now" is at most this old. */
export const LIVE_FRAME_INTERVAL_S = 2;

/** A press this soon after the room's last stop is refused (the shared
 *  contract holds the rule, so the Record button waits the same span). */
export { RECORDING_RESTART_COOLDOWN_MS };

/** A one off look at a run (a screen share just started) is skipped when the
 *  run was looked at or nudged this recently: a client flapping its `sharing`
 *  flag cannot queue LiveKit calls faster than this. */
export const RECORDING_NUDGE_MIN_GAP_MS = 2_000;

/** A run whose loop has not looked for this long has no loop: the sweep
 *  starts a new one (a loop looks at least every RECORDING_POLL_MS). */
export const RECORDING_LOOP_STALE_MS = 3 * 60_000;

/** Screen files one run may hold. A share toggled on and off makes a file
 *  each time; past this the run keeps the composite and stops adding. */
export const MAX_SCREEN_FILES_PER_RUN = 24;

// ── Runs ──────────────────────────────────────────────────────────────────

/** The run a row belongs to: a composite is its own run. */
export function runIdOf(row: { _id: string; run_id?: string | null }): string {
  return String(row.run_id ?? row._id);
}

/** The people in a room as LiveKit sees it: teammates and guests. LiveKit's
 *  recorder and agents (an agent's face, a server agent) are not anybody a
 *  recording is for, and a room holding only them is empty. */
export function peopleInRoom(participants: readonly LivekitParticipant[]): LivekitParticipant[] {
  return participants.filter(
    (p) =>
      p.identity &&
      p.kind !== "egress" &&
      p.kind !== "agent" &&
      !p.identity.startsWith("EG_") &&
      callParticipantKind(p.identity) !== "agent",
  );
}

/** The people whose presence keeps a recording going. A guest alone never
 *  keeps a huddle going (transcripts.huddleAlive: the admission dies with
 *  the huddle), so a room LiveKit shows holding only guests is as empty as
 *  the seat leases say it is (calls.leaveRoom stops the run when the last
 *  teammate leaves). One rule, both clocks: the seat lease when somebody
 *  leaves, LiveKit's room when a tab died without leaving. */
export function huddleKeepers(participants: readonly LivekitParticipant[]): LivekitParticipant[] {
  return peopleInRoom(participants).filter((p) => callParticipantKind(p.identity) === "person");
}

/** The shares in the room that should get a file and have none in this run
 *  yet. A share is a track: the same person sharing again publishes a new
 *  track and gets a new file. An agent's screen is never recorded on its own
 *  (agents share nothing a person did not already see in the composite). */
export function screenSharesToRecord(
  participants: readonly LivekitParticipant[],
  runRows: ReadonlyArray<{ kind: string; track_sid?: string | null }>,
): Array<{ identity: string; name: string; trackSid: string; width?: number; height?: number }> {
  const have = new Set(runRows.filter((r) => r.kind === "screen" && r.track_sid).map((r) => String(r.track_sid)));
  const room = screenShareTracks(peopleInRoom(participants));
  const fresh = room.filter((t) => !have.has(t.trackSid));
  const room_left = Math.max(0, MAX_SCREEN_FILES_PER_RUN - have.size);
  return fresh.slice(0, room_left);
}

/** When the reconciler should look again, or null when the run is done. */
export function nextPollDelayMs(rows: ReadonlyArray<{ status: CallRecordingStatus }>): number | null {
  const active = rows.filter((r) => isRecordingActive(r.status));
  if (active.length === 0) return null;
  return active.some((r) => r.status !== "recording") ? RECORDING_POLL_FAST_MS : RECORDING_POLL_MS;
}

/** Bits a screen file spends per pixel of each frame. Screen content is
 *  small high-contrast text, and a keyframe every second re-encodes all of
 *  it each second: at a flat bitrate a 4K share gets a third of the bits per
 *  pixel a 1080p one does, and its glyphs ring and smear. */
export const SCREEN_BITS_PER_PIXEL = 0.1;
/** The floor is LiveKit's own default (4500 kbps), which a 1080p share is
 *  written at today, so no share is written worse than before. The ceiling
 *  keeps an hour of a 4K share near 5 GB. */
export const SCREEN_BITRATE_KBPS = { min: 4500, max: 12000 } as const;

/** The encoding a screen file is written with. Transcoded to H.264 MP4 at
 *  the share's own size rather than copied as published: a published share
 *  is usually VP8, which LiveKit writes to WebM, and WebM from a live track
 *  carries no seek index, so every frame grab would read the file from the
 *  start and Safari would not play it at all. Keyframes every second make a
 *  grab land on the exact moment; 15fps is what a screen share sends. Sizes
 *  are kept even (H.264 wants it) and capped at 4K. The bitrate follows the
 *  pixel count (SCREEN_BITS_PER_PIXEL), rounded to 100 kbps and held inside
 *  SCREEN_BITRATE_KBPS, so a Retina or 4K share keeps its text legible. */
export function screenEncoding(
  track: { width?: number; height?: number },
): { width: number; height: number; framerate: number; key_frame_interval: number; video_bitrate: number } | null {
  if (!track.width || !track.height) return null;
  const scale = Math.min(1, 3840 / track.width, 2160 / track.height);
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  const width = even(track.width);
  const height = even(track.height);
  const framerate = 15;
  const kbps = Math.round((width * height * framerate * SCREEN_BITS_PER_PIXEL) / 1000 / 100) * 100;
  const video_bitrate = Math.min(SCREEN_BITRATE_KBPS.max, Math.max(SCREEN_BITRATE_KBPS.min, kbps));
  return { width, height, framerate, key_frame_interval: 1, video_bitrate };
}

// ── LiveKit's view onto a row ─────────────────────────────────────────────

/** LiveKit's error, said so a person knows what happened. The one LiveKit
 *  phrase worth translating is the composite that never saw a publisher. */
export function plainEgressError(raw: string | undefined | null): string {
  const text = (raw ?? "").trim();
  if (/start signal not received/i.test(text)) return "The recording never began: nobody in the room was sending audio or video yet.";
  if (!text) return "LiveKit stopped the recording without saying why.";
  return `LiveKit: ${text}`;
}

/** What to write to a row given LiveKit's latest view of its egress.
 *
 *  `drop` is a run stopped on purpose before LiveKit wrote a frame of it (the
 *  press was undone, the room emptied before anyone published): there is
 *  nothing to keep and nothing went wrong, so the row goes rather than
 *  sitting in the call as a failure. Only then: a file that ever began (we
 *  saw its time 0, or LiveKit reports one) and then failed is a recording
 *  that was lost, an upload that failed after an hour of call, and stays as
 *  a failure that says so, whatever LiveKit reports about its length.
 *
 *  A row never moves backwards. Once we asked for a stop it reads "stopping"
 *  until LiveKit says the file is finished, whatever an earlier poll in
 *  flight reports; a finished row only gains fields it lacked. */
export function egressPatch(
  row: Pick<RecordingRow, "kind" | "status" | "r2_key" | "started_at" | "ended_at" | "duration_ms" | "size_bytes" | "stop_reason" | "error">,
  egress: LivekitEgress,
): { drop: true } | { drop: false; patch: Partial<RecordingRow> } {
  const f = recordingFieldsFromEgress(egress);
  const patch: Partial<RecordingRow> = {};
  const set = <K extends keyof RecordingRow>(k: K, value: RecordingRow[K] | undefined) => {
    if (value !== undefined && row[k as keyof typeof row] !== value) patch[k] = value;
  };
  if (row.status === "failed") return { drop: false, patch };
  if (row.status === "ready") {
    if (f.status === "ready") {
      if (row.duration_ms === undefined) set("duration_ms", f.duration_ms);
      if (row.size_bytes === undefined) set("size_bytes", f.size_bytes);
      if (row.ended_at === undefined) set("ended_at", f.ended_at);
    }
    return { drop: false, patch };
  }
  if (f.status === "failed" && row.stop_reason && row.stop_reason !== "failed" && wroteNothing(row, f)) {
    return { drop: true };
  }
  const status: CallRecordingStatus =
    row.status === "stopping" && (f.status === "starting" || f.status === "recording") ? "stopping" : f.status;
  set("status", status);
  set("r2_key", f.r2_key);
  set("started_at", f.started_at);
  set("ended_at", f.ended_at);
  set("duration_ms", f.duration_ms);
  set("size_bytes", f.size_bytes);
  if (status === "failed") {
    set("error", plainEgressError(f.error ?? egress.error));
    if (!row.stop_reason) set("stop_reason", "failed");
  } else if (status === "ready" && !row.stop_reason) {
    // Finished without anyone asking: LiveKit's ceiling, a share that
    // ended, or LiveKit closing the file for its own reasons. Nothing here
    // knows the huddle ended or the room emptied (those stops are written
    // by whoever saw it, before LiveKit answers), so it says no more.
    set("stop_reason", egress.status === "limit_reached" ? "limit" : row.kind === "screen" ? "share_ended" : "ended");
  }
  return { drop: false, patch };
}

/** Whether LiveKit's view of an egress would change its row at all: what
 *  the reconciler asks before spending a mutation on it. A run that simply
 *  keeps recording answers no on every look. */
export function egressMovesRow(row: Parameters<typeof egressPatch>[0], egress: LivekitEgress): boolean {
  const result = egressPatch(row, egress);
  return result.drop || Object.keys(result.patch).length > 0;
}

/** Did an egress end without writing a frame? We never saw it record (a
 *  look while it ran stamps the row's started_at), and LiveKit's file says
 *  so: no length, no bytes, and an end at its start (an abort before the
 *  first frame reports started_at and ended_at as the same instant). Any one
 *  of those being otherwise means something was filmed and then lost. */
function wroteNothing(
  row: Pick<RecordingRow, "started_at">,
  f: { started_at?: number; ended_at?: number; duration_ms?: number; size_bytes?: number },
): boolean {
  if (row.started_at !== undefined) return false;
  if ((f.duration_ms ?? 0) > 0 || (f.size_bytes ?? 0) > 0) return false;
  return f.started_at === undefined || f.ended_at === undefined || f.ended_at <= f.started_at;
}

// ── Who may delete ────────────────────────────────────────────────────────

/** A run may be deleted by whoever pressed Record, and by an admin of the
 *  call's team (the people who may reshape what everyone else sees,
 *  privacy.isTeamAdmin). Never by the call record's started_by: in a huddle
 *  that is the scribe's seat, which moves to whichever client adopts it.
 *  Nothing may be deleted while any file of the run is still being written
 *  (its MP4 lands after the stop and would outlive its row). Reading the
 *  call is checked separately and first. */
export function mayDeleteRun(
  userId: string,
  runRows: ReadonlyArray<{ kind: string; started_by: string; status: CallRecordingStatus }>,
  isTeamAdmin: boolean,
): { ok: true } | { ok: false; reason: "not_yours" | "still_recording" } {
  const head = runRows.find((r) => r.kind === "composite") ?? runRows[0];
  if (!head || (String(head.started_by) !== String(userId) && !isTeamAdmin)) return { ok: false, reason: "not_yours" };
  if (runRows.some((r) => isRecordingActive(r.status))) return { ok: false, reason: "still_recording" };
  return { ok: true };
}

/** May this person put the call's video on its public link? Publishing reaches
 *  further than deleting (the whole internet rather than the room's
 *  audience), so it takes at least the same authority over every room video
 *  it would publish: whoever pressed Record for each of them, or an admin of
 *  the call's team. Reading the call is checked separately and first, and
 *  taking the video OFF the link needs only that: anyone who may read the
 *  call may make it less public. */
export function mayShareVideo(userId: string, composites: ReadonlyArray<{ started_by: string }>, isTeamAdmin: boolean): boolean {
  return isTeamAdmin || composites.every((c) => String(c.started_by) === String(userId));
}

/** The room videos a call's public link shows: every finished one pressed for
 *  before the moment somebody chose to include the video
 *  (`share_video_through`). A run recorded after that choice is a new
 *  recording nobody chose to publish, so it waits for a fresh choice. A link
 *  shared before the cutoff existed shows what it always showed. */
export function sharedVideoRuns<R extends { kind: string; status: string; started_at?: number | null; requested_at: number }>(
  rows: readonly R[],
  through: number | null | undefined,
): { shared: R[]; later: R[] } {
  const done = rows.filter((r) => r.kind === "composite" && r.status === "ready" && r.started_at != null);
  if (through == null) return { shared: done, later: [] };
  // Strictly before: a press landing in the very millisecond of the choice
  // is not something anybody saw when they made it.
  return { shared: done.filter((r) => r.requested_at < through), later: done.filter((r) => r.requested_at >= through) };
}

// ── Database helpers ──────────────────────────────────────────────────────

const ACTIVE: CallRecordingStatus[] = ["starting", "recording", "stopping"];

/** Every file of the room LiveKit is still working on. */
export async function activeRoomRecordings(ctx: any, roomKey: string): Promise<RecordingRow[]> {
  const out: RecordingRow[] = [];
  for (const status of ACTIVE) {
    out.push(
      ...(await ctx.db
        .query("call_recordings")
        .withIndex("by_room_status", (q: any) => q.eq("room_key", roomKey).eq("status", status))
        .collect()),
    );
  }
  return out;
}

/** The run the room is recording right now: its composite, still starting or
 *  recording. A run being stopped is no longer "recording" to the room. */
export async function liveRoomRun(ctx: any, roomKey: string): Promise<RecordingRow | null> {
  for (const status of ["recording", "starting"] as const) {
    // A room has a handful of rows in any one status; read them, keep the run.
    const rows: RecordingRow[] = await ctx.db
      .query("call_recordings")
      .withIndex("by_room_status", (q: any) => q.eq("room_key", roomKey).eq("status", status))
      .collect();
    const row = rows.find((r) => r.kind === "composite");
    if (row) return row;
  }
  return null;
}

/** Is the room being recorded? The one bit the room's people, guests and
 *  late joiners included, are always told. */
export async function isRoomRecording(ctx: any, roomKey: string): Promise<boolean> {
  return (await liveRoomRun(ctx, roomKey)) !== null;
}

/** Recording needs two things this deployment may lack: LiveKit's server
 *  credentials and the private bucket. Said before a press does anything. */
export function recordingConfigured(): boolean {
  return livekitConfigFromEnv() !== null && callRecordingsBucketFromEnv() !== null;
}

// ── A LiveKit plan out of recording minutes ───────────────────────────────
//
// LiveKit refuses every egress once the project's recording minutes for the
// billing period are spent, and keeps refusing until someone raises the plan.
// Finding that out by pressing is the worst way: each press inserts a run,
// tells the room "X started recording" (guests hear the chime and read the
// notice), and a second later tells it "Recording failed". So the first such
// refusal is remembered here (one system_config row), and until it lapses
// (RECORDING_OUTAGE_TTL_MS) or LiveKit accepts an egress again, a press is
// refused before it tells the room anything, and the room's Record button
// says why instead of offering itself.

const RECORDING_OUTAGE_KEY = "call_recording_outage";

/** The remembered outage: what a person is told, and since when. */
export async function recordingOutage(ctx: any): Promise<{ reason: string; since: number } | null> {
  const row = await ctx.db
    .query("system_config")
    .withIndex("by_key", (q: any) => q.eq("key", RECORDING_OUTAGE_KEY))
    .first();
  return row ? { reason: row.value, since: row.updated_at } : null;
}

/** Remember that LiveKit refused for spent minutes. The stamp lifts itself
 *  after RECORDING_OUTAGE_TTL_MS (a scheduled clear, so no reader needs a
 *  clock), and the next press probes LiveKit again. */
export async function noteRecordingOutage(ctx: any, reason: string): Promise<void> {
  if (await recordingOutage(ctx)) return;
  const now = Date.now();
  await ctx.db.insert("system_config", { key: RECORDING_OUTAGE_KEY, value: reason, updated_at: now });
  await ctx.scheduler.runAfter(RECORDING_OUTAGE_TTL_MS, internal.callRecordings.clearRecordingOutage, { since: now });
}

/** Forget the outage: LiveKit accepted an egress, or the stamp from `since`
 *  lapsed (a newer stamp is left alone). */
export async function forgetRecordingOutage(ctx: any, since?: number): Promise<void> {
  const row = await ctx.db
    .query("system_config")
    .withIndex("by_key", (q: any) => q.eq("key", RECORDING_OUTAGE_KEY))
    .first();
  if (row && (since === undefined || row.updated_at === since)) await ctx.db.delete(row._id);
}

export async function teammateName(ctx: any, userId: Id<"users"> | string): Promise<string> {
  const id = ctx.db.normalizeId("users", String(userId));
  return displayName(id ? await ctx.db.get(id) : null);
}

/** Whether a run's video goes out with its call's public link: the link
 *  carries video, and the run was pressed for before the choice's cutoff
 *  (sharedVideoRuns holds the same cutoff for finished files). */
export function runVideoShared(
  call: Pick<Doc<"transcripts">, "share_token" | "share_video_token" | "share_video_through">,
  run: Pick<RecordingRow, "requested_at">,
): boolean {
  return shareIncludesVideo(call) && (call.share_video_through == null || run.requested_at < call.share_video_through);
}

/** Restamp `video_shared` on the call's running room videos after its link
 *  or its video choice changed (callRecordings.setCallShareVideo,
 *  publicShare.claimShareToken): the live notice reads the run row, never
 *  the call record. Only a row whose answer moved is written. */
export async function restampRunShare(
  ctx: any,
  call: Pick<Doc<"transcripts">, "_id" | "share_token" | "share_video_token" | "share_video_through">,
): Promise<void> {
  const rows: RecordingRow[] = await ctx.db
    .query("call_recordings")
    .withIndex("by_transcript", (q: any) => q.eq("transcript_id", call._id))
    .collect();
  for (const r of rows) {
    if (r.kind !== "composite" || !isRecordingActive(r.status)) continue;
    const shared = runVideoShared(call, r);
    if (!!r.video_shared !== shared) await ctx.db.patch(r._id, { video_shared: shared });
  }
}

/** What the room's teammates are told about recording right now, or null
 *  when it is not recording. Nothing in it moves with the clock: it changes
 *  when a run starts, when LiveKit's first frame lands (started_at, once),
 *  and when it stops, so a room full of subscribers is re-pushed three times
 *  a run. An elapsed counter is the client's arithmetic on started_at. This
 *  names a teammate as the team does; a guest is told through callGuests'
 *  own notice, which carries no names and no ids. Here, beside the runs,
 *  because the live room list carries it (calls.getLiveRooms): the room's
 *  recording has one feed on the client, and one home in its store.
 *
 *  It reads the room's runs and the presser's name, never the call record:
 *  writeSegments moves that row on every transcript line, and every query
 *  carrying this (the live room list in every teammate's window, each
 *  guest's notice) would re-run with it. The two facts it needs from the
 *  record ride on the run row (call_short_id, video_shared). */
export async function roomRecordingState(ctx: any, roomKey: string) {
  // A run being stopped is no longer recording the room, and LiveKit is
  // still finishing its file: a client may say "saving".
  const run =
    (await liveRoomRun(ctx, roomKey)) ??
    (await activeRoomRecordings(ctx, roomKey)).find((r) => r.kind === "composite" && r.status === "stopping");
  if (!run) return null;
  return {
    status: run.status as "starting" | "recording" | "stopping",
    run_id: run._id,
    transcript_id: run.transcript_id,
    call_short_id: run.call_short_id ?? null,
    started_by: { id: String(run.started_by), name: await teammateName(ctx, run.started_by) },
    requested_at: run.requested_at,
    // The file's time 0: when the room began to be filmed, not the press.
    started_at: run.started_at ?? null,
    // When somebody (or something) asked a stopping run to stop: a new
    // press is accepted RECORDING_RESTART_COOLDOWN_MS after it, however long
    // LiveKit's upload takes, and the button counts from the same moment.
    stop_requested_at: run.stop_requested_at ?? null,
    // This run's video will be on the call's public link once it lands
    // (sharedVideoRuns): the room is told, since a guest's face then goes
    // further than the team.
    video_shared: !!run.video_shared,
  };
}

/** When a stopping run was asked to stop: its stamp, or for a row written
 *  before the stamp existed, its last write. */
export function stopRequestedAt(row: Pick<RecordingRow, "stop_requested_at" | "updated_at">): number {
  return row.stop_requested_at ?? row.updated_at;
}

/**
 * Stop what the room is recording: every file still being written, of every
 * run (there is one, but a leftover from a lost stop goes too), or of one run
 * (`runId`: the loop ending its own run never touches a newer press). The
 * rows flip to "stopping" here, so the room sees it on this round trip; the
 * egresses are stopped by an action right after, and the reconciler writes
 * the finished files.
 *
 * `stoppedBy` is a LiveKit identity (a user id or a `guest:` one), since
 * anyone in the room may stop. The room is always told, whoever or whatever
 * stopped it (announceRecordEnd): `announceAs` is the teammate who pressed
 * Stop, `guestName` the guest who did, and a stop nobody pressed (the room
 * emptied, the run hit its limit) says why instead. `transcriptId` narrows
 * it to one call's files, for the record ending.
 */
export async function stopRoomRecording(
  ctx: any,
  roomKey: string,
  opts: {
    reason: CallRecordingStopReason;
    stoppedBy?: string;
    announceAs?: Id<"users">;
    guestName?: string;
    transcriptId?: Id<"transcripts">;
    runId?: string;
  },
): Promise<{ stopped: number }> {
  const rows = (await activeRoomRecordings(ctx, roomKey)).filter(
    (r) =>
      (!opts.transcriptId || String(r.transcript_id) === String(opts.transcriptId)) &&
      (!opts.runId || runIdOf(r) === String(opts.runId)),
  );
  const now = Date.now();
  const toStop = rows.filter((r) => r.status !== "stopping");
  for (const r of toStop) {
    await ctx.db.patch(r._id, {
      status: "stopping",
      stop_reason: r.stop_reason ?? opts.reason,
      ...(opts.stoppedBy && !r.stopped_by ? { stopped_by: opts.stoppedBy } : {}),
      // Its own stamp, not updated_at, which every later write from
      // LiveKit's side moves: the restart cooldown and the save timeout
      // both count from the stop.
      stop_requested_at: now,
      updated_at: now,
    });
  }
  if (toStop.length === 0) return { stopped: 0 };
  await ctx.scheduler.runAfter(0, internal.callRecordings.stopEgresses, { ids: toStop.map((r) => r._id) });
  for (const composite of toStop.filter((r) => r.kind === "composite")) {
    await announceRecordEnd(ctx, composite, { reason: opts.reason, by: opts.announceAs, guestName: opts.guestName });
  }
  return { stopped: toStop.length };
}

/** Tell the room a run is no longer filming it, once, at the moment its
 *  composite leaves "starting"/"recording" however that happens: a press
 *  (by a teammate, `by`, or a guest, `guestName`), the room emptying, the
 *  six hour limit, LiveKit ending or failing it. The line is owned by the
 *  presser when nobody signed in did it, and `event_reason` says what
 *  happened, so the thread never reads "X started recording" with no end.
 *  `detail` is a failure's plain words. */
export async function announceRecordEnd(
  ctx: any,
  run: Pick<RecordingRow, "room_key" | "team_id" | "started_by" | "transcript_id">,
  opts: { reason: CallRecordingStopReason; by?: Id<"users">; guestName?: string; detail?: string },
): Promise<void> {
  await postEvent(ctx, {
    room_key: run.room_key,
    team_id: run.team_id,
    user_id: opts.by ?? run.started_by,
    event: "record_off",
    transcript_id: run.transcript_id,
    reason: opts.reason,
    ...(opts.guestName ? { guest_name: opts.guestName } : {}),
    ...(opts.detail ? { detail: opts.detail } : {}),
  });
}

/** Everyone the room's video shows may watch it: canReadCall admits a
 *  call's `recorded_people` the way it admits its speakers. Noted when a run
 *  starts (whoever is seated) and whenever a person takes a seat while one
 *  runs (calls.joinRoom). A no op when nothing is recording or the person is
 *  already listed, so a seat costs one indexed read. */
export async function noteRecordedPeople(ctx: any, roomKey: string, userIds: ReadonlyArray<Id<"users">>, run?: RecordingRow | null): Promise<void> {
  const live = run === undefined ? await liveRoomRun(ctx, roomKey) : run;
  if (!live || userIds.length === 0) return;
  const call = await ctx.db.get(live.transcript_id);
  if (!call) return;
  const have = new Set((call.recorded_people ?? []).map(String));
  const add: Id<"users">[] = [];
  for (const u of userIds) {
    if (have.has(String(u))) continue;
    have.add(String(u));
    add.push(u);
  }
  if (add.length) await ctx.db.patch(call._id, { recorded_people: [...(call.recorded_people ?? []), ...add] });
}

/** A screen share just started in the room: if it is being recorded, look for
 *  the new track now rather than at the next slow beat. The share's track is
 *  published a moment after the client says it is sharing, hence the delay;
 *  the reconciler's own beat is the backstop if this look is early. */
export async function nudgeRecordingForShare(ctx: any, roomKey: string): Promise<void> {
  const run = await liveRoomRun(ctx, roomKey);
  if (!run) return;
  const loop = await recordingLoop(ctx, run._id);
  const now = Date.now();
  if (loop && now - Math.max(loop.looked_at, loop.nudged_at ?? 0) < RECORDING_NUDGE_MIN_GAP_MS) return;
  if (loop) await ctx.db.patch(loop._id, { nudged_at: now });
  await ctx.scheduler.runAfter(2_000, internal.callRecordings.reconcileRun, { run_id: run._id, once: true });
}

/** Remove every recording of one call: its rows, each run's loop, and
 *  everything under the call's prefix in the bucket (files, live frames and
 *  LiveKit's manifests alike). Answers null, touching nothing, while any file
 *  of the call is still being written. */
export async function purgeCallRecordings(ctx: any, transcriptId: Id<"transcripts">): Promise<number | null> {
  const rows: RecordingRow[] = await ctx.db
    .query("call_recordings")
    .withIndex("by_transcript", (q: any) => q.eq("transcript_id", transcriptId))
    .collect();
  // A call nobody recorded has nothing in the bucket (a deleted run took its
  // prefix with it), so it costs no listing.
  if (rows.length === 0) return 0;
  if (rows.some((r) => isRecordingActive(r.status))) return null;
  for (const runId of new Set(rows.map(runIdOf))) {
    const loop = await recordingLoop(ctx, runId as Id<"call_recordings">);
    if (loop) await ctx.db.delete(loop._id);
  }
  for (const r of rows) await ctx.db.delete(r._id);
  // The whole call's prefix rather than each row's keys, so a file that
  // landed after its row failed goes too.
  await ctx.scheduler.runAfter(0, internal.callRecordings.deleteObjects, { keys: [], prefixes: [callRecordingCallPrefix(transcriptId)], attempt: 0 });
  return rows.length;
}

/** A run's loop bookkeeping (call_recording_loops), kept off the rows every
 *  reader subscribes to. */
export async function recordingLoop(ctx: any, runId: Id<"call_recordings">): Promise<Doc<"call_recording_loops"> | null> {
  return await ctx.db
    .query("call_recording_loops")
    .withIndex("by_run", (q: any) => q.eq("run_id", runId))
    .first();
}
