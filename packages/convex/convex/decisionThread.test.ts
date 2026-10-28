import { describe, expect, test } from "bun:test";
import { makeFakeDb, schemaIndexes } from "./testDb";
import schema from "./schema";
import { askCore, commentCore, decisionRootKey, decisionThreadKind, deleteCore, editCore, relayDecisionReply, resolveCore, thread, myThreads } from "./decisionThread";
import { escalateCore, passCore } from "./decisionHandoff";
import { backfill } from "./decisionThreadBackfill";
import { markRead } from "./threads";
import { formatDecisionDiscussion, parseDecisionDiscussion } from "@codecast/shared/contracts";

// A decision's team thread (decisionThread.ts): comments are review_comments
// rows anchored by decision_id alone; people write them, and a session
// speaks only when asked (the Ask button or an @mention), filling a
// placeholder; the owner, the thread's people and @mentions are notified,
// never the author; authors edit and delete their own; the thread resolves;
// unread rides thread_reads' decision kind; pass and escalate leave entries;
// older discussion[] comes over by a backfill.

const HOST = "users_host" as any; // owns the asking session; the decision is asked of them
const MATE = "users_mate" as any;
const OTHER = "users_other" as any;
const MGR = "users_mgr" as any;
const OUTSIDER = "users_out" as any;
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;

function seed(over: Record<string, any> = {}) {
  const tables: Record<string, any[]> = {
    users: [
      { _id: HOST, name: "Ashot", email: "ashot@acme.dev" },
      { _id: MATE, name: "Samvit", email: "samvit@acme.dev" },
      { _id: OTHER, name: "Jason", email: "jason@acme.dev" },
      { _id: MGR, name: "Armen", email: "armen@acme.dev" },
      { _id: OUTSIDER, name: "Outsider", email: "out@else.dev" },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    team_memberships: [
      { _id: "m1", user_id: HOST, team_id: TEAM, role: "admin", reports_to_user_id: MGR },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member" },
      { _id: "m3", user_id: OTHER, team_id: TEAM, role: "member" },
      { _id: "m4", user_id: MGR, team_id: TEAM, role: "admin" },
    ],
    org_roles: [],
    anchors: [],
    conversations: [
      { _id: "conversations_ask", short_id: "jxask01", session_id: "sess-ask", user_id: HOST, owner_user_id: HOST, team_id: TEAM, is_private: false, team_visibility: "full", title: "Fix the cart", message_count: 4 },
    ],
    session_owners: [{ _id: "so1", conversation_id: "conversations_ask", user_id: HOST, added_by: HOST, added_at: NOW }],
    session_decisions: [{
      _id: "session_decisions_d1", short_id: "sd-9", conversation_id: "conversations_ask", session_id: "sess-ask", user_id: HOST, asked_user_ids: [HOST],
      question: "Ship the cart fix?", options: [{ label: "Ship" }, { label: "Revise" }], blocking: true, status: "pending", created_at: NOW, ...over,
    }],
    decision_inbox: [],
    review_comments: [],
    thread_reads: [],
    notifications: [],
    pending_messages: [],
    messages: [],
  };
  const db = makeFakeDb(tables, { indexes: schemaIndexes(schema as any), strictPatch: true });
  const ctx = { db, scheduler: { runAfter: async () => {} } } as any;
  return { ctx, tables };
}

const as = (ctx: any, userId: string) => ({ ...ctx, auth: { async getUserIdentity() { return { subject: `${userId}|session` }; } } });
const call = (fn: any, ctx: any, args: any) => (fn as any)._handler(ctx, args);
const notesTo = (tables: Record<string, any[]>, user: string) => tables.notifications.filter((n) => String(n.recipient_user_id) === String(user));
const threadRows = (tables: Record<string, any[]>) => tables.review_comments.filter((c) => String(c.decision_id) === "session_decisions_d1");

describe("a comment on a decision", () => {
  test("is a review_comments row anchored by decision_id alone, for people: no session hears it", async () => {
    const { ctx, tables } = seed();
    const r = await commentCore(ctx, MATE, { decision: "sd-9", text: "Does this touch checkout?", client_id: "c1" });
    expect("ok" in r && r.asked).toEqual([]);
    const [row] = threadRows(tables);
    expect(row).toMatchObject({ content: "Does this touch checkout?", author_kind: "user", author_user_id: MATE, workspace: `team:${TEAM}` });
    for (const field of ["conversation_id", "source_comment_id", "origin", "pending_review", "decision_waiting"]) expect(row[field]).toBeUndefined();
    expect(tables.pending_messages).toHaveLength(0);
  });

  test("a redelivered send is one comment; an outsider and an empty comment are refused", async () => {
    const { ctx, tables } = seed();
    await commentCore(ctx, MATE, { decision: "sd-9", text: "hm?", client_id: "c2" });
    await commentCore(ctx, MATE, { decision: "sd-9", text: "hm?", client_id: "c2" });
    expect(threadRows(tables)).toHaveLength(1);
    expect(await commentCore(ctx, OUTSIDER, { decision: "sd-9", text: "let me in", client_id: "c3" })).toEqual({ error: "Decision not found" });
    expect(await commentCore(ctx, MATE, { decision: "sd-9", text: "  ", client_id: "c4" })).toEqual({ error: "The comment is empty" });
  });

  test("a reply hangs under the root of the comment it answers", async () => {
    const { ctx, tables } = seed();
    const root = await commentCore(ctx, MATE, { decision: "sd-9", text: "root", client_id: "r1" });
    const reply = await commentCore(ctx, HOST, { decision: "sd-9", text: "reply", client_id: "r2", parent_id: String((root as any).comment_id) });
    await commentCore(ctx, OTHER, { decision: "sd-9", text: "reply to the reply", client_id: "r3", parent_id: String((reply as any).comment_id) });
    const [, second, third] = threadRows(tables);
    expect(String(second.parent_id)).toBe(String((root as any).comment_id));
    expect(String(third.parent_id)).toBe(String((root as any).comment_id));
  });

  test("its author edits and deletes it; nobody else can", async () => {
    const { ctx, tables } = seed();
    const r: any = await commentCore(ctx, MATE, { decision: "sd-9", text: "first try", client_id: "e1" });
    expect(await editCore(ctx, HOST, { comment_id: String(r.comment_id), text: "hijack" })).toEqual({ error: "Only its author can change a comment" });
    expect(await editCore(ctx, MATE, { comment_id: String(r.comment_id), text: "second try" })).toEqual({ ok: true });
    expect(threadRows(tables)[0].content).toBe("second try");
    expect(await deleteCore(ctx, HOST, { comment_id: String(r.comment_id) })).toEqual({ error: "Only its author can change a comment" });
    expect(await deleteCore(ctx, MATE, { comment_id: String(r.comment_id) })).toEqual({ ok: true });
    expect(threadRows(tables)).toHaveLength(0);
  });

  test("resolve stamps every row, reopen clears them, and a later comment reads as open", async () => {
    const { ctx, tables } = seed();
    await commentCore(ctx, MATE, { decision: "sd-9", text: "one", client_id: "z1" });
    await commentCore(ctx, HOST, { decision: "sd-9", text: "two", client_id: "z2" });
    expect(await resolveCore(ctx, HOST, { decision: "sd-9", resolved: true })).toEqual({ ok: true });
    expect(threadRows(tables).every((c) => c.resolved && c.resolved_at && c.resolved_by === HOST)).toBe(true);
    await commentCore(ctx, MATE, { decision: "sd-9", text: "three", client_id: "z3" });
    expect(threadRows(tables)[2].resolved_at).toBeUndefined();
    await resolveCore(ctx, HOST, { decision: "sd-9", resolved: false });
    expect(threadRows(tables).some((c) => c.resolved_at)).toBe(false);
    expect(await resolveCore(ctx, OUTSIDER, { decision: "sd-9", resolved: true })).toEqual({ error: "Decision not found" });
  });
});

describe("who hears about it", () => {
  test("the owner, the thread's people and @mentions who can read it, never the author, once per batch", async () => {
    const { ctx, tables } = seed();
    // Each write a millisecond after the last, as real ones are.
    const realNow = Date.now;
    let clock = NOW;
    Date.now = () => ++clock;
    try {
      await commentCore(ctx, MATE, { decision: "sd-9", text: "Does this touch checkout?", client_id: "n1" });
      expect(notesTo(tables, MATE)).toHaveLength(0);
      expect(notesTo(tables, HOST).map((n) => n.type)).toEqual(["decision_comment"]);

      await commentCore(ctx, HOST, { decision: "sd-9", text: "@jason can you check, and @out too?", client_id: "n2" });
      expect(notesTo(tables, HOST)).toHaveLength(1);
      expect(notesTo(tables, MATE).map((n) => n.type)).toEqual(["decision_comment"]);
      expect(notesTo(tables, OTHER).map((n) => n.type)).toEqual(["mention"]);
      expect(notesTo(tables, OUTSIDER)).toHaveLength(0);

      // Samvit has not read the thread since: one notice covers the batch.
      await commentCore(ctx, HOST, { decision: "sd-9", text: "anyone?", client_id: "n3" });
      expect(notesTo(tables, MATE)).toHaveLength(1);
      expect(notesTo(tables, OTHER)).toHaveLength(1);
    } finally { Date.now = realNow; }
  });
});

describe("asking the session", () => {
  const frame = (body: string) => formatDecisionDiscussion({ decision: "sd-9", question: "Ship the cart fix?", from: "Samvit", body });
  const say = async (ctx: any, tables: Record<string, any[]>, i: number, role: string, content: string, extra: Record<string, any> = {}) => {
    const m = { _id: `messages_${i}`, conversation_id: "conversations_ask", role, content, timestamp: NOW + i * 1000, ...extra };
    tables.messages.push(m);
    if (role === "assistant") await relayDecisionReply(ctx, "conversations_ask" as any, m as any);
  };
  const atNow = async <T,>(fn: () => Promise<T>) => { const now = Date.now; Date.now = () => NOW; try { return await fn(); } finally { Date.now = now; } };

  test("Ask sends it the thread and its answer fills the placeholder, growing with the turn", async () => {
    const { ctx, tables } = seed();
    await atNow(() => commentCore(ctx, MATE, { decision: "sd-9", text: "Does this touch checkout?", client_id: "s1" }));
    const asked: any = await atNow(() => askCore(ctx, MATE, { decision: "sd-9", client_id: "ask1" }));
    const sent = tables.pending_messages.find((m) => m.client_id === "ask1");
    expect(String(sent.conversation_id)).toBe("conversations_ask");
    expect(parseDecisionDiscussion(sent.content)?.body).toContain("Samvit: Does this touch checkout?");
    const placeholder = () => tables.review_comments.find((c) => String(c._id) === String(asked.comment_id));
    expect(placeholder()).toMatchObject({ author_kind: "agent", agent_status: "thinking", content: "", decision_waiting: true, decision_session_id: "conversations_ask" });

    await say(ctx, tables, 1, "assistant", "earlier work, before the ask reached it");
    expect(placeholder().content).toBe("");
    await say(ctx, tables, 2, "user", frame("Samvit: Does this touch checkout?"), { client_id: "ask1" });
    await say(ctx, tables, 3, "assistant", "Reading the diff.");
    expect(placeholder()).toMatchObject({ content: "Reading the diff.", agent_status: "done" });
    // The person who asked hears the answer.
    expect(notesTo(tables, MATE).map((n) => n.type)).toEqual(["decision_comment"]);
    await say(ctx, tables, 4, "user", "", { tool_results: [{ tool_use_id: "t", content: "ok" }] });
    await say(ctx, tables, 5, "assistant", "No: it only changes the cart total.");
    expect(placeholder().content).toBe("No: it only changes the cart total.");
    expect(notesTo(tables, MATE)).toHaveLength(1);

    await say(ctx, tables, 6, "user", "something else entirely");
    await say(ctx, tables, 7, "assistant", "not about the decision");
    expect(placeholder()).toMatchObject({ content: "No: it only changes the cart total." });
    expect(placeholder().decision_waiting).toBeUndefined();
    expect(threadRows(tables)).toHaveLength(2);
  });

  test("an @mention of a session asks it; Ask with no session says so", async () => {
    const { ctx, tables } = seed();
    const r: any = await commentCore(ctx, MATE, { decision: "sd-9", text: "@[Fix the cart jxask01] does this touch checkout?", client_id: "m1" });
    expect(r.asked).toEqual(["conversations_ask"]);
    expect(tables.pending_messages).toHaveLength(1);
    expect(threadRows(tables).filter((c) => c.agent_status === "thinking")).toHaveLength(1);

    const lone = seed({ conversation_id: "conversations_gone" });
    lone.tables.conversations.push({ _id: "conversations_gone", user_id: HOST, team_id: TEAM, is_private: false, team_visibility: "full", inbox_killed_at: NOW, message_count: 0 });
    const none: any = await askCore(lone.ctx, HOST, { decision: "sd-9", client_id: "a0" });
    expect(lone.tables.review_comments.find((c) => String(c._id) === String(none.comment_id))).toMatchObject({ agent_status: "error" });
  });

  test("`cast decide comment` from the asked session fills its placeholder", async () => {
    const { ctx, tables } = seed();
    const asked: any = await askCore(ctx, MATE, { decision: "sd-9", client_id: "a1" });
    const r = await commentCore(ctx, HOST, { decision: "sd-9", text: "Because the total was wrong.", client_id: "a2", session_id: "conversations_ask" });
    expect("ok" in r && String(r.comment_id)).toBe(String(asked.comment_id));
    expect(threadRows(tables)).toHaveLength(1);
    expect(threadRows(tables)[0]).toMatchObject({ author_kind: "agent", agent_status: "done", content: "Because the total was wrong." });
    expect(threadRows(tables)[0].decision_waiting).toBeUndefined();
  });
});

describe("unread", () => {
  test("shows on the decision's thread for the owner and clears when they read it", async () => {
    const { ctx, tables } = seed();
    await commentCore(ctx, MATE, { decision: "sd-9", text: "first", client_id: "u1" });
    await commentCore(ctx, MATE, { decision: "sd-9", text: "second", client_id: "u2" });
    const view = await call(thread, as(ctx, HOST), { decision_id: "sd-9" });
    expect(view.comments.map((c: any) => [c.author_name, c.content])).toEqual([["Samvit", "first"], ["Samvit", "second"]]);
    expect(view.read).toMatchObject({ kind: "decision", root_key: decisionRootKey("session_decisions_d1"), decision_id: "session_decisions_d1", unread: 2, title: "Ship the cart fix?" });
    expect((await call(myThreads, as(ctx, HOST), {}))[0].unread).toBe(2);
    // The author reads nothing new.
    expect((await call(thread, as(ctx, MATE), { decision_id: "sd-9" })).read.unread).toBe(0);

    await call(markRead, as(ctx, HOST), { kind: "decision", root_key: decisionRootKey("session_decisions_d1") });
    expect((await call(thread, as(ctx, HOST), { decision_id: "sd-9" })).read.unread).toBe(0);
    expect((await call(myThreads, as(ctx, HOST), {}))[0].unread).toBe(0);
    const read = tables.thread_reads.find((r) => r.user_id === HOST);
    expect(await decisionThreadKind.unread(ctx, HOST, read, {})).toEqual({ unread: 0, unread_capped: false });
  });
});

describe("hand-offs in the thread", () => {
  test("a pass and an escalation each leave an entry with the note and whom it went to", async () => {
    const { ctx, tables } = seed();
    // The escalation a moment after the pass, as real ones are.
    const realNow = Date.now;
    let clock = NOW;
    Date.now = () => ++clock;
    try {
      expect(await passCore(ctx, HOST, "sd-9", { kind: "user", id: MATE }, "You own the parser now.")).toEqual({ passed: true });
      expect((await escalateCore(ctx, MATE, "sd-9", "Needs a call on budget")) as any).toMatchObject({ escalated: true });
    } finally { Date.now = realNow; }
    const [passed, escalated] = threadRows(tables);
    expect(passed).toMatchObject({ decision_event: "passed", author_user_id: HOST, content: "You own the parser now.", decision_event_to: { kind: "user", ids: [MATE] } });
    expect(escalated).toMatchObject({ decision_event: "escalated", author_user_id: MATE, content: "Needs a call on budget" });
    const view = await call(thread, as(ctx, HOST), { decision_id: "sd-9" });
    expect(view.comments[0]).toMatchObject({ author_name: "Ashot", event_to_names: ["Samvit"], decision_event: "passed" });
    // The new owner has the thread, filed by the pass.
    expect(tables.thread_reads.some((r) => r.user_id === MATE && r.kind === "decision")).toBe(true);
  });
});

describe("the backfill", () => {
  test("is a dry run by default, then writes discussion[] and the hand-off once", async () => {
    const { ctx, tables } = seed({
      discussion: [{ conversation_id: "conversations_ask", user_id: MATE, text: "Why a new table?", client_id: "old1", at: NOW + 1000 }],
      passed_to: { kind: "user", id: MATE, by: HOST, at: NOW + 500, note: "Yours", from: [HOST] },
    });
    tables.messages.push(
      { _id: "messages_1", conversation_id: "conversations_ask", role: "user", content: formatDecisionDiscussion({ decision: "sd-9", question: "Ship the cart fix?", from: "Samvit", body: "Why a new table?" }), timestamp: NOW + 2000 },
      { _id: "messages_2", conversation_id: "conversations_ask", role: "assistant", content: "The bodies exceed the row cap.", timestamp: NOW + 3000 },
    );
    const dry = await call(backfill, ctx, {});
    expect(dry).toMatchObject({ dry_run: true, decisions: 1, comments: 1, replies: 1, handoffs: 1 });
    expect(threadRows(tables)).toHaveLength(0);

    const wet = await call(backfill, ctx, { dry_run: false });
    expect(wet).toMatchObject({ dry_run: false, comments: 1, replies: 1, handoffs: 1 });
    const rows = threadRows(tables);
    expect(rows.map((r) => r.decision_event ?? r.author_kind)).toEqual(["user", "agent", "passed"]);
    expect(String(rows[1].parent_id)).toBe(String(rows[0]._id));
    expect(rows.every((r) => r.workspace === `team:${TEAM}` && !r.conversation_id && !r.source_comment_id)).toBe(true);
    expect(tables.pending_messages).toHaveLength(0);
    expect(tables.notifications).toHaveLength(0);

    expect(await call(backfill, ctx, { dry_run: false })).toMatchObject({ decisions: 0, comments: 0, replies: 0, handoffs: 0 });
    expect(threadRows(tables)).toHaveLength(3);
  });
});
