import { describe, expect, test } from "bun:test";
import {
  performNeedsInputCheck,
  performIdleDigestFlush,
  summarizeIdleDigest,
  IDLE_DIGEST_WINDOW_MS,
} from "./notifications";
import { settleRunConversation } from "./agentTasks";
import { runResultThreadOf } from "@codecast/shared/contracts";
import { performPushFlush } from "./pushRouter";

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
      // Range arms of an index read (the digest flush asks for rows created
      // since the window opened).
      const ranges: Array<(r: Rec) => boolean> = [];
      const q: any = {
        eq(field: string, val: any) {
          constraints.push({ field, val });
          return q;
        },
        gte(field: string, val: any) {
          ranges.push((r) => (r[field] ?? 0) >= val);
          return q;
        },
        gt(field: string, val: any) {
          ranges.push((r) => (r[field] ?? 0) > val);
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
            ranges.every((p) => p(r)) &&
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

    // The push is STAGED in the outbox (pushRouter routes/aggregates it),
    // not sent inline anymore.
    expect(tables.push_outbox.length).toBe(1);
    expect(tables.push_outbox[0].title).toBe("Fix the parser");
    expect(tables.push_outbox[0].body).toContain("nested arrays");
    // Drive the real flush: no desktop presence → the away debounce applies,
    // and the flush's batching lookahead covers it — the Expo send fires.
    await performPushFlush(ctx as any, "u1");
    const push = scheduled.find((s) => s.args.push_token);
    expect(push).toBeDefined();
    expect(push!.args.title).toBe("Fix the parser");
    expect(push!.args.body).toContain("nested arrays");
    // The settle classifier no longer rides the push (it has its own entry,
    // idleSummary.classifySettle, off the idle status change) — nothing else
    // is scheduled from here for this conversation.
  });

  // Assignment moves the alert with the inbox row: the account that RUNS a
  // session it no longer owns is not the one being asked (sessionOwnership,
  // isAssignedAwayFromOwnerSet). Without this the row left the runner's inbox
  // and kept ringing their phone.
  test("a session handed to a teammate rings the owner, not the runner", async () => {
    const { ctx, tables } = settledIdleWorld({
      conv: { owner_user_id: "u2" },
      users: [
        { _id: "u1", notifications_enabled: true, push_token: "tok-u1" },
        { _id: "u2", notifications_enabled: true, push_token: "tok-u2" },
      ],
      extra: { session_owners: [{ _id: "so1", conversation_id: "conv1", user_id: "u2", added_by: "u1", added_at: 1 }] },
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });

    expect(res.notified).toBe(true);
    expect(tables.notifications.map((n: Rec) => n.recipient_user_id)).toEqual(["u2"]);
  });

  test("an owner set that still holds the runner rings them both", async () => {
    const { ctx, tables } = settledIdleWorld({
      conv: { owner_user_id: "u2" },
      users: [
        { _id: "u1", notifications_enabled: true, push_token: "tok-u1" },
        { _id: "u2", notifications_enabled: true, push_token: "tok-u2" },
      ],
      extra: {
        session_owners: [
          { _id: "so1", conversation_id: "conv1", user_id: "u2", added_by: "u1", added_at: 1 },
          { _id: "so2", conversation_id: "conv1", user_id: "u1", added_by: "u1", added_at: 2 },
        ],
      },
    });
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(tables.notifications.map((n: Rec) => n.recipient_user_id).sort()).toEqual(["u1", "u2"]);
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
    // The row is superseded IN PLACE: same _id, so no second banner, and the
    // push the first episode staged still points at a live row.
    expect(tables.notifications[0]._id).toBe(firstRowId);
    // The first episode alerted and opened the digest window, so the second
    // rides it: its row is quiet and stages no push. One buzz, not two.
    expect(tables.notifications[0].quiet).toBe(true);
    expect(tables.push_outbox.length).toBe(1);
    await performPushFlush(ctx as any, "u1");
    expect(scheduled.filter((s) => s.args.push_token).length).toBe(1);
  });

  test("with the digest off, every episode alerts on its own", async () => {
    const { ctx, tables } = settledIdleWorld({
      users: [{
        _id: "u1", notifications_enabled: true, push_token: "tok-u1",
        notification_preferences: { session_idle_digest: false },
      }],
    });
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    tables.conversations[0].message_count = 6;
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(tables.notifications[0].quiet).toBeUndefined();
    expect(tables.push_outbox.length).toBe(2);
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
    expect(tables.push_outbox.length).toBe(1);
    expect(tables.push_outbox[0].body).toBe("Deploy to prod?");
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
    ["subagent", { parent_conversation_id: "convP" }],
    ["subagent", { is_workflow_sub: true }],
    ["pinned", { inbox_pinned_at: 1 }],
    // A hidden row with a PLAIN finished turn stays hidden — quiet progress is
    // what the hide asked for. (A hard stall un-hides; see the stall tests.)
    ["hidden", { inbox_dismissed_at: 1 }],
    ["hidden", { inbox_stashed_at: 1 }],
    ["killed", { inbox_killed_at: 1 }],
    ["no_content", { message_count: 0 }],
    // Machine-initiated sessions: cast-spawn fan-out and agent-team fleet
    // members (same classification as the "started coding" gate)…
    ["agent_spawned", { spawned_by_conversation_id: "convX" }],
    ["agent_spawned", { agent_name: "researcher" }],
    // …and spawned schedule-run conversations.
    ["schedule_run", { agent_task_id: "task1" }],
    // A session a role looks after reaches the person through the role
    // (org-roles-run-work.md R1, revised): its own settle rings nobody, and
    // an escalation through the role's card is still the role's to carry.
    ["under_role", { org_role_id: "role1" }],
    ["under_role", { org_role_id: "role1", escalated_by_role: { role_id: "role1", line: "needs you", at: 1 } }],
  ] as Array<[string, Rec]>)("%s sessions never push", async (reason, convOverride) => {
    const { ctx, tables } = settledIdleWorld({ conv: convOverride });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(false);
    expect(res.reason).toBe(reason);
    expect(tables.notifications.length).toBe(0);
  });

  // A worktree is a LOCATION, not a parent (ct-49429): a human-started
  // --isolated / cloud / path-stamped session is first-class and pushes like
  // any other card. Fan-out from INSIDE a session still stands down — those
  // workers carry a spawner (reason agent_spawned), not because of the tree.
  // The exception: a DIRECT escalation made the child the person's own card,
  // so its settles ring them like any other.
  test("a child a role put in front of the person directly pushes", async () => {
    const { ctx, tables } = settledIdleWorld({
      conv: { org_role_id: "role1", escalated_by_role: { role_id: "role1", line: "a permission prompt is open", at: 1, direct: true } },
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(true);
    expect(tables.notifications[0].type).toBe("session_idle");
  });

  test("a human-started worktree session pushes", async () => {
    const { ctx, tables } = settledIdleWorld({
      conv: { worktree_name: "cloud-d03aaa", worktree_branch: "codecast/cloud-d03aaa" },
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(true);
    expect(tables.notifications.length).toBe(1);
    expect(tables.notifications[0].type).toBe("session_idle");
  });

  // A parked cloud row is what conversations.createConversation inserts for
  // cloud_device_id: message_count 0, the first message queued as pending, no
  // managed session yet (placeConversation clears cloud_placement before the
  // host's session starts). It exits at no_content — before any etiquette
  // guard — so parking is never a stand-down reason of its own; once the host
  // binds a session and the row settles idle it is the human-started worktree
  // case above and pushes.
  test("a parked cloud session (placement pending) exits at no_content, not as a subagent", async () => {
    const { ctx, tables } = settledIdleWorld({
      conv: {
        cloud_placement: "pending", owner_device_id: "dev-cloud",
        message_count: 0, has_pending_messages: true, last_message_role: "user",
      },
      extra: { managed_sessions: [] },
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(false);
    expect(res.reason).toBe("no_content");
    expect(tables.notifications.length).toBe(0);
  });

  test("a worktree worker spawned from inside a session still stands down as agent_spawned", async () => {
    const { ctx, tables } = settledIdleWorld({
      conv: { worktree_name: "cloud-d03aaa", spawned_by_conversation_id: "convX" },
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(false);
    expect(res.reason).toBe("agent_spawned");
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

  // The legacy shape: an owner in the cache with no join row yet (pre-backfill).
  // It still names an owner, so it still moves the alert — the assigned owner
  // is rung and the account that merely runs the session is not.
  test("assigned owner gets the row+push; the runner does not", async () => {
    const { ctx, tables } = settledIdleWorld({
      conv: { owner_user_id: "u2" },
      users: [
        { _id: "u1", notifications_enabled: true, push_token: "tok-u1" },
        { _id: "u2", notifications_enabled: true, push_token: "tok-u2" },
      ],
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(true);
    expect(tables.notifications.map((n: Rec) => n.recipient_user_id)).toEqual(["u2"]);
    expect(tables.push_outbox.map((r: Rec) => r.user_id)).toEqual(["u2"]);
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

// ── The stall rule: "stash hides work, not stalls" ───────────────────────────
// A hidden session (stashed, or a folded run on the legacy dismissed stamp)
// may be quiet, never quietly stuck: a HARD block — open AskUserQuestion,
// permission prompt, dead process — clears the hide so the row surfaces in
// Needs Input. Plain settles and soft verdicts never do.
describe("needs-input check — stall rule for hidden sessions", () => {
  const now = Date.now();
  const auqPoll = {
    _id: "m2",
    conversation_id: "conv1",
    role: "assistant",
    content: "",
    tool_calls: [{ name: "AskUserQuestion", input: "{}" }],
    timestamp: now - 30_000,
  };

  test("an open AskUserQuestion poll un-stashes", async () => {
    const { ctx, tables } = settledIdleWorld({
      conv: { inbox_stashed_at: 111 },
      session: { agent_status: "working" },
      messages: [auqPoll],
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.reason).toBe("unstashed_stall");
    expect(tables.conversations[0].inbox_stashed_at).toBeUndefined();
    // No chime from the stall path — surfacing in Needs Input IS the signal.
    expect(tables.notifications.length).toBe(0);
  });

  test("a permission prompt un-stashes", async () => {
    const { ctx, tables } = settledIdleWorld({
      conv: { inbox_stashed_at: 111 },
      session: { agent_status: "permission_blocked" },
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.reason).toBe("unstashed_stall");
    expect(tables.conversations[0].inbox_stashed_at).toBeUndefined();
  });

  test("a dead process (stopped with content) un-stashes", async () => {
    const { ctx, tables } = settledIdleWorld({
      conv: { inbox_stashed_at: 111 },
      session: { agent_status: "stopped" },
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.reason).toBe("unstashed_stall");
    expect(tables.conversations[0].inbox_stashed_at).toBeUndefined();
  });

  // The regression: every headless trigger run ends by its process exiting, so
  // "stopped" arrived seconds after the clean completion folded the run and
  // put it straight back under Needs Input. The completion is the run's done
  // declaration (agentTasks.settleRunConversation), and an exit after a
  // declared done is not a death.
  test("a run that exited after completing cleanly stays folded", async () => {
    const { ctx, tables } = settledIdleWorld({
      conv: { inbox_stashed_at: 111, agent_task_id: "task1", thread_state_status: "done" },
      session: { agent_status: "stopped" },
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.reason).toBe("hidden");
    expect(tables.conversations[0].inbox_stashed_at).toBe(111);
  });

  test("a run whose process died WITHOUT reporting still un-stashes", async () => {
    const { ctx, tables } = settledIdleWorld({
      conv: { inbox_stashed_at: 111, agent_task_id: "task1" },
      session: { agent_status: "stopped" },
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.reason).toBe("unstashed_stall");
    expect(tables.conversations[0].inbox_stashed_at).toBeUndefined();
  });

  test("a folded run on the legacy dismissed stamp gets the same treatment", async () => {
    const { ctx, tables } = settledIdleWorld({
      conv: { inbox_dismissed_at: 111, agent_task_id: "task1" },
      session: { agent_status: "permission_blocked" },
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.reason).toBe("unstashed_stall");
    expect(tables.conversations[0].inbox_dismissed_at).toBeUndefined();
  });

  test("a plain finished turn stays hidden — quiet progress never breaks a hide", async () => {
    const { ctx, tables } = settledIdleWorld({ conv: { inbox_stashed_at: 111 } });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.reason).toBe("hidden");
    expect(tables.conversations[0].inbox_stashed_at).toBe(111);
  });

  test("a killed row never resurfaces, whatever it stalls on", async () => {
    const { ctx, tables } = settledIdleWorld({
      conv: { inbox_stashed_at: 111, inbox_killed_at: 222 },
      session: { agent_status: "permission_blocked" },
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.reason).toBe("killed");
    expect(tables.conversations[0].inbox_stashed_at).toBe(111);
  });
});

// The whole life of a trigger run in a fresh session, end to end through the
// REAL completion and the REAL stall check: the agent reports its outcome, the
// turn settles, the headless process exits. Before ct-52200 the exit read as a
// dead session with output, so the stall rule pulled every clean run back out
// of its fold and into Needs Input.
describe("a trigger run in a fresh session, from completion to process exit", () => {
  const task = (over: Rec = {}) =>
    ({ _id: "task1", short_id: "tr-9", title: "Stall sweep", schedule_type: "recurring", ...over }) as any;
  const exitProcess = (tables: Record<string, Rec[]>) => {
    tables.managed_sessions[0].agent_status = "stopped";
    tables.managed_sessions[0].agent_status_updated_at = Date.now() - 60_000;
  };
  const world = (conv: Rec = {}, extra: Rec[] = []) => {
    const w = settledIdleWorld({ conv: { agent_task_id: "task1", short_id: "jx7run1", ...conv } });
    w.tables.conversations.push(...extra);
    return w;
  };

  test("a repeating run that reports a clean outcome folds and STAYS folded after it exits", async () => {
    const { ctx, tables } = world();
    await settleRunConversation(ctx as any, task(), tables.conversations[0] as any, { summary: "Nothing stuck." }, Date.now());
    expect(tables.conversations[0].thread_state_status).toBe("done");
    expect(tables.conversations[0].thread_state).toBe("Nothing stuck.");
    expect(tables.conversations[0].inbox_stashed_at).toBeGreaterThan(0);

    exitProcess(tables);
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.reason).toBe("hidden");
    expect(tables.conversations[0].inbox_stashed_at).toBeGreaterThan(0);
  });

  test("--needs-attention declares blocked, never folds, and the exit keeps it in front of the human", async () => {
    const { ctx, tables } = world({ inbox_stashed_at: 111 });
    await settleRunConversation(ctx as any, task(), tables.conversations[0] as any, { summary: "Two sessions need you.", needs_attention: true }, Date.now());
    expect(tables.conversations[0].thread_state_status).toBe("blocked");
    expect(tables.conversations[0].inbox_stashed_at).toBeUndefined();
  });

  test("a run the DAEMON completed (the agent died without reporting) declares nothing and stays visible", async () => {
    const { ctx, tables } = world();
    await settleRunConversation(ctx as any, task(), tables.conversations[0] as any, { summary: "exit 1", daemon_id: "d1" }, Date.now());
    expect(tables.conversations[0].thread_state_status).toBeUndefined();
    expect(tables.conversations[0].inbox_stashed_at).toBeUndefined();
  });

  test("a once run armed from a session posts its result there and folds", async () => {
    const creator = { _id: "creator1", user_id: "u1", message_count: 7, updated_at: 1 };
    const { ctx, tables } = world({}, [creator]);
    const once = task({ schedule_type: "once", created_by_conversation_id: "creator1" });
    expect(runResultThreadOf(once)).toBe("creator1");
    await settleRunConversation(ctx as any, once, tables.conversations[0] as any, { summary: "CI is green." }, Date.now());

    const posted = tables.messages.find((m) => m.conversation_id === "creator1");
    expect(posted?.subtype).toBe("scheduled_task_result");
    expect(posted?.content).toBe("tr-9 ran in jx7run1:\n\nCI is green.");
    expect(tables.conversations[1].message_count).toBe(8);
    expect(tables.conversations[0].inbox_stashed_at).toBeGreaterThan(0);
  });

  test("a once run with no thread to post into stays in the inbox, filed under done", async () => {
    const { ctx, tables } = world();
    const once = task({ schedule_type: "once" });
    expect(runResultThreadOf(once)).toBeUndefined();
    await settleRunConversation(ctx as any, once, tables.conversations[0] as any, { summary: "Domain still held." }, Date.now());
    expect(tables.conversations[0].inbox_stashed_at).toBeUndefined();
    expect(tables.conversations[0].thread_state_status).toBe("done");

    // The exit neither chimes nor reads as a death: the row rests under Done.
    exitProcess(tables);
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(false);
    expect(tables.notifications.length).toBe(0);
  });

  test("a repeating trigger never posts to the session that armed it", () => {
    expect(runResultThreadOf(task({ created_by_conversation_id: "creator1" }))).toBeUndefined();
    expect(runResultThreadOf(task({ created_by_conversation_id: "creator1", target_conversation_id: "thread1" }))).toBe("thread1");
    // An inject trigger's home is not a fresh run: nothing to route.
    expect(runResultThreadOf(task({ schedule_type: "once", originating_conversation_id: "home1", created_by_conversation_id: "home1" }))).toBeUndefined();
  });

  test("a pin is the user's intent: a pinned run is never folded", async () => {
    const { ctx, tables } = world({ inbox_pinned_at: 5 });
    await settleRunConversation(ctx as any, task(), tables.conversations[0] as any, { summary: "ok" }, Date.now());
    expect(tables.conversations[0].inbox_stashed_at).toBeUndefined();
  });
});

// A resume, a clear or a manual /compact settles the row without a turn having
// ended. Before ct-49533 those events reported nothing at all; now they report
// a settled status, and this is what keeps that status from reading as a
// finished turn.
describe("needs-input check — a session boundary is not a completion", () => {
  test("a resume neither chimes nor claims the dedupe key", async () => {
    const { ctx, tables } = settledIdleWorld({ session: { agent_status_boundary: true } });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });

    expect(res).toEqual({ notified: false, reason: "session_boundary" });
    expect(tables.notifications.length).toBe(0);
    expect(tables.push_outbox ?? []).toEqual([]);
    // Leaving the key unwritten is the point: a key here would read as "this
    // episode was already announced" and swallow the real settle below.
    expect(tables.conversations[0].needs_input_notified_key).toBeUndefined();
  });

  test("the real turn that follows a resume still announces", async () => {
    const { ctx, tables } = settledIdleWorld({ session: { agent_status_boundary: true } });
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    // The user types, the agent works and stops. The hook's next write clears
    // the boundary claim, because the flag describes one settle only.
    await ctx.db.patch("ms1", { agent_status_boundary: undefined });

    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.notified).toBe(true);
    expect(tables.notifications.length).toBe(1);
    expect(tables.conversations[0].needs_input_notified_key).toBe("5:idle");
  });

  test("a boundary never un-stashes a hidden row", async () => {
    const { ctx, tables } = settledIdleWorld({
      conv: { inbox_stashed_at: 111 },
      session: { agent_status_boundary: true },
    });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.reason).toBe("session_boundary");
    expect(tables.conversations[0].inbox_stashed_at).toBe(111);
  });
});

// ── The needs-input digest ───────────────────────────────────────────────────
//
// The whole point: a fleet settling over an afternoon buzzes once an hour, not
// once per session, and the fold-up names the sessions that are still waiting.
describe("needs-input digest — one alert an hour", () => {
  // Three sessions on one user, each settled past the idle grace.
  function fleetWorld(prefs?: Record<string, any>) {
    const now = Date.now();
    const ids = ["conv1", "conv2", "conv3"];
    const titles = ["Fix the parser", "Auth refactor", "Ship the CLI"];
    return createCtx({
      users: [{
        _id: "u1", notifications_enabled: true, push_token: "tok-u1",
        ...(prefs ? { notification_preferences: prefs } : {}),
      }],
      conversations: ids.map((id, i) => ({
        _id: id, user_id: "u1", title: titles[i], status: "active",
        message_count: 5, updated_at: now - 120_000, last_message_role: "assistant",
      })),
      managed_sessions: ids.map((id, i) => ({
        _id: `ms${i + 1}`, user_id: "u1", conversation_id: id, session_id: `sess-${i + 1}`,
        agent_status: "idle", agent_status_updated_at: now - 60_000, last_heartbeat: now - 5_000,
      })),
      messages: ids.map((id, i) => ({
        _id: `m${i + 1}`, conversation_id: id, role: "assistant",
        content: "Done — what next?", timestamp: now - 70_000,
      })),
      pending_permissions: [],
      notifications: [],
    });
  }

  test("the first settle alerts; the rest of the hour goes quiet and folds up", async () => {
    const { ctx, tables } = fleetWorld();
    for (const id of ["conv1", "conv2", "conv3"]) {
      await performNeedsInputCheck(ctx as any, { conversation_id: id });
    }
    // Three rows in the list, one alert: only the first carries a push.
    expect(tables.notifications.length).toBe(3);
    expect(tables.notifications.map((n: Rec) => !!n.quiet)).toEqual([false, true, true]);
    expect(tables.push_outbox.length).toBe(1);

    // The window is armed once, not once per session.
    const armed = tables.users[0].idle_digest_state;
    expect(armed.flush_due_at).toBe(armed.last_alerted_at + IDLE_DIGEST_WINDOW_MS);

    // Wind the clock past the window and run the fold-up the enqueue armed.
    tables.users[0].idle_digest_state.last_alerted_at = Date.now() - IDLE_DIGEST_WINDOW_MS - 1;
    const res = await performIdleDigestFlush(ctx as any, "u1");
    expect(res).toEqual({ notified: true, count: 2 });

    const digest = tables.notifications.find((n: Rec) => n.type === "sessions_need_input");
    expect(digest.message).toBe("Auth refactor and Ship the CLI need your attention");
    expect(digest.conversation_id).toBeUndefined(); // opens the inbox, not one session
    expect(tables.push_outbox.length).toBe(2);
    expect(tables.push_outbox[1].title).toBe("2 sessions need your attention");
  });

  // An escalation's chime rode the idle rail on the role's standing session
  // with no settle episode of its own (R1, revised): the fold-up names it
  // while the escalation under the role is open, and forgets it once handed
  // back.
  test("an escalation through the role's card stays in the fold-up while it is open", async () => {
    const { ctx, tables } = fleetWorld();
    const now = Date.now();
    tables.conversations.push(
      { _id: "standing", user_id: "u1", title: "Growth lead", status: "active", message_count: 40, updated_at: now - 60_000, last_message_role: "assistant", standing_role_id: "role1", anchor_id: "anchor1" },
      { _id: "child", user_id: "u1", title: "Pricing copy", status: "active", message_count: 12, updated_at: now - 60_000, last_message_role: "assistant", org_role_id: "role1", escalated_by_role: { role_id: "role1", line: "needs your eye", at: now - 60_000 } },
    );
    tables.users[0].idle_digest_state = { last_alerted_at: now - 10_000 };
    tables.notifications.push({ _id: "n_esc", recipient_user_id: "u1", type: "session_idle", conversation_id: "standing", message: "@growth: needs your eye", read: false, quiet: true, created_at: now - 5_000 });
    tables.users[0].idle_digest_state.last_alerted_at = now - IDLE_DIGEST_WINDOW_MS - 1;
    let res = await performIdleDigestFlush(ctx as any, "u1");
    expect(res).toEqual({ notified: true, count: 1 });
    expect(tables.notifications.find((n: Rec) => n.type === "sessions_need_input").message).toBe("Growth lead needs your attention");

    // Handed back: the row is stale and the fold-up names nothing.
    delete tables.conversations.find((c: Rec) => c._id === "child").escalated_by_role;
    tables.notifications.push({ _id: "n_esc2", recipient_user_id: "u1", type: "session_idle", conversation_id: "standing", message: "@growth: needs your eye", read: false, quiet: true, created_at: now + 1 });
    tables.users[0].idle_digest_state = { last_alerted_at: now - IDLE_DIGEST_WINDOW_MS - 1 };
    res = await performIdleDigestFlush(ctx as any, "u1");
    expect(res).toEqual({ notified: false, reason: "nothing_waiting" });
  });

  test("a session the user already answered is not named", async () => {
    const { ctx, tables } = fleetWorld();
    for (const id of ["conv1", "conv2", "conv3"]) {
      await performNeedsInputCheck(ctx as any, { conversation_id: id });
    }
    // conv2 got a reply: the turn moved past the episode its row announced.
    tables.conversations[1].message_count = 7;
    tables.users[0].idle_digest_state.last_alerted_at = Date.now() - IDLE_DIGEST_WINDOW_MS - 1;

    const res = await performIdleDigestFlush(ctx as any, "u1");
    expect(res.count).toBe(1);
    const digest = tables.notifications.find((n: Rec) => n.type === "sessions_need_input");
    expect(digest.message).toBe("Ship the CLI needs your attention");
  });

  test("a quiet hour spends no alert: the window closes and the next settle rings", async () => {
    const { ctx, tables } = fleetWorld();
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv2" });
    // Both answered before the fold-up ran.
    tables.conversations[0].message_count = 9;
    tables.conversations[1].message_count = 9;
    tables.users[0].idle_digest_state.last_alerted_at = Date.now() - IDLE_DIGEST_WINDOW_MS - 1;

    const res = await performIdleDigestFlush(ctx as any, "u1");
    expect(res).toEqual({ notified: false, reason: "nothing_waiting" });
    expect(tables.notifications.some((n: Rec) => n.type === "sessions_need_input")).toBe(false);

    // The budget was not spent, so the next session to settle alerts at once.
    const pushesBefore = tables.push_outbox.length;
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv3" });
    expect(tables.push_outbox.length).toBe(pushesBefore + 1);
    expect(tables.notifications.find((n: Rec) => n.conversation_id === "conv3").quiet).toBeUndefined();
  });

  test("a fold-up that fires before its window ends waits the rest out", async () => {
    const { ctx, tables, scheduled } = fleetWorld();
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv2" });
    const res = await performIdleDigestFlush(ctx as any, "u1");
    expect(res.reason).toBe("early");
    expect(tables.notifications.some((n: Rec) => n.type === "sessions_need_input")).toBe(false);
    expect(scheduled.some((s) => s.args.user_id === "u1")).toBe(true);
  });

  test("the fold-up replaces the previous one instead of stacking", async () => {
    const { ctx, tables } = fleetWorld();
    tables.notifications.push({
      _id: "n_old_digest", recipient_user_id: "u1", type: "sessions_need_input",
      message: "2 sessions need your attention", read: false, created_at: Date.now() - 1000,
    });
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv2" });
    tables.users[0].idle_digest_state.last_alerted_at = Date.now() - IDLE_DIGEST_WINDOW_MS - 1;
    await performIdleDigestFlush(ctx as any, "u1");
    expect(tables.notifications.filter((n: Rec) => n.type === "sessions_need_input").length).toBe(1);
    expect(tables.notifications.some((n: Rec) => n._id === "n_old_digest")).toBe(false);
  });

  test("the aggregate line names two and counts the rest", () => {
    expect(summarizeIdleDigest(["A"])).toEqual({
      title: "1 session needs your attention",
      message: "A needs your attention",
    });
    expect(summarizeIdleDigest(["A", "B"]).message).toBe("A and B need your attention");
    expect(summarizeIdleDigest(["A", "B", "C"]).message).toBe("A, B and 1 other need your attention");
    expect(summarizeIdleDigest(["A", "B", "C", "D"]).message).toBe("A, B and 2 others need your attention");
  });
});
