import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { sendMessage } from "./chat";
import { addComment as addConversationComment, mirrorAgentReply } from "./comments";
import { addComment as cliAddTaskComment, webAddComment } from "./tasks";
import { deleteForWeb, submitComments } from "./artifacts";
import { hashToken } from "./apiTokens";
import {
  backfillThreadReads,
  purgeUserTeam,
  taskThreadParticipants,
  touchThread,
} from "./threadReads";
import { dismiss, listMine, markAllRead, markRead, unreadCount } from "./threads";

const ALICE = "user-alice" as any;
const BOB = "user-bob" as any;
const CAROL = "user-carol" as any;
const BOT = "user-bot" as any;
const TEAM = "team-main" as any;
const CHANNEL = "chat_channels_1" as any;
const CONVERSATION = "conversation-main" as any;
const PERSONAL_CONVERSATION = "conversation-personal" as any;
const TASK = "tasks_1" as any;
const TOKEN = "cast-token-alice";

// Every write stamps Date.now(); a monotonic clock keeps "after the mark"
// honest when two writes land inside one millisecond.
const realNow = Date.now;
let tick = 1_000_000;
beforeAll(() => { Date.now = () => ++tick; });
afterAll(() => { Date.now = realNow; });

function users() {
  return [
    { _id: ALICE, name: "Alice", email: "alice@example.test", github_username: "alice" },
    { _id: BOB, name: "Bob", email: "bob@example.test", github_username: "bob" },
    { _id: CAROL, name: "Carol", email: "carol@example.test", github_username: "carol" },
    { _id: BOT, name: "Anchor", is_bot: true, bot_kind: "anchor" },
  ];
}

function conversation(_id: string, extra: Record<string, unknown> = {}) {
  return { _id, user_id: ALICE, is_private: false, team_id: TEAM, status: "active", ...extra };
}

async function context(authenticatedUser: string | null, seed: Record<string, any[]> = {}) {
  const db = makeFakeDb({
    users: users(),
    teams: [{ _id: TEAM, name: "Main", invite_code: "MAIN", created_at: 1, features: { chat: true } }],
    team_memberships: [
      { _id: "m-alice", user_id: ALICE, team_id: TEAM, role: "member" },
      { _id: "m-bob", user_id: BOB, team_id: TEAM, role: "admin" },
      { _id: "m-carol", user_id: CAROL, team_id: TEAM, role: "member" },
      { _id: "m-bot", user_id: BOT, team_id: TEAM, role: "member" },
    ],
    api_tokens: [
      { _id: "tok-alice", user_id: ALICE, token_hash: await hashToken(TOKEN), name: "cli", created_at: 1, last_used_at: 1 },
    ],
    chat_channels: [
      { _id: CHANNEL, team_id: TEAM, name: "general", created_by: ALICE, created_at: 1_000, updated_at: 1_000 },
    ],
    chat_messages: [],
    chat_reads: [],
    chat_channel_members: [],
    thread_reads: [],
    rate_limits: [],
    notifications: [],
    push_outbox: [],
    entity_subscriptions: [],
    user_presence: [],
    anchors: [],
    anchor_channels: [],
    pending_messages: [],
    conversations: [conversation(CONVERSATION), conversation(PERSONAL_CONVERSATION, { team_id: undefined, session_id: "sess-personal" })],
    comments: [],
    messages: [],
    pull_requests: [],
    local_view_heads: [],
    local_command_receipts: [],
    conversation_execution_heads: [],
    execution_bindings: [],
    tasks: [{
      _id: TASK,
      short_id: "ct-1",
      title: "Ship threads",
      status: "open",
      user_id: ALICE,
      assignee: BOB,
      team_id: TEAM,
      workspace: `team:${TEAM}`,
      created_at: 1,
      updated_at: 1,
    }],
    task_comments: [],
    task_history: [],
    change_log: [],
    ...seed,
  });
  const emitted: Array<{ reference: unknown; args: any }> = [];
  const scheduled: Array<{ delay: number; reference: unknown; args: any }> = [];
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
    scheduler: {
      async runAfter(delay: number, reference: unknown, args: any) {
        scheduled.push({ delay, reference, args });
      },
    },
    _emitted: emitted,
    _scheduled: scheduled,
  } as any;
}

const call = (fn: any, ctx: any, args: any) => (fn as any)._handler(ctx, args);
const as = (ctx: any, userId: string) => ({
  ...ctx,
  auth: { async getUserIdentity() { return { subject: `${userId}|session` }; } },
});
const rows = (ctx: any) => ctx.db._tables.thread_reads as any[];
const rowOf = (ctx: any, userId: string, kind: string) =>
  rows(ctx).find((r) => r.user_id === userId && r.kind === kind);
const inbox = (ctx: any, args: any = { team_id: TEAM }) => call(listMine, ctx, args);

describe("touch per kind", () => {
  test("a chat reply files the thread as kind chat, keyed by the root", async () => {
    const ctx = await context(ALICE);
    const root = await call(sendMessage, ctx, { channel_id: CHANNEL, content: "question" });
    await call(sendMessage, as(ctx, BOB), { channel_id: CHANNEL, content: "answer", thread_root_id: root.message_id });
    const view = await inbox(ctx);
    expect(view.entries.length).toBe(1);
    expect(view.entries[0]).toMatchObject({
      _id: `chat:${root.message_id}`,
      kind: "chat",
      root_key: String(root.message_id),
      channel_id: CHANNEL,
      team_id: TEAM,
      unread: 1,
    });
    expect(view.entries[0].last_reply.preview).toBe("answer");
    expect(view.entries[0].last_reply.author_name).toBe("Bob");
    expect(view.payload.chat.roots[0].content).toBe("question");
    expect(view.payload.chat.threads[0].reply_count).toBe(1);
    // The bot never gets a row.
    expect(rowOf(ctx, BOT, "chat")).toBeUndefined();
  });

  test("a comment files its anchor thread for the owner; the commenter's copy is read", async () => {
    const ctx = await context(ALICE);
    const bob = as(ctx, BOB);
    await call(addConversationComment, bob, { conversation_id: CONVERSATION, content: "looks off" });
    const alice = await inbox(ctx);
    expect(alice.entries.length).toBe(1);
    expect(alice.entries[0]).toMatchObject({
      _id: `comment:${CONVERSATION}:global`,
      kind: "comment",
      conversation_id: CONVERSATION,
      team_id: TEAM,
      unread: 1,
    });
    expect(alice.entries[0].last_reply.preview).toBe("looks off");
    expect(alice.payload.comments[0]).toMatchObject({ content: "looks off", user: { name: "Bob" } });
    expect((await inbox(bob)).entries[0].unread).toBe(0);
    // A message anchor is its own thread.
    ctx.db._tables.messages.push({ _id: "messages_1", conversation_id: CONVERSATION, role: "assistant", content: "hi", timestamp: 1 });
    await call(addConversationComment, bob, { conversation_id: CONVERSATION, content: "on this line", message_id: "messages_1" });
    const again = await inbox(ctx);
    expect(again.entries.map((e: any) => e._id)).toEqual([
      `comment:${CONVERSATION}:msg:messages_1`,
      `comment:${CONVERSATION}:global`,
    ]);
    expect(again.entries[0].message_id).toBe("messages_1");
  });

  test("a mention in a comment starts following the thread", async () => {
    const ctx = await context(ALICE);
    await call(addConversationComment, as(ctx, BOB), { conversation_id: CONVERSATION, content: "ask @carol" });
    const carol = await inbox(as(ctx, CAROL));
    expect(carol.entries.length).toBe(1);
    expect(carol.entries[0].unread).toBe(1);
  });

  test("the agent's landed answer has no actor: the asker sees it unread, stamped at landing", async () => {
    const forkId = "conversation-fork" as any;
    const ctx = await context(ALICE, {
      conversations: [
        conversation(CONVERSATION),
        conversation(forkId, {
          comment_fork_parent: CONVERSATION,
          comment_fork_comment_id: "comment-agent",
          comment_fork_prompt_at: 5,
        }),
      ],
      comments: [{
        _id: "comment-agent",
        conversation_id: CONVERSATION,
        user_id: ALICE,
        content: "",
        created_at: 1,
        author_kind: "agent",
        agent_status: "thinking",
        fork_conversation_id: forkId,
      }],
      messages: [{ _id: "message-reply", conversation_id: forkId, role: "assistant", content: "The answer", timestamp: 10 }],
    });
    // The placeholder alone files nothing.
    expect((await inbox(ctx)).entries).toEqual([]);
    await call(mirrorAgentReply, ctx, { fork_conversation_id: forkId });
    const comment = ctx.db._tables.comments[0];
    expect(comment.agent_status).toBe("done");
    expect(comment.created_at).toBeGreaterThan(1);
    const view = await inbox(ctx);
    expect(view.entries.length).toBe(1);
    // Alice's own user_id is on the row, but it is the agent's reply: news.
    expect(view.entries[0].unread).toBe(1);
    expect(view.entries[0].last_activity_at).toBe(comment.created_at);
    expect(view.entries[0].last_reply).toMatchObject({ author_kind: "agent", preview: "The answer" });
  });

  test("a task comment files the task for its creator and assignee; the writer's copy is read", async () => {
    const ctx = await context(ALICE);
    await call(webAddComment, as(ctx, BOB), { short_id: "ct-1", text: "started on it" });
    const alice = await inbox(ctx);
    expect(alice.entries.length).toBe(1);
    expect(alice.entries[0]).toMatchObject({ _id: `task:${TASK}`, kind: "task", task_id: TASK, team_id: TEAM, unread: 1 });
    expect(alice.entries[0].last_reply).toMatchObject({ author_name: "Bob", author_kind: "user", preview: "started on it" });
    expect(alice.payload.tasks[0]).toMatchObject({ _id: TASK, short_id: "ct-1" });
    expect(alice.payload.tasks[0].comments[0]).toMatchObject({ text: "started on it", author_user_id: BOB });
    expect((await inbox(as(ctx, BOB))).entries[0].unread).toBe(0);
  });

  test("a CLI task comment by hand is the writer's; one from inside a session is an agent's", async () => {
    const ctx = await context(null);
    await call(cliAddTaskComment, ctx, { api_token: TOKEN, short_id: "ct-1", text: "by hand" });
    expect((await inbox(as(ctx, ALICE))).entries[0].unread).toBe(0);
    expect(ctx.db._tables.task_comments[0].author_user_id).toBe(ALICE);

    await call(cliAddTaskComment, ctx, {
      api_token: TOKEN, short_id: "ct-1", text: "from a session", conversation_id: "sess-personal",
    });
    expect(ctx.db._tables.task_comments[1].author_user_id).toBeUndefined();
    const view = await inbox(as(ctx, ALICE));
    expect(view.entries[0].unread).toBe(1);
    expect(view.entries[0].last_reply).toMatchObject({ author_kind: "agent", author_name: "Alice", preview: "from a session" });
  });

  test("marks move forward only", async () => {
    const ctx = await context(ALICE);
    const base = { kind: "task" as const, rootKey: String(TASK), teamId: TEAM, refs: { task_id: TASK }, participants: [ALICE, BOB] };
    await touchThread(ctx, { ...base, actorId: BOB, activityAt: 500 });
    await touchThread(ctx, { ...base, actorId: BOB, activityAt: 400 });
    expect(rowOf(ctx, ALICE, "task")).toMatchObject({ last_activity_at: 500, last_read_at: 0 });
    expect(rowOf(ctx, BOB, "task")).toMatchObject({ last_activity_at: 500, last_read_at: 500 });
  });
});

describe("task thread membership: earned by a human act, never by identity", () => {
  const AGENT_TASK = "tasks_agent" as any;
  const HUMAN_TASK = "tasks_human" as any;
  const sub = (_id: string, user_id: any, entity_id: any, reason: string, via?: string) =>
    ({ _id, user_id, entity_type: "task", entity_id: String(entity_id), reason, muted: false, created_at: 1, ...(via ? { via } : {}) });
  const task = (_id: any, extra: Record<string, unknown>) => ({
    _id, short_id: String(_id), title: "t", status: "open", user_id: ALICE, team_id: TEAM,
    workspace: `team:${TEAM}`, created_at: 1, updated_at: 1, ...extra,
  });
  const members = async (ctx: any, id: any) =>
    (await taskThreadParticipants(ctx, ctx.db._tables.tasks.find((t: any) => t._id === id))).sort();

  test("an agent's self-claim for its owner enrolls nobody; the same task filed by a person enrolls the owner", async () => {
    const ctx = await context(ALICE, {
      tasks: [
        task(AGENT_TASK, { source: "agent", assignee: ALICE }),
        task(HUMAN_TASK, { source: "human", assignee: ALICE }),
      ],
      entity_subscriptions: [
        sub("s1", ALICE, AGENT_TASK, "creator", "agent"),
        sub("s2", ALICE, AGENT_TASK, "assignee", "agent"),
        sub("s3", ALICE, HUMAN_TASK, "creator", "human"),
      ],
    });
    expect(await members(ctx, AGENT_TASK)).toEqual([]);
    expect(await members(ctx, HUMAN_TASK)).toEqual([ALICE]);
  });

  test("the owner earns membership through a human act: a creator or assignee row via human on an agent task", async () => {
    const ctx = await context(ALICE, {
      tasks: [task(AGENT_TASK, { source: "plan_mode", assignee: ALICE }), task(HUMAN_TASK, { source: "agent", assignee: ALICE })],
      entity_subscriptions: [
        sub("s1", ALICE, AGENT_TASK, "creator", "human"),
        sub("s2", ALICE, HUMAN_TASK, "creator", "agent"),
        sub("s3", ALICE, HUMAN_TASK, "assignee", "human"),
      ],
    });
    expect(await members(ctx, AGENT_TASK)).toEqual([ALICE]);
    expect(await members(ctx, HUMAN_TASK)).toEqual([ALICE]);
  });

  test("a promoted agent task is a human task: identity enrolls", async () => {
    const ctx = await context(ALICE, {
      tasks: [task(AGENT_TASK, { source: "agent", promoted: true, assignee: ALICE })],
      entity_subscriptions: [sub("s1", ALICE, AGENT_TASK, "creator", "agent")],
    });
    expect(await members(ctx, AGENT_TASK)).toEqual([ALICE]);
  });

  test("an agent task assigned to a different person enrolls that person, not the owner", async () => {
    const ctx = await context(ALICE, {
      tasks: [task(AGENT_TASK, { source: "agent", assignee: BOB })],
      entity_subscriptions: [
        sub("s1", ALICE, AGENT_TASK, "creator", "agent"),
        sub("s2", BOB, AGENT_TASK, "assignee", "agent"),
      ],
    });
    expect(await members(ctx, AGENT_TASK)).toEqual([BOB]);
  });

  test("commenters: via human enrolls, via agent never, a legacy row only on a human task; mentioned always", async () => {
    const ctx = await context(ALICE, {
      tasks: [task(AGENT_TASK, { source: "agent" }), task(HUMAN_TASK, { source: "human" })],
      entity_subscriptions: [
        sub("s1", ALICE, AGENT_TASK, "creator", "agent"),
        sub("s2", BOB, AGENT_TASK, "commenter", "agent"),
        sub("s3", CAROL, AGENT_TASK, "commenter"),
        sub("s4", BOB, HUMAN_TASK, "commenter", "agent"),
        sub("s5", CAROL, HUMAN_TASK, "commenter"),
      ],
    });
    expect(await members(ctx, AGENT_TASK)).toEqual([]);
    expect(await members(ctx, HUMAN_TASK)).toEqual([ALICE, CAROL].sort());

    ctx.db._tables.entity_subscriptions.push(sub("s6", BOB, AGENT_TASK, "commenter", "human"));
    ctx.db._tables.entity_subscriptions.push(sub("s7", CAROL, AGENT_TASK, "mentioned", "agent"));
    expect(await members(ctx, AGENT_TASK)).toEqual([BOB, CAROL].sort());
  });

  test("the inbox drops a row the rule no longer earns, but never the viewer's own touched row", async () => {
    const ctx = await context(ALICE, {
      tasks: [task(AGENT_TASK, { source: "agent", assignee: ALICE })],
      entity_subscriptions: [sub("s1", ALICE, AGENT_TASK, "creator", "agent")],
      task_comments: [
        { _id: "tc-1", task_id: AGENT_TASK, author: "Claude", text: "claimed", comment_type: "note", created_at: 100 },
      ],
    });
    // Filed under the old identity rule: owner of an agent task.
    await touchThread(ctx, {
      kind: "task", rootKey: String(AGENT_TASK), teamId: TEAM, refs: { task_id: AGENT_TASK },
      participants: [ALICE], activityAt: 100,
    });
    expect(rowOf(ctx, ALICE, "task")).toMatchObject({ last_read_at: 0 });
    expect((await inbox(ctx)).entries).toEqual([]);
    expect(await call(unreadCount, ctx, { team_id: TEAM })).toBe(0);

    // Alice writes in the thread by hand: her row is hers to keep. An agent
    // reply after that reaches her as unread.
    await call(webAddComment, ctx, { short_id: String(AGENT_TASK), text: "looks right" });
    expect((await inbox(ctx)).entries.map((e: any) => e._id)).toEqual([`task:${AGENT_TASK}`]);
    ctx.db._tables.entity_subscriptions = ctx.db._tables.entity_subscriptions.filter((s: any) => s.via !== "human");
    expect((await inbox(ctx)).entries.map((e: any) => e._id)).toEqual([`task:${AGENT_TASK}`]);
    expect((await inbox(ctx)).entries[0].unread).toBe(0);
  });

  test("a mute denies every leg: the owner of a human task, the assignee field, and the wrote-in-thread backstop", async () => {
    const mutedSub = (_id: string, user_id: any, entity_id: any) =>
      ({ ...sub(_id, user_id, entity_id, "watching"), muted: true });
    const ctx = await context(ALICE, {
      tasks: [task(HUMAN_TASK, { source: "human", assignee: BOB })],
      entity_subscriptions: [
        mutedSub("s1", ALICE, HUMAN_TASK),
        mutedSub("s2", BOB, HUMAN_TASK),
      ],
      task_comments: [
        // Alice wrote in the thread herself — the backstop that normally keeps
        // a row hers. A handoff mute beats it.
        { _id: "tc-1", task_id: HUMAN_TASK, author: "Alice", author_user_id: ALICE, text: "handing off", comment_type: "note", created_at: 100 },
      ],
    });
    expect(await members(ctx, HUMAN_TASK)).toEqual([]);
    await touchThread(ctx, {
      kind: "task", rootKey: String(HUMAN_TASK), teamId: TEAM, refs: { task_id: HUMAN_TASK },
      participants: [ALICE], activityAt: 100,
    });
    expect((await inbox(ctx)).entries).toEqual([]);
    expect(await call(unreadCount, ctx, { team_id: TEAM })).toBe(0);
  });
});

describe("dismiss", () => {
  test("dismiss archives the caller's row; the next reply files a fresh one", async () => {
    const ctx = await context(ALICE);
    await call(cliAddTaskComment, ctx, { api_token: TOKEN, short_id: "ct-1", text: "status", conversation_id: "sess-personal" });
    expect(rowOf(ctx, ALICE, "task")).toBeTruthy();

    await call(dismiss, ctx, { kind: "task", root_key: String(TASK) });
    expect(rowOf(ctx, ALICE, "task")).toBeUndefined();
    // Bob's follow is untouched: a dismiss is one person's triage.
    expect(rowOf(ctx, BOB, "task")).toBeTruthy();

    await call(cliAddTaskComment, ctx, { api_token: TOKEN, short_id: "ct-1", text: "more", conversation_id: "sess-personal" });
    expect(rowOf(ctx, ALICE, "task")).toMatchObject({ last_read_at: 0 });
  });
});

describe("listMine and unreadCount", () => {
  test("a row whose entity the viewer can no longer see is dropped and not counted", async () => {
    const ctx = await context(ALICE);
    const bob = as(ctx, BOB);
    await call(addConversationComment, bob, { conversation_id: CONVERSATION, content: "hey" });
    await call(addConversationComment, as(ctx, ALICE), { conversation_id: CONVERSATION, content: "hey back" });
    expect((await inbox(bob)).entries.length).toBe(1);
    expect(await call(unreadCount, bob, { team_id: TEAM })).toBe(1);
    // Alice locks the conversation private: Bob's row stays, but his inbox
    // and badge no longer show it.
    const conv = ctx.db._tables.conversations.find((c: any) => c._id === CONVERSATION);
    conv.is_private = true;
    conv.team_visibility = undefined;
    expect((await inbox(bob)).entries).toEqual([]);
    expect(await call(unreadCount, bob, { team_id: TEAM })).toBe(0);
    expect(rowOf(ctx, BOB, "comment")).toBeDefined();

    // The same for a task the viewer was taken off.
    await call(webAddComment, as(ctx, ALICE), { short_id: "ct-1", text: "note" });
    expect((await inbox(bob)).entries.map((e: any) => e.kind)).toEqual(["task"]);
    const task = ctx.db._tables.tasks[0];
    task.assignee = undefined;
    task.workspace = `user:${ALICE}`;
    expect((await inbox(bob)).entries).toEqual([]);
  });

  test("the personal inbox is its own scope: no team_id on the row, none in the query", async () => {
    const ctx = await context(ALICE);
    await call(addConversationComment, ctx, { conversation_id: PERSONAL_CONVERSATION, content: "note to self" });
    expect(rowOf(ctx, ALICE, "comment").team_id).toBeUndefined();
    expect((await inbox(ctx, {})).entries.map((e: any) => e._id)).toEqual([`comment:${PERSONAL_CONVERSATION}:global`]);
    expect((await inbox(ctx, { team_id: TEAM })).entries).toEqual([]);
    expect(await call(unreadCount, ctx, {})).toBe(0);
  });

  test("unread rules: own rows never count, agent rows always do, placeholders never do", async () => {
    const ctx = await context(ALICE);
    const bob = as(ctx, BOB);
    await call(addConversationComment, bob, { conversation_id: CONVERSATION, content: "one" });
    await call(addConversationComment, bob, { conversation_id: CONVERSATION, content: "two" });
    expect((await inbox(ctx)).entries[0].unread).toBe(2);
    // Alice replies: posting is reading, and her own row never counts.
    await call(addConversationComment, ctx, { conversation_id: CONVERSATION, content: "three" });
    expect((await inbox(ctx)).entries[0].unread).toBe(0);
    expect((await inbox(bob)).entries[0].unread).toBe(1);
    // A thinking placeholder under Alice's name is not a reply yet.
    ctx.db._tables.comments.push({
      _id: "comment-thinking", conversation_id: CONVERSATION, user_id: ALICE, content: "",
      created_at: Date.now(), author_kind: "agent", agent_status: "thinking",
    });
    expect((await inbox(bob)).entries[0].unread).toBe(1);
    expect((await inbox(ctx)).entries[0].unread).toBe(0);
  });

  test("pages newest activity first with a cursor", async () => {
    const ctx = await context(ALICE);
    const bob = as(ctx, BOB);
    await call(addConversationComment, bob, { conversation_id: CONVERSATION, content: "comment" });
    await call(webAddComment, bob, { short_id: "ct-1", text: "task" });
    const root = await call(sendMessage, ctx, { channel_id: CHANNEL, content: "root" });
    await call(sendMessage, bob, { channel_id: CHANNEL, content: "reply", thread_root_id: root.message_id });
    const first = await inbox(ctx, { team_id: TEAM, limit: 2 });
    expect(first.entries.map((e: any) => e.kind)).toEqual(["chat", "task"]);
    expect(first.has_more).toBe(true);
    const second = await inbox(ctx, { team_id: TEAM, limit: 2, cursor: first.next_cursor });
    expect(second.entries.map((e: any) => e.kind)).toEqual(["comment"]);
    expect(second.has_more).toBe(false);
    expect(await call(unreadCount, ctx, { team_id: TEAM })).toBe(3);
  });
});

describe("markRead and markAllRead", () => {
  test("markRead clamps to the newest counted row, forward only; the next reply raises it again", async () => {
    const ctx = await context(ALICE);
    const bob = as(ctx, BOB);
    await call(webAddComment, bob, { short_id: "ct-1", text: "one" });
    // A system row lands after the activity mark was written (no touch): the
    // mark must still clear past it.
    ctx.db._tables.task_comments.push({
      _id: "task_comments_sys", task_id: TASK, author: "system", text: "blocked", comment_type: "blocker",
      created_at: Date.now(),
    });
    expect((await inbox(ctx)).entries[0].unread).toBe(2);
    const marked = await call(markRead, ctx, { kind: "task", root_key: String(TASK) });
    expect(marked.last_read_at).toBe(ctx.db._tables.task_comments[1].created_at);
    expect((await inbox(ctx)).entries[0].unread).toBe(0);
    // A second mark never moves it back.
    const again = await call(markRead, ctx, { kind: "task", root_key: String(TASK) });
    expect(again.last_read_at).toBe(marked.last_read_at);
    await call(webAddComment, bob, { short_id: "ct-1", text: "two" });
    expect((await inbox(ctx)).entries[0].unread).toBe(1);
    // A row the caller does not have is a no-op, not an error.
    expect(await call(markRead, ctx, { kind: "comment", root_key: "nope:global" })).toMatchObject({ last_read_at: null });
  });

  test("markAllRead sweeps the scope, optionally one kind", async () => {
    const ctx = await context(ALICE);
    const bob = as(ctx, BOB);
    await call(addConversationComment, bob, { conversation_id: CONVERSATION, content: "comment" });
    await call(webAddComment, bob, { short_id: "ct-1", text: "task" });
    expect(await call(unreadCount, ctx, { team_id: TEAM })).toBe(2);
    expect(await call(markAllRead, ctx, { team_id: TEAM, kind: "task" })).toEqual({ marked: 1 });
    expect((await inbox(ctx)).entries.map((e: any) => [e.kind, e.unread])).toEqual([["task", 0], ["comment", 1]]);
    expect(await call(markAllRead, ctx, { team_id: TEAM })).toEqual({ marked: 1 });
    expect(await call(unreadCount, ctx, { team_id: TEAM })).toBe(0);
  });
});

describe("purge", () => {
  test("leaving the team removes every kind of follow for that member only", async () => {
    const ctx = await context(ALICE);
    const bob = as(ctx, BOB);
    await call(addConversationComment, bob, { conversation_id: CONVERSATION, content: "comment" });
    await call(webAddComment, bob, { short_id: "ct-1", text: "task" });
    await call(addConversationComment, ctx, { conversation_id: PERSONAL_CONVERSATION, content: "mine" });
    expect(await purgeUserTeam(ctx, ALICE, TEAM)).toBe(2);
    expect(rows(ctx).filter((r) => r.user_id === ALICE).map((r) => r.team_id)).toEqual([undefined]);
    expect(rows(ctx).filter((r) => r.user_id === BOB).length).toBe(2);
  });
});

describe("migration and backfill", () => {
  test("the comment backfill seeds every thread READ for its authors and the owner", async () => {
    const ctx = await context(ALICE, {
      comments: [
        { _id: "c-1", conversation_id: CONVERSATION, user_id: BOB, content: "old", created_at: 100 },
        { _id: "c-2", conversation_id: CONVERSATION, user_id: CAROL, content: "older reply", created_at: 200, message_id: "messages_1" },
        { _id: "c-3", conversation_id: CONVERSATION, user_id: ALICE, content: "", created_at: 300, author_kind: "agent", agent_status: "thinking" },
      ],
    });
    expect(await call(backfillThreadReads, ctx, { kind: "comment" })).toMatchObject({ scanned: 3, done: true });
    const keys = (userId: string) => rows(ctx).filter((r) => r.user_id === userId).map((r) => r.root_key).sort();
    expect(keys(ALICE)).toEqual([`${CONVERSATION}:global`, `${CONVERSATION}:msg:messages_1`]);
    expect(keys(BOB)).toEqual([`${CONVERSATION}:global`]);
    expect(keys(CAROL)).toEqual([`${CONVERSATION}:msg:messages_1`]);
    for (const r of rows(ctx)) expect(r.last_read_at).toBe(r.last_activity_at);
    expect(await call(unreadCount, ctx, { team_id: TEAM })).toBe(0);
    // Re-running changes nothing.
    const before = rows(ctx).length;
    await call(backfillThreadReads, ctx, { kind: "comment" });
    expect(rows(ctx).length).toBe(before);
  });

  test("the task backfill seeds subscribers, creator and assignee READ; muted and watching rows do not follow", async () => {
    const ctx = await context(ALICE, {
      task_comments: [
        { _id: "tc-1", task_id: TASK, author: "cast", text: "old", comment_type: "note", created_at: 100 },
        { _id: "tc-2", task_id: TASK, author: "Bob", author_user_id: BOB, text: "older", comment_type: "note", created_at: 200 },
      ],
      entity_subscriptions: [
        { _id: "es-1", user_id: CAROL, entity_type: "task", entity_id: String(TASK), reason: "mentioned", muted: false, created_at: 1 },
        { _id: "es-2", user_id: BOT, entity_type: "task", entity_id: String(TASK), reason: "commenter", muted: false, created_at: 1 },
      ],
    });
    expect(await call(backfillThreadReads, ctx, { kind: "task" })).toMatchObject({ scanned: 2, done: true });
    expect(rows(ctx).map((r) => r.user_id).sort()).toEqual([ALICE, BOB, CAROL].sort());
    for (const r of rows(ctx)) {
      expect(r).toMatchObject({ kind: "task", root_key: String(TASK), task_id: TASK, team_id: TEAM, last_activity_at: 200, last_read_at: 200 });
    }
    expect((await inbox(ctx)).entries[0].unread).toBe(0);
  });

  test("a long source reschedules itself with the page cursor", async () => {
    const comments = Array.from({ length: 401 }, (_, i) => ({
      _id: `c-${i}`, conversation_id: CONVERSATION, user_id: BOB, content: "x", created_at: i + 1,
    }));
    const ctx = await context(ALICE, { comments });
    const result = await call(backfillThreadReads, ctx, { kind: "comment" });
    expect(result).toMatchObject({ scanned: 400, done: false });
    expect(ctx._scheduled[0].args).toMatchObject({ kind: "comment", cursor: "400" });
  });
});

// ── page kind: published page discussions (artifact_comments) ───────────────

const ARTIFACT = "artifacts_9" as any;

function pageSeed(extra: Record<string, any[]> = {}) {
  return {
    artifacts: [{
      _id: ARTIFACT, slug: "weekly-report", title: "Weekly report", user_id: ALICE,
      storage_id: "storage-1", version: 1, size: 10, created_at: 1, updated_at: 1,
    }],
    artifact_comments: [],
    artifact_identities: [
      { _id: "ai-bob", token: "page-token-bob", artifact_id: ARTIFACT, user_id: BOB, created_at: 1 },
      { _id: "ai-carol", token: "page-token-carol", artifact_id: ARTIFACT, user_id: CAROL, created_at: 1 },
    ],
    ...extra,
  };
}

const submitPageComment = (ctx: any, o: { token?: string; name?: string; text: string }) =>
  call(submitComments, ctx, {
    slug: "weekly-report",
    author_name: o.name ?? "someone",
    version: 1,
    identity_token: o.token,
    comments: [{ text: o.text }],
  });

describe("page kind", () => {
  test("a signed-in comment files the page for owner and commenter; the commenter's copy is read", async () => {
    const ctx = await context(ALICE, pageSeed());
    await submitPageComment(ctx, { token: "page-token-bob", text: "chart looks off" });
    // Pages have no team: they land in the personal inbox scope.
    const alice = await inbox(ctx, {});
    expect(alice.entries.length).toBe(1);
    expect(alice.entries[0]).toMatchObject({
      _id: `page:${ARTIFACT}`,
      kind: "page",
      root_key: String(ARTIFACT),
      artifact_id: ARTIFACT,
      unread: 1,
    });
    expect(alice.entries[0].team_id).toBeUndefined();
    expect(alice.entries[0].last_reply).toMatchObject({ author_name: "Bob", preview: "chart looks off" });
    expect(alice.payload.pages[0]).toMatchObject({ _id: ARTIFACT, slug: "weekly-report", title: "Weekly report" });
    expect(alice.payload.pages[0].comments[0]).toMatchObject({ text: "chart looks off", author_user_id: BOB });
    // The payload never ships commenter emails, and never the artifact's keys.
    expect("author_email" in alice.payload.pages[0].comments[0]).toBe(false);
    expect("owner_key" in alice.payload.pages[0]).toBe(false);
    expect(await call(unreadCount, ctx, {})).toBe(1);
    expect((await inbox(as(ctx, BOB), {})).entries[0].unread).toBe(0);
  });

  test("an anonymous comment has no actor: everyone, owner included, sees it unread", async () => {
    const ctx = await context(ALICE, pageSeed());
    await submitPageComment(ctx, { token: "page-token-bob", text: "first" });
    await call(markRead, ctx, { kind: "page", root_key: String(ARTIFACT) });
    // The page is an opaque origin: an anonymous viewer carries no session.
    const anon = { ...ctx, auth: { async getUserIdentity() { return null; } } };
    await submitPageComment(anon, { name: "drive-by", text: "anonymous take" });
    // No account, no row: only Alice and Bob follow the page.
    expect(rows(ctx).filter((r) => r.kind === "page").map((r) => r.user_id).sort()).toEqual([ALICE, BOB].sort());
    const alice = await inbox(ctx, {});
    expect(alice.entries[0].unread).toBe(1);
    expect(alice.entries[0].last_reply).toMatchObject({ author_name: "drive-by", preview: "anonymous take" });
    expect(alice.entries[0].last_reply.user_id).toBeUndefined();
    // Bob wrote the first comment himself: only the anonymous one is news.
    expect((await inbox(as(ctx, BOB), {})).entries[0].unread).toBe(1);
  });

  test("access is owner or commenter: a mentioned teammate is filed but sees nothing until they comment", async () => {
    const ctx = await context(ALICE, pageSeed());
    await submitPageComment(ctx, { token: "page-token-bob", text: "ping @carol" });
    // The mention filed Carol's row, but she has not commented: dropped.
    expect(rowOf(ctx, CAROL, "page")).toBeDefined();
    expect((await inbox(as(ctx, CAROL), {})).entries).toEqual([]);
    expect(await call(unreadCount, as(ctx, CAROL), {})).toBe(0);
    // Her first comment opens it.
    await submitPageComment(ctx, { token: "page-token-carol", text: "on it" });
    expect((await inbox(as(ctx, CAROL), {})).entries[0].unread).toBe(0);
    expect((await inbox(ctx, {})).entries[0].unread).toBe(2);
  });

  test("the page backfill seeds owner and verified commenters READ", async () => {
    const ctx = await context(ALICE, pageSeed({
      artifact_comments: [
        { _id: "ac-1", artifact_id: ARTIFACT, batch_id: "b1", author_name: "drive-by", text: "old", version: 1, status: "open", delivered: false, created_at: 100 },
        { _id: "ac-2", artifact_id: ARTIFACT, batch_id: "b2", author_name: "Bob", author_user_id: BOB, text: "older", version: 1, status: "open", delivered: false, created_at: 200 },
      ],
    }));
    expect(await call(backfillThreadReads, ctx, { kind: "page" })).toMatchObject({ scanned: 2, done: true });
    expect(rows(ctx).map((r) => r.user_id).sort()).toEqual([ALICE, BOB].sort());
    for (const r of rows(ctx)) {
      expect(r).toMatchObject({ kind: "page", root_key: String(ARTIFACT), artifact_id: ARTIFACT, last_activity_at: 200, last_read_at: 200 });
      expect(r.team_id).toBeUndefined();
    }
    expect(await call(unreadCount, ctx, {})).toBe(0);
    // Re-running changes nothing.
    const before = rows(ctx).length;
    await call(backfillThreadReads, ctx, { kind: "page" });
    expect(rows(ctx).length).toBe(before);
  });

  test("a signed-in web caller needs no identity token, and a client_id retry never double-posts", async () => {
    const ctx = await context(ALICE, pageSeed());
    const bob = as(ctx, BOB);
    const reply = (clientId: string) => call(submitComments, bob, {
      artifact_id: ARTIFACT,
      author_name: "",
      client_id: clientId,
      comments: [{ text: "from the web" }],
    });
    const first = await reply("cl-1");
    expect(first.count).toBe(1);
    // Session auth resolved Bob; version defaulted to the artifact's.
    expect(ctx.db._tables.artifact_comments[0]).toMatchObject({
      author_user_id: BOB, author_name: "Bob", client_id: "cl-1", version: 1,
    });
    // The outbox retries: same row back, no twin, no second touch.
    const retry = await reply("cl-1");
    expect(retry.ids).toEqual(first.ids);
    expect(ctx.db._tables.artifact_comments.length).toBe(1);
    expect((await inbox(ctx, {})).entries[0].unread).toBe(1);
  });

  test("deleting the page purges every follow of its discussion", async () => {
    const ctx = await context(ALICE, pageSeed());
    await submitPageComment(ctx, { token: "page-token-bob", text: "hello" });
    expect(rows(ctx).filter((r) => r.kind === "page").length).toBe(2);
    const withStorage = { ...ctx, storage: { async delete() {} } };
    expect(await call(deleteForWeb, withStorage, { slug: "weekly-report" })).toEqual({ ok: true });
    expect(rows(ctx).filter((r) => r.kind === "page")).toEqual([]);
  });
});
