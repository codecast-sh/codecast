import { describe, expect, test } from "bun:test";
import {
  isGcableEmptyConversation,
  hasLiveDraft,
  shouldReapEmpty,
  conversationHasNoWork,
  reapEmptyConversation,
  cascadeHideToNestedChildren,
} from "./cleanup";

// Minimal in-memory ctx.db honoring the .withIndex(name, q => q.eq(field,val))
// chains the cleanup helpers use, so the reap logic is testable without the full
// convex harness. eq() filters are applied; range ops (gte/gt/lt) are no-ops.
function makeFakeDb(tables: Record<string, any[]>) {
  const inserted: Array<{ table: string; doc: any }> = [];
  const deleted: any[] = [];
  const db: any = {
    _inserted: inserted,
    _deleted: deleted,
    query(table: string) {
      const filters: Array<[string, any]> = [];
      // Copies, matching Convex semantics: a fetched row is a snapshot that a
      // later patch never mutates (applyHideTransition's transition gate needs
      // the PRE-patch flags on the row it was handed).
      const apply = () => (tables[table] ?? []).filter((r) => filters.every(([f, v]) => r[f] === v)).map((r) => ({ ...r }));
      const builder: any = {
        withIndex(_name: string, fn?: (q: any) => any) {
          if (fn) {
            const q: any = {
              eq(field: string, val: any) { filters.push([field, val]); return q; },
              gte() { return q; }, gt() { return q; }, lt() { return q; },
            };
            fn(q);
          }
          return builder;
        },
        order() { return builder; },
        async first() { return apply()[0] ?? null; },
        async collect() { return apply(); },
        async take(n: number) { return apply().slice(0, n); },
      };
      return builder;
    },
    async get(id: any) {
      for (const rows of Object.values(tables)) { const r = rows.find((x: any) => x._id === id); if (r) return r; }
      return null;
    },
    async insert(table: string, doc: any) {
      const _id = `${table}_${inserted.length + 1}`;
      (tables[table] ??= []).push({ _id, ...doc });
      inserted.push({ table, doc });
      return _id;
    },
    async delete(id: any) {
      deleted.push(id);
      for (const rows of Object.values(tables)) { const i = rows.findIndex((x: any) => x._id === id); if (i >= 0) rows.splice(i, 1); }
    },
    // Applied, not a no-op: the hide cascade reads back the flags it writes
    // (the already-hidden skip), so patches must land on the row objects.
    async patch(id: any, fields: any) {
      for (const rows of Object.values(tables)) { const r = rows.find((x: any) => x._id === id); if (r) Object.assign(r, fields); }
    },
  };
  return db;
}

// Row-level qualification for the abandoned empty-conversation GC. Anything
// signaling user intent or attached work must disqualify — these rows get
// HARD-DELETED, so the predicate errs closed.
describe("isGcableEmptyConversation", () => {
  test("a plain abandoned blank row qualifies", () => {
    expect(isGcableEmptyConversation({ message_count: 0 })).toBe(true);
    expect(isGcableEmptyConversation({})).toBe(true);
  });

  test("anything with messages or pending sends is kept", () => {
    expect(isGcableEmptyConversation({ message_count: 1 })).toBe(false);
    expect(isGcableEmptyConversation({ message_count: 0, has_pending_messages: true })).toBe(false);
  });

  test("user intent keeps the row: drafts, pins, favorites, custom titles, shares", () => {
    expect(isGcableEmptyConversation({ draft_message: "half-typed thought" })).toBe(false);
    expect(isGcableEmptyConversation({ draft_message: "   " })).toBe(true); // whitespace ≠ intent
    expect(isGcableEmptyConversation({ inbox_pinned_at: 123 })).toBe(false);
    expect(isGcableEmptyConversation({ is_favorite: true })).toBe(false);
    expect(isGcableEmptyConversation({ title_is_custom: true })).toBe(false);
    expect(isGcableEmptyConversation({ share_token: "tok" })).toBe(false);
  });

  test("attached work keeps the row: tasks, plans, workflows, forks, subagents", () => {
    expect(isGcableEmptyConversation({ active_task_id: "t" })).toBe(false);
    expect(isGcableEmptyConversation({ active_plan_id: "p" })).toBe(false);
    expect(isGcableEmptyConversation({ plan_ids: ["p"] })).toBe(false);
    expect(isGcableEmptyConversation({ workflow_run_id: "w" })).toBe(false);
    expect(isGcableEmptyConversation({ is_workflow_primary: true })).toBe(false);
    expect(isGcableEmptyConversation({ forked_from: "c" })).toBe(false);
    // A fork mid-copy legitimately has 0 messages — never sweep it.
    expect(isGcableEmptyConversation({ fork_status: "copying" })).toBe(false);
    expect(isGcableEmptyConversation({ is_subagent: true })).toBe(false);
    expect(isGcableEmptyConversation({ parent_conversation_id: "c" })).toBe(false);
  });
});

// The narrow exception to the daemon's "dismissal isn't a worker lifecycle
// signal" rule: a live heartbeat protects an empty pre-warm ONLY while it's still
// active. A dismissed empty pre-warm is cruft — its idle agent gets reaped.
describe("shouldReapEmpty", () => {
  test("an undismissed empty with a live agent is protected (fresh pre-warm / open terminal)", () => {
    expect(shouldReapEmpty({}, true)).toBe(false);
  });
  test("a DISMISSED empty with a live agent is reaped — this is the zombie-agent fix", () => {
    expect(shouldReapEmpty({ inbox_dismissed_at: 123 }, true)).toBe(true);
  });
  test("an empty with no live agent is always reaped, dismissed or not", () => {
    expect(shouldReapEmpty({}, false)).toBe(true);
    expect(shouldReapEmpty({ inbox_dismissed_at: 123 }, false)).toBe(true);
  });
  test("a STASHED empty with a live agent is reaped — an empty blank has nothing worth keeping alive", () => {
    expect(shouldReapEmpty({ inbox_stashed_at: 123 }, true)).toBe(true);
    expect(shouldReapEmpty({ inbox_stashed_at: 123 }, false)).toBe(true);
  });
});

describe("reapEmptyConversation", () => {
  const liveHb = Date.now();                       // fresh heartbeat → live agent
  const staleHb = Date.now() - 2 * 60 * 60 * 1000; // 2h old → agent gone

  test("a LIVE agent → enqueue kill_session and DEFER deletion (deleting first orphans the tmux)", async () => {
    const tables: Record<string, any[]> = {
      conversations: [{ _id: "c1", user_id: "u1" }],
      managed_sessions: [{ _id: "m1", conversation_id: "c1", last_heartbeat: liveHb }],
      conversation_git_diffs: [{ _id: "d1", conversation_id: "c1" }],
      daemon_commands: [],
    };
    const db = makeFakeDb(tables);
    const outcome = await reapEmptyConversation({ db }, { _id: "c1", user_id: "u1" });
    expect(outcome).toBe("kill_enqueued");
    const cmd = db._inserted.find((i: any) => i.table === "daemon_commands");
    expect(cmd?.doc.command).toBe("kill_session");
    expect(JSON.parse(cmd.doc.args).conversation_id).toBe("c1");
    // The conversation + managed row MUST survive — the daemon resolves the tmux
    // from them. Deleting here is the bug; the next pass (agent gone) deletes.
    expect(db._deleted).not.toContain("c1");
    expect(db._deleted).not.toContain("m1");
  });

  test("no live agent (stale managed row) → delete the conversation + stale row + diffs, no kill", async () => {
    const tables: Record<string, any[]> = {
      conversations: [{ _id: "c2", user_id: "u1" }],
      managed_sessions: [{ _id: "m2", conversation_id: "c2", last_heartbeat: staleHb }],
      conversation_git_diffs: [{ _id: "d2", conversation_id: "c2" }],
      daemon_commands: [],
    };
    const db = makeFakeDb(tables);
    const outcome = await reapEmptyConversation({ db }, { _id: "c2", user_id: "u1" });
    expect(outcome).toBe("deleted");
    expect(db._inserted.find((i: any) => i.table === "daemon_commands")).toBeUndefined();
    expect(db._deleted).toEqual(expect.arrayContaining(["c2", "m2", "d2"]));
  });

  test("no managed session at all → delete the empty conversation, no kill", async () => {
    const tables: Record<string, any[]> = {
      conversations: [{ _id: "c3", user_id: "u1" }],
      managed_sessions: [],
      conversation_git_diffs: [],
      daemon_commands: [],
    };
    const db = makeFakeDb(tables);
    expect(await reapEmptyConversation({ db }, { _id: "c3", user_id: "u1" })).toBe("deleted");
    expect(db._inserted.find((i: any) => i.table === "daemon_commands")).toBeUndefined();
    expect(db._deleted).toContain("c3");
  });

  test("a live agent with a kill already pending → no duplicate command (dedup)", async () => {
    const tables: Record<string, any[]> = {
      conversations: [{ _id: "c4", user_id: "u1" }],
      managed_sessions: [{ _id: "m4", conversation_id: "c4", last_heartbeat: liveHb }],
      conversation_git_diffs: [],
      daemon_commands: [{ _id: "cmdX", user_id: "u1", command: "kill_session", args: JSON.stringify({ conversation_id: "c4" }), created_at: liveHb, _creationTime: liveHb }],
    };
    const db = makeFakeDb(tables);
    expect(await reapEmptyConversation({ db }, { _id: "c4", user_id: "u1" })).toBe("kill_enqueued");
    expect(db._inserted.filter((i: any) => i.table === "daemon_commands").length).toBe(0);
  });
});

describe("conversationHasNoWork", () => {
  const empty = { _id: "c1", user_id: "u1", message_count: 0 };
  test("a truly empty conversation has no work", async () => {
    const db = makeFakeDb({ messages: [], pending_messages: [], client_state: [] });
    expect(await conversationHasNoWork({ db }, empty)).toBe(true);
  });
  test("an actual message keeps it (denormalized count can lag)", async () => {
    const db = makeFakeDb({ messages: [{ _id: "x", conversation_id: "c1" }], pending_messages: [], client_state: [] });
    expect(await conversationHasNoWork({ db }, empty)).toBe(false);
  });
  test("a pending send keeps it", async () => {
    const db = makeFakeDb({ messages: [], pending_messages: [{ _id: "p", conversation_id: "c1" }], client_state: [] });
    expect(await conversationHasNoWork({ db }, empty)).toBe(false);
  });
  test("a live per-user draft for this conversation keeps it", async () => {
    const db = makeFakeDb({ messages: [], pending_messages: [], client_state: [{ _id: "cs", user_id: "u1", drafts: { c1: { draft_message: "wip" } } }] });
    expect(await conversationHasNoWork({ db }, empty)).toBe(false);
  });
  test("row-level intent (custom title) keeps it without touching the source tables", async () => {
    const db = makeFakeDb({ messages: [], pending_messages: [], client_state: [] });
    expect(await conversationHasNoWork({ db }, { ...empty, title_is_custom: true })).toBe(false);
  });
});

describe("hasLiveDraft", () => {
  test("non-empty text or attachments count as a live draft", () => {
    expect(hasLiveDraft({ draft_message: "wip" })).toBe(true);
    expect(hasLiveDraft({ draft_message: "", draft_images: ["s1"] })).toBe(true);
  });

  test("cleared or empty entries do not", () => {
    expect(hasLiveDraft(null)).toBe(false);
    expect(hasLiveDraft(undefined)).toBe(false);
    expect(hasLiveDraft({ draft_message: "" })).toBe(false);
    expect(hasLiveDraft({ draft_message: "   " })).toBe(false);
    expect(hasLiveDraft({})).toBe(false);
  });
});

// Server-side hide cascade: killing/stashing a session takes the whole nested
// group (Task subagents + agent-team teammates) — the same set the inbox
// renders beneath the card. Bug history: cast kill on a team lead stranded its
// teammates as loose top-level needs-input cards (only the web store's
// optimistic sweep cascaded, and only over parent_conversation_id).
describe("cascadeHideToNestedChildren", () => {
  const LEAD = "conv_lead";
  const mkTables = (): Record<string, any[]> => ({
    conversations: [
      { _id: LEAD, user_id: "u1", agent_team_name: "session-team", agent_name: "team-lead", message_count: 10 },
      { _id: "conv_sub", user_id: "u1", session_id: "s-sub", parent_conversation_id: LEAD, is_subagent: true, message_count: 5 },
      { _id: "conv_mate", user_id: "u1", session_id: "s-mate", spawned_by_conversation_id: LEAD, agent_team_name: "session-team", agent_name: "review-worker", message_count: 5 },
      // cast-spawn lineage: spawned_by WITHOUT a team name stays first-class.
      { _id: "conv_spawn", user_id: "u1", session_id: "s-spawn", spawned_by_conversation_id: LEAD, message_count: 5 },
      { _id: "conv_fork", user_id: "u1", session_id: "s-fork", forked_from: LEAD, message_count: 5 },
    ],
    daemon_commands: [],
    messages: [],
    pending_messages: [],
    managed_sessions: [],
    client_state: [],
    agent_tasks: [],
  });

  test("kill cascade dismisses Task subagents AND teammates, with full kill side effects", async () => {
    const tables = mkTables();
    const db = makeFakeDb(tables);
    const lead = tables.conversations[0];

    const cascaded = await cascadeHideToNestedChildren({ db }, lead, { inbox_dismissed_at: 111 });
    expect(cascaded).toBe(2);

    const row = (id: string) => tables.conversations.find((r: any) => r._id === id)!;
    expect(row("conv_sub").inbox_dismissed_at).toBe(111);
    expect(row("conv_mate").inbox_dismissed_at).toBe(111);
    // applyHideTransition ran per child: retired + teardown enqueued.
    expect(row("conv_sub").status).toBe("completed");
    expect(row("conv_mate").inbox_killed_at).toBeGreaterThan(0);
    const kills = db._inserted.filter((i: any) => i.table === "daemon_commands");
    expect(kills).toHaveLength(2);
    // First-class lineages untouched.
    expect(row("conv_spawn").inbox_dismissed_at).toBeUndefined();
    expect(row("conv_fork").inbox_dismissed_at).toBeUndefined();
  });

  test("already-hidden children are skipped — a re-asserted hide never re-kills", async () => {
    const tables = mkTables();
    const db = makeFakeDb(tables);
    const lead = tables.conversations[0];

    await cascadeHideToNestedChildren({ db }, lead, { inbox_dismissed_at: 111 });
    const again = await cascadeHideToNestedChildren({ db }, lead, { inbox_dismissed_at: 222 });
    expect(again).toBe(0);
    expect(tables.conversations.find((r: any) => r._id === "conv_sub")!.inbox_dismissed_at).toBe(111);
    expect(db._inserted.filter((i: any) => i.table === "daemon_commands")).toHaveLength(2);
  });

  test("stash cascade sets inbox_stashed_at only — agents stay alive", async () => {
    const tables = mkTables();
    const db = makeFakeDb(tables);
    const lead = tables.conversations[0];

    const cascaded = await cascadeHideToNestedChildren({ db }, lead, { inbox_stashed_at: 333 });
    expect(cascaded).toBe(2);
    const row = (id: string) => tables.conversations.find((r: any) => r._id === id)!;
    expect(row("conv_mate").inbox_stashed_at).toBe(333);
    expect(row("conv_mate").inbox_killed_at).toBeUndefined();
    expect(row("conv_sub").status).toBeUndefined();
    expect(db._inserted.filter((i: any) => i.table === "daemon_commands")).toHaveLength(0);
  });
});
