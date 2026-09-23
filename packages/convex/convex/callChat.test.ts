import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { agentLineText, list, mirrorAgentTurn, post, postEvent, scheduleFedSessionSettle } from "./callChat";
import { setRoomTranscribeOff } from "./calls";
import { syncAgentFeeds } from "./transcripts";
import { makeFakeDb } from "./testDb";
import { characterOf } from "@codecast/shared/contracts/sessionCharacter";

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
    // The only write besides the delete is the room's line about it.
    expect(ctx.db._inserted.map((i: any) => i.table)).toEqual(["call_chat_messages"]);
    expect(ctx.db._inserted[0].doc).toMatchObject({
      room_key: "session:conv1",
      user_id: "ua",
      event: "agent_left",
      agent_conversation_id: "conv2",
      text: "",
    });
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
    // The call ended; nobody left. The thread gets no line for the wipe.
    expect(ctx.db._tables.call_chat_messages ?? []).toHaveLength(0);
  });

  test("a feed row inserted is an agent joining, credited to whoever added the route", async () => {
    const ctx = ctxWith({
      transcripts: [transcript()],
      conversations: [conversation],
      call_agent_feeds: [],
      messages: [],
      call_chat_messages: [],
    });
    await syncAgentFeeds(ctx, transcript({ routes: [{ kind: "session", target: "conv1", mode: "live", sent_seq: 0, added_by: "ub" }] }) as any);
    const events = ctx.db._tables.call_chat_messages;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      room_key: "session:conv1",
      team_id: "team1",
      user_id: "ub",
      event: "agent_joined",
      agent_conversation_id: "conv1",
      text: "",
    });
    // Idempotent: the same routes again change nothing and say nothing.
    await syncAgentFeeds(ctx, transcript({ routes: [{ kind: "session", target: "conv1", mode: "live", sent_seq: 0, added_by: "ub" }] }) as any);
    expect(ctx.db._tables.call_chat_messages).toHaveLength(1);
  });
});

describe("postEvent", () => {
  test("a recording has no room thread, so nothing is written for one", async () => {
    const ctx = ctxWith({ call_chat_messages: [] });
    const id = await postEvent(ctx, {
      room_key: "rec:9f8e7d6c-1234-4abc-9def-0123456789ab",
      user_id: "ua" as any,
      event: "transcribe_on",
    });
    expect(id).toBeNull();
    expect(ctx.db._tables.call_chat_messages).toHaveLength(0);
  });

  test("a huddle event is a row with empty text and the actor as its owner", async () => {
    const ctx = ctxWith({ call_chat_messages: [] });
    const id = await postEvent(ctx, { room_key: "channel:chan1", team_id: "team1" as any, user_id: "ua" as any, event: "transcribe_off" });
    expect(id).not.toBeNull();
    expect(ctx.db._tables.call_chat_messages[0]).toMatchObject({
      room_key: "channel:chan1",
      team_id: "team1",
      user_id: "ua",
      text: "",
      event: "transcribe_off",
    });
    expect(ctx.db._tables.call_chat_messages[0].agent_conversation_id).toBeUndefined();
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

describe("scheduleFedSessionSettle", () => {
  test("a fed session's settle mirrors its reply and delivers the words that waited", async () => {
    const fed = ctxWith({
      call_agent_feeds: [{ _id: "f1", conversation_id: "conv1", transcript_id: "t1", room_key: "session:conv1", added_by: "ua" }],
    });
    expect(await scheduleFedSessionSettle(fed, "conv1" as any)).toBe(true);
    expect(fed._scheduled.map((s) => s.name)).toEqual(["callChat:mirrorAgentTurn", "transcripts:deliverRoutes"]);
    // The catch up says why it runs, so delivery can wait for a quiet room.
    expect(fed._scheduled[1].args).toMatchObject({ transcript_id: "t1", include_after_routes: false, reason: "settle" });
    const unfed = ctxWith({ call_agent_feeds: [] });
    expect(await scheduleFedSessionSettle(unfed, "conv1" as any)).toBe(false);
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
    conversations: [{ ...conversation, team_id: "team1" }],
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
    await call(post, ctx, { room_key: "session:conv1", text: "  can you check the deploy?  " });
    const stored = ctx.db._tables.call_chat_messages;
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe("can you check the deploy?");
    expect(stored[0].agent_conversation_id).toBeUndefined();
    expect(stored[0].attachments).toBeUndefined();
    const relays = ctx._scheduled.filter((s) => s.name === "transcripts:deliverToSession");
    expect(relays).toHaveLength(1);
    expect(relays[0].args.as_user).toBe("ua");
    expect(relays[0].args.to).toBe("conv1");
    expect(relays[0].args.body).toContain("Ada Lovelace wrote in the huddle's chat");
    expect(relays[0].args.body).toContain("**Ada Lovelace**: can you check the deploy?");
    expect(relays[0].args.image_storage_ids).toBeUndefined();
  });

  test("an image rides the chat attachment shape and the session image path", async () => {
    const ctx = ctxWith(
      {
        ...seated,
        call_chat_messages: [],
        transcripts: [transcript()],
        call_agent_feeds: [{ _id: "f1", conversation_id: "conv1", transcript_id: "t1", room_key: "session:conv1", added_by: "ua" }],
      },
      { userId: "ua" },
    );
    const shot = { storage_id: "kg23b1w4w5y06f1yd7vfha6x298ehr6x", mime: "image/png" };
    await call(post, ctx, {
      room_key: "session:conv1",
      text: "look at this",
      attachments: [shot],
    });
    expect(ctx.db._tables.call_chat_messages).toHaveLength(1);
    expect(ctx.db._tables.call_chat_messages[0].attachments).toEqual([shot]);
    const relays = ctx._scheduled.filter((s) => s.name === "transcripts:deliverToSession");
    expect(relays).toHaveLength(1);
    expect(relays[0].args.body).toContain("**Ada Lovelace**: look at this");
    expect(relays[0].args.image_storage_ids).toEqual([shot.storage_id]);
  });

  test("an image-only line is stored and relayed without invented text", async () => {
    const ctx = ctxWith(
      {
        ...seated,
        call_chat_messages: [],
        transcripts: [transcript()],
        call_agent_feeds: [{ _id: "f1", conversation_id: "conv1", transcript_id: "t1", room_key: "session:conv1", added_by: "ua" }],
      },
      { userId: "ua" },
    );
    await call(post, ctx, {
      room_key: "session:conv1",
      text: "   ",
      attachments: [{ storage_id: "img1", mime: "image/jpeg" }],
    });
    expect(ctx.db._tables.call_chat_messages[0].text).toBe("");
    expect(ctx.db._tables.call_chat_messages[0].attachments).toHaveLength(1);
    const relays = ctx._scheduled.filter((s) => s.name === "transcripts:deliverToSession");
    expect(relays[0].args.body).toContain("attached an image");
    expect(relays[0].args.image_storage_ids).toEqual(["img1"]);
  });

  test("empty text with no image is a no-op", async () => {
    const ctx = ctxWith(
      {
        ...seated,
        call_chat_messages: [],
        transcripts: [transcript()],
        call_agent_feeds: [{ _id: "f1", conversation_id: "conv1", transcript_id: "t1", room_key: "session:conv1", added_by: "ua" }],
      },
      { userId: "ua" },
    );
    await call(post, ctx, { room_key: "session:conv1", text: "  " });
    expect(ctx.db._tables.call_chat_messages).toHaveLength(0);
    expect(ctx._scheduled).toHaveLength(0);
  });
});

describe("list tells an event row from a line", () => {
  const seated = {
    call_members: [{ _id: "cm1", room_key: "session:conv1", user_id: "ua", team_id: "team1", last_seen: Date.now(), expires_at: Date.now() + 60_000 }],
    call_rooms: [],
    call_room_state: [],
    call_invites: [],
    users: [
      { _id: "ua", name: "Ada Lovelace", email: "ada@x.org", image: "https://x/ada.png" },
      { _id: "ub", name: "Bob", email: "bob@x.org" },
    ],
    team_members: [{ team_id: "team1", user_id: "ua" }],
    teams: [{ _id: "team1", features: { calls: true } }],
    conversations: [{ ...conversation, team_id: "team1" }],
  };

  test("an event row names its actor, carries the agent beside it, and is never mine", async () => {
    const ctx = ctxWith(
      {
        ...seated,
        call_chat_messages: [
          { _id: "c1", _creationTime: 10, room_key: "session:conv1", team_id: "team1", user_id: "ua", text: "hello", },
          { _id: "c2", _creationTime: 20, room_key: "session:conv1", team_id: "team1", user_id: "ua", text: "", event: "agent_joined", agent_conversation_id: "conv1" },
          { _id: "c3", _creationTime: 30, room_key: "session:conv1", team_id: "team1", user_id: "ua", text: "On it.", agent_conversation_id: "conv1", source_message_id: "m9" },
          { _id: "c4", _creationTime: 40, room_key: "session:conv1", team_id: "team1", user_id: "ub", text: "", event: "transcribe_off" },
        ],
      },
      { userId: "ua" },
    );
    const rows = await call(list, ctx, { room_key: "session:conv1" });
    expect(rows.map((r: any) => r._id)).toEqual(["c1", "c2", "c3", "c4"]);
    // A typed line: mine, my name, no event.
    expect(rows[0]).toMatchObject({ user_name: "Ada Lovelace", user_image: "https://x/ada.png", mine: true, event: null, agent: null });
    // The agent joining: the ACTOR's name, the agent separately, not mine.
    expect(rows[1]).toMatchObject({ user_name: "Ada Lovelace", mine: false, event: "agent_joined", text: "" });
    expect(rows[1].agent).toMatchObject({ conversation_id: "conv1", short_id: "conv1", title: "Fix the auth race", agent_type: "claude_code" });
    // The agent's own line keeps its identity: what the room calls it (its
    // character name, the hash default when nobody chose one), not mine.
    const name = characterOf({ _id: "conv1" }).name;
    expect(rows[2]).toMatchObject({ user_name: name, user_image: undefined, mine: false, event: null });
    expect(rows[2].agent).toMatchObject({ conversation_id: "conv1", name, character_avatar: null, character_name: null });
    // Somebody else pressed the switch: their name, no agent.
    expect(rows[3]).toMatchObject({ user_name: "Bob", mine: false, event: "transcribe_off", agent: null });
  });
});

describe("the room's transcription switch", () => {
  const room = () => ({
    call_members: [
      { _id: "cm1", room_key: "channel:chan1", user_id: "ua", team_id: "team1", last_seen: Date.now(), expires_at: Date.now() + 60_000 },
    ],
    call_room_state: [],
    call_chat_messages: [],
  });

  test("switching it off writes one line naming the presser; a repeat press and switching on write nothing", async () => {
    const ctx = ctxWith(room(), { userId: "ua" });
    await call(setRoomTranscribeOff, ctx, { room_key: "channel:chan1", off: true });
    expect(ctx.db._tables.call_chat_messages).toHaveLength(1);
    expect(ctx.db._tables.call_chat_messages[0]).toMatchObject({
      room_key: "channel:chan1",
      team_id: "team1",
      user_id: "ua",
      event: "transcribe_off",
      text: "",
    });
    // The flag is already set: another press is not another event.
    await call(setRoomTranscribeOff, ctx, { room_key: "channel:chan1", off: true });
    expect(ctx.db._tables.call_chat_messages).toHaveLength(1);
    // Switching on is told by the fresh run transcripts.start writes, not here.
    await call(setRoomTranscribeOff, ctx, { room_key: "channel:chan1", off: false });
    expect(ctx.db._tables.call_chat_messages).toHaveLength(1);
    expect(ctx.db._tables.call_room_state[0]).toMatchObject({ transcribe_off: false });
  });
});
