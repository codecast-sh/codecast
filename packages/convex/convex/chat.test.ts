import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  createChannel,
  deleteMessage,
  editMessage,
  listMessages,
  patchChat,
  replyAsAnchor,
  sendMessage,
  toggleReaction,
} from "./chat";
import {
  extractMentionHandles,
  isValidEmoji,
  mentionsHere,
  normalizeChannelName,
  plainPreview,
} from "./chatText";

const ALICE = "user-alice" as any;
const BOB = "user-bob" as any;
const OUTSIDER = "user-outsider" as any;
const BOT = "user-bot" as any;
const TEAM = "team-main" as any;
const OTHER_TEAM = "team-other" as any;
const CHANNEL = "chat_channels_1" as any;
const OTHER_CHANNEL = "chat_channels_2" as any;
const ANCHOR = "anchor-main" as any;

function users() {
  return [
    { _id: ALICE, name: "Alice", email: "alice@example.test", github_username: "alice" },
    { _id: BOB, name: "Bob", email: "bob@example.test", github_username: "bob" },
    { _id: OUTSIDER, name: "Outsider", email: "out@example.test", github_username: "outsider" },
    { _id: BOT, name: "Anchor", is_bot: true, bot_kind: "anchor" },
  ];
}

function memberships() {
  return [
    { _id: "m-alice", user_id: ALICE, team_id: TEAM, role: "member" },
    { _id: "m-bob", user_id: BOB, team_id: TEAM, role: "admin" },
    { _id: "m-bot", user_id: BOT, team_id: TEAM, role: "member" },
    { _id: "m-outsider", user_id: OUTSIDER, team_id: OTHER_TEAM, role: "member" },
  ];
}

function channels() {
  return [
    {
      _id: CHANNEL,
      team_id: TEAM,
      name: "general",
      created_by: ALICE,
      created_at: 1_000,
      updated_at: 1_000,
    },
    {
      _id: OTHER_CHANNEL,
      team_id: TEAM,
      name: "random",
      created_by: ALICE,
      created_at: 1_000,
      updated_at: 1_000,
    },
  ];
}

function context(authenticatedUser: string | null, seed: Record<string, any[]> = {}) {
  const db = makeFakeDb({
    users: users(),
    team_memberships: memberships(),
    chat_channels: channels(),
    chat_messages: [],
    chat_reactions: [],
    chat_reads: [],
    rate_limits: [],
    notifications: [],
    user_presence: [],
    anchors: [],
    anchor_channels: [],
    pending_messages: [],
    conversations: [],
    ...seed,
  });
  const emitted: Array<{ reference: unknown; args: any }> = [];
  return {
    db,
    auth: {
      async getUserIdentity() {
        return authenticatedUser ? { subject: `${authenticatedUser}|session` } : null;
      },
    },
    async runMutation(reference: unknown, args: any) {
      emitted.push({ reference, args });
      return undefined;
    },
    scheduler: { async runAfter() {} },
    _emitted: emitted,
  } as any;
}

const call = (fn: any, ctx: any, args: any) => (fn as any)._handler(ctx, args);

function messagesIn(ctx: any) {
  return ctx.db._tables.chat_messages;
}

describe("chat text rules", () => {
  test("channel names normalize to a slug", () => {
    expect(normalizeChannelName("  Release   Train!! ")).toBe("release-train");
    expect(normalizeChannelName("###")).toBe("");
  });

  test("mention handles skip scopes and email-looking text", () => {
    expect(extractMentionHandles("hey @alice and @bob")).toEqual(["alice", "bob"]);
    expect(extractMentionHandles("@here everyone @channel")).toEqual([]);
    // A bare address is not a mention: the char before @ is a word character.
    expect(extractMentionHandles("write to alice@example.test")).toEqual([]);
    expect(mentionsHere("ping @here now")).toBe(true);
  });

  test("previews are plain text with invisible and bidi codepoints removed", () => {
    const hostile = "**bold** [link](http://x) ‮gnorw‬ ​zero";
    const preview = plainPreview(hostile);
    expect(preview).not.toContain("**");
    expect(preview).not.toContain("http://x");
    expect(preview).not.toContain("‮");
    expect(preview).not.toContain("​");
    expect(plainPreview("a\n```\nsecret code\n```\nb")).toBe("a [code] b");
  });

  test("an emoji token cannot carry markup or whitespace", () => {
    expect(isValidEmoji("🎉")).toBe(true);
    expect(isValidEmoji("<img>")).toBe(false);
    expect(isValidEmoji("a b")).toBe(false);
    expect(isValidEmoji("x".repeat(64))).toBe(false);
  });
});

describe("patchChat", () => {
  // The store keeps a row's previous identity when no SCALAR field changed, so a
  // patch touching only an array would never reach the UI. Every chat write goes
  // through this helper for exactly that reason.
  test("an array-only patch still moves a scalar", async () => {
    const ctx = context(ALICE, {
      chat_messages: [
        { _id: "m1", channel_id: CHANNEL, content: "hi", created_at: 1, updated_at: 1 },
      ],
    });
    await patchChat(ctx, "m1" as any, { mentions: [BOB] });
    const row = ctx.db._tables.chat_messages[0];
    expect(row.mentions).toEqual([BOB]);
    expect(row.updated_at).toBeGreaterThan(1);
  });
});

describe("sendMessage authorization", () => {
  test("a member of another team cannot read or write the channel", async () => {
    const ctx = context(OUTSIDER);
    await expect(call(sendMessage, ctx, { channel_id: CHANNEL, content: "hi" }))
      .rejects.toThrow("Channel not found");
    const view = await call(listMessages, ctx, { channel_id: CHANNEL });
    expect(view.messages).toEqual([]);
  });

  test("an unauthenticated caller gets nothing", async () => {
    const ctx = context(null);
    const view = await call(listMessages, ctx, { channel_id: CHANNEL });
    expect(view).toEqual({ messages: [], reactions: [], has_more: false });
  });
});

describe("sendMessage", () => {
  test("a retried send with the same client_id returns the first row", async () => {
    const ctx = context(ALICE);
    const first = await call(sendMessage, ctx, {
      channel_id: CHANNEL, content: "hello", client_id: "c-1",
    });
    const second = await call(sendMessage, ctx, {
      channel_id: CHANNEL, content: "hello", client_id: "c-1",
    });
    expect(second.message_id).toBe(first.message_id);
    expect(second.created).toBe(false);
    expect(messagesIn(ctx).length).toBe(1);
  });

  test("a reused client_id carrying different intent is refused", async () => {
    const ctx = context(ALICE);
    await call(sendMessage, ctx, { channel_id: CHANNEL, content: "hello", client_id: "c-1" });
    await expect(call(sendMessage, ctx, {
      channel_id: CHANNEL, content: "different", client_id: "c-1",
    })).rejects.toThrow("already bound");
  });

  test("identity and scope come from the server, never from the caller", async () => {
    const ctx = context(ALICE);
    await call(sendMessage, ctx, { channel_id: CHANNEL, content: "hello" });
    const row = messagesIn(ctx)[0];
    expect(row.user_id).toBe(ALICE);
    expect(row.author_kind).toBe("user");
    expect(row.team_id).toBe(TEAM);
    expect(row.created_at).toBeGreaterThan(0);
    expect(row.updated_at).toBe(row.created_at);
  });

  test("a plain channel message notifies nobody", async () => {
    const ctx = context(ALICE);
    await call(sendMessage, ctx, { channel_id: CHANNEL, content: "morning all" });
    expect(ctx._emitted.length).toBe(0);
  });

  test("a mention resolves against the roster and emits one direct notification", async () => {
    const ctx = context(ALICE);
    const sent = await call(sendMessage, ctx, {
      channel_id: CHANNEL, content: "can you look @bob",
    });
    expect(sent.mentioned).toBe(1);
    expect(messagesIn(ctx)[0].mentions).toEqual([BOB]);
    expect(ctx._emitted.length).toBe(1);
    const emit = ctx._emitted[0].args;
    expect(emit.event_type).toBe("chat_mention");
    expect(emit.direct_recipient_id).toBe(BOB);
    expect(emit.entity_type).toBe("chat_channel");
    expect(emit.entity_id).toBe(String(CHANNEL));
    expect(emit.chat_message_id).toBe(sent.message_id);
  });

  test("a display name is never a mention handle", async () => {
    // Bob renames himself to Alice's display name; @alice must still be Alice.
    const ctx = context(BOB, {
      users: [
        { _id: ALICE, name: "Alice", email: "alice@example.test", github_username: "alice" },
        { _id: BOB, name: "alice", email: "bob@example.test", github_username: "bob" },
      ],
    });
    await call(sendMessage, ctx, { channel_id: CHANNEL, content: "hey @alice" });
    expect(messagesIn(ctx)[0].mentions).toEqual([ALICE]);
  });

  test("posting marks the channel read for the author", async () => {
    const ctx = context(ALICE);
    await call(sendMessage, ctx, { channel_id: CHANNEL, content: "hi" });
    const read = ctx.db._tables.chat_reads[0];
    expect(read.user_id).toBe(ALICE);
    expect(read.channel_id).toBe(CHANNEL);
    expect(read.notify_level).toBe("all");
  });

  test("a reply cannot cross channels or nest", async () => {
    const ctx = context(ALICE);
    const root = await call(sendMessage, ctx, { channel_id: CHANNEL, content: "root" });
    await expect(call(sendMessage, ctx, {
      channel_id: OTHER_CHANNEL, content: "sneaky", thread_root_id: root.message_id,
    })).rejects.toThrow("not in this channel");

    const reply = await call(sendMessage, ctx, {
      channel_id: CHANNEL, content: "reply", thread_root_id: root.message_id,
    });
    await expect(call(sendMessage, ctx, {
      channel_id: CHANNEL, content: "nested", thread_root_id: reply.message_id,
    })).rejects.toThrow("Threads are flat");
  });

  test("a thread reply notifies the root author once, not twice", async () => {
    const ctx = context(ALICE);
    const root = await call(sendMessage, ctx, { channel_id: CHANNEL, content: "root" });
    ctx._emitted.length = 0;
    await call(sendMessage, ctx, {
      channel_id: CHANNEL, content: "answer @bob", thread_root_id: root.message_id,
    });
    const recipients = ctx._emitted.map((e: any) => e.args.direct_recipient_id);
    expect(recipients).toEqual([BOB]);
  });
});

describe("editMessage and deleteMessage", () => {
  test("only the author may edit, and an edit notifies nobody", async () => {
    const ctx = context(ALICE);
    const sent = await call(sendMessage, ctx, { channel_id: CHANNEL, content: "draft" });
    const bobCtx = { ...ctx, auth: context(BOB).auth };
    await expect(call(editMessage, bobCtx, { message_id: sent.message_id, content: "no" }))
      .rejects.toThrow("Only the author");

    ctx._emitted.length = 0;
    await call(editMessage, ctx, { message_id: sent.message_id, content: "final @bob" });
    const row = messagesIn(ctx)[0];
    expect(row.content).toBe("final @bob");
    expect(row.edited_at).toBeGreaterThan(0);
    expect(ctx._emitted.length).toBe(0);
  });

  test("delete leaves a tombstone and drops the reactions", async () => {
    const ctx = context(ALICE);
    const sent = await call(sendMessage, ctx, { channel_id: CHANNEL, content: "oops" });
    await call(toggleReaction, ctx, { message_id: sent.message_id, emoji: "🎉" });
    await call(deleteMessage, ctx, { message_id: sent.message_id });
    const row = messagesIn(ctx)[0];
    expect(row.deleted_at).toBeGreaterThan(0);
    expect(row.content).toBe("");
    expect(ctx.db._tables.chat_reactions.length).toBe(0);
  });
});

describe("toggleReaction", () => {
  test("the caller's own id is the only one written, and a second call removes it", async () => {
    const ctx = context(ALICE);
    const sent = await call(sendMessage, ctx, { channel_id: CHANNEL, content: "ship it" });
    const on = await call(toggleReaction, ctx, { message_id: sent.message_id, emoji: "🚀" });
    expect(on.reacted).toBe(true);
    const row = ctx.db._tables.chat_reactions[0];
    expect(row.user_id).toBe(ALICE);
    expect(row.channel_id).toBe(CHANNEL);

    const off = await call(toggleReaction, ctx, { message_id: sent.message_id, emoji: "🚀" });
    expect(off.reacted).toBe(false);
    expect(ctx.db._tables.chat_reactions.length).toBe(0);
  });

  test("a reaction never patches the message document", async () => {
    const ctx = context(ALICE);
    const sent = await call(sendMessage, ctx, { channel_id: CHANNEL, content: "ship it" });
    const before = messagesIn(ctx)[0].updated_at;
    await call(toggleReaction, ctx, { message_id: sent.message_id, emoji: "🚀" });
    expect(messagesIn(ctx)[0].updated_at).toBe(before);
  });
});

describe("createChannel", () => {
  test("only an admin can set the default channel", async () => {
    const alice = context(ALICE, { chat_channels: [] });
    await expect(call(createChannel, alice, {
      team_id: TEAM, name: "launch", is_default: true,
    })).rejects.toThrow("team admin");

    const bob = context(BOB, { chat_channels: [] });
    const made = await call(createChannel, bob, { team_id: TEAM, name: "Launch Plan", is_default: true });
    expect(made.created).toBe(true);
    expect(bob.db._tables.chat_channels[0].name).toBe("launch-plan");
  });

  test("a caller outside the team cannot create a channel in it", async () => {
    const ctx = context(OUTSIDER, { chat_channels: [] });
    await expect(call(createChannel, ctx, { team_id: TEAM, name: "spy" }))
      .rejects.toThrow("Not a member");
  });
});

describe("replyAsAnchor", () => {
  function anchorSeed(status: string) {
    return {
      anchors: [{
        _id: ANCHOR,
        team_id: TEAM,
        bot_user_id: BOT,
        host_user_id: BOB,
        status: "active",
        name: "Anchor",
      }],
      chat_messages: [{
        _id: "placeholder",
        team_id: TEAM,
        channel_id: CHANNEL,
        thread_root_id: "root",
        user_id: BOT,
        author_kind: "agent",
        agent_status: status,
        agent_anchor_id: ANCHOR,
        content: "",
        created_at: 5,
        updated_at: 5,
      }],
    };
  }

  test("a team member fills the waiting placeholder exactly once", async () => {
    const ctx = context(ALICE, anchorSeed("thinking"));
    await call(replyAsAnchor, ctx, { message_id: "placeholder", content: "here you go" });
    const row = messagesIn(ctx)[0];
    expect(row.content).toBe("here you go");
    expect(row.agent_status).toBe("done");
    expect(row.updated_at).toBeGreaterThan(5);

    await expect(call(replyAsAnchor, ctx, { message_id: "placeholder", content: "again" }))
      .rejects.toThrow("already finished");
  });

  test("a caller with no claim on the anchor cannot write as the bot", async () => {
    const ctx = context(OUTSIDER, anchorSeed("thinking"));
    await expect(call(replyAsAnchor, ctx, { message_id: "placeholder", content: "hi" }))
      .rejects.toThrow("Not authorized for this anchor");
  });

  test("an ordinary message cannot be overwritten through the reply path", async () => {
    const ctx = context(ALICE);
    const sent = await call(sendMessage, ctx, { channel_id: CHANNEL, content: "mine" });
    await expect(call(replyAsAnchor, ctx, { message_id: sent.message_id, content: "hijacked" }))
      .rejects.toThrow("not an agent reply");
  });

  test("a placeholder whose author is not the anchor's bot is refused", async () => {
    const seed = anchorSeed("thinking");
    seed.chat_messages[0].user_id = ALICE;
    const ctx = context(ALICE, seed);
    await expect(call(replyAsAnchor, ctx, { message_id: "placeholder", content: "hi" }))
      .rejects.toThrow("does not belong to this anchor");
  });
});
