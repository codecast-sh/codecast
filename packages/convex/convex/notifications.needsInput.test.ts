import { describe, expect, test } from "bun:test";
import { performNeedsInputCheck } from "./notifications";

// ── In-memory Convex-ish ctx ─────────────────────────────────────────────────
// Same pattern as pendingMessages.teamSend.test.ts: a fake `ctx.db` faithful
// enough to run the REAL needs-input check end-to-end. withIndex ignores the
// index NAME and matches on the eq constraints; order("desc") sorts by
// `timestamp` (the only ordered read the check makes is the messages tail).
// scheduler.runAfter records calls so tests can assert on pushes/summaries.

type Rec = Record<string, any>;

function createCtx(seed: Record<string, Rec[]>) {
  const tables: Record<string, Rec[]> = {};
  const counters: Record<string, number> = {};
  for (const [table, rows] of Object.entries(seed)) {
    tables[table] = rows.map((r) => ({ ...r }));
  }
  const allRows = () => Object.values(tables).flat();

  const db = {
    async get(id: string) {
      return allRows().find((r) => r._id === id) ?? null;
    },
    async insert(table: string, doc: Rec) {
      counters[table] = (counters[table] ?? 0) + 1;
      const _id = `${table}_${counters[table]}`;
      (tables[table] ??= []).push({ _id, ...doc });
      return _id;
    },
    async patch(id: string, patch: Rec) {
      const row = allRows().find((r) => r._id === id);
      if (!row) throw new Error(`patch: no row ${id}`);
      Object.assign(row, patch);
    },
    async delete(id: string) {
      for (const rows of Object.values(tables)) {
        const i = rows.findIndex((r) => r._id === id);
        if (i !== -1) {
          rows.splice(i, 1);
          return;
        }
      }
      throw new Error(`delete: no row ${id}`);
    },
    query(table: string) {
      const constraints: Array<{ field: string; val: any }> = [];
      const q: any = {
        eq(field: string, val: any) {
          constraints.push({ field, val });
          return q;
        },
      };
      let desc = false;
      // .filter(q => q.eq(q.field("role"), "user")) — the one filter shape the
      // check uses. field() returns a marker resolved per row at run time.
      const rowPredicates: Array<(r: Rec) => boolean> = [];
      const filterQ = {
        field: (name: string) => ({ __field: name }),
        eq: (a: any, b: any) => ({ __eq: [a, b] }),
      };
      const resolveOperand = (r: Rec, x: any) =>
        x && typeof x === "object" && "__field" in x ? r[x.__field] : x;
      const run = () => {
        const rows = (tables[table] ?? []).filter(
          (r) =>
            constraints.every((c) => String(r[c.field]) === String(c.val)) &&
            rowPredicates.every((p) => p(r))
        );
        if (desc) rows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
        return rows;
      };
      const chain: any = {
        withIndex(_name: string, builder?: (q: any) => unknown) {
          if (builder) builder(q);
          return chain;
        },
        filter(builder: (fq: any) => any) {
          const expr = builder(filterQ);
          rowPredicates.push((r) => {
            const [a, b] = expr.__eq;
            return String(resolveOperand(r, a)) === String(resolveOperand(r, b));
          });
          return chain;
        },
        order(dir: string) {
          desc = dir === "desc";
          return chain;
        },
        async collect() {
          return run();
        },
        async first() {
          return run()[0] ?? null;
        },
        async take(n: number) {
          return run().slice(0, n);
        },
      };
      return chain;
    },
  };

  const scheduled: Array<{ delay: number; args: Rec }> = [];
  const scheduler = {
    async runAfter(delay: number, _fn: unknown, args: Rec) {
      scheduled.push({ delay, args });
    },
  };

  return { ctx: { db, scheduler }, tables, scheduled };
}

// A session that finished a turn and settled past the idle grace: the daemon
// flipped agent_status to "idle" 60s ago (grace is 45s), the last synced
// message is the assistant's answer, heartbeat fresh. This is the exact state
// the web inbox files under NEEDS INPUT and chimes for.
function settledIdleWorld(overrides: {
  conv?: Rec;
  session?: Rec;
  users?: Rec[];
  messages?: Rec[];
  extra?: Record<string, Rec[]>;
} = {}) {
  const now = Date.now();
  return createCtx({
    users: overrides.users ?? [
      { _id: "u1", notifications_enabled: true, push_token: "tok-u1" },
    ],
    conversations: [
      {
        _id: "conv1",
        user_id: "u1",
        title: "Fix the parser",
        status: "active",
        message_count: 5,
        updated_at: now - 120_000,
        last_message_role: "assistant",
        ...(overrides.conv ?? {}),
      },
    ],
    managed_sessions: [
      {
        _id: "ms1",
        user_id: "u1",
        conversation_id: "conv1",
        session_id: "sess-1",
        agent_status: "idle",
        agent_status_updated_at: now - 60_000,
        last_heartbeat: now - 5_000,
        ...(overrides.session ?? {}),
      },
    ],
    messages: overrides.messages ?? [
      {
        _id: "m1",
        conversation_id: "conv1",
        role: "assistant",
        content: "Done — the parser handles nested arrays now. What next?",
        timestamp: now - 70_000,
      },
    ],
    pending_permissions: [],
    notifications: [],
    ...(overrides.extra ?? {}),
  });
}

describe("needs-input push — settled idle", () => {
  test("pushes once when a finished turn settles into needs-input", async () => {
    const { ctx, tables, scheduled } = settledIdleWorld();
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });

    expect(res.notified).toBe(true);
    expect(tables.notifications.length).toBe(1);
    expect(tables.notifications[0].type).toBe("session_idle");
    expect(tables.notifications[0].recipient_user_id).toBe("u1");
    expect(tables.conversations[0].needs_input_notified_key).toBe("5:idle");

    const push = scheduled.find((s) => s.args.push_token);
    expect(push).toBeDefined();
    expect(push!.args.title).toBe("Fix the parser");
    expect(push!.args.body).toContain("nested arrays");
    // Idle summary rides the same trigger (it was dead along with the push).
    expect(scheduled.some((s) => !s.args.push_token && s.args.conversation_id === "conv1")).toBe(true);
  });

  test("same waiting episode never pushes twice; a new turn pushes again", async () => {
    const { ctx, tables, scheduled } = settledIdleWorld();
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    const dup = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(dup.notified).toBe(false);
    expect(dup.reason).toBe("dup");
    expect(tables.notifications.length).toBe(1);

    // Next turn ends: message_count grew — the key changes, so it may push
    // again. The push fires, but the row REPLACES the conversation's previous
    // state row instead of stacking a second entry in the notification list.
    tables.conversations[0].message_count = 6;
    const firstRowId = tables.notifications[0]._id;
    const next = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(next.notified).toBe(true);
    expect(tables.notifications.length).toBe(1);
    expect(tables.notifications[0]._id).not.toBe(firstRowId); // fresh _id = new banner
    expect(scheduled.filter((s) => s.args.push_token).length).toBe(2);
  });

  test("state rows replace per conversation; event rows and other convos survive", async () => {
    const { ctx, tables } = settledIdleWorld();
    // Pre-existing rows for the same recipient: an EVENT row on the same
    // conversation, a state row on a DIFFERENT conversation.
    tables.notifications.push(
      {
        _id: "n_assigned",
        recipient_user_id: "u1",
        conversation_id: "conv1",
        type: "session_assigned",
        message: "Sam assigned you this session",
        read: false,
        created_at: Date.now() - 60_000,
      },
      {
        _id: "n_other_conv",
        recipient_user_id: "u1",
        conversation_id: "convOther",
        type: "session_idle",
        message: "Other session ready",
        read: false,
        created_at: Date.now() - 60_000,
      },
      {
        _id: "n_old_state",
        recipient_user_id: "u1",
        conversation_id: "conv1",
        type: "permission_request",
        message: "Permission needed",
        read: true,
        created_at: Date.now() - 120_000,
      },
    );
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(true);

    const ids = tables.notifications.map((n) => n._id);
    expect(ids).toContain("n_assigned"); // event row untouched
    expect(ids).toContain("n_other_conv"); // other conversation untouched
    expect(ids).not.toContain("n_old_state"); // superseded state row gone
    const conv1States = tables.notifications.filter(
      (n) => n.conversation_id === "conv1" && n.type !== "session_assigned",
    );
    expect(conv1States.length).toBe(1);
    expect(conv1States[0].type).toBe("session_idle");
  });

  test("aborts when the status moved on since scheduling (superseded)", async () => {
    const { ctx, tables } = settledIdleWorld();
    const res = await performNeedsInputCheck(ctx as any, {
      conversation_id: "conv1",
      status_ts: 12345, // != the session's agent_status_updated_at
    });
    expect(res.notified).toBe(false);
    expect(res.reason).toBe("superseded");
    expect(tables.notifications.length).toBe(0);
  });

  test("no push within the idle grace (status just flipped)", async () => {
    const now = Date.now();
    const { ctx, tables } = settledIdleWorld({
      conv: { updated_at: now - 5_000 },
      session: { agent_status_updated_at: now - 5_000 },
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(false);
    expect(res.reason).toBe("not_needs_input");
    expect(tables.notifications.length).toBe(0);
  });

  test("queued work (has_pending_messages) means WORKING, not needs-input", async () => {
    const { ctx, tables } = settledIdleWorld({ conv: { has_pending_messages: true } });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(false);
    expect(tables.notifications.length).toBe(0);
  });

  test("a producing subagent child keeps the parent in WORKING — no push mid-orchestration", async () => {
    const now = Date.now();
    const { ctx, tables } = settledIdleWorld();
    tables.conversations.push({
      _id: "convChild",
      user_id: "u1",
      parent_conversation_id: "conv1",
      is_subagent: true,
      status: "active",
      updated_at: now - 30_000, // produced output within the 5-min grace
      message_count: 3,
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(false);
    expect(tables.notifications.length).toBe(0);
  });
});

describe("needs-input push — AskUserQuestion", () => {
  test("an open poll pushes the question text, even while status says working", async () => {
    const now = Date.now();
    const { ctx, tables, scheduled } = settledIdleWorld({
      conv: { updated_at: now - 2_000 },
      session: { agent_status: "working", agent_status_updated_at: now - 2_000 },
      messages: [
        {
          _id: "m1",
          conversation_id: "conv1",
          role: "assistant",
          content: "",
          timestamp: now - 1_000,
          tool_calls: [
            {
              id: "tu1",
              name: "AskUserQuestion",
              input: JSON.stringify({ questions: [{ question: "Deploy to prod?" }] }),
            },
          ],
        },
      ],
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(true);
    expect(tables.conversations[0].needs_input_notified_key).toBe("5:awaiting_input");
    const push = scheduled.find((s) => s.args.push_token);
    expect(push!.args.body).toBe("Deploy to prod?");
  });

  test("an answered poll (tool_result is newer) does not push", async () => {
    const now = Date.now();
    const { ctx, tables } = settledIdleWorld({
      conv: { updated_at: now - 2_000 },
      session: { agent_status: "working", agent_status_updated_at: now - 2_000 },
      messages: [
        {
          _id: "m1",
          conversation_id: "conv1",
          role: "assistant",
          content: "",
          timestamp: now - 10_000,
          tool_calls: [{ id: "tu1", name: "AskUserQuestion", input: "{}" }],
        },
        {
          _id: "m2",
          conversation_id: "conv1",
          role: "user",
          content: "yes",
          timestamp: now - 1_000,
        },
      ],
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(false);
    expect(tables.notifications.length).toBe(0);
  });
});

describe("needs-input push — permission blocks", () => {
  test("recordless block (buffered AskUserQuestion / scraped prompt) pushes", async () => {
    const now = Date.now();
    const { ctx, tables } = settledIdleWorld({
      conv: { updated_at: now - 2_000 },
      session: { agent_status: "permission_blocked", agent_status_updated_at: now - 11_000 },
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(true);
    expect(tables.conversations[0].needs_input_notified_key).toBe("5:permission_blocked");
  });

  test("a pending permission record means the daemon already pushed — stand down", async () => {
    const now = Date.now();
    const { ctx, tables } = settledIdleWorld({
      conv: { updated_at: now - 2_000 },
      session: { agent_status: "permission_blocked", agent_status_updated_at: now - 11_000 },
      extra: {
        pending_permissions: [
          { _id: "pp1", conversation_id: "conv1", status: "pending", tool_name: "Bash" },
        ],
      },
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(false);
    expect(res.reason).toBe("daemon_permission_push");
    expect(tables.notifications.length).toBe(0);
    // Episode is still marked handled so a later idle flip can't re-push it.
    expect(tables.conversations[0].needs_input_notified_key).toBe("5:permission_blocked");
  });
});

describe("needs-input push — exclusions (mirrors the idle sound's guards)", () => {
  test.each([
    ["subagent", { is_subagent: true }],
    ["pinned", { inbox_pinned_at: 1 }],
    ["dismissed", { inbox_dismissed_at: 1 }],
    ["no_content", { message_count: 0 }],
    // Machine-initiated sessions: cast-spawn fan-out and agent-team fleet
    // members (same classification as the "started coding" gate)…
    ["agent_spawned", { spawned_by_conversation_id: "convX" }],
    ["agent_spawned", { agent_name: "researcher" }],
    // …and spawned schedule-run conversations.
    ["schedule_run", { agent_task_id: "task1" }],
  ] as Array<[string, Rec]>)("%s sessions never push", async (reason, convOverride) => {
    const { ctx, tables } = settledIdleWorld({ conv: convOverride });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(false);
    expect(res.reason).toBe(reason);
    expect(tables.notifications.length).toBe(0);
  });

  test("dead sessions (stopped with content) are needs-input on the web but do not push", async () => {
    const { ctx, tables } = settledIdleWorld({
      session: { agent_status: "stopped" },
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(false);
    expect(res.reason).toBe("dead");
    expect(tables.notifications.length).toBe(0);
  });

  test("session_idle pref off suppresses the row and the push", async () => {
    const { ctx, tables } = settledIdleWorld({
      users: [
        {
          _id: "u1",
          notifications_enabled: true,
          push_token: "tok-u1",
          notification_preferences: { session_idle: false },
        },
      ],
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(false);
    expect(tables.notifications.length).toBe(0);
  });

  test("assigned owner gets a mirrored row+push", async () => {
    const { ctx, tables, scheduled } = settledIdleWorld({
      conv: { owner_user_id: "u2" },
      users: [
        { _id: "u1", notifications_enabled: true, push_token: "tok-u1" },
        { _id: "u2", notifications_enabled: true, push_token: "tok-u2" },
      ],
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(true);
    expect(tables.notifications.length).toBe(2);
    expect(scheduled.filter((s) => s.args.push_token).map((s) => s.args.push_token).sort()).toEqual([
      "tok-u1",
      "tok-u2",
    ]);
  });
});

// The bar: a push means "a session YOU were driving is waiting on YOU". A turn
// started by machinery — a peer session's cast send, a schedule injection —
// parks the session idle without the user having asked anything.
describe("needs-input push — only human-started turns clear the bar", () => {
  const now = Date.now();

  test("a turn started by another session's cast send does not push", async () => {
    const { ctx, tables } = settledIdleWorld({
      messages: [
        {
          _id: "m1",
          conversation_id: "conv1",
          role: "user",
          content: '<session-message from="jx7abc">status check — reply when done</session-message>',
          timestamp: now - 90_000,
        },
        {
          _id: "m2",
          conversation_id: "conv1",
          role: "assistant",
          content: "All green, standing by.",
          timestamp: now - 70_000,
        },
      ],
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(false);
    expect(res.reason).toBe("machine_turn");
    expect(tables.notifications.length).toBe(0);
  });

  test("a turn started by a schedule injection does not push", async () => {
    const { ctx, tables } = settledIdleWorld({
      messages: [
        {
          _id: "m1",
          conversation_id: "conv1",
          role: "user",
          content: '<scheduled-task title="Check CI" task-id="t1">check whether CI is green</scheduled-task>',
          timestamp: now - 90_000,
        },
        {
          _id: "m2",
          conversation_id: "conv1",
          role: "assistant",
          content: "CI is green.",
          timestamp: now - 70_000,
        },
      ],
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(false);
    expect(res.reason).toBe("machine_turn");
    expect(tables.notifications.length).toBe(0);
  });

  test("a human-started turn pushes (the machine gate keys on the LATEST user turn)", async () => {
    const { ctx, tables } = settledIdleWorld({
      messages: [
        // An older machine turn must not poison the verdict…
        {
          _id: "m1",
          conversation_id: "conv1",
          role: "user",
          content: '<session-message from="jx7abc">earlier ping</session-message>',
          timestamp: now - 300_000,
        },
        // …when the human drove the latest turn themselves.
        {
          _id: "m2",
          conversation_id: "conv1",
          role: "user",
          content: "can you fix the parser?",
          timestamp: now - 100_000,
        },
        {
          _id: "m3",
          conversation_id: "conv1",
          role: "assistant",
          content: "Done — nested arrays handled. Ship it?",
          timestamp: now - 70_000,
        },
      ],
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(true);
    expect(tables.notifications.length).toBe(1);
  });

  test("the team lead is the one agent-identity session a human drives — it still pushes", async () => {
    const { ctx, tables } = settledIdleWorld({ conv: { agent_name: "team-lead" } });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(true);
    expect(tables.notifications.length).toBe(1);
  });
});
