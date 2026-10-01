import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { mirrorAgentTurn } from "./callChat";
import { syncAgentFeeds } from "./transcripts";
import { faceForAvatar, join, leave, speak } from "./tavusPal";
import { makeFakeDb } from "./testDb";

// An agent fed live into a huddle gets a face in the room: Tavus joins the
// LiveKit room as `agent:<conversation>`, says each reply the room's chat
// shows, and leaves with the feed. These pin when each of the three calls
// happens and what goes over the wire.

const call = (fn: any, c: any, args: any) => (fn as any)._handler(c, args);

function ctxWith(tables: Record<string, any[]>) {
  const scheduled: { name: string; args: any }[] = [];
  return {
    db: makeFakeDb(tables),
    scheduler: {
      async runAfter(_delay: number, reference: unknown, args: any) {
        scheduled.push({ name: getFunctionName(reference as any), args });
      },
    },
    _scheduled: scheduled,
  };
}
const faceCalls = (ctx: { _scheduled: { name: string; args: any }[] }) =>
  ctx._scheduled.filter((s) => s.name.startsWith("tavusPal:"));

const transcript = (over: Record<string, unknown> = {}) => ({
  _id: "t1",
  room_key: "session:conv1",
  team_id: "team1",
  started_by: "ua",
  status: "live",
  started_at: 1_000,
  routes: [{ kind: "session", target: "conv1", mode: "live", sent_seq: 0, added_by: "ua" }],
  last_seq: 0,
  ...over,
});
const conversation = { _id: "conv1", short_id: "conv1", title: "Fix the auth race", agent_type: "claude_code", user_id: "ua", character_avatar: "fox", character_name: "Ember" };
const feed = (over: Record<string, unknown> = {}) => ({
  _id: "f1", conversation_id: "conv1", transcript_id: "t1", room_key: "session:conv1", team_id: "team1", added_by: "ua", last_mirrored_message_id: "m1", ...over,
});

const ENV = {
  TAVUS_API_KEY: "tk",
  TAVUS_PAL_ID: "pal1",
  LIVEKIT_URL: "wss://lk.example",
  LIVEKIT_API_KEY: "lkkey",
  LIVEKIT_API_SECRET: "lksecret-lksecret-lksecret-lksecret",
};
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterEach(() => {
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = realFetch;
});

function recordFetch(reply: (url: string) => unknown = () => ({})) {
  const sent: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: string, init: any) => {
    sent.push({ url, init });
    return new Response(JSON.stringify(reply(url)), { status: 200 });
  }) as any;
  return sent;
}
const jwtPayload = (token: string) => JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));

describe("a face's lifetime is its feed row", () => {
  test("a feed row inserted sends a face to join", async () => {
    const ctx = ctxWith({ transcripts: [transcript()], conversations: [conversation], call_agent_feeds: [], messages: [] });
    await syncAgentFeeds(ctx, transcript() as any);
    const row = ctx.db._tables.call_agent_feeds[0];
    expect(faceCalls(ctx)).toEqual([{ name: "tavusPal:join", args: { feed_id: row._id } }]);
  });

  test("with Tavus unconfigured the agent stays chat only", async () => {
    delete process.env.TAVUS_API_KEY;
    const ctx = ctxWith({ transcripts: [transcript()], conversations: [conversation], call_agent_feeds: [], messages: [] });
    await syncAgentFeeds(ctx, transcript() as any);
    expect(ctx.db._tables.call_agent_feeds).toHaveLength(1);
    expect(faceCalls(ctx)).toEqual([]);
  });

  test("a feed removed or ended takes its face out of the room", async () => {
    const ctx = ctxWith({ transcripts: [], conversations: [conversation], call_agent_feeds: [feed({ tavus_conversation_id: "tc1" })], messages: [] });
    await syncAgentFeeds(ctx, transcript({ status: "ended" }) as any);
    expect(faceCalls(ctx)).toEqual([{ name: "tavusPal:leave", args: { tavus_conversation_id: "tc1" } }]);
  });

  test("a feed whose face never joined leaves nothing to end", async () => {
    const ctx = ctxWith({ transcripts: [], conversations: [conversation], call_agent_feeds: [feed()], messages: [] });
    await syncAgentFeeds(ctx, transcript({ status: "ended" }) as any);
    expect(faceCalls(ctx)).toEqual([]);
  });
});

describe("the face says what the chat shows", () => {
  test("a mirrored reply is spoken as plain words, code left to the chat", async () => {
    const ctx = ctxWith({
      call_agent_feeds: [feed({ tavus_conversation_id: "tc1" })],
      transcripts: [transcript()],
      messages: [
        { _id: "m1", conversation_id: "conv1", role: "assistant", content: "earlier", timestamp: 1 },
        { _id: "m2", conversation_id: "conv1", role: "assistant", content: "The **fix** is in `auth.ts`:\n```ts\nconst x = 1;\n```\nShip it.", timestamp: 2 },
      ],
      call_chat_messages: [],
    });
    await call(mirrorAgentTurn, ctx, { conversation_id: "conv1", attempt: 0 });
    expect(faceCalls(ctx)).toEqual([
      {
        name: "tavusPal:speak",
        args: { room_key: "session:conv1", conversation_id: "conv1", tavus_conversation_id: "tc1", text: "The fix is in auth.ts: Ship it." },
      },
    ]);
  });

  test("a passed turn says nothing", async () => {
    const ctx = ctxWith({
      call_agent_feeds: [feed({ tavus_conversation_id: "tc1" })],
      transcripts: [transcript()],
      messages: [{ _id: "m2", conversation_id: "conv1", role: "assistant", content: "[pass]", timestamp: 2 }],
      call_chat_messages: [],
    });
    await call(mirrorAgentTurn, ctx, { conversation_id: "conv1", attempt: 0 });
    expect(faceCalls(ctx)).toEqual([]);
  });

  test("a huddle found over at the mirror ends the face", async () => {
    const ctx = ctxWith({
      call_agent_feeds: [feed({ tavus_conversation_id: "tc1" })],
      transcripts: [transcript({ status: "ended" })],
      messages: [],
      call_chat_messages: [],
    });
    await call(mirrorAgentTurn, ctx, { conversation_id: "conv1", attempt: 0 });
    expect(faceCalls(ctx)).toEqual([{ name: "tavusPal:leave", args: { tavus_conversation_id: "tc1" } }]);
  });
});

describe("the wire", () => {
  test("join asks Tavus for the agent's face in this room, as agent:<conversation>", async () => {
    const sent = recordFetch(() => ({ conversation_id: "tc9" }));
    const ran: { fn: string; args: any }[] = [];
    const actx = {
      runQuery: async () => ({ room_key: "session:conv1", conversation_id: "conv1", name: "Ember", avatar: "fox" }),
      runMutation: async (_fn: unknown, args: any) => {
        ran.push({ fn: "attachFace", args });
        return true;
      },
    };
    await call(join, actx, { feed_id: "f1" });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://tavusapi.com/v2/conversations");
    const body = JSON.parse(sent[0].init.body);
    expect(body.pal_id).toBe("pal1");
    expect(body.face_id).toBe(faceForAvatar("fox", ["rc8992fe8e8e", "rcf10ec292c1", "refaf3628ea7", "rc9cff32ceba", "rbb3ca3630f7", "r3f4182ef554", "r0df0ace1c0a", "rccbeedfc684", "r5ad3b1690f0", "r1ce7f5b22d4", "rbb3d627a705", "r4dc9377a68e"]));
    expect(body.properties.livekit_ws_url).toBe("wss://lk.example");
    const claims = jwtPayload(body.properties.livekit_room_token);
    expect(claims).toMatchObject({ sub: "agent:conv1", name: "Ember", video: { room: "session:conv1", roomJoin: true, canPublish: true } });
    expect(ran).toEqual([{ fn: "attachFace", args: { feed_id: "f1", tavus_conversation_id: "tc9" } }]);
  });

  test("a feed gone while the face was starting ends the face at once", async () => {
    const sent = recordFetch((url) => (url.endsWith("/conversations") ? { conversation_id: "tc9" } : {}));
    const actx = {
      runQuery: async () => ({ room_key: "session:conv1", conversation_id: "conv1", name: "Ember", avatar: "fox" }),
      runMutation: async () => false,
    };
    await call(join, actx, { feed_id: "f1" });
    expect(sent.map((s) => s.url)).toEqual(["https://tavusapi.com/v2/conversations", "https://tavusapi.com/v2/conversations/tc9/end"]);
  });

  test("speak sends one echo to the face alone, on the topic Tavus reads", async () => {
    const sent = recordFetch();
    await call(speak, {}, { room_key: "session:conv1", conversation_id: "conv1", tavus_conversation_id: "tc1", text: "Ship it." });
    expect(sent[0].url).toBe("https://lk.example/twirp/livekit.RoomService/SendData");
    const body = JSON.parse(sent[0].init.body);
    expect(body).toMatchObject({ room: "session:conv1", topic: "app_messages", destinationIdentities: ["agent:conv1"] });
    expect(JSON.parse(atob(body.data))).toEqual({
      message_type: "conversation",
      event_type: "conversation.echo",
      conversation_id: "tc1",
      properties: { modality: "text", text: "Ship it.", done: true },
    });
    const claims = jwtPayload(sent[0].init.headers.authorization.slice("Bearer ".length));
    expect(claims.video).toEqual({ room: "session:conv1", roomAdmin: true });
  });

  test("leave ends the Tavus conversation", async () => {
    const sent = recordFetch();
    await call(leave, {}, { tavus_conversation_id: "tc1" });
    expect(sent[0].url).toBe("https://tavusapi.com/v2/conversations/tc1/end");
    expect(sent[0].init.method).toBe("POST");
  });
});
