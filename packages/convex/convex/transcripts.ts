// Huddle transcription control plane.
//
// The SCRIBE — the client that toggled Transcribe on — owns the run: it holds
// every audio track in the room (its mic plus each subscribed remote track),
// streams each one to ASR separately, and appends attributed segments here.
// Speaker attribution is structural (track identity = participant), never
// inferred. This module stores the segments, mints short-lived ASR credentials,
// and delivers accumulated words to the transcript's routes: an agent session
// (the same rails as `cast send`, so the agent answers in its own thread), a
// doc (content append), or a linked Slack channel. Route mode "live" delivers
// on the silence gaps the scribe detects via server VAD — the natural beat for
// an agent to reply; "after" delivers once at stop.
//
// A RECORDING (`rec:<uuid>`, see callRooms) is the same machinery with one
// track and no room: somebody presses record, their microphone becomes the
// only scribe, and everything after capture — segments, flush beats, the
// summary and action items, the calls page, `cast calls` — happens unchanged.
// Only three things differ, and each is marked where it lives: the paths a
// recording may walk pass `{ rec: true }` to authorizeRoom; `canReadCall`
// answers a recording with its creator and nobody else; and the row carries
// its own liveness (`last_beat`) because there are no seat leases to read it
// off, plus the audio file it uploads when it stops.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  CALL_MEMBER_STALE_MS,
  authorizeRoom,
  authorizeRoomNoGrant,
  isRoomTranscribeOff,
  isSeat,
  liveMembers,
} from "./callRooms";
import { isTeamMember } from "./privacy";
import { teamHasFeature } from "./teamFeatures";
import { performSessionSend } from "./pendingMessages";
import {
  RECORDING_SUMMARY_PUSH_TYPE,
  TRANSCRIBE_MAX_BYTES,
  formatHuddleDigest,
  formatHuddleSummaryTag,
  formatTranscriptChunk as formatChunk,
  isRecRoomKey,
  parseRoomKey,
} from "@codecast/shared/contracts";
import { requireAccessibleDoc } from "./lib/access";
import { verifyApiToken } from "./apiTokens";
import { enqueuePush } from "./pushRouter";

// added_by is deliberately NOT accepted from clients: delivery acts AS the
// route's adder (deliverRoutes), so a client-chosen added_by would let a
// scribe inject messages as any user into sessions and docs only that user
// can reach. The server stamps it from the authenticated caller everywhere.
const ROUTE_VALIDATOR = v.object({
  kind: v.union(v.literal("session"), v.literal("doc"), v.literal("slack")),
  target: v.string(),
  mode: v.union(v.literal("live"), v.literal("after")),
  sent_seq: v.number(),
});

// A transcript the caller may write to: they started it and it is live.
async function requireOwnLiveTranscript(
  ctx: any,
  userId: Id<"users">,
  id: Id<"transcripts">,
): Promise<Doc<"transcripts">> {
  const t = await ctx.db.get(id);
  if (!t || String(t.started_by) !== String(userId)) {
    throw new Error("Transcript not found");
  }
  if (t.status !== "live") throw new Error("Transcript has ended");
  return t;
}

/** Who runs the room's transcript, decided here so every client agrees.
 *
 *  Every huddle transcribes: each deliberate participant's client asks to
 *  scribe when it joins, and this is the arbiter. One live transcript per
 *  room; the caller either owns it ("scribe" — a fresh run, their own run
 *  resumed after a reload, or an orphaned run adopted because its scribe's
 *  seat lease died), or somebody else is running it ("observer" — open no
 *  pipes, or the room would hear every word twice), or the huddle turned
 *  transcription off ("off", auto starts only — a manual toggle clears the
 *  flag first). Adoption reassigns `started_by`, which is what the append and
 *  flush paths authorize on: the new scribe must be able to write. */
export const start = mutation({
  args: {
    room_key: v.string(),
    routes: v.optional(v.array(ROUTE_VALIDATOR)),
    // The client is starting on its own because it joined a huddle, not
    // because a person pressed Transcribe. Honors the room's opt-out.
    auto: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    transcript_id: Id<"transcripts"> | null;
    existing: boolean;
    role: "scribe" | "observer" | "off";
  }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    // `{ rec: true }`: this is one of the five paths a recording is allowed
    // to walk. For a rec key the rule underneath is the transcript's own
    // creator, and a fresh uuid nobody has started on belongs to whoever
    // starts it here.
    const auth = await authorizeRoom(ctx, userId, args.room_key, { rec: true });
    if (!auth.ok) throw new Error(`Cannot transcribe this room: ${auth.reason}`);
    if (args.auto && (await isRoomTranscribeOff(ctx, args.room_key))) {
      return { transcript_id: null, existing: false, role: "off" };
    }
    const existing = await ctx.db
      .query("transcripts")
      .withIndex("by_room", (q) => q.eq("room_key", args.room_key))
      .collect();
    const live = existing.find((t) => t.status === "live");
    if (live) {
      if (String(live.started_by) === String(userId)) {
        return { transcript_id: live._id, existing: true, role: "scribe" };
      }
      // A recording never reaches here (only its creator may start on its
      // key), so the seat check reads the room the huddle is actually in.
      const seated = await ctx.db
        .query("call_members")
        .withIndex("by_room", (q: any) => q.eq("room_key", args.room_key))
        .collect();
      const scribeSeated = liveMembers(seated, Date.now()).some(
        (m: any) => String(m.user_id) === String(live.started_by),
      );
      if (scribeSeated) return { transcript_id: live._id, existing: true, role: "observer" };
      await ctx.db.patch(live._id, { started_by: userId });
      return { transcript_id: live._id, existing: true, role: "scribe" };
    }
    const id = await ctx.db.insert("transcripts", {
      room_key: args.room_key,
      team_id: auth.teamId,
      started_by: userId,
      status: "live",
      started_at: Date.now(),
      routes: (args.routes ?? []).map((r) => ({ ...r, added_by: userId })),
      last_seq: 0,
    });
    return { transcript_id: id, existing: false, role: "scribe" };
  },
});

export const setRoutes = mutation({
  args: {
    transcript_id: v.id("transcripts"),
    routes: v.array(ROUTE_VALIDATOR),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const t = await requireOwnLiveTranscript(ctx, userId, args.transcript_id);
    // Keep delivery watermarks (and who added what) for routes that survive
    // the edit, so changing one route never re-sends another's history.
    const routes = args.routes.map((r) => {
      const prior = t.routes.find((p) => p.kind === r.kind && p.target === r.target);
      return {
        ...r,
        sent_seq: prior?.sent_seq ?? 0,
        added_by: prior?.added_by ?? userId,
      };
    });
    await ctx.db.patch(t._id, { routes });
  },
});

// Any participant points the live words at a session or doc — feeding an
// agent must not require being the scribe. The route delivers as its adder,
// and the backlog ships immediately so the target starts with full context.
export const addRoute = mutation({
  args: {
    transcript_id: v.id("transcripts"),
    kind: v.union(v.literal("session"), v.literal("doc"), v.literal("slack")),
    target: v.string(),
    mode: v.union(v.literal("live"), v.literal("after")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const t = await ctx.db.get(args.transcript_id);
    // A LIVE-huddle action authorizes like the huddle, grant included: a
    // guest rung into the room may point the words at their agent even
    // before they have spoken (canReadCall is the HISTORY rule — its
    // participant door would blink on only once the scribe hears them).
    if (!t || !(await authorizeRoom(ctx, userId, t.room_key, { rec: true })).ok) {
      throw new Error("Transcript not found");
    }
    // A recording has exactly one participant, so "any participant" is its
    // owner and nothing else. Checked against THIS row rather than the room:
    // a rec key is a uuid, and the room's answer could be some later
    // transcript that reused it.
    if (isRecRoomKey(t.room_key) && String(t.started_by) !== String(userId)) {
      throw new Error("Transcript not found");
    }
    if (t.status !== "live") throw new Error("Transcript has ended");
    if (t.routes.some((r) => r.kind === args.kind && r.target === args.target)) return;
    await ctx.db.patch(t._id, {
      routes: [
        ...t.routes,
        { kind: args.kind, target: args.target, mode: args.mode, sent_seq: 0, added_by: userId },
      ],
    });
    if (args.mode === "live") {
      await ctx.scheduler.runAfter(0, internal.transcripts.deliverRoutes, {
        transcript_id: t._id,
        include_after_routes: false,
      });
    }
  },
});

export const removeRoute = mutation({
  args: {
    transcript_id: v.id("transcripts"),
    kind: v.string(),
    target: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const t = await ctx.db.get(args.transcript_id);
    if (!t) throw new Error("Transcript not found");
    const route = t.routes.find((r) => r.kind === args.kind && r.target === args.target);
    if (!route) return;
    // The scribe manages the run; everyone else manages only their own routes.
    const isScribe = String(t.started_by) === String(userId);
    const isAdder = route.added_by && String(route.added_by) === String(userId);
    if (!isScribe && !isAdder) throw new Error("Not your route");
    await ctx.db.patch(t._id, {
      routes: t.routes.filter((r) => !(r.kind === args.kind && r.target === args.target)),
    });
  },
});

export const appendSegments = mutation({
  args: {
    transcript_id: v.id("transcripts"),
    segments: v.array(
      v.object({
        speaker_id: v.string(),
        speaker_name: v.string(),
        text: v.string(),
        t0: v.number(),
        t1: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const t = await requireOwnLiveTranscript(ctx, userId, args.transcript_id);
    return { last_seq: await writeSegments(ctx, t, args.segments) };
  },
});

/**
 * The one place `transcript_segments` rows are made.
 *
 * Two callers reach it and they disagree about everything except the write:
 * the live scribe appends to its own transcript while it runs, and the
 * recording transcriber appends to its own transcript after it ended. Keeping
 * one writer is what makes the seq watermark trustworthy — it is the routes'
 * delivery cursor, and two hand-rolled increments would eventually skip one.
 *
 * `trackParticipants` is off for a recording, deliberately. The roster means
 * "voices we could put a name to", and one microphone in a room can name none
 * of them; filling it with a placeholder would put a fake person on the call
 * object that the list, the summary and the detail view all read.
 */
async function writeSegments(
  ctx: any,
  t: Doc<"transcripts">,
  segments: {
    speaker_id: string;
    speaker_name: string;
    text: string;
    t0: number;
    t1: number;
  }[],
  opts: { trackParticipants?: boolean } = {},
): Promise<number> {
  const trackParticipants = opts.trackParticipants !== false;
  let seq = t.last_seq;
  for (const s of segments) {
    const text = s.text.trim();
    if (!text) continue;
    seq += 1;
    await ctx.db.insert("transcript_segments", {
      transcript_id: t._id,
      seq,
      speaker_id: s.speaker_id,
      speaker_name: s.speaker_name,
      text,
      t0: s.t0,
      t1: s.t1,
    });
  }
  if (seq === t.last_seq) return seq;
  // Accumulate the speaker roster on the call object as voices appear —
  // actual speakers, not seat leases (a lurker who never talks is in the
  // room but not in the transcript's cast).
  const known = new Set((t.participants ?? []).map((p) => p.id));
  const newcomers = !trackParticipants
    ? []
    : segments
        .filter((s) => s.text.trim() && !known.has(s.speaker_id))
        .reduce((acc: { id: string; name: string }[], s) => {
          if (!acc.some((p) => p.id === s.speaker_id)) {
            acc.push({ id: s.speaker_id, name: s.speaker_name });
          }
          return acc;
        }, []);
  await ctx.db.patch(t._id, {
    last_seq: seq,
    ...(newcomers.length
      ? { participants: [...(t.participants ?? []), ...newcomers] }
      : {}),
  });
  return seq;
}

// The room went quiet (scribe-side VAD gap): ship every live route its unsent
// segments. Also called with force=true on stop, where "after" routes ship too.
export const flush = mutation({
  args: { transcript_id: v.id("transcripts"), force: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const t = await ctx.db.get(args.transcript_id);
    if (!t || String(t.started_by) !== String(userId)) {
      throw new Error("Transcript not found");
    }
    await ctx.scheduler.runAfter(0, internal.transcripts.deliverRoutes, {
      transcript_id: t._id,
      include_after_routes: args.force === true,
    });
  },
});

/**
 * Has a recording's own lease gone stale?
 *
 * This is the whole difference between a recording and a huddle in the orphan
 * sweep. A huddle's transcript is kept alive by the room's seat leases; a
 * recording has no room and no seats, so an empty `call_members` table is its
 * NORMAL state — reading that as "the room emptied" would end every live
 * recording on the sweep's next pass, two minutes in. It reads the row's own
 * beat instead, through the same window a seat uses.
 *
 * A recording that has not beaten yet is measured from its start, so a tab
 * that died during the first fifteen seconds still gets swept.
 */
export function recLeaseExpired(
  t: { last_beat?: number; started_at: number },
  now: number,
): boolean {
  return now - (t.last_beat ?? t.started_at) >= CALL_MEMBER_STALE_MS;
}

/** A recording says it is still going. The room's seat leases do this job for
 *  a huddle; a recording has no room, so it holds its own lease and the orphan
 *  sweep reads the same staleness window off it. */
export const beat = mutation({
  args: { transcript_id: v.id("transcripts") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const t = await requireOwnLiveTranscript(ctx, userId, args.transcript_id);
    // Only a recording holds its own lease; a huddle's liveness is its seats.
    if (!isRecRoomKey(t.room_key)) throw new Error("Not a recording");
    await ctx.db.patch(t._id, { last_beat: Date.now() });
  },
});

/** The audio a recording kept, uploaded once it stops. Additive to the row and
 *  deliberately separate from `stop`: the transcript, the summary and the
 *  action items are the artifact, and they must land whether or not the bytes
 *  do. Callable on an ended transcript for exactly that reason — the upload
 *  finishes after the recording has. */
export const attachRecording = mutation({
  args: {
    transcript_id: v.id("transcripts"),
    storage_id: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const t = await ctx.db.get(args.transcript_id);
    if (!t || String(t.started_by) !== String(userId)) {
      throw new Error("Transcript not found");
    }
    // A huddle has no single recording to keep: its transcript is shared, and
    // an audio blob attached by one seat would publish that seat's mic to the
    // whole room's detail page. Only rec transcripts carry audio.
    if (!isRecRoomKey(t.room_key)) throw new Error("Not a recording");
    await ctx.db.patch(t._id, { recording_storage_id: args.storage_id });
    if (!needsServerTranscription(t)) return;
    // A finished recording that produced no words while it ran has none at all
    // unless the server reads them out of the audio. That is every phone
    // recording by construction, and a desktop one whose recognizer died.
    //
    // Both statuses go back to pending here. `stop` already ran the summary
    // against an empty transcript and got "skipped" for it, which would
    // otherwise sit on the screen as a finished, wordless meeting while the
    // words were still being fetched.
    await ctx.db.patch(t._id, {
      transcribe_status: "pending",
      summary_status: "pending",
    });
    await ctx.scheduler.runAfter(0, internal.transcripts.transcribeRecording, {
      transcript_id: t._id,
    });
  },
});

/**
 * Does this recording still need its words read out of its audio?
 *
 * Three conditions, and each one rules out a different way of being wrong:
 * only a recording has audio to read (a huddle's transcript is shared and its
 * audio is nobody's); only an ENDED one is finished being written, so this can
 * never race a live recognizer that is still appending; and only an EMPTY one
 * has nothing, so a desktop recording whose live pipe worked is never
 * transcribed twice and never pays for the same words at the same API a second
 * time.
 *
 * Exported for its test: the condition is the whole trigger, and getting it
 * wrong is either a silent duplicate transcript or a permanently wordless one.
 */
export function needsServerTranscription(t: {
  room_key: string;
  status: string;
  last_seq: number;
}): boolean {
  return isRecRoomKey(t.room_key) && t.status === "ended" && t.last_seq === 0;
}

export const stop = mutation({
  args: { transcript_id: v.id("transcripts") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const t = await ctx.db.get(args.transcript_id);
    if (!t || String(t.started_by) !== String(userId)) {
      throw new Error("Transcript not found");
    }
    await endTranscript(ctx, t);
  },
});

/** The one way a transcript ends: flip the flag, deliver the "after" routes,
 *  generate the summary. `stop` (the scribe's toggle), the room-emptied
 *  hooks in calls.ts and the orphan sweep all funnel here. */
export async function endTranscript(
  ctx: any,
  t: Doc<"transcripts">,
  endedAt: number = Date.now(),
): Promise<void> {
  if (t.status === "ended") return;
  await ctx.db.patch(t._id, {
    status: "ended",
    ended_at: Math.max(t.started_at, endedAt),
    summary_status: "pending",
  });
  await ctx.scheduler.runAfter(0, internal.transcripts.deliverRoutes, {
    transcript_id: t._id,
    include_after_routes: true,
  });
  await ctx.scheduler.runAfter(0, internal.transcripts.generateSummary, {
    transcript_id: t._id,
  });
}

/** A transcript has no lease of its own; the room's does. When a room has no
 *  live member left, its live transcript is over — nobody is in it to be
 *  transcribed, and the scribe's audio pipes died with their tab. Called from
 *  calls.leaveRoom / joinRoom when they find the room empty, and by the cron
 *  sweep for rooms nobody touched again. */
export async function endLiveTranscriptsForRoom(ctx: any, roomKey: string): Promise<number> {
  const rows: Doc<"transcripts">[] = await ctx.db
    .query("transcripts")
    .withIndex("by_room", (q: any) => q.eq("room_key", roomKey))
    .collect();
  let n = 0;
  for (const t of rows) {
    if (t.status !== "live") continue;
    await endTranscript(ctx, t);
    n++;
  }
  return n;
}

/** Cron backstop: a live transcript whose room holds no fresh lease is an
 *  orphan (the scribe closed the tab, the last member timed out and nobody
 *  rejoined to trigger the in-mutation end). Ends it. */
export const sweepOrphanedLive = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const live = await ctx.db
      .query("transcripts")
      .withIndex("by_status", (q) => q.eq("status", "live"))
      .collect();
    let ended = 0;
    for (const t of live) {
      // A recording is its own room, so it holds its own lease. Without this
      // branch the sweep would end every live recording two minutes in: a rec
      // key has no call_members rows by design, which reads here as an empty
      // room. Same staleness window as a seat, ended at the last beat so the
      // duration stays honest.
      if (isRecRoomKey(t.room_key)) {
        if (!recLeaseExpired(t, now)) continue;
        await endTranscript(ctx, t, t.last_beat ?? t.started_at);
        ended++;
        continue;
      }
      const seated = await ctx.db
        .query("call_members")
        .withIndex("by_room", (q) => q.eq("room_key", t.room_key))
        .collect();
      if (liveMembers(seated, now).length > 0) continue;
      // The honest end is when the last lease was refreshed, not when the
      // sweep noticed — otherwise an orphan's duration grows until it runs.
      //
      // SEATS ONLY. A prewarm row is a connection held open ahead of a burst
      // by somebody who opened this DM after the huddle died, so its lease is
      // the freshest thing in the room and means nothing about when people
      // stopped talking. Counting it would date the end up to ninety seconds
      // late and inflate the recording by exactly that.
      const lastSeen = seated.filter(isSeat).reduce((m, r) => Math.max(m, r.last_seen), 0);
      await endTranscript(ctx, t, lastSeen || now);
      ended++;
    }
    return { checked: live.length, ended };
  },
});

// ── The call object: summary + list/detail surfaces ───────────────────────
// Otter's post-meeting artifact, minus the guesswork: attribution here is
// structural (one audio track = one speaker), so "who said what" is exact,
// and the summary/action items generate within seconds of stop.

// Below this many words there is nothing worth summarizing.
const SUMMARY_MIN_WORDS = 40;
// Transcript text sent to the model is capped; long calls get the tail
// (decisions and action items live at the end far more often than the start).
const SUMMARY_MAX_CHARS = 60_000;

export const getForSummary = internalQuery({
  args: { transcript_id: v.id("transcripts") },
  handler: async (ctx, args) => {
    const t = await ctx.db.get(args.transcript_id);
    if (!t) return null;
    const segs = await ctx.db
      .query("transcript_segments")
      .withIndex("by_transcript_seq", (q) => q.eq("transcript_id", t._id))
      .collect();
    return {
      title: t.title,
      room_key: t.room_key,
      started_at: t.started_at,
      ended_at: t.ended_at,
      participants: t.participants ?? [],
      lines: segs.map((s) => ({ speaker: s.speaker_name, text: s.text })),
    };
  },
});

export const setSummary = internalMutation({
  args: {
    transcript_id: v.id("transcripts"),
    summary_status: v.union(
      v.literal("done"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    action_items: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const t = await ctx.db.get(args.transcript_id);
    if (!t) return;
    // The first terminal write for this run. `endTranscript` (and, for a
    // recording, `attachRecording`) put the row at "pending" exactly once, so
    // this is what makes the digest below post once however many times the
    // summary action is retried.
    const firstVerdict = t.summary_status === "pending";
    await ctx.db.patch(t._id, {
      summary_status: args.summary_status,
      ...(args.title && !t.title ? { title: args.title } : {}),
      ...(args.summary ? { summary: args.summary } : {}),
      ...(args.action_items ? { action_items: args.action_items } : {}),
    });
    if (firstVerdict) await scheduleHuddleDigest(ctx, t, args);
    // A recording is the one transcript whose owner walked away from it. They
    // pressed stop, put the phone in a pocket, and the words, the summary and
    // the action items land minutes later with nothing on screen to see them
    // on. A huddle is the opposite — everyone was just in it — so it does not
    // push, and nobody but the recording's creator can read it anyway.
    if (args.summary_status !== "done" || !isRecRoomKey(t.room_key)) return;
    const owner = await ctx.db.get(t.started_by);
    if (!owner) return;
    await enqueuePush(ctx, {
      user: owner,
      type: RECORDING_SUMMARY_PUSH_TYPE,
      title: args.title || "Recording ready",
      body: args.summary
        ? args.summary.slice(0, 200)
        : "Your recording has been transcribed.",
      data: { type: RECORDING_SUMMARY_PUSH_TYPE, recordingId: String(t._id) },
    });
  },
});

/** Where a huddle's digest goes, from its room key: a chat room (a channel or
 *  a member set) gets a chat message; a session room gets a turn for its agent.
 *  A recording is one person's microphone and has no room to report into. */
export function huddleDigestTarget(
  roomKey: string,
): { kind: "chat" } | { kind: "session"; conversationId: string } | null {
  const parsed = parseRoomKey(roomKey);
  if (!parsed) return null;
  if (parsed.kind === "channel" || parsed.kind === "dm") return { kind: "chat" };
  if (parsed.kind === "session") return { kind: "session", conversationId: parsed.conversationId };
  return null;
}

/** The row a finished huddle leaves where it was held. Every huddle with any
 *  words gets one — a summary when there was enough said to write one, the
 *  words themselves when there was not (a "skipped" summary is under forty
 *  words, and those words ARE the summary). A chat room gets a message the
 *  reader can unfold into the transcript (chat.postCallDigest); a session room
 *  gets its agent woken with the summary and the command that reads the whole
 *  transcript, never the transcript itself. Delivery acts as the scribe. */
async function scheduleHuddleDigest(
  ctx: any,
  t: Doc<"transcripts">,
  verdict: { summary_status: "done" | "failed" | "skipped"; title?: string; summary?: string; action_items?: string[] },
): Promise<void> {
  const target = huddleDigestTarget(t.room_key);
  if (!target || t.last_seq <= 0) return;
  let summary = verdict.summary ?? t.summary ?? null;
  if (!summary && verdict.summary_status === "skipped") {
    const segs = await ctx.db
      .query("transcript_segments")
      .withIndex("by_transcript_seq", (q: any) => q.eq("transcript_id", t._id))
      .collect();
    summary = formatChunk(segs) || null;
  }
  const digest = {
    title: t.title ?? verdict.title ?? null,
    startedAt: t.started_at,
    endedAt: t.ended_at ?? null,
    speakers: (t.participants ?? []).map((p) => p.name),
    summary,
    actionItems: verdict.action_items ?? t.action_items ?? [],
    summaryStatus: verdict.summary_status,
  };
  if (target.kind === "chat") {
    await ctx.scheduler.runAfter(0, internal.chat.postCallDigest, {
      transcript_id: t._id,
      room_key: t.room_key,
      team_id: t.team_id,
      author: t.started_by,
      content: formatHuddleDigest(digest),
    });
    return;
  }
  await ctx.scheduler.runAfter(0, internal.transcripts.deliverToSession, {
    as_user: t.started_by,
    to: target.conversationId,
    body: formatHuddleSummaryTag(String(t._id), digest),
  });
}

export const generateSummary = internalAction({
  args: { transcript_id: v.id("transcripts") },
  handler: async (ctx, args) => {
    const t = await ctx.runQuery(internal.transcripts.getForSummary, {
      transcript_id: args.transcript_id,
    });
    if (!t) return;
    const wordCount = t.lines.reduce(
      (n: number, l: { text: string }) => n + l.text.split(/\s+/).length,
      0,
    );
    if (wordCount < SUMMARY_MIN_WORDS) {
      await ctx.runMutation(internal.transcripts.setSummary, {
        transcript_id: args.transcript_id,
        summary_status: "skipped",
      });
      return;
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      await ctx.runMutation(internal.transcripts.setSummary, {
        transcript_id: args.transcript_id,
        summary_status: "failed",
      });
      return;
    }
    // A huddle is one audio track per person, so who said what is structural
    // and the model can be told to trust it. A recording is one microphone in
    // a room: it heard everybody and can tell nobody apart, so the same
    // instruction would invite it to invent an attribution out of a placeholder
    // speaker label. The two transcripts are not the same evidence and must not
    // be described to the model as if they were.
    const isRecording = isRecRoomKey(t.room_key);
    let text = isRecording
      ? t.lines.map((l: { text: string }) => l.text).join("\n")
      : t.lines
          .map((l: { speaker: string; text: string }) => `${l.speaker}: ${l.text}`)
          .join("\n");
    if (text.length > SUMMARY_MAX_CHARS) text = text.slice(-SUMMARY_MAX_CHARS);
    const durationMin = t.ended_at
      ? Math.max(1, Math.round((t.ended_at - t.started_at) / 60_000))
      : null;
    const source = isRecording
      ? `This is the transcript of a meeting recorded on ONE microphone in the room${durationMin ? `, about ${durationMin} min` : ""}. Voices are NOT separated and nobody is identified: attribute something to a person only when the words themselves name them, and otherwise write about what was said, not who said it.`
      : `This is the transcript of a team huddle (voice call)${durationMin ? `, about ${durationMin} min` : ""}. Speakers are exactly attributed.`;
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 700,
          messages: [
            {
              role: "user",
              content: `${source}

Write JSON only, this shape:
{"title": "3-7 word title of what the call was about", "summary": "2-5 sentences: what was discussed, what was decided. Name people for decisions and disagreements. Plain words.", "action_items": ["each concrete follow-up someone committed to, with the owner's name first, e.g. 'Sam: ship the fix behind a flag'"]}

Empty action_items array if there were none — never invent any.

Transcript:
${text}`,
            },
          ],
        }),
      });
      if (!response.ok) throw new Error(`Anthropic ${response.status}`);
      const data = await response.json();
      const raw: string = data?.content?.[0]?.text ?? "";
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON in response");
      const parsed = JSON.parse(match[0]);
      await ctx.runMutation(internal.transcripts.setSummary, {
        transcript_id: args.transcript_id,
        summary_status: "done",
        title: typeof parsed.title === "string" ? parsed.title.slice(0, 120) : undefined,
        summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 2000) : undefined,
        action_items: Array.isArray(parsed.action_items)
          ? parsed.action_items
              .filter((a: unknown) => typeof a === "string")
              .slice(0, 20)
          : undefined,
      });
    } catch (err) {
      console.error("Call summary generation failed:", err);
      await ctx.runMutation(internal.transcripts.setSummary, {
        transcript_id: args.transcript_id,
        summary_status: "failed",
      });
    }
  },
});

// ── Reading a recording's words out of its audio ──────────────────────────
// The live recognizer is a websocket fed PCM by the browser, and a phone
// cannot open one: React Native has no AudioContext and no way to tap a
// microphone as samples. So a phone recording arrives as a finished m4a with
// an empty transcript, and this is where it gets its words.

/**
 * What reads the file.
 *
 * Deliberately NOT the live recognizer's model. The live path streams words as
 * they are spoken and has no use for timestamps; a recording is a finished
 * thing somebody scrolls through next to a player, so every line needs to know
 * when it was said. `whisper-1` is the transcription model that returns
 * segment boundaries, which is the whole reason it is used here.
 */
const RECORDING_TRANSCRIBE_MODEL = "whisper-1";

/** Segments written per mutation. A two hour meeting is a couple of thousand
 *  lines, and one mutation inserting all of them would run past what a
 *  transaction should do; the seq watermark makes the batches safe to resume
 *  from and stitch back together in order. */
const SEGMENT_WRITE_BATCH = 200;

/** One microphone in a room heard everybody. There is no diarization here and
 *  no honest name to put on a line, so every segment carries the same one and
 *  the surfaces that render a recording hide the label entirely. */
const RECORDING_SPEAKER = { id: "mic", name: "Speaker" } as const;

/**
 * The transcriber's reply, as segments this table can hold.
 *
 * `verbose_json` gives `{ text, segments: [{ start, end, text }] }` with the
 * times in seconds. A reply without a segments array is still words — the
 * models degrade to a plain transcript under load and for very short audio —
 * so it becomes one segment spanning the whole file rather than nothing.
 * Exported for its test: this is the seam between somebody else's JSON and our
 * rows, and it is the piece most likely to change under us.
 */
export function parseTranscriptionSegments(
  payload: unknown,
  fallbackDurationMs: number,
): { speaker_id: string; speaker_name: string; text: string; t0: number; t1: number }[] {
  const body = (payload ?? {}) as {
    text?: unknown;
    segments?: unknown;
  };
  const speaker = {
    speaker_id: RECORDING_SPEAKER.id,
    speaker_name: RECORDING_SPEAKER.name,
  };
  if (Array.isArray(body.segments)) {
    const out = body.segments
      .map((raw: any) => {
        const text = typeof raw?.text === "string" ? raw.text.trim() : "";
        if (!text) return null;
        const t0 = Math.max(0, Math.round((Number(raw?.start) || 0) * 1000));
        const t1 = Math.max(t0, Math.round((Number(raw?.end) || 0) * 1000));
        return { ...speaker, text, t0, t1 };
      })
      .filter(Boolean) as {
      speaker_id: string;
      speaker_name: string;
      text: string;
      t0: number;
      t1: number;
    }[];
    if (out.length) return out;
  }
  const whole = typeof body.text === "string" ? body.text.trim() : "";
  if (!whole) return [];
  return [{ ...speaker, text: whole, t0: 0, t1: Math.max(0, fallbackDurationMs) }];
}

/** Append a batch of a recording's transcribed words. Owner-checked at the
 *  scheduling end (only `attachRecording` reaches this), rec-checked here so a
 *  future caller cannot use it to write into somebody's huddle. */
export const appendRecordingSegments = internalMutation({
  args: {
    transcript_id: v.id("transcripts"),
    segments: v.array(
      v.object({
        speaker_id: v.string(),
        speaker_name: v.string(),
        text: v.string(),
        t0: v.number(),
        t1: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const t = await ctx.db.get(args.transcript_id);
    if (!t || !isRecRoomKey(t.room_key)) return { last_seq: 0 };
    // A recording names no voices; see writeSegments.
    return { last_seq: await writeSegments(ctx, t, args.segments, { trackParticipants: false }) };
  },
});

/** Close the transcription out: say how it went, and hand a transcript that
 *  now has words to the parts of the pipeline that were waiting for them. */
export const finishRecordingTranscript = internalMutation({
  args: { transcript_id: v.id("transcripts"), ok: v.boolean() },
  handler: async (ctx, args) => {
    const t = await ctx.db.get(args.transcript_id);
    if (!t || !isRecRoomKey(t.room_key)) return;
    if (!args.ok) {
      // The audio is still there and still plays. What is gone is the words,
      // and with them anything to summarize — "skipped" is exactly what that
      // means everywhere else in this file, so the surfaces need no new case.
      await ctx.db.patch(t._id, {
        transcribe_status: "failed",
        summary_status: "skipped",
      });
      return;
    }
    await ctx.db.patch(t._id, { transcribe_status: "done" });
    // Everything downstream of an ended transcript runs now, for the first
    // time with something in it: the routes ship the words, and the summary
    // and action items generate off them.
    await ctx.scheduler.runAfter(0, internal.transcripts.deliverRoutes, {
      transcript_id: t._id,
      include_after_routes: true,
    });
    await ctx.scheduler.runAfter(0, internal.transcripts.generateSummary, {
      transcript_id: t._id,
    });
  },
});

/**
 * Transcribe a recording's uploaded audio.
 *
 * Scheduled by `attachRecording`, once, for a recording that ended with
 * nothing in it. Every exit sets a status: a recording that sits on
 * "transcribing" forever is worse than one that says it failed, because the
 * person watching cannot tell the difference between working and broken.
 */
export const transcribeRecording = internalAction({
  args: { transcript_id: v.id("transcripts") },
  handler: async (ctx, args): Promise<void> => {
    let ok = false;
    try {
      const row = await ctx.runQuery(internal.transcripts.getForTranscription, {
        transcript_id: args.transcript_id,
      });
      if (!row?.storage_id) throw new Error("no audio attached");
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
      const audio = await ctx.storage.get(row.storage_id);
      if (!audio) throw new Error("audio missing from storage");
      // The recorder stops before it can make a file this big (see
      // shared/contracts/recordingAudio). Reaching here means something else
      // produced the audio, and the endpoint would refuse it with a 413 that
      // reads like an outage — say the real thing instead.
      if (audio.size > TRANSCRIBE_MAX_BYTES) {
        throw new Error(
          `audio is ${Math.round(audio.size / 1024 / 1024)}MB, over the ${Math.round(TRANSCRIBE_MAX_BYTES / 1024 / 1024)}MB transcription limit`,
        );
      }
      const form = new FormData();
      // The extension is what the API reads the container off. A phone records
      // m4a; the desktop recorder's MediaRecorder gives webm everywhere but
      // Safari, which gives mp4.
      const ext = audio.type.includes("webm") ? "webm" : "m4a";
      form.append("file", audio, `recording.${ext}`);
      form.append("model", RECORDING_TRANSCRIBE_MODEL);
      form.append("response_format", "verbose_json");
      const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!resp.ok) {
        throw new Error(`OpenAI ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
      }
      const segments = parseTranscriptionSegments(
        await resp.json(),
        Math.max(0, (row.ended_at ?? row.started_at) - row.started_at),
      );
      if (!segments.length) throw new Error("transcription came back empty");
      for (let i = 0; i < segments.length; i += SEGMENT_WRITE_BATCH) {
        await ctx.runMutation(internal.transcripts.appendRecordingSegments, {
          transcript_id: args.transcript_id,
          segments: segments.slice(i, i + SEGMENT_WRITE_BATCH),
        });
      }
      ok = true;
    } catch (err) {
      console.error("[transcripts] recording transcription failed", String(err).slice(0, 300));
    }
    await ctx.runMutation(internal.transcripts.finishRecordingTranscript, {
      transcript_id: args.transcript_id,
      ok,
    });
  },
});

export const getForTranscription = internalQuery({
  args: { transcript_id: v.id("transcripts") },
  handler: async (ctx, args) => {
    const t = await ctx.db.get(args.transcript_id);
    if (!t || !isRecRoomKey(t.room_key)) return null;
    return {
      storage_id: t.recording_storage_id ?? null,
      started_at: t.started_at,
      ended_at: t.ended_at ?? null,
    };
  },
});

// Live view for the dock caption strip + the routes popover. Team-gated the
// same way the room is.
export const getLive = query({
  args: { room_key: v.string(), tail: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const auth = await authorizeRoom(ctx, userId, args.room_key, { rec: true });
    if (!auth.ok) return null;
    const all = await ctx.db
      .query("transcripts")
      .withIndex("by_room", (q) => q.eq("room_key", args.room_key))
      .collect();
    const t = all.find((x) => x.status === "live");
    if (!t) return null;
    const tail = Math.min(args.tail ?? 6, 20);
    const segs = await ctx.db
      .query("transcript_segments")
      .withIndex("by_transcript_seq", (q) => q.eq("transcript_id", t._id))
      .order("desc")
      .take(tail);
    return {
      transcript_id: t._id,
      started_by: t.started_by,
      started_at: t.started_at,
      routes: t.routes.map((r: any) => ({
        kind: r.kind,
        target: r.target,
        mode: r.mode,
        added_by: String(r.added_by ?? t.started_by),
      })),
      tail: segs.reverse().map((s: Doc<"transcript_segments">) => ({
        seq: s.seq,
        speaker_name: s.speaker_name,
        text: s.text,
        // Wall-clock arrival, so clients can age captions out — someone who
        // joins an hour into a lulled transcript must not see stale lines.
        // (Age-filtering lives client-side: a Date.now() cutoff inside a
        // reactive query only re-evaluates on data changes, not as time
        // passes, so it could never HIDE a caption on its own.)
        at: s._creationTime,
      })),
    };
  },
});

// ── Call list/detail (web page + cast CLI) ────────────────────────────────
// One core, two doors of authentication: the web queries use getAuthUserId,
// the CLI twins verifyApiToken. Authorization per row is canReadCall.

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
async function canReadCall(
  ctx: any,
  userId: Id<"users">,
  t: Doc<"transcripts">,
): Promise<boolean> {
  // A RECORDING IS ITS CREATOR'S until they say otherwise. No participant
  // door (they are the only voice in it), and for the creator no team door
  // and no feature gate — a person recording the meeting in the room around
  // them has not published anything to anybody. `rec_shared` is the creator
  // having said otherwise: the recording was triaged into its team, and
  // teammates read it under the ordinary team door, feature gate included.
  if (isRecRoomKey(t.room_key)) {
    if (String(t.started_by) === String(userId)) return true;
    return (
      !!t.rec_shared &&
      (await isTeamMember(ctx, userId, t.team_id)) &&
      (await teamHasFeature(ctx, t.team_id, "calls"))
    );
  }
  if ((t.participants ?? []).some((p) => String(p.id) === String(userId))) {
    return (
      (await isTeamMember(ctx, userId, t.team_id)) &&
      (await teamHasFeature(ctx, t.team_id, "calls"))
    );
  }
  return (await authorizeRoomNoGrant(ctx, userId, t.room_key)).ok;
}

function shapeCallRow(t: Doc<"transcripts">) {
  return {
    _id: t._id,
    room_key: t.room_key,
    status: t.status,
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
  };
}

async function listCallsCore(ctx: any, userId: Id<"users">, limit: number) {
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const rows: Doc<"transcripts">[] = [];
  for (const m of memberships) {
    const ts = await ctx.db
      .query("transcripts")
      .withIndex("by_team_started", (q: any) => q.eq("team_id", m.team_id))
      .order("desc")
      .take(limit);
    rows.push(...ts);
  }
  // The personal shelf: my own recordings, whatever team they were filed
  // under. The team walk above only sees the CURRENT teams — a recording
  // routed to a team I later left, or filed under a team this viewer stopped
  // looking at, is still mine to read, and this is the index that finds it.
  const mine = await ctx.db
    .query("transcripts")
    .withIndex("by_creator_started", (q: any) => q.eq("started_by", userId))
    .order("desc")
    .take(limit);
  rows.push(...mine.filter((t: Doc<"transcripts">) => isRecRoomKey(t.room_key)));
  rows.sort((a, b) => b.started_at - a.started_at);
  const out = [];
  const seen = new Set<string>();
  for (const t of rows) {
    if (out.length >= limit) break;
    if (seen.has(String(t._id))) continue;
    seen.add(String(t._id));
    if (await canReadCall(ctx, userId, t)) out.push(shapeCallRow(t));
  }
  return out;
}

async function getCallCore(
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
    // Present only for a recording that finished uploading its audio; a
    // detail view offers playback when there is something to play.
    recording_url: t.recording_storage_id
      ? await ctx.storage.getUrl(t.recording_storage_id)
      : null,
    routes: t.routes.map((r: any) => ({
      kind: r.kind,
      target: r.target,
      mode: r.mode,
      added_by: r.added_by ? String(r.added_by) : String(t.started_by),
    })),
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

export const webListCalls = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return listCallsCore(ctx, userId, Math.min(args.limit ?? 50, 200));
  },
});

export const webGetCall = query({
  args: { transcript_id: v.id("transcripts") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return getCallCore(ctx, userId, args.transcript_id);
  },
});

// The triage gesture: a recording's creator files it into one of their teams
// (or takes it back). Sharing sets BOTH fields on purpose — team_id so the
// team's list walk finds the row, rec_shared so canReadCall opens the team
// door. Unsharing only clears the flag: team_id is routing and keeps its last
// honest value, and access never read it anyway.
export const setRecordingScope = mutation({
  args: {
    transcript_id: v.id("transcripts"),
    // A team to share into, or absent to make it private again.
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const t = await ctx.db.get(args.transcript_id);
    // One error for "no row", "not a recording", and "not yours": naming
    // which of the three failed would confirm the row exists.
    if (!t || !isRecRoomKey(t.room_key) || String(t.started_by) !== String(userId)) {
      throw new Error("Recording not found");
    }
    if (!args.team_id) {
      await ctx.db.patch(t._id, { rec_shared: false });
      return;
    }
    if (!(await isTeamMember(ctx, userId, args.team_id))) {
      throw new Error("Not a member of that team");
    }
    await ctx.db.patch(t._id, { team_id: args.team_id, rec_shared: true });
  },
});

export const cliListCalls = query({
  args: { api_token: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    return listCallsCore(ctx, auth.userId, Math.min(args.limit ?? 30, 200));
  },
});

export const cliGetCall = query({
  args: { api_token: v.string(), transcript_id: v.id("transcripts") },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    return getCallCore(ctx, auth.userId, args.transcript_id);
  },
});

// ── ASR credentials ───────────────────────────────────────────────────────
// OpenAI Realtime transcription: the scribe opens one websocket per audio
// track and streams pcm16; the server returns streaming transcript deltas and
// VAD speech start/stop events (the gap signal). The browser must never see
// OPENAI_API_KEY, so this action mints a short-lived client secret scoped to
// a transcription session. Authorization = may the caller transcribe the room.
export const mintAsrToken = action({
  args: { room_key: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ client_secret: string; model: string } | { error: string }> => {
    const grant = await ctx.runQuery(internal.transcripts.authForAsr, {
      room_key: args.room_key,
    });
    if (!grant) return { error: "Not authorized for this room" };
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { error: "Transcription is not configured" };
    const model = "gpt-4o-mini-transcribe";
    // GA realtime API: client secrets are minted at /v1/realtime/client_secrets
    // with the session config nested under `session` (audio.input vocabulary).
    const resp = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: { model },
              turn_detection: { type: "server_vad", silence_duration_ms: 600 },
            },
          },
        },
      }),
    });
    if (!resp.ok) {
      const body = (await resp.text()).slice(0, 300);
      console.error("[transcripts] mint failed", resp.status, body);
      return { error: `ASR session mint failed (${resp.status})` };
    }
    const data = (await resp.json()) as { value?: string; client_secret?: { value?: string } };
    const secret = data.value ?? data.client_secret?.value;
    if (!secret) return { error: "ASR session mint returned no secret" };
    return { client_secret: secret, model };
  },
});

export const authForAsr = internalQuery({
  args: { room_key: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    // A recording mints against its own key like a huddle does; authorizeRoom
    // has already answered "is this transcript yours".
    const auth = await authorizeRoom(ctx, userId, args.room_key, { rec: true });
    return auth.ok ? { user_id: String(userId) } : null;
  },
});

// ── Route delivery ────────────────────────────────────────────────────────

// Chunk formatting is shared with the web's "send to agent" actions:
// @codecast/shared/contracts formatTranscriptChunk.
export { formatChunk };

export const readUnsent = internalQuery({
  args: { transcript_id: v.id("transcripts") },
  handler: async (ctx, args) => {
    const t = await ctx.db.get(args.transcript_id);
    if (!t) return null;
    const minSent = Math.min(...t.routes.map((r) => r.sent_seq), t.last_seq);
    const segs = await ctx.db
      .query("transcript_segments")
      .withIndex("by_transcript_seq", (q) =>
        q.eq("transcript_id", args.transcript_id).gt("seq", minSent),
      )
      .collect();
    return {
      transcript: {
        _id: t._id,
        room_key: t.room_key,
        team_id: t.team_id,
        status: t.status,
        started_by: t.started_by,
        started_at: t.started_at,
        routes: t.routes,
        last_seq: t.last_seq,
      },
      segments: segs.map((s) => ({
        seq: s.seq,
        speaker_name: s.speaker_name,
        text: s.text,
      })),
    };
  },
});

export const markRouteSent = internalMutation({
  args: {
    transcript_id: v.id("transcripts"),
    kind: v.string(),
    target: v.string(),
    sent_seq: v.number(),
  },
  handler: async (ctx, args) => {
    const t = await ctx.db.get(args.transcript_id);
    if (!t) return;
    await ctx.db.patch(t._id, {
      routes: t.routes.map((r) =>
        r.kind === args.kind && r.target === args.target
          ? { ...r, sent_seq: Math.max(r.sent_seq, args.sent_seq) }
          : r,
      ),
    });
  },
});

export const deliverToSession = internalMutation({
  args: {
    as_user: v.id("users"),
    to: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    await performSessionSend(ctx, args.as_user, { to: args.to, body: args.body });
  },
});

export const deliverToDoc = internalMutation({
  args: {
    as_user: v.id("users"),
    doc_id: v.string(),
    chunk: v.string(),
    header: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const docId = ctx.db.normalizeId("docs", args.doc_id);
    if (!docId) throw new Error("Doc not found");
    const doc = await requireAccessibleDoc(ctx, args.as_user, docId);
    const base = doc.content ?? "";
    const head = args.header && !base.includes(args.header) ? `${args.header}\n\n` : "";
    await ctx.db.patch(docId, {
      content: `${base ? base + "\n\n" : ""}${head}${args.chunk}`,
      updated_at: Date.now(),
    });
  },
});

export const slackTokenForChannel = internalQuery({
  args: { channel: v.string(), team_id: v.id("teams") },
  handler: async (ctx, args): Promise<string | null> => {
    // A linked channel (anchor_channels) whose anchor belongs to the
    // transcript's team; its workspace installation holds the bot token.
    const rows = await ctx.db
      .query("anchor_channels")
      .withIndex("by_surface_channel", (q: any) =>
        q.eq("surface", "slack").eq("channel_key", args.channel),
      )
      .collect();
    for (const row of rows) {
      const install = await ctx.db
        .query("slack_installations")
        .withIndex("by_workspace", (q: any) => q.eq("workspace_id", row.workspace_key))
        .first();
      if (install?.bot_token) return install.bot_token;
    }
    return null;
  },
});

export const deliverRoutes = internalAction({
  args: {
    transcript_id: v.id("transcripts"),
    include_after_routes: v.boolean(),
  },
  handler: async (ctx, args) => {
    const data = await ctx.runQuery(internal.transcripts.readUnsent, {
      transcript_id: args.transcript_id,
    });
    if (!data) return;
    const { transcript, segments } = data;
    for (const route of transcript.routes) {
      if (route.mode === "after" && !args.include_after_routes) continue;
      const unsent = segments.filter((s) => s.seq > route.sent_seq);
      if (unsent.length === 0) continue;
      const chunk = formatChunk(unsent);
      const maxSeq = unsent[unsent.length - 1].seq;
      // Delivery acts as whoever pointed the route at the call — a
      // participant feeding an agent speaks as themselves. Routes from before
      // added_by existed fall back to the scribe.
      const asUser = route.added_by ?? transcript.started_by;
      try {
        if (route.kind === "session") {
          await ctx.runMutation(internal.transcripts.deliverToSession, {
            as_user: asUser,
            to: route.target,
            body: `Huddle transcript (live)\n\n${chunk}`,
          });
        } else if (route.kind === "doc") {
          await ctx.runMutation(internal.transcripts.deliverToDoc, {
            as_user: asUser,
            doc_id: route.target,
            chunk,
            header: `# Huddle transcript — ${new Date(transcript.started_at).toISOString().slice(0, 16).replace("T", " ")}`,
          });
        } else if (route.kind === "slack") {
          const token = await ctx.runQuery(internal.transcripts.slackTokenForChannel, {
            channel: route.target,
            team_id: transcript.team_id,
          });
          if (!token) throw new Error("Slack channel not linked");
          const resp = await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              Authorization: `Bearer ${token}`,
            },
            // Slack renders *bold* with single asterisks.
            body: JSON.stringify({
              channel: route.target,
              text: chunk.replace(/\*\*/g, "*"),
            }),
          });
          const out = (await resp.json()) as { ok: boolean; error?: string };
          if (!out.ok) throw new Error(`slack: ${out.error}`);
        }
        await ctx.runMutation(internal.transcripts.markRouteSent, {
          transcript_id: args.transcript_id,
          kind: route.kind,
          target: route.target,
          sent_seq: maxSeq,
        });
      } catch (err) {
        // A failing route never blocks the others; the watermark stays put so
        // the next flush retries this chunk.
        console.error("[transcripts] route delivery failed", route.kind, String(err).slice(0, 200));
      }
    }
  },
});
