import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { mirrorAgentTurn } from "./callChat";
import { syncAgentFeeds } from "./transcripts";
import { ask, brief, dispatchFace, FACE_HOST_AGENT, FACE_TOPIC, faceForAvatar, handleFaceRequest, join, leave, said, tell } from "./callFace";
import { makeFakeDb } from "./testDb";

// An agent fed live into a huddle gets a face in the room when its team has
// agent_faces on, and a live model behind it with agent_realtime too: the
// face worker is dispatched in, reads its brief, hands the session work, and
// tells the room each reply. These pin the gates, when each step happens,
// and what goes over the wire.

const call = (fn: any, c: any, args: any) => (fn as any)._handler(c, args);

function ctxWith(tables: Record<string, any[]>) {
  const scheduled: { name: string; args: any }[] = [];
  return {
    db: makeFakeDb({ teams: [team()], ...tables }),
    scheduler: {
      async runAfter(_delay: number, reference: unknown, args: any) {
        scheduled.push({ name: getFunctionName(reference as any), args });
      },
    },
    _scheduled: scheduled,
  };
}
const faceCalls = (ctx: { _scheduled: { name: string; args: any }[] }) =>
  ctx._scheduled.filter((s) => s.name.startsWith("callFace:"));

const team = (faces = true, realtime = true) => ({ _id: "team1", name: "Team", features: { agent_faces: faces, agent_realtime: realtime } });
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
  FACE_WORKER_SECRET: "s3cret",
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
  const sent: { url: string; body: any }[] = [];
  globalThis.fetch = (async (url: string, init: any) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply(url)), { status: 200 });
  }) as any;
  return sent;
}
const LK = "https://lk.example/twirp/livekit.";

describe("the flags", () => {
  test("faces off, or unset, a feed joins nothing and its replies go to chat only, real-time on or not", async () => {
    for (const teams of [[team(false)], [team(false, false)], [{ _id: "team1", name: "Team" }]]) {
      const ctx = ctxWith({ teams, transcripts: [transcript()], conversations: [conversation], call_agent_feeds: [], messages: [] });
      await syncAgentFeeds(ctx, transcript() as any);
      expect(ctx.db._tables.call_agent_feeds).toHaveLength(1);
      expect(faceCalls(ctx)).toEqual([]);
    }
  });

  test("faces on, a feed row inserted sends the face in, real-time only when that is on too", async () => {
    for (const realtime of [false, true]) {
      const ctx = ctxWith({ teams: [team(true, realtime)], transcripts: [transcript()], conversations: [conversation], call_agent_feeds: [], messages: [] });
      await syncAgentFeeds(ctx, transcript() as any);
      const row = ctx.db._tables.call_agent_feeds[0];
      expect(faceCalls(ctx)).toEqual([{ name: "callFace:join", args: { feed_id: row._id, realtime } }]);
    }
  });

  test("on, but the worker unconfigured, nothing joins", async () => {
    delete process.env.FACE_WORKER_SECRET;
    const ctx = ctxWith({ transcripts: [transcript()], conversations: [conversation], call_agent_feeds: [], messages: [] });
    await syncAgentFeeds(ctx, transcript() as any);
    expect(faceCalls(ctx)).toEqual([]);
  });

  test("without real-time on, the worker's requests reach nothing", async () => {
    for (const teams of [[team(false)], [team(true, false)]]) {
      const ctx = ctxWith({ teams, call_agent_feeds: [feed()], transcripts: [transcript()], conversations: [conversation], messages: [] });
      expect(await call(brief, ctx, { conversation_id: "conv1", room_key: "session:conv1" })).toBeNull();
      expect(await call(ask, ctx, { conversation_id: "conv1", room_key: "session:conv1", text: "look" })).toBe(false);
    }
  });
});

describe("a voice's lifetime is its feed row", () => {
  test("a feed removed or ended takes the voice out of the room", async () => {
    const ctx = ctxWith({ transcripts: [], conversations: [conversation], call_agent_feeds: [feed()], messages: [] });
    await syncAgentFeeds(ctx, transcript({ status: "ended" }) as any);
    expect(faceCalls(ctx)).toEqual([{ name: "callFace:leave", args: { room_key: "session:conv1", conversation_id: "conv1" } }]);
  });

  test("a mirrored reply is told as plain words; a passed turn tells nothing", async () => {
    const ctx = ctxWith({
      call_agent_feeds: [feed()],
      transcripts: [transcript()],
      messages: [
        { _id: "m1", conversation_id: "conv1", role: "assistant", content: "earlier", timestamp: 1 },
        { _id: "m2", conversation_id: "conv1", role: "assistant", content: "The **fix** is in `auth.ts`:\n```ts\nconst x = 1;\n```\nShip it.", timestamp: 2 },
      ],
      call_chat_messages: [],
    });
    await call(mirrorAgentTurn, ctx, { conversation_id: "conv1", attempt: 0 });
    expect(faceCalls(ctx)).toEqual([
      { name: "callFace:tell", args: { room_key: "session:conv1", conversation_id: "conv1", text: "The fix is in auth.ts: Ship it." } },
    ]);
    const passed = ctxWith({
      call_agent_feeds: [feed()],
      transcripts: [transcript()],
      messages: [{ _id: "m2", conversation_id: "conv1", role: "assistant", content: "[pass]", timestamp: 2 }],
      call_chat_messages: [],
    });
    await call(mirrorAgentTurn, passed, { conversation_id: "conv1", attempt: 0 });
    expect(faceCalls(passed)).toEqual([]);
  });
});

describe("what the worker reads and writes", () => {
  const live = () => ctxWith({
    call_agent_feeds: [feed()],
    transcripts: [transcript()],
    conversations: [conversation],
    messages: [{ _id: "m1", conversation_id: "conv1", role: "assistant", content: "Found the race in **refresh**.", timestamp: 1 }],
    transcript_segments: [],
    pending_messages: [],
  });

  test("the brief names the agent, its session and what it last said", async () => {
    const out = await call(brief, live(), { conversation_id: "conv1", room_key: "session:conv1" });
    expect(out.name).toBe("Ember");
    expect(out.spoken_names).toContain("Ember");
    expect(out.instructions).toContain("Fix the auth race");
    expect(out.instructions).toContain("Found the race in refresh.");
  });

  test("a brief for another room, or a feed that ended, is refused", async () => {
    expect(await call(brief, live(), { conversation_id: "conv1", room_key: "session:other" })).toBeNull();
    const ended = ctxWith({ call_agent_feeds: [feed()], transcripts: [transcript({ status: "ended" })], conversations: [conversation], messages: [] });
    expect(await call(brief, ended, { conversation_id: "conv1", room_key: "session:conv1" })).toBeNull();
  });

  test("an ask reaches the session as the feed's adder, with who asked", async () => {
    const ctx = live();
    expect(await call(ask, ctx, { conversation_id: "conv1", room_key: "session:conv1", text: "Why does refresh race?", speaker: "Ada" })).toBe(true);
    const [sent] = ctx._scheduled.filter((s) => s.name === "transcripts:deliverToSession");
    expect(sent.args.as_user).toBe("ua");
    expect(sent.args.to).toBe("conv1");
    expect(sent.args.body).toContain("from Ada");
    expect(sent.args.body).toEndWith("Why does refresh race?");
  });

  test("what the voice said lands in the transcript under its own name", async () => {
    const ctx = live();
    expect(await call(said, ctx, { conversation_id: "conv1", room_key: "session:conv1", text: "Ember is on it." })).toBe(true);
    expect(ctx.db._tables.transcript_segments[0]).toMatchObject({ speaker_id: "agent:conv1", speaker_name: "Ember (voice)", text: "Ember is on it." });
  });

  test("the endpoint wants the worker's secret", async () => {
    const hctx = { runQuery: async () => ({ name: "Ember" }), runMutation: async () => true };
    const req = (auth: string) => new Request("https://site/calls/face", {
      method: "POST",
      headers: { authorization: auth },
      body: JSON.stringify({ op: "brief", conversation_id: "conv1", room_key: "session:conv1" }),
    });
    expect((await handleFaceRequest(hctx, req("Bearer nope"))).status).toBe(401);
    const ok = await handleFaceRequest(hctx, req("Bearer s3cret"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ name: "Ember" });
  });
});

describe("the wire", () => {
  test("join dispatches the worker, told whose face, which one, and the mode", async () => {
    const sent = recordFetch();
    const actx = { runQuery: async () => ({ room_key: "session:conv1", conversation_id: "conv1", name: "Ember", avatar: "fox" }) };
    await call(join, actx, { feed_id: "f1", realtime: true });
    expect(sent.map((x) => x.url)).toEqual([`${LK}AgentDispatchService/ListDispatch`, `${LK}AgentDispatchService/CreateDispatch`]);
    expect(sent[1].body).toEqual({
      room: "session:conv1",
      agentName: FACE_HOST_AGENT,
      metadata: JSON.stringify({ conversation_id: "conv1", name: "Ember", ...faceForAvatar("fox"), realtime: true }),
    });
  });

  const cfg = { secret: "s", lkUrl: "wss://lk.example", lkKey: "lkkey", lkSecret: ENV.LIVEKIT_API_SECRET };
  const faceFeed = { room_key: "session:conv1", conversation_id: "conv1", name: "Ember", avatar: "fox" };
  const listing = (status: string | null, conversation = "conv1") => ({
    agent_dispatches: [{ id: "AD_1", agent_name: FACE_HOST_AGENT, metadata: JSON.stringify({ conversation_id: conversation }), state: { jobs: status === null ? [] : [{ state: status ? { status } : {} }] } }],
  });

  test("a face already on its way or in the room is not sent twice", async () => {
    for (const status of [null, "", "JS_PENDING", "JS_RUNNING"]) {
      const sent = recordFetch((url) => (url.endsWith("ListDispatch") ? listing(status) : {}));
      expect(await dispatchFace(cfg, faceFeed, false)).toBe(false);
      expect(sent.map((x) => x.url)).toEqual([`${LK}AgentDispatchService/ListDispatch`]);
    }
  });

  test("a finished dispatch is cleared and a new one goes; another agent's is left alone", async () => {
    const sent = recordFetch((url) => (url.endsWith("ListDispatch") ? listing("JS_FAILED") : {}));
    expect(await dispatchFace(cfg, faceFeed, false)).toBe(true);
    expect(sent.map((x) => x.url.slice(LK.length))).toEqual(["AgentDispatchService/ListDispatch", "AgentDispatchService/DeleteDispatch", "AgentDispatchService/CreateDispatch"]);
    expect(sent[1].body).toEqual({ dispatchId: "AD_1", room: "session:conv1" });
    const other = recordFetch((url) => (url.endsWith("ListDispatch") ? listing("JS_RUNNING", "conv2") : {}));
    expect(await dispatchFace(cfg, faceFeed, false)).toBe(true);
    expect(other.map((x) => x.url.slice(LK.length))).toEqual(["AgentDispatchService/ListDispatch", "AgentDispatchService/CreateDispatch"]);
  });

  test("tell puts the reply on the voice's topic", async () => {
    const sent = recordFetch();
    await call(tell, {}, { room_key: "session:conv1", conversation_id: "conv1", text: "Ship it." });
    expect(sent[0].url).toBe("https://lk.example/twirp/livekit.RoomService/SendData");
    expect(sent[0].body).toMatchObject({ room: "session:conv1", topic: FACE_TOPIC });
    expect(JSON.parse(atob(sent[0].body.data))).toEqual({ conversation_id: "conv1", kind: "reply", text: "Ship it." });
  });

  test("a leave from the last call does not take the next call's face", async () => {
    const sent = recordFetch();
    await call(leave, { runQuery: async () => true }, { room_key: "session:conv1", conversation_id: "conv1" });
    expect(sent).toEqual([]);
  });

  test("leave removes the face from the room", async () => {
    const sent = recordFetch();
    await call(leave, { runQuery: async () => false }, { room_key: "session:conv1", conversation_id: "conv1" });
    expect(sent[0].url).toBe("https://lk.example/twirp/livekit.RoomService/RemoveParticipant");
    expect(sent[0].body).toEqual({ room: "session:conv1", identity: "agent:conv1" });
  });
});
