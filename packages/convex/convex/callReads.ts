// Reading a call's record (transcripts.ts list/get/ref surfaces): who may
// read it (canReadCall), the row a list draws, the whole call a detail page
// draws, and what hangs off it (its board, the sessions it reached, the tasks
// pulled from it). Plain helpers; the queries that use them stay in
// transcripts.ts.
import type { Doc, Id } from "./_generated/dataModel";
import { authorizeRoom, authorizeRoomNoGrant, canReadRoomlessCall } from "./callRooms";
import { isTeamMember } from "./privacy";
import { teamHasFeature } from "./teamFeatures";
import { isRoomlessKey, parseRoomKey, sessionRoomConversationId } from "@codecast/shared/contracts";
import { canAccessConversation, canAccessDoc, canAccessTask } from "./lib/access";
import { agentIdentity } from "./callChat";
import { mayPublishCall } from "./lib/callRecordingRuns";
import { callGuestsOnRecord } from "./lib/callGuestAdmission";
import { speakerRoster, speakersForClient } from "./lib/callSpeakers";
import type { Route } from "./transcripts";

/** A route as clients read it: whose it is, and whether its agent wears a face. */
export function routeView(t: Doc<"transcripts">, r: Route) {
  return {
    kind: r.kind,
    target: r.target,
    mode: r.mode,
    added_by: String(r.added_by ?? t.started_by),
    ...(r.face === false ? { face: false } : {}),
  };
}

/** May `userId` read this call's record? Two doors: the room's own
 *  membership rules (no invite grant — a grant admits its guest to the
 *  running huddle, never to everything the room ever recorded), or having
 *  BEEN in it: the words you sat through stay yours after the huddle ends,
 *  guest or not — while you remain on the call's team. Leaving the team
 *  closes this door like every other (and keeps list and get agreeing:
 *  listCallsCore only walks the viewer's current teams). participants[] is
 *  the scribe's attribution list — built from speaker ids the scribe client
 *  reports (appendSegments), not server-derived — so this second door
 *  trusts the scribe, which already holds the words. A guest who never
 *  spoke leaves no participant row and loses the record when the huddle
 *  ends: accepted. */
export async function canReadCall(
  ctx: any,
  userId: Id<"users">,
  t: Doc<"transcripts">,
  opts: { liveDoor?: boolean } = {},
): Promise<boolean> {
  // A RECORDING IS ITS CREATOR'S until they say otherwise. No participant
  // door (they are the only voice in it), and for the creator no team door
  // and no feature gate — a person recording the meeting in the room around
  // them has not published anything to anybody. `rec_shared` is the creator
  // having said otherwise: the recording was triaged into its team, and
  // teammates read it under the ordinary team door, feature gate included.
  // A MEETING BOT'S CALL is its sender's the same way, plus a participant
  // door for a teammate the bot heard speak (callRooms.canReadRoomlessCall).
  if (isRoomlessKey(t.room_key)) return await canReadRoomlessCall(ctx, userId, t);
  // The people in it: whoever spoke, whoever scribed it (started_by), and
  // whoever a recording of it showed
  // (recorded_people: seated while it was filmed, the presser included,
  // even when they came in on an invite grant, never spoke, or transcription
  // was off). Still only while they are on the team with calls on. The scope
  // is the whole call, not the stretch they sat in: anyone filmed in any part
  // of it may read all of it, every run and the full transcript, the way a
  // speaker always could.
  if (
    (t.participants ?? []).some((p) => String(p.id) === String(userId)) ||
    (t.recorded_people ?? []).some((id) => String(id) === String(userId)) ||
    String(t.started_by) === String(userId)
  ) {
    return (
      (await isTeamMember(ctx, userId, t.team_id)) &&
      (await teamHasFeature(ctx, t.team_id, "calls"))
    );
  }
  // A huddle about your own session that feeds that session (its own route,
  // carried or owed) is yours to read: its words are your session's, and a
  // scribe handover (releaseScribe) can leave you neither speaker nor scribe.
  // A private huddle a teammate chose on your session withheld that route,
  // so it stays with the people in it. A route someone removed leaves no
  // trace, and then this door stays shut.
  const own = sessionRoomConversationId(t.room_key);
  if (own && (t.own_route_owed || t.routes.some((r) => r.kind === "session" && r.target === own))) {
    const conversation = await ctx.db.get(own as Id<"conversations">);
    if (
      conversation &&
      String(conversation.user_id) === String(userId) &&
      (await isTeamMember(ctx, userId, t.team_id)) &&
      (await teamHasFeature(ctx, t.team_id, "calls"))
    ) {
      return true;
    }
  }
  // A private huddle's record is the people in it. The room's membership
  // reaches the team (a team-visible session, a public channel) everywhere
  // but a people room, whose key names exactly the people it was for.
  const membershipReads = !t.private || parseRoomKey(t.room_key)?.kind === "dm";
  if (membershipReads && (await authorizeRoomNoGrant(ctx, userId, t.room_key)).ok) return true;
  // The huddle running now reads like the huddle: whoever its door admits
  // (the open door, a ring) may read the words being said in it, the way they
  // could walk in and hear them. That is this run only. Once it ends, the
  // doors above decide, so a walk-in who never spoke loses it as before.
  // The words only: a call's recordings pass `liveDoor: false`, so walking
  // past an occupied room never opens its video or its delete.
  return opts.liveDoor !== false && t.status === "live" && (await authorizeRoom(ctx, userId, t.room_key)).ok;
}

export function shapeCallRow(t: Doc<"transcripts">) {
  return {
    _id: t._id,
    short_id: t.short_id ?? null,
    room_key: t.room_key,
    status: t.status,
    // The room emptied and the huddle is waiting out its grace.
    idle_since: t.idle_since ?? null,
    started_at: t.started_at,
    ended_at: t.ended_at ?? null,
    title: t.title ?? null,
    participants: t.participants ?? [],
    summary: t.summary ?? null,
    action_items: t.action_items ?? [],
    summary_status: t.summary_status ?? null,
    // Absent on everything that got its words live, which is every huddle. A
    // recording waiting on the server to read its audio says so with this.
    transcribe_status: t.transcribe_status ?? null,
    last_seq: t.last_seq,
    // For the calls page's recording scope chip: whose row this is, where it
    // is filed, and whether the creator shared it there. Routing facts plus
    // one flag — access already happened (canReadCall) before shaping.
    started_by: String(t.started_by),
    team_id: String(t.team_id),
    rec_shared: t.rec_shared ?? false,
    // Readable only by the people in it: started private, or one person's
    // alone (a room of one, a session the team cannot read). The calls page
    // files these under Personal.
    private: t.private ?? false,
    // Whether Record was ever pressed on this call (a run seats the people it
    // shows): the history marks the calls that have video, and a surface
    // that cannot play it yet (the phone) says where it plays rather than
    // offering only the words. Off the row, so neither the list nor the
    // detail re-runs for the recording reconciler's writes.
    filmed: callFilmed(t),
    // A screen recording somebody sent to a session (screenRecordings.ts):
    // its picture size, and whether the video had any sound to transcribe.
    screen: t.screen_recording
      ? {
          width: t.screen_recording.width ?? null,
          height: t.screen_recording.height ?? null,
          no_audio: !!t.screen_recording.no_audio,
          // The session it was sent to: a daemon expands its tag only there,
          // and only for a message its recorder sent (cli screenRecordingBrief).
          conversation_id: t.screen_recording.conversation_id ? String(t.screen_recording.conversation_id) : null,
        }
      : null,
  };
}

/** Does this call have video, or video on its way? The row's own count of
 *  files that have not failed (lib/callRecordingRuns.syncCallVideo), so the
 *  row answers without reading a run. Never recorded_people: that is who may
 *  watch, written at the press, and it outlives a refused start and a
 *  deleted run. */
export function callFilmed(t: Pick<Doc<"transcripts">, "video_runs">): boolean {
  return (t.video_runs ?? 0) > 0;
}

/** How many rows one source of the call list may read past the calls it
 *  keeps. A team whose newest rows are all silent scratch huddles (a ring
 *  answered and hung up, a microphone test) stays bounded rather than
 *  walking its whole history. */
const CALL_LIST_SCAN_CAP = 400;

export async function listCallsCore(ctx: any, userId: Id<"users">, limit: number) {
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  // Each source keeps its own newest `limit` calls the viewer would see,
  // filtering WHILE it walks. Taking `limit` rows and filtering afterwards
  // let a team whose newest rows are silent huddles contribute nothing, so
  // the merged list came back short and skipped recent calls. With every
  // source holding its own top `limit` kept rows, the merged top `limit` is
  // exact.
  // A screen recording is a message in a session, not a call: it lives in
  // that session's thread and on its own page, never in the history.
  const keep = async (t: Doc<"transcripts">) =>
    !t.screen_recording && !(await isSilentHuddle(ctx, t)) && (await canReadCall(ctx, userId, t));
  const walk = async (query: any, only?: (t: Doc<"transcripts">) => boolean) => {
    const kept: Doc<"transcripts">[] = [];
    let scanned = 0;
    for await (const t of query) {
      if (kept.length >= limit || scanned++ >= CALL_LIST_SCAN_CAP) break;
      if ((!only || only(t)) && (await keep(t))) kept.push(t);
    }
    return kept;
  };
  const rows: Doc<"transcripts">[] = [];
  for (const m of memberships) {
    rows.push(
      ...(await walk(
        ctx.db
          .query("transcripts")
          .withIndex("by_team_started", (q: any) => q.eq("team_id", m.team_id))
          .order("desc"),
      )),
    );
  }
  // The personal shelf: my own recordings, whatever team they were filed
  // under. The team walk above only sees the CURRENT teams — a recording
  // routed to a team I later left, or filed under a team this viewer stopped
  // looking at, is still mine to read, and this is the index that finds it.
  rows.push(
    ...(await walk(
      ctx.db
        .query("transcripts")
        .withIndex("by_creator_started", (q: any) => q.eq("started_by", userId))
        .order("desc"),
      (t) => isRoomlessKey(t.room_key),
    )),
  );
  rows.sort((a, b) => b.started_at - a.started_at);
  const out = [];
  const seen = new Set<string>();
  for (const t of rows) {
    if (out.length >= limit) break;
    if (seen.has(String(t._id))) continue;
    seen.add(String(t._id));
    out.push(shapeCallRow(t));
  }
  return out;
}

/** A huddle that ended with nothing in it: no word said, no line typed or
 *  answered (an agent coming and going, the switch flipped, is the room's
 *  log, not content). A ring answered and hung up, a join to test the
 *  microphone. It is no call anybody would look for, so the history leaves
 *  it out, unless it was filmed (the video is content). A recording is
 *  never silent here: its words can arrive after it ends. */
async function isSilentHuddle(ctx: any, t: Doc<"transcripts">): Promise<boolean> {
  if (t.status === "live" || isRoomlessKey(t.room_key) || t.last_seq > 0) return false;
  // A huddle that was filmed and never transcribed is still a call: its
  // video is the content. The same rule the Video glyph reads.
  if (callFilmed(t)) return false;
  const line = await ctx.db
    .query("call_chat_messages")
    .withIndex("by_transcript", (q: any) => q.eq("transcript_id", t._id))
    .filter((q: any) => q.eq(q.field("event"), undefined))
    .first();
  return !line;
}

export async function getCallCore(
  ctx: any,
  userId: Id<"users">,
  transcriptId: Id<"transcripts">,
) {
  const t = await ctx.db.get(transcriptId);
  if (!t) return null;
  if (!(await canReadCall(ctx, userId, t))) return null;
  const segs = await ctx.db
    .query("transcript_segments")
    .withIndex("by_transcript_seq", (q: any) => q.eq("transcript_id", t._id))
    .collect();
  return {
    ...shapeCallRow(t),
    // "Anyone with the link" (publicShare.ts): readers may copy it, like a doc's.
    share_token: t.share_token ?? null,
    // Whether this viewer may open the link to anyone (mayPublishCall: in the
    // call, or a team admin), so the popover says who can rather than failing
    // on the press. Closing it is any reader's.
    can_share_link: await mayPublishCall(ctx, userId, t),
    // Present only for a recording that finished uploading its audio; a
    // detail view offers playback when there is something to play.
    recording_url: t.recording_storage_id
      ? await ctx.storage.getUrl(t.recording_storage_id)
      : null,
    routes: t.routes.map((r: Route) => routeView(t, r)),
    sessions: await linkedSessions(ctx, userId, t._id),
    // The call's board (callStage.ensureCallBoard), when this viewer may open it.
    board: await callBoardFor(ctx, userId, t),
    // The people from outside the team who were let in, each already marked
    // "(guest)" in the name, with `spoke` matched by identity against
    // `participants` (who the scribe heard), so a page lists the listeners
    // from here without matching names.
    guests: await callGuestsOnRecord(ctx, t),
    // Who each voice of a diarized voice note is (lib/callSpeakers). The
    // segments below carry their written speaker_name; a client names a line
    // through resolveLineSpeaker(segment, speakers, roster), so an assignment
    // made on this device paints every line before the server answers.
    speakers: speakersForClient(t),
    // The names of every teammate those speakers name, so a client names
    // them whatever workspace it is in (callSpeakerRoster lays these over
    // its own team members).
    speaker_names: await speakerRoster(ctx, t.speakers),
    segments: segs.map((s: Doc<"transcript_segments">) => ({
      seq: s.seq,
      speaker_id: s.speaker_id,
      speaker_name: s.speaker_name,
      text: s.text,
      t0: s.t0,
      t1: s.t1,
      at: s._creationTime,
    })),
  };
}

async function callBoardFor(ctx: any, userId: Id<"users">, t: Doc<"transcripts">): Promise<{ doc_id: string; title: string } | null> {
  if (!t.board_doc_id) return null;
  const doc = await ctx.db.get(t.board_doc_id);
  if (!doc || doc.archived_at || !(await canAccessDoc(ctx, userId, doc))) return null;
  return { doc_id: String(doc._id), title: doc.title };
}

/** The sessions a call reached that the viewer may open, newest first. */
async function linkedSessions(ctx: any, userId: Id<"users">, transcriptId: Id<"transcripts">) {
  const links: Doc<"call_session_links">[] = await ctx.db
    .query("call_session_links")
    .withIndex("by_transcript", (q: any) => q.eq("transcript_id", transcriptId))
    .collect();
  links.sort((a, b) => b.updated_at - a.updated_at);
  const out = [];
  for (const l of links) {
    const conv = await ctx.db.get(l.conversation_id);
    if (!conv || !(await canAccessConversation(ctx, userId, conv))) continue;
    const who = await agentIdentity(ctx, l.conversation_id);
    if (!who) continue;
    out.push({ ...who, live: !!l.live, excerpts: l.excerpts ?? [], added_by: String(l.added_by), at: l.updated_at });
  }
  return out;
}

/** The tasks pulled from a call (tasks.from_call) that the viewer may read. */
export async function callTasks(ctx: any, userId: Id<"users">, transcriptId: Id<"transcripts">) {
  const rows: Doc<"tasks">[] = await ctx.db
    .query("tasks")
    .withIndex("by_from_call", (q: any) => q.eq("from_call", transcriptId))
    .take(200);
  const out = [];
  for (const t of rows) {
    if (!(await canAccessTask(ctx, userId, t))) continue;
    out.push({ short_id: t.short_id, title: t.title, status: t.status, assignee: t.assignee ?? null });
  }
  return out;
}
