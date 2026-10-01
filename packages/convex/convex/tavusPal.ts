// An agent's face in a call.
//
// A session fed live into a huddle (call_agent_feeds) gets a face: a Tavus
// PAL that joins the room's LiveKit session as a participant with video and
// audio, and says the agent's replies out loud. Nothing here runs media; the
// whole integration is three HTTP calls.
//
//   join   LiveKit dispatches the face's host (infra/call-face-worker) into
//          the room, and Tavus creates a conversation and joins it with a
//          LiveKit token we sign for `agent:<conversationId>` (shared
//          agentFaceIdentity), so every client can tell the face from a
//          person by identity alone.
//   speak  LiveKit's server API sends a `conversation.echo` data message to
//          that participant on the `app_messages` topic. The PAL runs
//          Tavus's echo pipeline: it speaks exactly the text it is given with
//          its face's voice and never answers on its own.
//   leave  Tavus ends the conversation and the face leaves the room.
//
// The feed row is the face's lifetime: transcripts.syncAgentFeeds joins one
// when it inserts a row and ends it when it deletes one, and
// callChat.mirrorAgentTurn speaks each reply it posts to the room's chat.
//
// The host exists because in LiveKit mode Tavus keeps a face only while a
// participant of kind "agent" is in the room, holding on to one of them; with
// only people there it shuts the face down after two minutes. The host is
// that participant: it joins with the face and leaves when the face does.
// Configured by TAVUS_API_KEY and TAVUS_PAL_ID (an echo PAL on LiveKit
// transport) beside the LIVEKIT_* the room itself needs; with any of them
// missing, agents stay chat only.
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { agentFaceIdentity } from "@codecast/shared/contracts";
import { AVATAR_KEYS } from "@codecast/shared/contracts/orgAvatars";
import { characterOf } from "@codecast/shared/contracts/sessionCharacter";
import { speakableAgentLine } from "@codecast/shared/contracts/plainText";
import { signLivekitJwt } from "./lib/livekitJwt";

const TAVUS_API = "https://tavusapi.com/v2";
// Tavus stock faces on Phoenix-4.5, its real-time model. TAVUS_FACE_IDS (comma
// separated) replaces the set.
const STOCK_FACES = [
  "rc8992fe8e8e", // Brooke
  "rcf10ec292c1", // Dominic
  "refaf3628ea7", // Evan
  "rc9cff32ceba", // Anna
  "rbb3ca3630f7", // Charlie
  "r3f4182ef554", // Lucas
  "r0df0ace1c0a", // Zane
  "rccbeedfc684", // Darius
  "r5ad3b1690f0", // Ivy
  "r1ce7f5b22d4", // Maya
  "rbb3d627a705", // Mateo
  "r4dc9377a68e", // Priya
];
// A huddle can run for hours; Tavus ends a conversation at an hour unless told.
const MAX_CALL_SECONDS = 4 * 3600;
// The name the face host registers under (infra/call-face-worker).
export const FACE_HOST_AGENT = "codecast-face";

type FaceConfig = { tavusKey: string; palId: string; lkUrl: string; lkKey: string; lkSecret: string; faces: string[] };

function faceConfig(): FaceConfig | null {
  const tavusKey = process.env.TAVUS_API_KEY;
  const palId = process.env.TAVUS_PAL_ID;
  const lkUrl = process.env.LIVEKIT_URL;
  const lkKey = process.env.LIVEKIT_API_KEY;
  const lkSecret = process.env.LIVEKIT_API_SECRET;
  if (!tavusKey || !palId || !lkUrl || !lkKey || !lkSecret) return null;
  const faces = (process.env.TAVUS_FACE_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { tavusKey, palId, lkUrl, lkKey, lkSecret, faces: faces.length ? faces : STOCK_FACES };
}

/** A face follows the agent's character, so it looks the same in every call
 *  and two agents a room told apart by character are told apart by face. */
export function faceForAvatar(avatar: string, faces: readonly string[]): string {
  const i = Math.max(0, (AVATAR_KEYS as readonly string[]).indexOf(avatar));
  return faces[i % faces.length];
}

/** From a mutation that just inserted a feed row. */
export async function scheduleFaceJoin(ctx: any, feedId: Id<"call_agent_feeds">): Promise<void> {
  if (!faceConfig()) return;
  await ctx.scheduler.runAfter(0, internal.tavusPal.join, { feed_id: feedId });
}

/** From a mutation deleting a feed row: its face leaves with it. */
export async function scheduleFaceLeave(ctx: any, feed: Doc<"call_agent_feeds">): Promise<void> {
  if (!feed.tavus_conversation_id) return;
  await ctx.scheduler.runAfter(0, internal.tavusPal.leave, { tavus_conversation_id: feed.tavus_conversation_id });
}

/** From the mirror, for the replies it just posted to the room's chat. */
export async function scheduleFaceSpeak(ctx: any, feed: Doc<"call_agent_feeds">, replies: string[]): Promise<void> {
  if (!feed.tavus_conversation_id) return;
  const text = speakableAgentLine(replies.join("\n\n"));
  if (!text) return;
  await ctx.scheduler.runAfter(0, internal.tavusPal.speak, {
    room_key: feed.room_key,
    conversation_id: feed.conversation_id,
    tavus_conversation_id: feed.tavus_conversation_id,
    text,
  });
}

export const feedForFace = internalQuery({
  args: { feed_id: v.id("call_agent_feeds") },
  handler: async (ctx, args): Promise<{ room_key: string; conversation_id: string; name: string; avatar: string } | null> => {
    const feed = await ctx.db.get(args.feed_id);
    if (!feed || feed.tavus_conversation_id) return null;
    const conv = await ctx.db.get(feed.conversation_id);
    if (!conv) return null;
    const character = characterOf({ _id: String(conv._id), character_avatar: conv.character_avatar, character_name: conv.character_name });
    return { room_key: feed.room_key, conversation_id: String(conv._id), name: character.name, avatar: character.avatar };
  },
});

/** Record the face on its feed. False when the feed ended while Tavus was
 *  starting the face, which then has nowhere to be. */
export const attachFace = internalMutation({
  args: { feed_id: v.id("call_agent_feeds"), tavus_conversation_id: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const feed = await ctx.db.get(args.feed_id);
    if (!feed || feed.tavus_conversation_id) return false;
    await ctx.db.patch(feed._id, { tavus_conversation_id: args.tavus_conversation_id });
    return true;
  },
});

/** LiveKit's server API (Twirp over JSON), as an admin of one room. */
async function livekit(cfg: FaceConfig, room: string, method: string, body: unknown): Promise<any> {
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
  if (!res.ok) throw new Error(`LiveKit ${method}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function tavus(cfg: FaceConfig, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${TAVUS_API}/${path}`, {
    method,
    headers: { "x-api-key": cfg.tavusKey, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Tavus ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export const join = internalAction({
  args: { feed_id: v.id("call_agent_feeds") },
  handler: async (ctx, args): Promise<void> => {
    const cfg = faceConfig();
    if (!cfg) return;
    const feed = await ctx.runQuery(internal.tavusPal.feedForFace, { feed_id: args.feed_id });
    if (!feed) return;
    const face = agentFaceIdentity(feed.conversation_id);
    const token = await signLivekitJwt({
      apiKey: cfg.lkKey,
      apiSecret: cfg.lkSecret,
      identity: face,
      name: feed.name,
      room: feed.room_key,
      metadata: JSON.stringify({ agent_conversation_id: feed.conversation_id }),
      ttlSeconds: MAX_CALL_SECONDS,
    });
    await livekit(cfg, feed.room_key, "AgentDispatchService/CreateDispatch", {
      room: feed.room_key,
      agentName: FACE_HOST_AGENT,
      metadata: JSON.stringify({ face }),
    });
    const created = await tavus(cfg, "POST", "conversations", {
      pal_id: cfg.palId,
      face_id: faceForAvatar(feed.avatar, cfg.faces),
      conversation_name: `${feed.name} in ${feed.room_key}`.slice(0, 120),
      properties: { livekit_ws_url: cfg.lkUrl, livekit_room_token: token, max_call_duration: MAX_CALL_SECONDS },
    });
    const id = String(created?.conversation_id ?? "");
    if (!id) throw new Error("Tavus created no conversation");
    const kept = await ctx.runMutation(internal.tavusPal.attachFace, { feed_id: args.feed_id, tavus_conversation_id: id });
    if (!kept) await tavus(cfg, "POST", `conversations/${id}/end`);
  },
});

export const speak = internalAction({
  args: { room_key: v.string(), conversation_id: v.id("conversations"), tavus_conversation_id: v.string(), text: v.string() },
  handler: async (_ctx, args): Promise<void> => {
    const cfg = faceConfig();
    if (!cfg) return;
    const message = {
      message_type: "conversation",
      event_type: "conversation.echo",
      conversation_id: args.tavus_conversation_id,
      properties: { modality: "text", text: args.text, done: true },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(message));
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    await livekit(cfg, args.room_key, "RoomService/SendData", {
      room: args.room_key,
      data: btoa(bin),
      kind: "RELIABLE",
      topic: "app_messages",
      destinationIdentities: [agentFaceIdentity(String(args.conversation_id))],
    });
  },
});

export const leave = internalAction({
  args: { tavus_conversation_id: v.string() },
  handler: async (_ctx, args): Promise<void> => {
    const cfg = faceConfig();
    if (!cfg) return;
    await tavus(cfg, "POST", `conversations/${args.tavus_conversation_id}/end`);
  },
});
