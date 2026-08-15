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
    if (seq !== t.last_seq) await ctx.db.patch(t._id, { last_seq: seq });
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
    await ctx.db.patch(t._id, { status: "ended", ended_at: Date.now() });
    await ctx.scheduler.runAfter(0, internal.transcripts.deliverRoutes, {
      transcript_id: t._id,
      include_after_routes: true,
    });
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
      })),
    };
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
