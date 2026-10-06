// An agent's face in a call.
//
// A session fed live into a huddle (call_agent_feeds) gets a face: the face
// worker (infra/call-face-worker) joins the room and seats a Tavus face as
// `agent:<conversationId>` (shared agentFaceIdentity). Two modes, one per
// team feature:
//
//   agent_faces     The face says each reply the session posts to the call's
//                   chat, word for word.
//   agent_realtime  The worker also runs a fast live model that hears the
//                   room, sees the speaker's camera and any shared screen,
//                   and answers at once; the session stays the agent's
//                   working half, handed real work through `ask`, and its
//                   replies reach the model to tell the room in its own
//                   words. Prompt texts: shared huddleVoiceInstructions and
//                   huddleVoiceAskHeader.
//
//   join   LiveKit dispatches the worker into the room, told which session
//          it speaks for, as which face and voice, and in which mode. Two
//          callers race to it on purpose: a client in the call asks at once
//          (ensureFaces), because the scheduler can run minutes behind, and
//          the feed's own scheduled join is the fallback. A dispatch already
//          on its way for the session wins.
//   tell   Each reply the room's chat shows reaches the worker on the room's
//          data channel.
//   leave  The face is removed from the room and the worker leaves with it.
//   brief, ask, said (real-time only, over /calls/face): who the voice is,
//          work it hands the session, and what it said, which becomes the
//          transcript's so the record and the session both know it.
//
// The feed row is the face's lifetime: transcripts.syncAgentFeeds joins one
// when it inserts a row and removes it when it deletes one. Off unless the
// team has the feature and FACE_WORKER_SECRET (shared with the worker) is set
// beside the LIVEKIT_* the room needs; otherwise agents in a call stay chat
// only.
import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { agentFaceIdentity, agentSpokenNames, huddleVoiceAskHeader, huddleVoiceInstructions } from "@codecast/shared/contracts";
import { AVATAR_KEYS } from "@codecast/shared/contracts/orgAvatars";
import { characterOf } from "@codecast/shared/contracts/sessionCharacter";
import { plainAgentLine } from "@codecast/shared/contracts/plainText";
import { signLivekitJwt } from "./lib/livekitJwt";
import { timingSafeEqualHex } from "./lib/hmac";
import { teamHasFeature } from "./lib/teamFeatureGuard";
import { agentLineText, liveTranscriptFor } from "./callChat";
import { writeSegments } from "./transcripts";
import { authorizeRoom } from "./callRooms";

// The name the worker registers under, and the data topic it listens on.
export const FACE_HOST_AGENT = "codecast-face";
export const FACE_TOPIC = "codecast.face";
// Tavus stock faces on Phoenix-4.5, its real-time model, each with the live
// model's voice that suits it.
const FACES: readonly { face: string; voice: string }[] = [
  { face: "rc8992fe8e8e", voice: "marin" }, // Brooke
  { face: "rcf10ec292c1", voice: "cedar" }, // Dominic
  { face: "refaf3628ea7", voice: "cedar" }, // Evan
  { face: "rc9cff32ceba", voice: "marin" }, // Anna
  { face: "rbb3ca3630f7", voice: "cedar" }, // Charlie
  { face: "r3f4182ef554", voice: "cedar" }, // Lucas
  { face: "r0df0ace1c0a", voice: "cedar" }, // Zane
  { face: "rccbeedfc684", voice: "cedar" }, // Darius
  { face: "r5ad3b1690f0", voice: "marin" }, // Ivy
  { face: "r1ce7f5b22d4", voice: "marin" }, // Maya
  { face: "rbb3d627a705", voice: "cedar" }, // Mateo
  { face: "r4dc9377a68e", voice: "marin" }, // Priya
];
// The session replies the voice is briefed with, and how long a told reply may be.
const BRIEF_REPLIES = 3;
const TELL_MAX = 2000;

type FaceConfig = { secret: string; lkUrl: string; lkKey: string; lkSecret: string };

function faceConfig(): FaceConfig | null {
  const secret = process.env.FACE_WORKER_SECRET;
  const lkUrl = process.env.LIVEKIT_URL;
  const lkKey = process.env.LIVEKIT_API_KEY;
  const lkSecret = process.env.LIVEKIT_API_SECRET;
  if (!secret || !lkUrl || !lkKey || !lkSecret) return null;
  return { secret, lkUrl, lkKey, lkSecret };
}

/** How an agent shows up in this team's calls: not at all, as a face, or as
 *  a face with a live model behind it. */
async function faceMode(ctx: any, teamId: Id<"teams"> | null | undefined): Promise<"off" | "face" | "realtime"> {
  if (!faceConfig() || !(await teamHasFeature(ctx, teamId, "agent_faces"))) return "off";
  return (await teamHasFeature(ctx, teamId, "agent_realtime")) ? "realtime" : "face";
}

/** A face follows the agent's character, so it looks and sounds the same in
 *  every call, and agents a room tells apart by character it tells apart by face. */
export function faceForAvatar(avatar: string): { face: string; voice: string } {
  const i = Math.max(0, (AVATAR_KEYS as readonly string[]).indexOf(avatar));
  return FACES[i % FACES.length];
}

/** From a mutation that just inserted a feed row. */
export async function scheduleFaceJoin(ctx: any, feedId: Id<"call_agent_feeds">, teamId: Id<"teams"> | null | undefined): Promise<void> {
  const mode = await faceMode(ctx, teamId);
  if (mode === "off") return;
  await ctx.scheduler.runAfter(0, internal.callFace.join, { feed_id: feedId, realtime: mode === "realtime" });
}

/** From a mutation deleting a feed row: its voice leaves with it. */
export async function scheduleFaceLeave(ctx: any, feed: Doc<"call_agent_feeds">): Promise<void> {
  if (!faceConfig()) return;
  await ctx.scheduler.runAfter(0, internal.callFace.leave, {
    room_key: feed.room_key,
    conversation_id: feed.conversation_id,
  });
}

/** From the mirror, for the replies it just posted to the room's chat. */
export async function scheduleFaceTell(ctx: any, feed: Doc<"call_agent_feeds">, replies: string[]): Promise<void> {
  if ((await faceMode(ctx, feed.team_id)) === "off") return;
  const text = plainAgentLine(replies.join("\n\n")).slice(0, TELL_MAX);
  if (!text) return;
  await ctx.scheduler.runAfter(0, internal.callFace.tell, {
    room_key: feed.room_key,
    conversation_id: feed.conversation_id,
    text,
  });
}

/** The live feed of this session in this room, or null: every worker request
 *  is checked against it, so a voice can only reach its own session, while
 *  its huddle runs, in a team with real-time agents on. */
async function liveFeed(ctx: any, conversationId: string, roomKey: string): Promise<Doc<"call_agent_feeds"> | null> {
  const id = ctx.db.normalizeId("conversations", conversationId);
  if (!id) return null;
  const feed: Doc<"call_agent_feeds"> | null = await ctx.db
    .query("call_agent_feeds")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", id))
    .first();
  if (!feed || feed.room_key !== roomKey || (await faceMode(ctx, feed.team_id)) !== "realtime") return null;
  const t = await ctx.db.get(feed.transcript_id);
  return t?.status === "live" ? feed : null;
}

async function characterFor(ctx: any, conversationId: Id<"conversations">) {
  const conv: Doc<"conversations"> | null = await ctx.db.get(conversationId);
  if (!conv) return null;
  return { conv, character: characterOf({ _id: String(conv._id), character_avatar: conv.character_avatar, character_name: conv.character_name }) };
}

export const feedForFace = internalQuery({
  args: { feed_id: v.id("call_agent_feeds") },
  handler: async (ctx, args) => {
    const feed = await ctx.db.get(args.feed_id);
    if (!feed) return null;
    const who = await characterFor(ctx, feed.conversation_id);
    if (!who) return null;
    return { room_key: feed.room_key, conversation_id: String(feed.conversation_id), name: who.character.name, avatar: who.character.avatar };
  },
});

export const brief = internalQuery({
  args: { conversation_id: v.string(), room_key: v.string() },
  handler: async (ctx, args) => {
    const feed = await liveFeed(ctx, args.conversation_id, args.room_key);
    if (!feed) return null;
    const who = await characterFor(ctx, feed.conversation_id);
    if (!who) return null;
    const recent = (
      await ctx.db
        .query("messages")
        .withIndex("by_conversation_role_timestamp", (q) => q.eq("conversation_id", feed.conversation_id).eq("role", "assistant"))
        .order("desc")
        .take(20)
    )
      .map((m) => plainAgentLine(agentLineText(m)))
      .filter(Boolean)
      .slice(0, BRIEF_REPLIES)
      .reverse();
    const name = who.character.name;
    return {
      name,
      spoken_names: agentSpokenNames({ name, agentType: who.conv.agent_type }),
      instructions: huddleVoiceInstructions({ name, title: who.conv.title || "agent session", recent }),
    };
  },
});

export const ask = internalMutation({
  args: { conversation_id: v.string(), room_key: v.string(), text: v.string(), speaker: v.optional(v.string()) },
  handler: async (ctx, args): Promise<boolean> => {
    const feed = await liveFeed(ctx, args.conversation_id, args.room_key);
    const who = feed && (await characterFor(ctx, feed.conversation_id));
    if (!feed || !who) return false;
    await ctx.scheduler.runAfter(0, internal.transcripts.deliverToSession, {
      as_user: feed.added_by,
      to: String(feed.conversation_id),
      body: `${huddleVoiceAskHeader(who.character.name, args.speaker ?? null)}\n\n${args.text}`,
    });
    return true;
  },
});

export const said = internalMutation({
  args: { conversation_id: v.string(), room_key: v.string(), text: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const feed = await liveFeed(ctx, args.conversation_id, args.room_key);
    const who = feed && (await characterFor(ctx, feed.conversation_id));
    const t = feed && (await liveTranscriptFor(ctx, feed.room_key));
    if (!feed || !who || !t) return false;
    const end = Date.now() - t.started_at;
    await writeSegments(ctx, t, [
      { speaker_id: agentFaceIdentity(args.conversation_id), speaker_name: `${who.character.name} (voice)`, text: args.text, t0: end, t1: end },
    ]);
    return true;
  },
});

/** The worker's one endpoint (/calls/face): a bearer of FACE_WORKER_SECRET, one op per call. */
export async function handleFaceRequest(ctx: { runQuery: any; runMutation: any }, request: Request): Promise<Response> {
  const cfg = faceConfig();
  if (!cfg) return new Response("not configured", { status: 500 });
  const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!timingSafeEqualHex(bearer, cfg.secret)) return new Response("unauthorized", { status: 401 });
  const body = (await request.json().catch(() => null)) as Record<string, string> | null;
  const base = { conversation_id: String(body?.conversation_id ?? ""), room_key: String(body?.room_key ?? "") };
  const text = String(body?.text ?? "").trim();
  let out: unknown;
  if (body?.op === "brief") out = await ctx.runQuery(internal.callFace.brief, base);
  else if (body?.op === "ask" && text) out = await ctx.runMutation(internal.callFace.ask, { ...base, text, speaker: body.speaker || undefined });
  else if (body?.op === "said" && text) out = await ctx.runMutation(internal.callFace.said, { ...base, text });
  else return new Response("bad request", { status: 400 });
  return Response.json(out ?? null);
}

/** LiveKit's server API (Twirp over JSON), as an admin of one room. */
async function livekit(cfg: FaceConfig, room: string, method: string, body: unknown, okStatuses: number[] = []): Promise<any> {
  const admin = await signLivekitJwt({
    apiKey: cfg.lkKey,
    apiSecret: cfg.lkSecret,
    identity: "codecast-server",
    name: "codecast",
    room,
    grant: { roomAdmin: true },
    ttlSeconds: 60,
  });
  const res = await fetch(`${cfg.lkUrl.replace(/^ws/, "http")}/twirp/livekit.${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok && !okStatuses.includes(res.status)) throw new Error(`LiveKit ${method}: ${res.status} ${text.slice(0, 300)}`);
  return res.ok && text ? JSON.parse(text) : null;
}

type FaceFeed = { room_key: string; conversation_id: string; name: string; avatar: string };

/** A dispatch that has not finished: none of its jobs ended yet. LiveKit
 *  names a job's status as a word or, with defaults left out, not at all. */
function dispatchAlive(d: { state?: { jobs?: { state?: { status?: string | number } }[] } }): boolean {
  const jobs = d.state?.jobs ?? [];
  const live = (status: string | number | undefined) => !status || status === "JS_PENDING" || status === "JS_RUNNING" || status === 1;
  return jobs.length === 0 || jobs.some((j) => live(j.state?.status));
}

/** Send the worker in for this session's face, unless a dispatch for it is
 *  already on its way or running. A finished one (the face left, or never
 *  came) is cleared so a new one can go. True when it dispatched. */
export async function dispatchFace(cfg: FaceConfig, feed: FaceFeed, realtime: boolean): Promise<boolean> {
  const listed = await livekit(cfg, feed.room_key, "AgentDispatchService/ListDispatch", { room: feed.room_key }, [404]);
  // LiveKit answers in snake_case; the camelCase reading keeps a server that
  // answers in protobuf's other JSON spelling from going unseen.
  for (const d of listed?.agent_dispatches ?? listed?.agentDispatches ?? []) {
    if ((d.agent_name ?? d.agentName) !== FACE_HOST_AGENT) continue;
    let meta: { conversation_id?: string } = {};
    try {
      meta = JSON.parse(d.metadata || "{}");
    } catch {}
    if (meta.conversation_id !== feed.conversation_id) continue;
    if (dispatchAlive(d)) return false;
    await livekit(cfg, feed.room_key, "AgentDispatchService/DeleteDispatch", { dispatchId: d.id, room: feed.room_key }, [404]);
  }
  await livekit(cfg, feed.room_key, "AgentDispatchService/CreateDispatch", {
    room: feed.room_key,
    agentName: FACE_HOST_AGENT,
    metadata: JSON.stringify({ conversation_id: feed.conversation_id, name: feed.name, ...faceForAvatar(feed.avatar), realtime }),
  });
  return true;
}

export const join = internalAction({
  args: { feed_id: v.id("call_agent_feeds"), realtime: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<void> => {
    const cfg = faceConfig();
    if (!cfg) return;
    const feed = await ctx.runQuery(internal.callFace.feedForFace, { feed_id: args.feed_id });
    if (!feed) return;
    await dispatchFace(cfg, feed, args.realtime === true);
  },
});

/** The faces this caller's call should have: every live feed of the room
 *  they may be in, when their team has faces on. */
export const facesForRoom = internalQuery({
  args: { room_key: v.string() },
  handler: async (ctx, args): Promise<(FaceFeed & { realtime: boolean })[]> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    if (!(await authorizeRoom(ctx, userId, args.room_key)).ok) return [];
    const t = await liveTranscriptFor(ctx, args.room_key);
    const mode = t ? await faceMode(ctx, t.team_id) : "off";
    if (!t || mode === "off") return [];
    const feeds: Doc<"call_agent_feeds">[] = await ctx.db
      .query("call_agent_feeds")
      .withIndex("by_transcript", (q) => q.eq("transcript_id", t._id))
      .collect();
    const out: (FaceFeed & { realtime: boolean })[] = [];
    for (const feed of feeds) {
      const who = await characterFor(ctx, feed.conversation_id);
      if (who) out.push({ room_key: feed.room_key, conversation_id: String(feed.conversation_id), name: who.character.name, avatar: who.character.avatar, realtime: mode === "realtime" });
    }
    return out;
  },
});

/** From a client in the call, whenever the agents in the room change: seat
 *  each one's face now rather than when the scheduler gets to it. */
export const ensureFaces = action({
  args: { room_key: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const cfg = faceConfig();
    if (!cfg) return 0;
    const feeds = await ctx.runQuery(internal.callFace.facesForRoom, { room_key: args.room_key });
    let sent = 0;
    for (const feed of feeds) if (await dispatchFace(cfg, feed, feed.realtime)) sent++;
    return sent;
  },
});

export const tell = internalAction({
  args: { room_key: v.string(), conversation_id: v.id("conversations"), text: v.string() },
  handler: async (_ctx, args): Promise<void> => {
    const cfg = faceConfig();
    if (!cfg) return;
    const bytes = new TextEncoder().encode(JSON.stringify({ conversation_id: args.conversation_id, kind: "reply", text: args.text }));
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    await livekit(cfg, args.room_key, "RoomService/SendData", {
      room: args.room_key,
      data: btoa(bin),
      kind: "RELIABLE",
      topic: FACE_TOPIC,
    });
  },
});

/** Is this session fed live into this room right now? */
export const fedNow = internalQuery({
  args: { room_key: v.string(), conversation_id: v.id("conversations") },
  handler: async (ctx, args): Promise<boolean> => {
    const feed = await ctx.db
      .query("call_agent_feeds")
      .withIndex("by_conversation", (q) => q.eq("conversation_id", args.conversation_id))
      .first();
    return !!feed && feed.room_key === args.room_key;
  },
});

export const leave = internalAction({
  args: { room_key: v.string(), conversation_id: v.id("conversations") },
  handler: async (ctx, args): Promise<void> => {
    const cfg = faceConfig();
    if (!cfg) return;
    // A room is reused call after call: a leave for the last call's feed that
    // runs after the next call fed the session again must not take its face.
    if (await ctx.runQuery(internal.callFace.fedNow, args)) return;
    // A face already gone (or never seated) is the outcome we wanted.
    await livekit(cfg, args.room_key, "RoomService/RemoveParticipant", {
      room: args.room_key,
      identity: agentFaceIdentity(String(args.conversation_id)),
    }, [404]);
  },
});
