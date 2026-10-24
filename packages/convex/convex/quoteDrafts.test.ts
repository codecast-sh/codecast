import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { listForConversation as listQuotes, parseQuoteDrafts, remove, save, stampQuotesSent } from "./quoteDrafts";
import { canAccessComment, codeThreadRows, listForConversation, listForFile, listForPR, listForRef, pendingRowsFor } from "./codeComments";
import { list as listNotes, overduePromises } from "./reviewNotes";
import { markAnsweredReviewNotes } from "./lib/reviewAnswered";
import { sendMessageV2 } from "./pendingMessages";
import { dispatch } from "./dispatch";

const runDispatch = (ctx: any, action: string, args: any[], result?: any) =>
  (dispatch as any)._handler(ctx, { action, args, ...(result ? { result } : {}) });

const USER = "user_1" as any;
const OTHER = "user_2" as any;
const TEAM = "team_1" as any;
const CONV = "conv_1" as any;
const PR = "pr_1" as any;
const MSG = "msg_1" as any;
const REPO = "codecast-sh/codecast";

function context(user: string | null, seed: Record<string, any[]> = {}) {
  const db = makeFakeDb({
    users: [{ _id: USER, name: "Ashot" }, { _id: OTHER, name: "Sam" }],
    teams: [{ _id: TEAM, name: "Codecast" }],
    team_memberships: [
      { _id: "m1", user_id: USER, team_id: TEAM },
      { _id: "m2", user_id: OTHER, team_id: TEAM },
    ],
    github_app_installations: [
      { _id: "inst_1", team_id: TEAM, installation_id: 7, account_login: "codecast-sh", repository_selection: "all" },
    ],
    directory_team_mappings: [],
    session_owners: [],
    collab_grants: [],
    // Shared with the team, so a teammate can read the conversation: the
    // quotes on it must stay its author's anyway.
    conversations: [
      { _id: CONV, user_id: USER, owner_user_id: USER, team_id: TEAM, is_private: false, team_visibility: "full", session_id: "sess-1", title: "Git backend", status: "active", message_count: 1, updated_at: 1 },
    ],
    messages: [{ _id: MSG, conversation_id: CONV, role: "assistant", content: "Plan: rewrite the sync layer.", timestamp: 1 }],
    pull_requests: [
      { _id: PR, team_id: TEAM, repository: REPO, number: 12, title: "PR", state: "open", head_sha: "abc", linked_session_ids: [], created_at: 1, updated_at: 2 },
    ],
    review_comments: [],
    thread_reads: [],
    pending_messages: [],
    managed_sessions: [],
    conversation_execution_heads: [],
    execution_bindings: [],
    local_view_heads: [],
    local_command_receipts: [],
    change_log: [],
    ...seed,
  });
  return {
    db,
    auth: { async getUserIdentity() { return user ? { subject: `${user}|session` } : null; } },
    scheduler: { async runAfter() {} },
  } as any;
}

const draft = (over: Record<string, any> = {}) => ({
  client_id: "item-1",
  message_id: MSG,
  block_index: 2,
  quote: "rewrite the sync layer",
  body: "why now?",
  ...over,
});

async function saveAs(ctx: any, drafts: any[]) {
  return await (save as any)._handler(ctx, { conversation_id: CONV, drafts });
}

const rows = (ctx: any) => ctx.db._tables.review_comments as any[];

describe("quoteDrafts.save", () => {
  test("writes an author-only quote row keyed by the batch item id", async () => {
    const ctx = context(USER);
    await saveAs(ctx, [draft({ verdict: "cut" })]);
    const [row] = rows(ctx);
    expect(row).toMatchObject({
      origin: "quote",
      client_id: "item-1",
      conversation_id: CONV,
      message_id: MSG,
      block_index: 2,
      prose_anchor: { text: "rewrite the sync layer", index: 2 },
      verdict: "cut",
      content: "why now?",
      author_user_id: USER,
      resolved: false,
    });
    expect(row.sent_at).toBeUndefined();
    expect(await canAccessComment(ctx, USER, row)).toBe(true);
    // The teammate can read the conversation, never the quote.
    expect(await canAccessComment(ctx, OTHER, row)).toBe(false);
  });

  test("is idempotent by client_id: a second save edits the same row", async () => {
    const ctx = context(USER);
    await saveAs(ctx, [draft()]);
    await saveAs(ctx, [draft({ body: "edited" })]);
    await saveAs(ctx, [draft({ body: "edited" })]);
    expect(rows(ctx)).toHaveLength(1);
    expect(rows(ctx)[0].content).toBe("edited");
  });

  test("another person's same client_id is their own row", async () => {
    const ctx = context(USER);
    await saveAs(ctx, [draft()]);
    const other = context(OTHER);
    other.db._tables.review_comments = ctx.db._tables.review_comments;
    await saveAs(other, [draft({ body: "mine" })]);
    expect(rows(ctx)).toHaveLength(2);
    expect(rows(ctx).find((r) => r.author_user_id === USER).content).toBe("why now?");
  });

  test("a message id from another conversation, or a stub, is not stored", async () => {
    const ctx = context(USER, {
      messages: [{ _id: "msg_9", conversation_id: "conv_9", role: "assistant", content: "x", timestamp: 1 }],
    });
    await saveAs(ctx, [draft({ client_id: "a", message_id: "msg_9" }), draft({ client_id: "b", message_id: "msg_1#plan" })]);
    expect(rows(ctx).map((r) => r.message_id)).toEqual([undefined, undefined]);
  });

  test("refuses a conversation the caller cannot read", async () => {
    const ctx = context("user_3");
    ctx.db._tables.users.push({ _id: "user_3", name: "Stranger" });
    await expect(saveAs(ctx, [draft()])).rejects.toThrow("Conversation not found");
    expect(rows(ctx)).toHaveLength(0);
  });

  test("a sent quote is a record: a replayed save leaves it as sent", async () => {
    const ctx = context(USER);
    await saveAs(ctx, [draft()]);
    await stampQuotesSent(ctx, USER, CONV, "send-1", ["item-1"], null);
    await saveAs(ctx, [draft({ body: "changed after send" })]);
    expect(rows(ctx)[0].content).toBe("why now?");
  });
});

describe("quoteDrafts.remove", () => {
  test("drops unsent quotes and keeps sent ones", async () => {
    const ctx = context(USER);
    await saveAs(ctx, [draft({ client_id: "a" }), draft({ client_id: "b" })]);
    await stampQuotesSent(ctx, USER, CONV, "send-1", ["b"], null);
    const out = await (remove as any)._handler(ctx, { client_ids: ["a", "b", "missing"] });
    expect(out).toEqual({ removed: 1 });
    expect(rows(ctx).map((r) => r.client_id)).toEqual(["b"]);
  });

  test("never removes another person's quote", async () => {
    const ctx = context(USER);
    await saveAs(ctx, [draft()]);
    const other = context(OTHER);
    other.db._tables.review_comments = ctx.db._tables.review_comments;
    await (remove as any)._handler(other, { client_ids: ["item-1"] });
    expect(rows(ctx)).toHaveLength(1);
  });
});

describe("sending quotes with a message", () => {
  const sendArgs = (extra: Record<string, unknown> = {}) => ({
    command_id: "send-1",
    client_id: "send-1",
    conversation_id: CONV,
    content: "> rewrite the sync layer\n\nwhy now?",
    ...extra,
  });

  test("sendMessageV2 queues the message and stamps the quotes in the same mutation", async () => {
    const ctx = context(USER);
    await saveAs(ctx, [draft({ client_id: "a" }), draft({ client_id: "b" }), draft({ client_id: "c" })]);
    const receipt = await (sendMessageV2 as any)._handler(ctx, sendArgs({ quote_client_ids: ["a", "b", "missing"] }));
    expect(receipt.status).toBe("acknowledged");
    expect(ctx.db._tables.pending_messages).toHaveLength(1);
    const byId = Object.fromEntries(rows(ctx).map((r) => [r.client_id, r]));
    for (const id of ["a", "b"]) {
      expect(byId[id].sent_at).toBeNumber();
      expect(byId[id].sent_to_conversation_id).toBe(CONV);
      expect(byId[id].sent_client_id).toBe("send-1");
    }
    expect(byId.c.sent_at).toBeUndefined();
    // The shared outcome: no live process, so the message waits.
    expect(receipt.result.quotes).toEqual({ kind: "queued", sent_ids: [byId.a._id, byId.b._id].map(String), waiting: "offline" });
  });

  test("a replay of the same send stamps nothing twice and keeps its receipt", async () => {
    const ctx = context(USER);
    await saveAs(ctx, [draft()]);
    const first = await (sendMessageV2 as any)._handler(ctx, sendArgs({ quote_client_ids: ["item-1"] }));
    const stamped = rows(ctx)[0].sent_at;
    const again = await (sendMessageV2 as any)._handler(ctx, sendArgs({ quote_client_ids: ["item-1"] }));
    expect(again).toEqual(first);
    expect(rows(ctx)[0].sent_at).toBe(stamped);
    expect(ctx.db._tables.pending_messages).toHaveLength(1);
  });

  test("a send without quotes keeps its old receipt fingerprint and result", async () => {
    const ctx = context(USER);
    const receipt = await (sendMessageV2 as any)._handler(ctx, sendArgs());
    expect(receipt.status).toBe("acknowledged");
    expect(receipt.result).toBeUndefined();
    // The same command id with quotes is different intent.
    await expect((sendMessageV2 as any)._handler(ctx, sendArgs({ quote_client_ids: ["item-1"] }))).rejects.toThrow();
  });

  test("a quote sent in one message is not claimed by another", async () => {
    const ctx = context(USER);
    await saveAs(ctx, [draft()]);
    await stampQuotesSent(ctx, USER, CONV, "send-1", ["item-1"], null);
    const outcome = await stampQuotesSent(ctx, USER, CONV, "send-2", ["item-1"], null);
    expect(outcome).toEqual({ kind: "sent", sent_ids: [] });
    expect(rows(ctx)[0].sent_client_id).toBe("send-1");
  });

  test("the dispatch send passes the quote ids through; an older four-arg send is unchanged", async () => {
    const calls: any[] = [];
    const ctx = { ...context(USER), runMutation: async (_ref: any, args: any) => { calls.push(args); return { status: "acknowledged" }; } };
    const envelope = (id: string) => ({ receiptActionVersion: 1, commandId: id });
    await runDispatch(ctx, "sendMessage", [CONV, "hi", undefined, "c1", ["item-1"]], envelope("c1"));
    await runDispatch(ctx, "sendMessage", [CONV, "hi", undefined, "c2"], envelope("c2"));
    expect(calls[0].quote_client_ids).toEqual(["item-1"]);
    expect("quote_client_ids" in calls[1]).toBe(false);
  });

  test("the dispatch mirror skips a stub conversation and malformed items", async () => {
    const ctx = context(USER);
    await runDispatch(ctx, "saveQuoteDrafts", ["stub-123", [draft()]]);
    await runDispatch(ctx, "saveQuoteDrafts", [CONV, [{ client_id: 5 }, { nope: true }]]);
    expect(rows(ctx)).toHaveLength(0);
    expect(parseQuoteDrafts([draft({ verdict: "maybe" })])[0]).not.toHaveProperty("verdict");
  });
});

describe("the agent's reply answers a sent quote", () => {
  test("a reply quoting the quoted text stamps it answered; an unsent draft is never touched", async () => {
    const ctx = context(USER);
    await saveAs(ctx, [draft({ client_id: "a", quote: "rewrite the sync layer before the launch", body: "" }), draft({ client_id: "b" })]);
    await stampQuotesSent(ctx, USER, CONV, "send-1", ["a"], null);
    const sentAt = rows(ctx)[0].sent_at;
    await markAnsweredReviewNotes(ctx, CONV, {
      _id: "msg_2" as any,
      content: "> rewrite the sync layer before the launch\n\nBecause the old one drops writes.",
      timestamp: sentAt + 1,
    });
    const byId = Object.fromEntries(rows(ctx).map((r) => [r.client_id, r]));
    expect(byId.a.answered_message_id).toBe("msg_2");
    expect(byId.b.answered_at).toBeUndefined();
  });
});

describe("existing readers ignore quote rows", () => {
  async function seeded() {
    const ctx = context(USER);
    await saveAs(ctx, [draft()]);
    // A hostile row: shaped like a quote but also carrying every anchor a
    // code comment reader keys on. The readers must still skip it.
    ctx.db._tables.review_comments.push({
      _id: "rc_hostile", origin: "quote", client_id: "item-2", author_user_id: USER, conversation_id: CONV,
      pull_request_id: PR, repository: REPO, ref: "abc", file_path: "src/a.ts", line_number: 3,
      content: "quote", resolved: false, created_at: 2,
    });
    return ctx;
  }

  test("listForConversation, listForPR, listForRef, listForFile", async () => {
    for (const user of [USER, OTHER]) {
      const ctx = await seeded();
      ctx.auth = { async getUserIdentity() { return { subject: `${user}|session` }; } };
      expect(await (listForConversation as any)._handler(ctx, { conversation_id: CONV })).toEqual([]);
      expect(await (listForPR as any)._handler(ctx, { pull_request_id: PR })).toEqual([]);
      expect(await (listForRef as any)._handler(ctx, { repository: REPO, ref: "abc" })).toEqual([]);
      expect(await (listForFile as any)._handler(ctx, { repository: REPO, file_path: "src/a.ts" })).toEqual([]);
    }
  });

  test("Threads: a quote files no thread and joins no code thread", async () => {
    const ctx = await seeded();
    expect(ctx.db._tables.thread_reads).toHaveLength(0);
    const thread = await codeThreadRows(ctx, { repository: REPO, ref: "abc", file_path: "src/a.ts", line_number: 3 });
    // codeThreadRows reads by file; the real quote row has none.
    expect(thread.filter((r: any) => r.client_id === "item-1")).toEqual([]);
  });

  test("the pending review, cast review notes and the promise sweep", async () => {
    const ctx = await seeded();
    expect(await pendingRowsFor(ctx, USER, PR)).toEqual([]);
    expect(await (listNotes as any)._handler(ctx, { git_root: "/Users/ashot/src/codecast", include_sent: true })).toEqual([]);
    expect(await overduePromises(ctx.db, Date.now() + 1e9)).toEqual([]);
  });

  test("reviewAnswered: a draft that was never sent is not a candidate", async () => {
    const ctx = await seeded();
    await markAnsweredReviewNotes(ctx, CONV, { _id: "msg_2" as any, content: "> rewrite the sync layer\nwhy now?", timestamp: Date.now() + 1 });
    expect(rows(ctx).every((r) => r.answered_at === undefined)).toBe(true);
  });

  test("the viewer's own list is the one place a quote shows, and only to its author", async () => {
    const ctx = await seeded();
    const mine = await (listQuotes as any)._handler(ctx, { conversation_id: CONV });
    expect(mine.map((r: any) => r.client_id).sort()).toEqual(["item-1", "item-2"]);
    const other = await seeded();
    other.auth = { async getUserIdentity() { return { subject: `${OTHER}|session` }; } };
    expect(await (listQuotes as any)._handler(other, { conversation_id: CONV })).toEqual([]);
  });
});
