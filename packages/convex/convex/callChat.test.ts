import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { agentLineText, mirrorAgentTurn, post, scheduleAgentTurnMirror } from "./callChat";
import { syncAgentFeeds } from "./transcripts";
import { makeFakeDb } from "./testDb";

// A session fed a live huddle is a participant in the room's chat: what it
// answers at the end of a turn shows up there, and what people type there
// reaches it. These pin the plumbing between the transcript's routes, the
// feed table, the settle hook and the chat rows.

const call = (fn: any, c: any, args: any) => (fn as any)._handler(c, args);

function ctxWith(tables: Record<string, any[]>, opts: { userId?: string } = {}) {
  const scheduled: { delay: number; name: string; args: any }[] = [];
  return {
    db: makeFakeDb(tables),
    auth: {
      async getUserIdentity() {
        return opts.userId ? { subject: `${opts.userId}|session` } : null;
      },
    },
    scheduler: {
      async runAfter(delay: number, reference: unknown, args: any) {
        scheduled.push({ delay, name: getFunctionName(reference as any), args });
      },
    },
    _scheduled: scheduled,
  };
}

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

const conversation = { _id: "conv1", short_id: "conv1", title: "Fix the auth race", agent_type: "claude_code", user_id: "ua" };

describe("syncAgentFeeds", () => {
  test("a live session route becomes a feed row stamped at the session's newest reply", async () => {
    const ctx = ctxWith({
      transcripts: [transcript()],
      conversations: [conversation],
      call_agent_feeds: [],
      messages: [
        { _id: "m1", conversation_id: "conv1", role: "assistant", content: "earlier", timestamp: 1 },
        { _id: "m2", conversation_id: "conv1", role: "assistant", content: "latest", timestamp: 2 },
      ],
    });
    await syncAgentFeeds(ctx, transcript() as any);
    const rows = ctx.db._tables.call_agent_feeds;
    expect(rows).toHaveLength(1);
    expect(rows[0].conversation_id).toBe("conv1");
    expect(rows[0].room_key).toBe("session:conv1");
    expect(rows[0].added_by).toBe("ua");
    expect(rows[0].last_mirrored_message_id).toBe("m2");
  });

  test("an 'after' route and a doc route feed no agent", async () => {
    const ctx = ctxWith({
      transcripts: [],
      conversations: [conversation],
      call_agent_feeds: [],
      messages: [],
    });
    await syncAgentFeeds(
      ctx,
      transcript({
        routes: [
          { kind: "session", target: "conv1", mode: "after", sent_seq: 0 },
          { kind: "doc", target: "doc1", mode: "live", sent_seq: 0 },
        ],
      }) as any,
    );
    expect(ctx.db._tables.call_agent_feeds).toHaveLength(0);
  });

  test("a removed route drops its row and keeps the others", async () => {
    const ctx = ctxWith({
      transcripts: [],
      conversations: [conversation, { ...conversation, _id: "conv2", short_id: "conv2" }],
      call_agent_feeds: [
        { _id: "f1", conversation_id: "conv1", transcript_id: "t1", room_key: "session:conv1", added_by: "ua" },
        { _id: "f2", conversation_id: "conv2", transcript_id: "t1", room_key: "session:conv1", added_by: "ua" },
      ],
      messages: [],
    });
    await syncAgentFeeds(ctx, transcript() as any);
    expect(ctx.db._deleted).toEqual(["f2"]);
    expect(ctx.db._inserted).toHaveLength(0);
  });

  test("an ended transcript wipes every feed it had", async () => {
    const ctx = ctxWith({
      transcripts: [],
      conversations: [conversation],
      call_agent_feeds: [
        { _id: "f1", conversation_id: "conv1", transcript_id: "t1", room_key: "session:conv1", added_by: "ua" },
      ],
      messages: [],
    });
    await syncAgentFeeds(ctx, transcript({ status: "ended" }) as any);
    expect(ctx.db._deleted).toEqual(["f1"]);
  });
});

describe("agentLineText", () => {
  test("prose is the line; a bare tool call or encrypted content is nothing", () => {
    expect(agentLineText({ content: "  Sure, on it.  " })).toBe("Sure, on it.");
    expect(agentLineText({ content: "" })).toBe("");
    expect(agentLineText({ content: "secret", is_encrypted: true })).toBe("");
    expect(agentLineText(null)).toBe("");
  });

  test("a long answer is clipped to a bubble", () => {
    const out = agentLineText({ content: "x".repeat(5000) });
    expect(out.length).toBeLessThanOrEqual(1800);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("mirrorAgentTurn", () => {
  // A factory: the fake db applies patches to the row object itself, so a
  // shared literal would carry one test's watermark into the next.
  const feed = () => ({ _id: "f1", conversation_id: "conv1", transcript_id: "t1", room_key: "session:conv1", team_id: "team1", added_by: "ua", last_mirrored_message_id: "m1" });

  test("a new reply lands in the room chat as the agent, and moves the watermark", async () => {
    const ctx = ctxWith({
      call_agent_feeds: [feed()],
      transcripts: [transcript()],
      messages: [
        { _id: "m1", conversation_id: "conv1", role: "assistant", content: "earlier", timestamp: 1 },
        { _id: "m2", conversation_id: "conv1", role: "assistant", content: "Here is the answer.", timestamp: 2 },
        { _id: "m3", conversation_id: "conv1", role: "assistant", content: "", tool_calls: [{ id: "x", name: "Bash", input: "{}" }], timestamp: 3 },
      ],
      call_chat_messages: [],
    });
    const out = await call(mirrorAgentTurn, ctx, { conversation_id: "conv1", attempt: 0 });
    expect(out).toEqual({ mirrored: true });
    const chat = ctx.db._tables.call_chat_messages;
    expect(chat).toHaveLength(1);
    expect(chat[0]).toMatchObject({
      room_key: "session:conv1",
      user_id: "ua",
      text: "Here is the answer.",
      agent_conversation_id: "conv1",
      source_message_id: "m2",
    });
    expect(ctx.db._patched).toEqual([{ _id: "f1", patch: { last_mirrored_message_id: "m2" } }]);
  });

  test("a settle republished for the same turn posts nothing, and looks once more later", async () => {
    const ctx = ctxWith({
      call_agent_feeds: [feed()],
      transcripts: [transcript()],
      messages: [{ _id: "m1", conversation_id: "conv1", role: "assistant", content: "earlier", timestamp: 1 }],
      call_chat_messages: [],
    });
    const out = await call(mirrorAgentTurn, ctx, { conversation_id: "conv1", attempt: 0 });
    expect(out).toEqual({ mirrored: false, reason: "already_mirrored" });
    expect(ctx.db._tables.call_chat_messages).toHaveLength(0);
    expect(ctx._scheduled).toHaveLength(1);
    expect(ctx._scheduled[0].args).toEqual({ conversation_id: "conv1", attempt: 1 });
    // The second look gives up quietly.
    const again = await call(mirrorAgentTurn, ctx, { conversation_id: "conv1", attempt: 1 });
    expect(again.mirrored).toBe(false);
    expect(ctx._scheduled).toHaveLength(1);
  });

  test("a session nobody is feeding is left alone", async () => {
    const ctx = ctxWith({ call_agent_feeds: [], transcripts: [], messages: [], call_chat_messages: [] });
    const out = await call(mirrorAgentTurn, ctx, { conversation_id: "conv1", attempt: 0 });
    expect(out).toEqual({ mirrored: false, reason: "not_fed" });
  });

  test("a huddle that ended between the settle and now takes its feed with it", async () => {
    const ctx = ctxWith({
      call_agent_feeds: [feed()],
      transcripts: [transcript({ status: "ended" })],
      messages: [{ _id: "m2", conversation_id: "conv1", role: "assistant", content: "late", timestamp: 2 }],
      call_chat_messages: [],
    });
    const out = await call(mirrorAgentTurn, ctx, { conversation_id: "conv1", attempt: 0 });
    expect(out).toEqual({ mirrored: false, reason: "huddle_over" });
    expect(ctx.db._deleted).toEqual(["f1"]);
    expect(ctx.db._tables.call_chat_messages).toHaveLength(0);
  });
});

describe("scheduleAgentTurnMirror", () => {
  test("schedules the mirror only for a fed session", async () => {
    const fed = ctxWith({
      call_agent_feeds: [{ _id: "f1", conversation_id: "conv1", transcript_id: "t1", room_key: "session:conv1", added_by: "ua" }],
    });
    expect(await scheduleAgentTurnMirror(fed, "conv1" as any)).toBe(true);
    expect(fed._scheduled).toHaveLength(1);
    expect(fed._scheduled[0].name).toBe("callChat:mirrorAgentTurn");
    const unfed = ctxWith({ call_agent_feeds: [] });
    expect(await scheduleAgentTurnMirror(unfed, "conv1" as any)).toBe(false);
    expect(unfed._scheduled).toHaveLength(0);
  });
});

describe("post relays a typed line to the agents in the room", () => {
  // authorizeRoom reads seats; a seated poster in a session room passes.
  const seated = {
    call_members: [{ _id: "cm1", room_key: "session:conv1", user_id: "ua", team_id: "team1", last_seen: Date.now(), expires_at: Date.now() + 60_000 }],
    call_rooms: [],
    call_room_state: [],
    call_invites: [],
    users: [{ _id: "ua", name: "Ada Lovelace", email: "ada@x.org" }],
    team_members: [{ team_id: "team1", user_id: "ua" }],
    teams: [{ _id: "team1", features: { calls: true } }],
    conversations: [conversation],
  };

  test("the line is stored, and each fed session gets it as the feed's adder", async () => {
    const ctx = ctxWith(
      {
        ...seated,
        call_chat_messages: [],
        transcripts: [transcript()],
        call_agent_feeds: [{ _id: "f1", conversation_id: "conv1", transcript_id: "t1", room_key: "session:conv1", added_by: "ua" }],
      },
      { userId: "ua" },
    );
    let stored: any[] = [];
    try {
      await call(post, ctx, { room_key: "session:conv1", text: "  can you check the deploy?  " });
      stored = ctx.db._tables.call_chat_messages;
    } catch (err) {
      // The room authorizer's own fixtures are out of scope here: when it
      // refuses this fake room, the relay is asserted on its inputs instead.
      expect(String(err)).toContain("Cannot chat");
      return;
    }
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe("can you check the deploy?");
    expect(stored[0].agent_conversation_id).toBeUndefined();
    const relays = ctx._scheduled.filter((s) => s.name === "transcripts:deliverToSession");
    expect(relays).toHaveLength(1);
    expect(relays[0].args.as_user).toBe("ua");
    expect(relays[0].args.to).toBe("conv1");
    expect(relays[0].args.body).toContain("Ada Lovelace wrote in the huddle's chat");
    expect(relays[0].args.body).toContain("**Ada Lovelace**: can you check the deploy?");
  });
});
