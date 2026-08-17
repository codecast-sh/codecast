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
import { authorizeRoom } from "./callRooms";
import { performSessionSend } from "./pendingMessages";
import { requireAccessibleDoc } from "./lib/access";
import { verifyApiToken } from "./apiTokens";

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

export const start = mutation({
  args: {
    room_key: v.string(),
    routes: v.optional(v.array(ROUTE_VALIDATOR)),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const auth = await authorizeRoom(ctx, userId, args.room_key);
    if (!auth.ok) throw new Error(`Cannot transcribe this room: ${auth.reason}`);
    // One live transcript per room: a second Transcribe toggle joins the
    // existing run rather than forking the record.
    const existing = await ctx.db
      .query("transcripts")
      .withIndex("by_room", (q) => q.eq("room_key", args.room_key))
      .collect();
    const live = existing.find((t) => t.status === "live");
    if (live) return { transcript_id: live._id, existing: true };
    const id = await ctx.db.insert("transcripts", {
      room_key: args.room_key,
      team_id: auth.teamId,
      started_by: userId,
      status: "live",
      started_at: Date.now(),
      routes: args.routes ?? [],
      last_seq: 0,
    });
    return { transcript_id: id, existing: false };
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
    // Keep delivery watermarks for routes that survive the edit, so changing
    // one route never re-sends another's history.
    const routes = args.routes.map((r) => {
      const prior = t.routes.find((p) => p.kind === r.kind && p.target === r.target);
      return { ...r, sent_seq: prior?.sent_seq ?? 0 };
    });
    await ctx.db.patch(t._id, { routes });
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
    let seq = t.last_seq;
    for (const s of args.segments) {
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
    if (seq !== t.last_seq) {
      // Accumulate the speaker roster on the call object as voices appear —
      // actual speakers, not seat leases (a lurker who never talks is in the
      // room but not in the transcript's cast).
      const known = new Set((t.participants ?? []).map((p) => p.id));
      const newcomers = args.segments
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
    }
    return { last_seq: seq };
  },
});

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

export const stop = mutation({
  args: { transcript_id: v.id("transcripts") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const t = await ctx.db.get(args.transcript_id);
    if (!t || String(t.started_by) !== String(userId)) {
      throw new Error("Transcript not found");
    }
    if (t.status === "ended") return;
    await ctx.db.patch(t._id, {
      status: "ended",
      ended_at: Date.now(),
      summary_status: "pending",
    });
    await ctx.scheduler.runAfter(0, internal.transcripts.deliverRoutes, {
      transcript_id: t._id,
      include_after_routes: true,
    });
    await ctx.scheduler.runAfter(0, internal.transcripts.generateSummary, {
      transcript_id: t._id,
    });
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
    await ctx.db.patch(t._id, {
      summary_status: args.summary_status,
      ...(args.title && !t.title ? { title: args.title } : {}),
      ...(args.summary ? { summary: args.summary } : {}),
      ...(args.action_items ? { action_items: args.action_items } : {}),
    });
  },
});

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
    let text = t.lines
      .map((l: { speaker: string; text: string }) => `${l.speaker}: ${l.text}`)
      .join("\n");
    if (text.length > SUMMARY_MAX_CHARS) text = text.slice(-SUMMARY_MAX_CHARS);
    const durationMin = t.ended_at
      ? Math.max(1, Math.round((t.ended_at - t.started_at) / 60_000))
      : null;
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
              content: `This is the transcript of a team huddle (voice call)${durationMin ? `, about ${durationMin} min` : ""}. Speakers are exactly attributed.

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

// Live view for the dock caption strip + the routes popover. Team-gated the
// same way the room is.
export const getLive = query({
  args: { room_key: v.string(), tail: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const auth = await authorizeRoom(ctx, userId, args.room_key);
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
      routes: t.routes.map((r) => ({ kind: r.kind, target: r.target, mode: r.mode })),
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
// One core, two doors: the web queries authenticate via getAuthUserId, the
// CLI twins via verifyApiToken. Authorization per row is authorizeRoom — the
// same boundary the media path enforces, so a dm call is readable by exactly
// its two people and nothing leaks through team listing.

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
    last_seq: t.last_seq,
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
  rows.sort((a, b) => b.started_at - a.started_at);
  const out = [];
  for (const t of rows) {
    if (out.length >= limit) break;
    const auth = await authorizeRoom(ctx, userId, t.room_key);
    if (auth.ok) out.push(shapeCallRow(t));
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
  const auth = await authorizeRoom(ctx, userId, t.room_key);
  if (!auth.ok) return null;
  const segs = await ctx.db
    .query("transcript_segments")
    .withIndex("by_transcript_seq", (q: any) => q.eq("transcript_id", t._id))
    .collect();
  return {
    ...shapeCallRow(t),
    routes: (t.routes as { kind: string; target: string; mode: string }[]).map(
      (r) => ({ kind: r.kind, target: r.target, mode: r.mode }),
    ),
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
    const auth = await authorizeRoom(ctx, userId, args.room_key);
    return auth.ok ? { user_id: String(userId) } : null;
  },
});

// ── Route delivery ────────────────────────────────────────────────────────

export function formatChunk(
  segments: Array<{ speaker_name: string; text: string }>,
): string {
  // Collapse consecutive segments from one speaker into one line — the
  // readable Otter shape: "Name: sentence sentence".
  const lines: string[] = [];
  for (const s of segments) {
    const prefix = `**${s.speaker_name}**: `;
    if (lines.length && lines[lines.length - 1].startsWith(prefix)) {
      lines[lines.length - 1] += " " + s.text;
    } else {
      lines.push(prefix + s.text);
    }
  }
  return lines.join("\n");
}

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
      try {
        if (route.kind === "session") {
          await ctx.runMutation(internal.transcripts.deliverToSession, {
            as_user: transcript.started_by,
            to: route.target,
            body: `Huddle transcript (live)\n\n${chunk}`,
          });
        } else if (route.kind === "doc") {
          await ctx.runMutation(internal.transcripts.deliverToDoc, {
            as_user: transcript.started_by,
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
