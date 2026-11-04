// Conversation comments live in review_comments (ct-70907, sd-2422): every
// write path lands there and nothing writes `comments`, comments written
// before the move keep their ids, and no other reader of review_comments
// sees a conversation comment.
import { describe, expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import {
  addComment,
  addCommentV2,
  askAgentInThreadV2,
  deleteComment,
  deleteCommentV2,
  getConversationCommentSummary,
  mirrorAgentReply,
  resolveThread,
  updateComment,
  updateCommentV2,
  updateGitHubCommentId,
} from "./comments";
import { conversationComments } from "./commentTwins";
import { legacyCommentRow, storedComments } from "./testComments";
import { applyPatches } from "./dispatch";
import { mergeDuplicateUser } from "./admin_mergeUser";
import { purgeConversationRows } from "./sessionDelete";
import {
  canAccessComment,
  codeThreadRows,
  listForConversation,
  listForFile,
  listForPR,
  listForRef,
  pendingRowsFor,
  resolve as resolveCodeComment,
  update as updateCodeComment,
} from "./codeComments";
import { get as getNote, list as listNotes, overduePromises } from "./reviewNotes";
import { markAnsweredReviewNotes } from "./lib/reviewAnswered";
import { listForConversation as listQuotes } from "./quoteDrafts";
import { listMine, unreadCount } from "./threads";
import { processReviewCommentEvent } from "./githubWebhooks";

const OWNER = "user_owner" as any;
const MEMBER = "user_member" as any;
const STRANGER = "user_stranger" as any;
const TEAM = "team_1" as any;
const CONV = "conv_1" as any;
const MSG = "msg_1" as any;
const PR = "pr_1" as any;
const REPO = "codecast-sh/codecast";
const HEAD = "abcdef1234567890abcdef1234567890abcdef12";

function context(user: string | null, seed: Record<string, any[]> = {}, opts: { runMutation?: (ref: unknown, args: any) => Promise<unknown> } = {}) {
  const db = makeFakeDb({
    users: [
      { _id: OWNER, name: "Owner", email: "owner@x.test", github_username: "owner" },
      { _id: MEMBER, name: "Member", email: "member@x.test" },
      { _id: STRANGER, name: "Stranger", email: "stranger@x.test" },
    ],
    teams: [{ _id: TEAM, name: "Codecast" }],
    team_memberships: [
      { _id: "m1", user_id: OWNER, team_id: TEAM, visibility: "summary" },
      { _id: "m2", user_id: MEMBER, team_id: TEAM, visibility: "summary" },
    ],
    conversations: [
      { _id: CONV, user_id: OWNER, team_id: TEAM, is_private: false, team_visibility: "full", status: "active", title: "Sync", updated_at: 1 },
    ],
    messages: [{ _id: MSG, conversation_id: CONV, role: "assistant", content: "Plan: rewrite the sync layer.", timestamp: 1 }],
    pull_requests: [
      { _id: PR, team_id: TEAM, repository: REPO, number: 12, title: "PR", state: "open", head_sha: HEAD, linked_session_ids: [CONV], created_at: 1, updated_at: 2 },
    ],
    pull_request_sessions: [{ _id: "prs_1", pull_request_id: PR, conversation_id: CONV }],
    github_app_installations: [
      { _id: "inst_1", team_id: TEAM, installation_id: 7, account_login: "codecast-sh", repository_selection: "all" },
    ],
    comments: [],
    review_comments: [],
    thread_reads: [],
    local_view_heads: [],
    local_command_receipts: [],
    pending_messages: [],
    conversation_execution_heads: [],
    execution_bindings: [],
    managed_sessions: [],
    directory_team_mappings: [],
    session_owners: [],
    collab_grants: [],
    change_log: [],
    ...seed,
  });
  const scheduled: Array<{ reference: unknown; args: any }> = [];
  return {
    db,
    auth: { async getUserIdentity() { return user ? { subject: `${user}|session` } : null; } },
    async runMutation(reference: unknown, args: any) {
      return opts.runMutation ? await opts.runMutation(reference, args) : undefined;
    },
    scheduler: { async runAfter(_delay: number, reference: unknown, args: any) { scheduled.push({ reference, args }); } },
    _scheduled: scheduled,
  } as any;
}

const as = (ctx: any, user: string) => ({ ...ctx, auth: { async getUserIdentity() { return { subject: `${user}|session` }; } } });
const stored = (ctx: any) => storedComments(ctx.db);
const rowOf = (ctx: any, id: string) => (ctx.db._tables.review_comments as any[]).find((r) => r._id === id || r.source_comment_id === id);
const legacyTable = (ctx: any) => ctx.db._tables.comments as any[];

async function add(ctx: any, over: Record<string, any> = {}) {
  const result = await (addCommentV2 as any)._handler(ctx, {
    command_id: `cmd-${Math.random()}`,
    conversation_id: CONV,
    content: "Why rewrite it?",
    client_id: `client-${Math.random()}`,
    ...over,
  });
  expect(result.status).toBe("acknowledged");
  return result.result.commentId as string;
}

/** A comment written before the move: a `comments` row and its twin. */
function legacy(id: string, over: Record<string, any> = {}) {
  const comment = { _id: id, conversation_id: CONV, user_id: OWNER, content: `old ${id}`, created_at: 1, ...over };
  return { comment, twin: legacyCommentRow(`rc_${id}`, comment) };
}

describe("every write path lands in review_comments and nothing writes comments", () => {
  test("create (V1 and V2) writes one review_comments row and goes by its id; a client_id replay writes nothing", async () => {
    const ctx = context(OWNER);
    const v1 = await (addComment as any)._handler(ctx, { conversation_id: CONV, message_id: MSG, content: "legacy api" });
    const args = { command_id: "c-1", conversation_id: CONV, content: "on a line", file_path: "src/a.ts", line_number: 4, anchor_lines: { before: [], lines: ["x"], after: [] }, client_id: "cl-1" };
    const first = await (addCommentV2 as any)._handler(ctx, args);
    const replay = await (addCommentV2 as any)._handler(ctx, { ...args, command_id: "c-2" });
    expect(replay.result.commentId).toBe(first.result.commentId);
    expect(legacyTable(ctx)).toEqual([]);
    expect(ctx.db._tables.review_comments).toHaveLength(2);
    expect(rowOf(ctx, v1)).toMatchObject({ _id: v1, origin: "comment", content: "legacy api", message_id: MSG, author_user_id: OWNER, resolved: false });
    expect(rowOf(ctx, first.result.commentId)).toMatchObject({ origin: "comment", file_path: "src/a.ts", line_number: 4, client_id: "cl-1" });
    expect(stored(ctx).map((c) => c._id).sort()).toEqual([v1, first.result.commentId].sort());
  });

  test("a reply names its parent by id; edit, resolve and delete (V1 and V2) write the row", async () => {
    const ctx = context(OWNER);
    const a = await add(ctx, { message_id: MSG });
    const b = await add(ctx, { message_id: MSG });
    const reply = await add(as(ctx, MEMBER), { message_id: MSG, parent_comment_id: b, content: "Because it drops writes." });
    expect(stored(ctx).find((c) => c._id === reply)).toMatchObject({ parent_comment_id: b, user_id: MEMBER });
    expect(rowOf(ctx, reply).parent_id).toBe(b);

    await (updateComment as any)._handler(ctx, { comment_id: a, content: "edited v1" });
    await (updateCommentV2 as any)._handler(ctx, { command_id: "e-2", conversation_id: CONV, comment_id: b, content: "edited v2" });
    expect(rowOf(ctx, a).content).toBe("edited v1");
    expect(rowOf(ctx, b).content).toBe("edited v2");

    await (resolveThread as any)._handler(as(ctx, MEMBER), { conversation_id: CONV, message_id: MSG, resolved: true });
    for (const id of [a, b, reply]) expect(rowOf(ctx, id)).toMatchObject({ resolved: true, resolved_by: MEMBER });
    await (resolveThread as any)._handler(ctx, { conversation_id: CONV, message_id: MSG, resolved: false });
    expect(rowOf(ctx, a)).toMatchObject({ resolved: false, resolved_at: undefined, resolved_by: undefined });

    await (deleteComment as any)._handler(ctx, { comment_id: a });
    await (deleteCommentV2 as any)._handler(ctx, { command_id: "d-2", conversation_id: CONV, comment_id: b });
    expect(rowOf(ctx, a)).toBeUndefined();
    expect(rowOf(ctx, b)).toBeUndefined();
    expect(stored(ctx).find((c) => c._id === reply)?.parent_comment_id).toBeUndefined();
    expect(legacyTable(ctx)).toEqual([]);
  });

  test("ask the agent: the placeholder row carries agent status and fork, the fork links it, then the mirrored reply", async () => {
    const fork = "conv_fork" as any;
    const ctx = context(OWNER, {
      conversations: [
        { _id: CONV, user_id: OWNER, team_id: TEAM, is_private: false, team_visibility: "full", status: "active", updated_at: 1 },
        { _id: fork, user_id: OWNER, is_private: true, status: "active", updated_at: 1 },
      ],
    }, { async runMutation() { return { conversation_id: fork }; } });
    await (askAgentInThreadV2 as any)._handler(ctx, { command_id: "ask-1", conversation_id: CONV, client_id: "ask-cl" });
    const placeholder = stored(ctx)[0];
    expect(placeholder).toMatchObject({ author_kind: "agent", agent_status: "thinking", fork_conversation_id: fork, content: "" });
    expect(ctx.db._tables.conversations.find((c: any) => c._id === fork).comment_fork_comment_id).toBe(placeholder._id);

    ctx.db._tables.messages.push({ _id: "msg_reply", conversation_id: fork, role: "assistant", content: "It drops writes.", timestamp: Date.now() + 10 });
    await (mirrorAgentReply as any)._handler(ctx, { fork_conversation_id: fork });
    expect(stored(ctx)[0]).toMatchObject({ agent_status: "done", content: "It drops writes." });
    expect(legacyTable(ctx)).toEqual([]);
  });

  test("a failed fork writes the error onto the placeholder", async () => {
    const ctx = context(OWNER, {}, { async runMutation() { throw new Error("fork refused"); } });
    await (askAgentInThreadV2 as any)._handler(ctx, { command_id: "ask-err", conversation_id: CONV, client_id: "ask-err" });
    expect(stored(ctx)[0].agent_status).toBe("error");
    expect(stored(ctx)[0].content).toContain("fork refused");
  });

  test("the GitHub post names the new comment, and its GitHub id lands in source_github_comment_id", async () => {
    const ctx = context(OWNER, { users: [{ _id: OWNER, name: "Owner", github_access_token: "tok" }] });
    const id = await add(ctx, { pr_id: PR });
    const posts = ctx._scheduled.filter((s: any) => s.args?.pr_number);
    expect(posts).toHaveLength(1);
    expect(posts[0].args.comment_id).toBe(id);
    await (updateGitHubCommentId as any)._handler(ctx, { comment_id: id, github_comment_id: 4242 });
    expect(rowOf(ctx, id)).toMatchObject({ source_github_comment_id: 4242, source_pr_id: PR });
    expect(rowOf(ctx, id).github_comment_id).toBeUndefined();
    expect(rowOf(ctx, id).pull_request_id).toBeUndefined();
    expect(stored(ctx)[0]).toMatchObject({ github_comment_id: 4242, pr_id: PR });
  });

  test("the generic dispatch patch, an account merge and a session delete", async () => {
    const ctx = context(OWNER);
    const id = await add(ctx);
    await applyPatches(ctx, OWNER, { comments: { [id]: { content: "patched" } } });
    expect(rowOf(ctx, id).content).toBe("patched");
    // Only the author edits through the generic patch.
    await applyPatches(ctx, MEMBER, { comments: { [id]: { content: "not mine" } } });
    expect(rowOf(ctx, id).content).toBe("patched");

    const merged = context(null, {
      users: [
        { _id: STRANGER, name: "Dup", email: "same@x.test" },
        { _id: MEMBER, name: "Survivor", email: "same@x.test" },
        { _id: OWNER, name: "Owner" },
      ],
    });
    const mergedId = await add(as(merged, OWNER));
    // A duplicate account wrote it; the merge moves it to the survivor.
    rowOf(merged, mergedId).author_user_id = STRANGER;
    await (mergeDuplicateUser as any)._handler(merged, { from_user_id: STRANGER, to_user_id: MEMBER, dry_run: false, delete_source: false });
    expect(rowOf(merged, mergedId).author_user_id).toBe(MEMBER);

    await (purgeConversationRows as any)._handler(ctx, { conversation_id: CONV });
    expect(stored(ctx)).toHaveLength(0);
  });
});

describe("comments written before the move keep their ids", () => {
  test("they read with their old ids and parents, and a new reply names the old parent", async () => {
    const root = legacy("comments_old_root", { message_id: MSG });
    const reply = legacy("comments_old_reply", { message_id: MSG, parent_comment_id: "comments_old_root", user_id: MEMBER, created_at: 2 });
    const replyTwin = { ...reply.twin, parent_id: root.twin._id };
    const ctx = context(OWNER, { comments: [root.comment, reply.comment], review_comments: [root.twin, replyTwin] });
    const rows = await (getConversationCommentSummary as any)._handler(ctx, { conversation_id: CONV });
    expect(rows.map((r: any) => [r._id, r.parent_comment_id])).toEqual([
      ["comments_old_root", undefined],
      ["comments_old_reply", "comments_old_root"],
    ]);

    const fresh = await add(as(ctx, MEMBER), { message_id: MSG, parent_comment_id: "comments_old_root" });
    expect(rowOf(ctx, fresh).parent_id).toBe(root.twin._id);
    expect(stored(ctx).find((c) => c._id === fresh)?.parent_comment_id).toBe("comments_old_root");
  });

  test("edit, resolve and delete by the old id write the twin and leave the history row alone", async () => {
    const a = legacy("comments_old_a");
    const b = legacy("comments_old_b");
    const ctx = context(OWNER, { comments: [a.comment, b.comment], review_comments: [a.twin, b.twin] });
    await (updateCommentV2 as any)._handler(ctx, { command_id: "e-old", conversation_id: CONV, comment_id: "comments_old_a", content: "edited" });
    expect(rowOf(ctx, "comments_old_a").content).toBe("edited");
    await applyPatches(ctx, OWNER, { comments: { comments_old_a: { resolved_at: 5 } } });
    expect(rowOf(ctx, "comments_old_a")).toMatchObject({ resolved: true, resolved_at: 5, resolved_by: OWNER });
    await (deleteComment as any)._handler(ctx, { comment_id: "comments_old_b" });
    expect(rowOf(ctx, "comments_old_b")).toBeUndefined();
    expect(legacyTable(ctx).map((c) => [c._id, c.content])).toEqual([["comments_old_a", "old comments_old_a"], ["comments_old_b", "old comments_old_b"]]);
    expect(stored(ctx).map((c) => [c._id, c.content])).toEqual([["comments_old_a", "edited"]]);
  });

  test("an agent placeholder from before the move still receives its reply through the fork's old link", async () => {
    const fork = "conv_fork" as any;
    const placeholder = legacy("comments_old_agent", { author_kind: "agent", agent_status: "thinking", content: "", fork_conversation_id: fork });
    const ctx = context(OWNER, {
      conversations: [
        { _id: CONV, user_id: OWNER, team_id: TEAM, is_private: false, team_visibility: "full", status: "active", updated_at: 1 },
        { _id: fork, user_id: OWNER, is_private: true, status: "active", updated_at: 1, comment_fork_parent: CONV, comment_fork_comment_id: "comments_old_agent", comment_fork_prompt_at: 0 },
      ],
      messages: [{ _id: "msg_reply", conversation_id: fork, role: "assistant", content: "Answered.", timestamp: 10 }],
      comments: [placeholder.comment],
      review_comments: [placeholder.twin],
    });
    await (mirrorAgentReply as any)._handler(ctx, { fork_conversation_id: fork });
    expect(rowOf(ctx, "comments_old_agent")).toMatchObject({ agent_status: "done", content: "Answered." });
  });
});

describe("existing review_comments readers never see a conversation comment", () => {
  // A conversation with a code-line comment linked to the PR and mirrored to
  // GitHub, a message comment, a reply, and one written before the move.
  async function seeded() {
    const old = legacy("comments_old", { file_path: "src/a.ts", line_number: 3 });
    const ctx = context(OWNER, { comments: [old.comment], review_comments: [old.twin] });
    const line = await add(ctx, { file_path: "src/a.ts", line_number: 3, pr_id: PR, anchor_lines: { before: [], lines: ["x"], after: [] } });
    await (updateGitHubCommentId as any)._handler(ctx, { comment_id: line, github_comment_id: 4242 });
    const root = await add(ctx, { message_id: MSG, content: "rewrite the sync layer" });
    await add(as(ctx, MEMBER), { message_id: MSG, parent_comment_id: root });
    expect(stored(ctx)).toHaveLength(4);
    return { ctx, line };
  }

  test("listForConversation, listForPR, listForRef and listForFile, for the author and a teammate", async () => {
    const { ctx } = await seeded();
    for (const user of [OWNER, MEMBER]) {
      const c = as(ctx, user);
      expect(await (listForConversation as any)._handler(c, { conversation_id: CONV })).toEqual([]);
      expect(await (listForPR as any)._handler(c, { pull_request_id: PR })).toEqual([]);
      expect(await (listForRef as any)._handler(c, { repository: REPO, ref: HEAD })).toEqual([]);
      expect(await (listForFile as any)._handler(c, { repository: REPO, file_path: "src/a.ts" })).toEqual([]);
    }
    expect(await codeThreadRows(ctx, { repository: REPO, ref: HEAD, file_path: "src/a.ts", line_number: 3 })).toEqual([]);
  });

  test("no code comment path reaches one by id, its author included, and nothing mirrors to GitHub", async () => {
    const { ctx, line } = await seeded();
    for (const id of [line, "comments_old"]) {
      const row = rowOf(ctx, id);
      expect(await canAccessComment(ctx, OWNER, row)).toBe(false);
      const before = ctx._scheduled.length;
      await expect((updateCodeComment as any)._handler(ctx, { comment_id: row._id, content: "x" })).rejects.toThrow();
      await expect((resolveCodeComment as any)._handler(ctx, { comment_id: row._id })).rejects.toThrow();
      expect(await (getNote as any)._handler(ctx, { comment_id: row._id })).toBeNull();
      expect(ctx._scheduled.length).toBe(before);
      expect(rowOf(ctx, id)).toMatchObject({ content: row.content, resolved: false });
    }
  });

  test("pending review, cast review notes, the promise sweep and quote drafts", async () => {
    const { ctx } = await seeded();
    expect(await pendingRowsFor(ctx, OWNER, PR)).toEqual([]);
    expect(await (listNotes as any)._handler(ctx, { git_root: "/Users/ashot/src/codecast", include_sent: true })).toEqual([]);
    expect(await overduePromises(ctx.db, Date.now() + 1e9)).toEqual([]);
    expect(await (listQuotes as any)._handler(ctx, { conversation_id: CONV })).toEqual([]);
  });

  test("reviewAnswered stamps no conversation comment, even on a reply quoting it", async () => {
    const { ctx } = await seeded();
    await markAnsweredReviewNotes(ctx, CONV, { _id: "msg_2" as any, content: "> rewrite the sync layer\nsrc/a.ts:3", timestamp: Date.now() + 1 });
    expect(ctx.db._tables.review_comments.every((r: any) => r.answered_at === undefined)).toBe(true);
  });

  test("a GitHub webhook for the comment's GitHub id still ingests a review comment", async () => {
    const { ctx } = await seeded();
    ctx.db._tables.github_webhook_events = [{
      _id: "event_1", delivery_id: "d1", event_type: "pull_request_review_comment", action: "created", processed: false, created_at: 0,
      payload: JSON.stringify({
        repository: { full_name: REPO },
        pull_request: { number: 12 },
        comment: { id: 4242, body: "from GitHub", path: "src/a.ts", line: 3, side: "RIGHT", commit_id: HEAD, html_url: "https://github.com/c/4242", created_at: "2026-10-24T10:00:00Z", updated_at: "2026-10-24T10:00:00Z", user: { login: "samvit" } },
      }),
    }];
    for (const table of ["external_events", "reviews", "agent_tasks", "commits", "file_changes", "tasks"]) ctx.db._tables[table] ??= [];
    await (processReviewCommentEvent as any)._handler(ctx, { event_id: "event_1" });
    const ingested = ctx.db._tables.review_comments.filter((r: any) => r.github_comment_id === 4242);
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toMatchObject({ content: "from GitHub", pull_request_id: PR });
    expect(ingested[0].origin).toBeUndefined();
  });

  test("Threads files comment threads only; the conversation signal counts comments", async () => {
    const { ctx } = await seeded();
    expect(ctx.db._tables.thread_reads.every((r: any) => r.kind === "comment")).toBe(true);
    const page = await (listMine as any)._handler(ctx, { team_id: TEAM });
    expect(page.payload.codeComments).toEqual([]);
    expect(page.payload.comments.map((c: any) => c._id).sort()).toEqual(stored(ctx).map((c) => c._id).sort());
    const conversation = ctx.db._tables.conversations.find((c: any) => c._id === CONV);
    expect(conversation.unresolved_comment_count).toBe(2);
  });
});

describe("both comment reads answer alike", () => {
  test("conversationComments equals getConversationCommentSummary, and a stranger or signed-out caller reads nothing", async () => {
    const old = legacy("comments_old");
    const ctx = context(OWNER, { comments: [old.comment], review_comments: [old.twin] });
    await add(ctx, { message_id: MSG });
    const summary = await (getConversationCommentSummary as any)._handler(ctx, { conversation_id: CONV });
    expect(summary).toHaveLength(2);
    expect(await (conversationComments as any)._handler(ctx, { conversation_id: CONV })).toEqual(summary);
    for (const reader of [as(ctx, STRANGER), context(null)]) {
      expect(await (getConversationCommentSummary as any)._handler(reader, { conversation_id: CONV })).toEqual([]);
      expect(await (conversationComments as any)._handler(reader, { conversation_id: CONV })).toEqual([]);
    }
  });

  test("Threads answers the same with or without the retired comments_from_review argument", async () => {
    const ctx = context(OWNER);
    const root = await add(ctx, { message_id: MSG });
    // The reply lands after the owner's own comment, so it is news to them.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await add(as(ctx, MEMBER), { message_id: MSG, parent_comment_id: root, content: "reply" });
    const plain = await (listMine as any)._handler(ctx, { team_id: TEAM });
    const flagged = await (listMine as any)._handler(ctx, { team_id: TEAM, comments_from_review: true });
    expect(flagged).toEqual(plain);
    expect(await (unreadCount as any)._handler(ctx, { team_id: TEAM })).toBe(await (unreadCount as any)._handler(ctx, { team_id: TEAM, comments_from_review: false }));
    expect(await (unreadCount as any)._handler(ctx, { team_id: TEAM })).toBeGreaterThan(0);
  });
});
