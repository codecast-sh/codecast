import { describe, expect, test } from "bun:test";
import {
  isGcableEmptyConversation,
  hasLiveDraft,
  shouldReapEmpty,
  conversationHasNoWork,
  reapEmptyConversation,
  cascadeHideToNestedChildren,
  applyHideTransition,
} from "./cleanup";
import { enqueuePendingMessage } from "./pendingMessages";

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

  // A FORCED kill takes the group down again: the lead's teardown is only as
  // good as its children's, and a resurrected teammate is exactly the bug
  // forcing exists to fix. Their hide stamps stay put — only teardown re-runs.
  test("a FORCED kill re-tears-down already-hidden children (group comes down as one unit)", async () => {
    const tables = mkTables();
    const db = makeFakeDb(tables);
    const lead = tables.conversations[0];
    const kills = () => db._inserted.filter((i: any) => i.table === "daemon_commands");

    await cascadeHideToNestedChildren({ db }, lead, { inbox_dismissed_at: 111 });
    expect(kills()).toHaveLength(2);
    // The daemon executed those kills; a resurrection bug brought the workers
    // back. Executed commands leave nothing pending, so the re-kill enqueues.
    for (const cmd of tables.daemon_commands) cmd.executed_at = 1;

    const again = await cascadeHideToNestedChildren({ db }, lead, { inbox_dismissed_at: 222 }, { forceKill: true });
    expect(again).toBe(2);
    expect(kills()).toHaveLength(4);
    // Already-hidden children keep their original stamp — no timestamp churn.
    expect(tables.conversations.find((r: any) => r._id === "conv_sub")!.inbox_dismissed_at).toBe(111);
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

  // The cascade is built into applyHideTransition itself, so EVERY hide
  // surface gets it — most importantly the web dispatch hook, which used to
  // rely on the client patching each child and silently stranded teammates
  // whenever the client couldn't (unsynced rows, or the owner gate dropping a
  // second-party owner's child patches on an assigned session).
  test("applyHideTransition cascades to the nested group by default", async () => {
    const tables = mkTables();
    const db = makeFakeDb(tables);
    const lead = tables.conversations[0];

    const patch = { inbox_dismissed_at: 444 };
    await db.patch(LEAD, patch);
    const { cascaded } = await applyHideTransition({ db }, lead, patch);
    expect(cascaded).toBe(2);
    const row = (id: string) => tables.conversations.find((r: any) => r._id === id)!;
    expect(row("conv_sub").inbox_dismissed_at).toBe(444);
    expect(row("conv_mate").inbox_dismissed_at).toBe(444);
  });

  test("a stash through applyHideTransition also takes the group (action is 'none')", async () => {
    const tables = mkTables();
    const db = makeFakeDb(tables);
    const lead = tables.conversations[0];

    const patch = { inbox_stashed_at: 555 };
    await db.patch(LEAD, patch);
    const { action, cascaded } = await applyHideTransition({ db }, lead, patch);
    expect(action).toBe("none");
    expect(cascaded).toBe(2);
    expect(tables.conversations.find((r: any) => r._id === "conv_mate")!.inbox_stashed_at).toBe(555);
  });

  test("cascade: false keeps the per-child transition single-level", async () => {
    const tables = mkTables();
    const db = makeFakeDb(tables);
    const lead = tables.conversations[0];

    const patch = { inbox_dismissed_at: 666 };
    await db.patch(LEAD, patch);
    const { cascaded } = await applyHideTransition({ db }, lead, patch, { cascade: false });
    expect(cascaded).toBe(0);
    expect(tables.conversations.find((r: any) => r._id === "conv_sub")!.inbox_dismissed_at).toBeUndefined();
  });
});

// Kill is a DESIRED STATE, not an event. classifyHideTransition gates on the
// hide flag's transition, which is right for a quiet re-assert (the web's
// optimistic re-patch, a stub-rekey flush) and wrong for a deliberate re-kill:
// a killed session whose worker a daemon bug revived was still flagged, so
// `cast kill` classified "none" and never enqueued teardown — the worker was
// unkillable through the supported path. forceKill is how an EXPLICIT kill
// gesture says "make it so" regardless of the flags.
describe("applyHideTransition — explicit kill forces teardown", () => {
  const CONV = "conv_killed";
  // Already killed (dismissed + completed), with real work so the empty-reap
  // path can't fire — the resurrection case. `extra` overrides the row (e.g.
  // back to a live, never-killed session for the fresh-kill cases).
  const mkTables = (extra: Record<string, any> = {}): Record<string, any[]> => ({
    conversations: [{
      _id: CONV, user_id: "u1", session_id: "s-1", message_count: 12,
      inbox_dismissed_at: 111, inbox_killed_at: 111, status: "completed", ...extra,
    }],
    daemon_commands: [],
    messages: [],
    pending_messages: [],
    managed_sessions: [],
    client_state: [],
    agent_tasks: [],
  });
  const prePatch = (tables: Record<string, any[]>) => ({ ...tables.conversations[0] });
  const kills = (db: any) => db._inserted.filter((i: any) => i.table === "daemon_commands");

  test("a re-asserted EXPLICIT kill enqueues teardown again", async () => {
    const tables = mkTables();
    const db = makeFakeDb(tables);
    const doc = prePatch(tables);
    const patch = { inbox_dismissed_at: 222 };
    await db.patch(CONV, patch);

    const { action, teardownEnqueued } = await applyHideTransition({ db }, doc, patch, { forceKill: true });
    expect(action).toBe("kill");
    expect(teardownEnqueued).toBe(true);
    expect(kills(db)).toHaveLength(1);
    expect(kills(db)[0].doc.command).toBe("kill_session");
    expect(JSON.parse(kills(db)[0].doc.args)).toMatchObject({ conversation_id: CONV, session_id: "s-1" });
    expect(tables.conversations[0].inbox_killed_at).toBeGreaterThan(111);
  });

  test("a re-asserted quiet DISMISS still does not re-kill", async () => {
    const tables = mkTables();
    const db = makeFakeDb(tables);
    const doc = prePatch(tables);
    const patch = { inbox_dismissed_at: 222 };
    await db.patch(CONV, patch);

    const { action, teardownEnqueued } = await applyHideTransition({ db }, doc, patch);
    expect(action).toBe("none");
    expect(teardownEnqueued).toBe(false);
    expect(kills(db)).toHaveLength(0);
  });

  test("forceKill never turns a STASH into a kill", async () => {
    const tables = mkTables({ inbox_dismissed_at: undefined, inbox_killed_at: undefined, status: "active" });
    const db = makeFakeDb(tables);
    const doc = prePatch(tables);
    const patch = { inbox_stashed_at: 333 };
    await db.patch(CONV, patch);

    const { action } = await applyHideTransition({ db }, doc, patch, { forceKill: true });
    expect(action).toBe("none");
    expect(kills(db)).toHaveLength(0);
    expect(tables.conversations[0].status).toBe("active");
  });

  test("a kill still queued for the daemon reports no new command, but the state holds", async () => {
    const tables = mkTables();
    // An UNEXECUTED kill_session for this conversation is already on the queue.
    tables.daemon_commands.push({
      _id: "cmdPending", user_id: "u1", command: "kill_session",
      args: JSON.stringify({ conversation_id: CONV }), created_at: 111,
    });
    const db = makeFakeDb(tables);
    const doc = prePatch(tables);
    const patch = { inbox_dismissed_at: 222 };
    await db.patch(CONV, patch);

    const { action, teardownEnqueued } = await applyHideTransition({ db }, doc, patch, { forceKill: true });
    expect(action).toBe("kill");
    expect(teardownEnqueued).toBe(false);
    expect(kills(db)).toHaveLength(0);
  });

  // A persistent anchor goes dormant on a kill, it is never retired — only
  // decommissionAnchor clears `persistent`. Forcing must not change that.
  test("a forced kill on a persistent anchor keeps anchor semantics", async () => {
    const tables = mkTables({ persistent: true, status: "active" });
    tables.agent_tasks.push({
      _id: "t1", user_id: "u1", status: "scheduled", originating_conversation_id: CONV,
    });
    const db = makeFakeDb(tables);
    const doc = prePatch(tables);
    const patch = { inbox_dismissed_at: 222 };
    await db.patch(CONV, patch);

    const { action, canceledSchedules, teardownEnqueued } = await applyHideTransition({ db }, doc, patch, { forceKill: true });
    expect(action).toBe("kill");
    expect(teardownEnqueued).toBe(true);
    expect(canceledSchedules).toBe(0);
    expect(tables.agent_tasks[0].status).toBe("scheduled");
    expect(tables.conversations[0].status).toBe("active");
    expect(tables.conversations[0].inbox_killed_at).toBeGreaterThan(111);
  });

  // Kill is TERMINAL for messages already queued. Retained ones kept retrying:
  // one could land later and revive a session still stamped inbox_killed_at
  // (observed live — 193 messages after the kill), and an exhausted one left the
  // row completed + has_pending_messages forever.
  test("a kill cancels the messages already queued and clears has_pending_messages", async () => {
    const tables = mkTables({
      inbox_dismissed_at: undefined, inbox_killed_at: undefined,
      status: "active", has_pending_messages: true,
    });
    tables.pending_messages.push(
      { _id: "pm_pending", conversation_id: CONV, status: "pending", retry_count: 0 },
      { _id: "pm_undeliverable", conversation_id: CONV, status: "undeliverable", retry_count: 9 },
      { _id: "pm_delivered", conversation_id: CONV, status: "delivered", retry_count: 1 },
    );
    const db = makeFakeDb(tables);
    const doc = prePatch(tables);
    const patch = { inbox_dismissed_at: 222 };
    await db.patch(CONV, patch);

    // A FRESH kill (no force needed) — the flag transitions here.
    const { action, canceledMessages } = await applyHideTransition({ db }, doc, patch);
    expect(action).toBe("kill");
    expect(canceledMessages).toBe(2);
    const msg = (id: string) => tables.pending_messages.find((r: any) => r._id === id)!;
    expect(msg("pm_pending").status).toBe("cancelled");
    expect(msg("pm_undeliverable").status).toBe("cancelled");
    expect(msg("pm_delivered").status).toBe("delivered"); // terminal, untouched
    expect(tables.conversations[0].has_pending_messages).toBe(false);
  });

  test("a forced re-kill cancels what was queued since the first kill", async () => {
    const tables = mkTables({ has_pending_messages: true });
    tables.pending_messages.push(
      { _id: "pm_since", conversation_id: CONV, status: "pending", retry_count: 0 },
    );
    const db = makeFakeDb(tables);
    const doc = prePatch(tables);
    const patch = { inbox_dismissed_at: 222 };
    await db.patch(CONV, patch);

    const { canceledMessages } = await applyHideTransition({ db }, doc, patch, { forceKill: true });
    expect(canceledMessages).toBe(1);
    expect(tables.pending_messages[0].status).toBe("cancelled");
    expect(tables.conversations[0].has_pending_messages).toBe(false);
  });

  // The other half of the contract: only the PRE-kill queue dies. A human send
  // afterwards re-enqueues and resurfaces the session — enqueuePendingMessage's
  // wake-up rules clear the dismissed/killed flags and flip completed → active.
  test("a later send still revives the killed session; the pre-kill queue stays dead", async () => {
    const tables = mkTables({ has_pending_messages: true });
    tables.pending_messages.push(
      { _id: "pm_before", conversation_id: CONV, status: "pending", retry_count: 0 },
    );
    const db = makeFakeDb(tables);
    const doc = prePatch(tables);
    const patch = { inbox_dismissed_at: 222 };
    await db.patch(CONV, patch);
    await applyHideTransition({ db }, doc, patch, { forceKill: true });
    expect(tables.pending_messages[0].status).toBe("cancelled");

    const conv = await db.get(CONV);
    const newId = await enqueuePendingMessage({ db }, conv, "u1" as any, { content: "back to work" });

    expect(tables.pending_messages.find((r: any) => r._id === newId)!.status).toBe("pending");
    expect(conv.inbox_dismissed_at).toBeUndefined();
    expect(conv.inbox_killed_at).toBeUndefined();
    expect(conv.status).toBe("active");
    expect(conv.has_pending_messages).toBe(true);
    // The message queued before the kill is terminal — it must not ride along.
    expect(tables.pending_messages.find((r: any) => r._id === "pm_before")!.status).toBe("cancelled");
  });

  // Re-running the schedule sweep is safe: it only touches
  // scheduled/running/paused tasks, so already-canceled ones stay put — and a
  // trigger re-armed since the first kill dies again with the session.
  test("a forced kill re-cancels a schedule re-armed since the first kill", async () => {
    const tables = mkTables();
    tables.agent_tasks.push({
      _id: "t1", user_id: "u1", status: "scheduled", originating_conversation_id: CONV,
    });
    const db = makeFakeDb(tables);
    const doc = prePatch(tables);
    const patch = { inbox_dismissed_at: 222 };
    await db.patch(CONV, patch);

    const { canceledSchedules } = await applyHideTransition({ db }, doc, patch, { forceKill: true });
    expect(canceledSchedules).toBe(1);
    expect(tables.agent_tasks[0].status).toBe("completed");
    expect(tables.agent_tasks[0].canceled_on_kill_at).toBeGreaterThan(0);
  });
});
