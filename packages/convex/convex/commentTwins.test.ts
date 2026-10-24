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
import {
  backfill,
  conversationComments,
  foldParityPages,
  parityPage,
  paritySweep,
} from "./commentTwins";
import { reconcileCommentTwin } from "./commentTwinWrites";
import { commentTwinFields } from "./lib/commentTwins";
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
const comments = (ctx: any) => ctx.db._tables.comments as any[];
const twins = (ctx: any) => (ctx.db._tables.review_comments ?? []).filter((r: any) => r.source_comment_id) as any[];
const twinOf = (ctx: any, id: string) => twins(ctx).find((t) => t.source_comment_id === id);

async function parity(ctx: any) {
  const pages = [];
  for (const phase of ["comments", "twins"] as const) {
    let cursor: string | undefined;
    for (;;) {
      const page = await (parityPage as any)._handler(ctx, { phase, cursor });
      pages.push(page);
      if (page.done) break;
      cursor = page.cursor;
    }
  }
  return foldParityPages(pages);
}

/** Every comment has exactly one twin equal to the mapping, and no twin is stray. */
async function expectParity(ctx: any) {
  const report = await parity(ctx);
  expect(report).toMatchObject({ clean: true, missing_twin: 0, duplicate_twin: 0, mismatched: 0, orphan_twin: 0 });
  expect(twins(ctx)).toHaveLength(comments(ctx).length);
}

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

describe("dual write: every comments write path keeps the twin equal", () => {
  test("create (V1 and V2), with a client_id replay writing no second twin", async () => {
    const ctx = context(OWNER);
    const v1 = await (addComment as any)._handler(ctx, { conversation_id: CONV, message_id: MSG, content: "legacy" });
    const args = { command_id: "c-1", conversation_id: CONV, content: "on a line", file_path: "src/a.ts", line_number: 4, anchor_lines: { before: [], lines: ["x"], after: [] }, client_id: "cl-1" };
    await (addCommentV2 as any)._handler(ctx, args);
    await (addCommentV2 as any)._handler(ctx, { ...args, command_id: "c-2" });
    expect(comments(ctx)).toHaveLength(2);
    expect(twinOf(ctx, v1)).toMatchObject({ content: "legacy", message_id: MSG, author_user_id: OWNER, resolved: false });
    expect(twinOf(ctx, comments(ctx)[1]._id)).toMatchObject({ file_path: "src/a.ts", line_number: 4, client_id: "cl-1" });
    await expectParity(ctx);
  });

  test("a reply's twin points at its parent's twin", async () => {
    const ctx = context(OWNER);
    const root = await add(ctx, { message_id: MSG });
    const reply = await add(as(ctx, MEMBER), { message_id: MSG, parent_comment_id: root, content: "Because it drops writes." });
    expect(twinOf(ctx, reply).parent_id).toBe(twinOf(ctx, root)._id);
    expect(twinOf(ctx, reply).author_user_id).toBe(MEMBER);
    await expectParity(ctx);
  });

  test("edit and delete (V1 and V2); a deleted parent leaves its reply's twin without a parent", async () => {
    const ctx = context(OWNER);
    const a = await add(ctx);
    const b = await add(ctx);
    const reply = await add(ctx, { parent_comment_id: b });
    await (updateComment as any)._handler(ctx, { comment_id: a, content: "edited v1" });
    await (updateCommentV2 as any)._handler(ctx, { command_id: "e-2", conversation_id: CONV, comment_id: b, content: "edited v2" });
    expect(twinOf(ctx, a).content).toBe("edited v1");
    expect(twinOf(ctx, b).content).toBe("edited v2");
    await (deleteComment as any)._handler(ctx, { comment_id: a });
    await (deleteCommentV2 as any)._handler(ctx, { command_id: "d-2", conversation_id: CONV, comment_id: b });
    expect(twinOf(ctx, a)).toBeUndefined();
    expect(twinOf(ctx, b)).toBeUndefined();
    expect(twinOf(ctx, reply).parent_id).toBeUndefined();
    await expectParity(ctx);
  });

  test("resolveThread stamps every twin of the thread and reopening clears them", async () => {
    const ctx = context(OWNER);
    const a = await add(ctx, { message_id: MSG });
    const b = await add(ctx, { message_id: MSG });
    const other = await add(ctx);
    await (resolveThread as any)._handler(as(ctx, MEMBER), { conversation_id: CONV, message_id: MSG, resolved: true });
    for (const id of [a, b]) expect(twinOf(ctx, id)).toMatchObject({ resolved: true, resolved_by: MEMBER });
    expect(twinOf(ctx, other).resolved).toBe(false);
    await expectParity(ctx);
    await (resolveThread as any)._handler(ctx, { conversation_id: CONV, message_id: MSG, resolved: false });
    expect(twinOf(ctx, a)).toMatchObject({ resolved: false, resolved_at: undefined, resolved_by: undefined });
    await expectParity(ctx);
  });

  test("ask the agent: the placeholder twin carries agent status and fork, then the mirrored reply", async () => {
    const fork = "conv_fork" as any;
    const ctx = context(OWNER, {
      conversations: [
        { _id: CONV, user_id: OWNER, team_id: TEAM, is_private: false, team_visibility: "full", status: "active", updated_at: 1 },
        { _id: fork, user_id: OWNER, is_private: true, status: "active", updated_at: 1 },
      ],
    }, { async runMutation() { return { conversation_id: fork }; } });
    await (askAgentInThreadV2 as any)._handler(ctx, { command_id: "ask-1", conversation_id: CONV, client_id: "ask-cl" });
    const placeholder = comments(ctx)[0];
    expect(twinOf(ctx, placeholder._id)).toMatchObject({ author_kind: "agent", agent_status: "thinking", fork_conversation_id: fork, content: "" });
    await expectParity(ctx);

    ctx.db._tables.messages.push({ _id: "msg_reply", conversation_id: fork, role: "assistant", content: "It drops writes.", timestamp: Date.now() + 10 });
    await (mirrorAgentReply as any)._handler(ctx, { fork_conversation_id: fork });
    expect(twinOf(ctx, placeholder._id)).toMatchObject({ agent_status: "done", content: "It drops writes.", created_at: comments(ctx)[0].created_at });
    await expectParity(ctx);
  });

  test("a failed fork writes the error onto the twin too", async () => {
    const ctx = context(OWNER, {}, { async runMutation() { throw new Error("fork refused"); } });
    await (askAgentInThreadV2 as any)._handler(ctx, { command_id: "ask-err", conversation_id: CONV, client_id: "ask-err" });
    const twin = twinOf(ctx, comments(ctx)[0]._id);
    expect(twin.agent_status).toBe("error");
    expect(twin.content).toContain("fork refused");
    await expectParity(ctx);
  });

  test("the GitHub id lands in source_github_comment_id, never github_comment_id", async () => {
    const ctx = context(OWNER);
    const id = await add(ctx, { pr_id: PR });
    await (updateGitHubCommentId as any)._handler(ctx, { comment_id: id, github_comment_id: 4242 });
    expect(twinOf(ctx, id)).toMatchObject({ source_github_comment_id: 4242, source_pr_id: PR });
    expect(twinOf(ctx, id).github_comment_id).toBeUndefined();
    expect(twinOf(ctx, id).pull_request_id).toBeUndefined();
    await expectParity(ctx);
  });

  test("the generic dispatch patch, an account merge and a session delete", async () => {
    const ctx = context(OWNER);
    const id = await add(ctx);
    await applyPatches(ctx, OWNER, { comments: { [id]: { content: "patched" } } });
    expect(twinOf(ctx, id).content).toBe("patched");

    const merged = context(null, {
      users: [
        { _id: STRANGER, name: "Dup", email: "same@x.test" },
        { _id: MEMBER, name: "Survivor", email: "same@x.test" },
        { _id: OWNER, name: "Owner" },
      ],
    });
    const mergedId = await add(as(merged, OWNER));
    // A duplicate account wrote it; the merge moves it to the survivor.
    merged.db._tables.comments[0].user_id = STRANGER;
    await reconcileCommentTwin(merged, mergedId as any);
    await (mergeDuplicateUser as any)._handler(merged, { from_user_id: STRANGER, to_user_id: MEMBER, dry_run: false, delete_source: false });
    expect(twinOf(merged, mergedId).author_user_id).toBe(MEMBER);
    await expectParity(merged);

    await (purgeConversationRows as any)._handler(ctx, { conversation_id: CONV });
    expect(comments(ctx)).toHaveLength(0);
    expect(twins(ctx)).toHaveLength(0);
  });

  test("a twin that cannot be written never fails the comment write", async () => {
    const ctx = context(OWNER);
    const insert = ctx.db.insert.bind(ctx.db);
    ctx.db.insert = async (table: string, doc: any) => {
      if (table === "review_comments") throw new Error("twin write refused");
      return await insert(table, doc);
    };
    const errors = console.error;
    console.error = () => {};
    try {
      await add(ctx);
    } finally {
      console.error = errors;
    }
    expect(comments(ctx)).toHaveLength(1);
    expect(twins(ctx)).toHaveLength(0);
    expect((await parity(ctx)).missing_twin).toBe(1);
  });

  test("the comment write schedules exactly what it scheduled before: one GitHub post", async () => {
    const ctx = context(OWNER, {
      users: [{ _id: OWNER, name: "Owner", github_access_token: "tok" }],
    });
    await add(ctx);
    const posts = ctx._scheduled.filter((s: any) => s.args?.pr_number);
    expect(posts).toHaveLength(1);
    expect(ctx._scheduled.every((s: any) => !("comment_id" in (s.args ?? {})) || comments(ctx).some((c) => c._id === s.args.comment_id))).toBe(true);
  });
});

describe("existing review_comments readers never see a twin", () => {
  // A conversation with a code-line comment linked to the PR and mirrored to
  // GitHub, a message comment and a reply: twins for each.
  async function seeded() {
    const ctx = context(OWNER);
    const line = await add(ctx, { file_path: "src/a.ts", line_number: 3, pr_id: PR, anchor_lines: { before: [], lines: ["x"], after: [] } });
    await (updateGitHubCommentId as any)._handler(ctx, { comment_id: line, github_comment_id: 4242 });
    const root = await add(ctx, { message_id: MSG, content: "rewrite the sync layer" });
    await add(as(ctx, MEMBER), { message_id: MSG, parent_comment_id: root });
    expect(twins(ctx)).toHaveLength(3);
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

  test("no code comment path reaches a twin by id, its author included, and nothing mirrors to GitHub", async () => {
    const { ctx, line } = await seeded();
    const twin = twinOf(ctx, line);
    expect(await canAccessComment(ctx, OWNER, twin)).toBe(false);
    const before = ctx._scheduled.length;
    await expect((updateCodeComment as any)._handler(ctx, { comment_id: twin._id, content: "x" })).rejects.toThrow();
    await expect((resolveCodeComment as any)._handler(ctx, { comment_id: twin._id })).rejects.toThrow();
    expect(await (getNote as any)._handler(ctx, { comment_id: twin._id })).toBeNull();
    expect(ctx._scheduled.length).toBe(before);
    expect(twinOf(ctx, line)).toMatchObject({ content: twin.content, resolved: false });
  });

  test("pending review, cast review notes, the promise sweep and quote drafts", async () => {
    const { ctx } = await seeded();
    expect(await pendingRowsFor(ctx, OWNER, PR)).toEqual([]);
    expect(await (listNotes as any)._handler(ctx, { git_root: "/Users/ashot/src/codecast", include_sent: true })).toEqual([]);
    expect(await overduePromises(ctx.db, Date.now() + 1e9)).toEqual([]);
    expect(await (listQuotes as any)._handler(ctx, { conversation_id: CONV })).toEqual([]);
  });

  test("reviewAnswered stamps no twin, even on a reply quoting it", async () => {
    const { ctx } = await seeded();
    await markAnsweredReviewNotes(ctx, CONV, { _id: "msg_2" as any, content: "> rewrite the sync layer\nsrc/a.ts:3", timestamp: Date.now() + 1 });
    expect(twins(ctx).every((t) => t.answered_at === undefined)).toBe(true);
  });

  test("a GitHub webhook for the twin's GitHub id still ingests a review comment", async () => {
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
    expect(ingested[0].source_comment_id).toBeUndefined();
  });

  test("Threads files comment threads only, as before; the conversation signal counts comments", async () => {
    const { ctx } = await seeded();
    expect(ctx.db._tables.thread_reads.every((r: any) => r.kind === "comment")).toBe(true);
    const page = await (listMine as any)._handler(ctx, { team_id: TEAM });
    expect(page.payload.codeComments).toEqual([]);
    expect(page.payload.comments.map((c: any) => c._id).sort()).toEqual(comments(ctx).map((c) => c._id).sort());
    const conversation = ctx.db._tables.conversations.find((c: any) => c._id === CONV);
    expect(conversation.unresolved_comment_count).toBe(2);
  });
});

describe("backfill", () => {
  function legacy() {
    // Rows written before the dual write: comments with no twins.
    return context(OWNER, {
      comments: [
        { _id: "c_root", _creationTime: 1, conversation_id: CONV, message_id: MSG, user_id: OWNER, content: "root", created_at: 1 },
        { _id: "c_line", _creationTime: 2, conversation_id: CONV, user_id: MEMBER, content: "line", created_at: 2, file_path: "src/a.ts", line_number: 9, pr_id: PR, github_comment_id: 77, resolved_at: 5, resolved_by: OWNER },
        { _id: "c_reply", _creationTime: 3, conversation_id: CONV, message_id: MSG, user_id: MEMBER, content: "reply", created_at: 3, parent_comment_id: "c_root" },
        { _id: "c_agent", _creationTime: 4, conversation_id: CONV, user_id: OWNER, content: "", created_at: 4, author_kind: "agent", agent_status: "thinking", fork_conversation_id: "conv_fork", client_id: "a1" },
        { _id: "c_global", _creationTime: 5, conversation_id: CONV, user_id: OWNER, content: "global", created_at: 5 },
      ],
    });
  }

  test("dry run by default: counts what it would write, writes nothing", async () => {
    const ctx = legacy();
    const result = await (backfill as any)._handler(ctx, {});
    expect(result).toMatchObject({ dryRun: true, created: 5, scanned: 5, done: true });
    expect(twins(ctx)).toHaveLength(0);
    expect(ctx.db._inserted).toHaveLength(0);
  });

  test("pages resume from the cursor, auto continues, and a rerun writes nothing", async () => {
    const ctx = legacy();
    const first = await (backfill as any)._handler(ctx, { dryRun: false, numItems: 2, auto: true });
    expect(first).toMatchObject({ created: 2, done: false });
    const next = ctx._scheduled.at(-1);
    expect(next.args).toMatchObject({ dryRun: false, cursor: first.cursor, numItems: 2, auto: true });
    let page = first;
    while (!page.done) page = await (backfill as any)._handler(ctx, { dryRun: false, numItems: 2, cursor: page.cursor });
    await expectParity(ctx);
    expect(twinOf(ctx, "c_reply").parent_id).toBe(twinOf(ctx, "c_root")._id);
    expect(twinOf(ctx, "c_line")).toMatchObject({ resolved: true, source_github_comment_id: 77, source_pr_id: PR });

    const writes = ctx.db._inserted.length + ctx.db._patched.length;
    const rerun = await (backfill as any)._handler(ctx, { dryRun: false, numItems: 50 });
    expect(rerun).toMatchObject({ created: 0, updated: 0, unchanged: 5 });
    expect(ctx.db._inserted.length + ctx.db._patched.length).toBe(writes);
  });

  test("a reply backfilled before its parent creates the parent's twin first", async () => {
    const ctx = legacy();
    await reconcileCommentTwin(ctx, "c_reply" as any);
    expect(twins(ctx)).toHaveLength(2);
    expect(twinOf(ctx, "c_reply").parent_id).toBe(twinOf(ctx, "c_root")._id);
    const result = await (backfill as any)._handler(ctx, { dryRun: false });
    expect(result).toMatchObject({ created: 3, unchanged: 2 });
    await expectParity(ctx);
  });

  test("a drifted twin is repaired, a duplicate removed", async () => {
    const ctx = legacy();
    await (backfill as any)._handler(ctx, { dryRun: false });
    twinOf(ctx, "c_root").content = "stale";
    ctx.db._tables.review_comments.push({ ...twinOf(ctx, "c_global"), _id: "rc_dup", _creationTime: 99 });
    expect(await (backfill as any)._handler(ctx, {})).toMatchObject({ updated: 2 });
    expect(await (backfill as any)._handler(ctx, { dryRun: false })).toMatchObject({ updated: 2, unchanged: 3 });
    await expectParity(ctx);
  });

  test("with the schema's real indexes: the source index, creation order and key cursors", async () => {
    const seed = legacy().db._tables;
    const ctx = context(OWNER);
    ctx.db = makeFakeDb(seed, { indexes: schemaIndexes(schema) });
    let page = await (backfill as any)._handler(ctx, { dryRun: false, numItems: 2 });
    while (!page.done) page = await (backfill as any)._handler(ctx, { dryRun: false, numItems: 2, cursor: page.cursor });
    await expectParity(ctx);
  });
});

describe("parity sweep", () => {
  test("reports missing, orphan, duplicate and mismatched twins with counts, fields and samples", async () => {
    const ctx = context(OWNER, {
      comments: [
        { _id: "c_ok", conversation_id: CONV, user_id: OWNER, content: "ok", created_at: 1 },
        { _id: "c_missing", conversation_id: CONV, user_id: OWNER, content: "missing", created_at: 2 },
        { _id: "c_drift", conversation_id: CONV, user_id: OWNER, content: "now", created_at: 3, resolved_at: 9 },
        { _id: "c_dup", conversation_id: CONV, user_id: OWNER, content: "dup", created_at: 4 },
      ],
    });
    for (const id of ["c_ok", "c_drift", "c_dup"]) await reconcileCommentTwin(ctx, id as any);
    Object.assign(twinOf(ctx, "c_drift"), { content: "then", resolved: false });
    ctx.db._tables.review_comments.push({ ...twinOf(ctx, "c_dup"), _id: "rc_dup2", _creationTime: 50 });
    ctx.db._tables.review_comments.push({ _id: "rc_orphan", ...commentTwinFields({ _id: "c_gone", conversation_id: CONV, user_id: OWNER, content: "gone", created_at: 0 } as any) });
    ctx.db._tables.review_comments.push({ _id: "rc_code", repository: REPO, content: "a code comment", resolved: false, created_at: 1 });

    const report = await parity(ctx);
    expect(report).toMatchObject({
      comments_scanned: 4,
      twins_scanned: 5,
      missing_twin: 1,
      duplicate_twin: 1,
      mismatched: 1,
      orphan_twin: 1,
      mismatched_fields: { content: 1, resolved: 1 },
      clean: false,
      samples: {
        missing_twin: ["c_missing"],
        duplicate_twin: ["c_dup"],
        mismatched: [{ comment_id: "c_drift", fields: ["content", "resolved"] }],
        orphan_twin: ["rc_orphan"],
      },
    });
    // The sweep reads only.
    expect(ctx.db._patched).toHaveLength(0);
  });

  test("the action walks every page of both phases into one report", async () => {
    const ctx = context(OWNER, {
      comments: Array.from({ length: 5 }, (_, i) => ({ _id: `c${i}`, conversation_id: CONV, user_id: OWNER, content: `n${i}`, created_at: i })),
    });
    for (let i = 0; i < 4; i++) await reconcileCommentTwin(ctx, `c${i}` as any);
    const actionCtx = { runQuery: (_ref: unknown, args: any) => (parityPage as any)._handler(ctx, args) };
    const report = await (paritySweep as any)._handler(actionCtx, { numItems: 2 });
    expect(report).toMatchObject({ comments_scanned: 5, twins_scanned: 4, missing_twin: 1, samples: { missing_twin: ["c4"] }, clean: false });
  });
});

describe("reads from review_comments answer exactly what comments answer", () => {
  async function busy() {
    const fork = "conv_fork" as any;
    const ctx = context(OWNER, {
      conversations: [
        { _id: CONV, user_id: OWNER, team_id: TEAM, is_private: false, team_visibility: "full", status: "active", updated_at: 1 },
        { _id: fork, user_id: OWNER, is_private: true, status: "active", updated_at: 1 },
      ],
      users: [
        { _id: OWNER, name: "Owner", github_username: "owner", github_avatar_url: "https://a/o", image: "img" },
        { _id: MEMBER, name: "Member" },
        { _id: STRANGER, name: "Stranger" },
      ],
    }, { async runMutation() { return { conversation_id: fork }; } });
    const root = await add(ctx, { message_id: MSG });
    await add(as(ctx, MEMBER), { message_id: MSG, parent_comment_id: root, content: "@owner look" });
    await add(ctx, { file_path: "src/a.ts", line_number: 3, anchor_lines: { before: ["a"], lines: ["b"], after: ["c"] } });
    const doomed = await add(ctx, { content: "global" });
    await add(ctx, { parent_comment_id: doomed, content: "orphaned reply" });
    await (deleteCommentV2 as any)._handler(ctx, { command_id: "del", conversation_id: CONV, comment_id: doomed });
    await (resolveThread as any)._handler(ctx, { conversation_id: CONV, message_id: MSG, resolved: true });
    await (askAgentInThreadV2 as any)._handler(ctx, { command_id: "ask", conversation_id: CONV, file_path: "src/a.ts", line_number: 3, client_id: "ask" });
    return ctx;
  }

  const strip = (rows: any[]) => rows.map(({ _creationTime, ...rest }) => rest);
  // A reply whose parent was deleted keeps the dead id in `comments`; its twin
  // has no parent to name. Every surface looks the parent up among the rows it
  // holds, so both render the same; the raw rows differ only there.
  const withoutDeadParents = (rows: any[]) => {
    const ids = new Set(rows.map((r) => r._id));
    return rows.map((r) => (r.parent_comment_id && !ids.has(r.parent_comment_id) ? (({ parent_comment_id, ...rest }) => rest)(r) : r));
  };

  test("conversationComments equals getConversationCommentSummary, row for row", async () => {
    const ctx = await busy();
    for (const user of [OWNER, MEMBER]) {
      const fromComments = await (getConversationCommentSummary as any)._handler(as(ctx, user), { conversation_id: CONV });
      const fromTwins = await (conversationComments as any)._handler(as(ctx, user), { conversation_id: CONV });
      expect(fromComments.length).toBe(5);
      expect(strip(fromTwins)).toEqual(strip(withoutDeadParents(fromComments)));
    }
  });

  test("the same access rule: a stranger and a signed-out caller read nothing from either", async () => {
    const ctx = await busy();
    const privateCtx = context(OWNER, { conversations: [{ _id: CONV, user_id: OWNER, is_private: true, status: "active", updated_at: 1 }] });
    await add(privateCtx);
    for (const c of [as(ctx, STRANGER), as(privateCtx, MEMBER), context(null)]) {
      expect(await (getConversationCommentSummary as any)._handler(c, { conversation_id: CONV })).toEqual([]);
      expect(await (conversationComments as any)._handler(c, { conversation_id: CONV })).toEqual([]);
    }
  });

  test("Threads: listMine and the unread badge answer alike from either source", async () => {
    const ctx = await busy();
    for (const user of [OWNER, MEMBER]) {
      const c = as(ctx, user);
      const off = await (listMine as any)._handler(c, { team_id: TEAM });
      const on = await (listMine as any)._handler(c, { team_id: TEAM, comments_from_review: true });
      expect(off.entries.length).toBeGreaterThan(0);
      expect(off.payload.comments.length).toBeGreaterThan(0);
      expect(on.entries).toEqual(off.entries);
      expect(strip(on.payload.comments)).toEqual(strip(withoutDeadParents(off.payload.comments)));
      expect(await (unreadCount as any)._handler(c, { team_id: TEAM, comments_from_review: true }))
        .toBe(await (unreadCount as any)._handler(c, { team_id: TEAM }));
    }
  });
});
