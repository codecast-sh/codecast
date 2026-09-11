import { afterEach, describe, expect, test } from "bun:test";
import {
  buildLiveActivityPayload,
  performLiveActivityRefresh,
  resolveLiveActivityPush,
  liveActivitySessionOf,
} from "./liveActivity";
import { scheduleLiveActivityRefresh } from "./lib/liveActivityRefresh";
import {
  LIVE_ACTIVITY_ATTRIBUTES_TYPE,
  LIVE_ACTIVITY_PUSH_INTERVAL_MS,
  LIVE_ACTIVITY_START_GRACE_MS,
  LIVE_ACTIVITY_SWEEP_INTERVAL_MS,
  deriveLiveActivityState,
} from "@codecast/shared/contracts";

// ── In-memory Convex-ish ctx ─────────────────────────────────────────────────
// Same pattern as notifications.needsInput.test.ts, plus the one range shape
// the live-session read uses (`by_user_heartbeat`: eq + gt).

type Rec = Record<string, any>;

function createCtx(seed: Record<string, Rec[]>) {
  const tables: Record<string, Rec[]> = {};
  const counters: Record<string, number> = {};
  for (const [table, rows] of Object.entries(seed)) tables[table] = rows.map((r) => ({ ...r }));
  const allRows = () => Object.values(tables).flat();

  const db = {
    async get(id: string) {
      return allRows().find((r) => r._id === id) ?? null;
    },
    async insert(table: string, doc: Rec) {
      counters[table] = (counters[table] ?? 0) + 1;
      const _id = `${table}_${counters[table]}`;
      (tables[table] ??= []).push({ _id, _creationTime: Date.now(), ...doc });
      return _id;
    },
    async patch(id: string, patch: Rec) {
      const row = allRows().find((r) => r._id === id);
      if (!row) throw new Error(`patch: no row ${id}`);
      for (const [k, val] of Object.entries(patch)) {
        if (val === undefined) delete row[k];
        else row[k] = val;
      }
    },
    async delete(id: string) {
      for (const rows of Object.values(tables)) {
        const i = rows.findIndex((r) => r._id === id);
        if (i !== -1) return void rows.splice(i, 1);
      }
      throw new Error(`delete: no row ${id}`);
    },
    query(table: string) {
      const preds: Array<(r: Rec) => boolean> = [];
      const q: any = {
        eq(field: string, val: any) {
          preds.push((r) => String(r[field]) === String(val));
          return q;
        },
        gt(field: string, val: any) {
          preds.push((r) => (r[field] ?? -Infinity) > val);
          return q;
        },
      };
      let desc = false;
      const filterQ = {
        field: (name: string) => ({ __field: name }),
        eq: (a: any, b: any) => ({ __eq: [a, b] }),
      };
      const operand = (r: Rec, x: any) => (x && typeof x === "object" && "__field" in x ? r[x.__field] : x);
      const run = () => {
        const rows = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
        if (desc) rows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
        return rows;
      };
      const chain: any = {
        withIndex(_name: string, builder?: (qq: any) => unknown) {
          if (builder) builder(q);
          return chain;
        },
        filter(builder: (fq: any) => any) {
          const expr = builder(filterQ);
          preds.push((r) => String(operand(r, expr.__eq[0])) === String(operand(r, expr.__eq[1])));
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

  const scheduled: Array<{ delay: number; fn: unknown; args: Rec }> = [];
  const scheduler = {
    async runAfter(delay: number, fn: unknown, args: Rec) {
      scheduled.push({ delay, fn, args });
    },
  };
  return { ctx: { db, scheduler }, tables, scheduled };
}

const NOW = 1_754_000_000_000;
const realNow = Date.now;
afterEach(() => {
  Date.now = realNow;
});
function freezeTime(at: number) {
  Date.now = () => at;
}

// The pushes the refresh handed to the scheduler (internal.liveActivity.push
// carries an `event`); the sweeps it armed carry a `due`.
const pushes = (w: ReturnType<typeof createCtx>) => w.scheduled.filter((s) => s.args.event);
const sweeps = (w: ReturnType<typeof createCtx>) => w.scheduled.filter((s) => s.args.due !== undefined);

function world(over: {
  row?: Rec | null;
  sessions?: Rec[];
  conversations?: Rec[];
  messages?: Rec[];
  user?: Rec;
} = {}) {
  return createCtx({
    users: [{ _id: "u1", notifications_enabled: true, push_token: "tok", ...(over.user ?? {}) }],
    live_activities:
      over.row === null
        ? []
        : [
            {
              _id: "la1",
              user_id: "u1",
              environment: "sandbox",
              push_to_start_token: "start-token",
              updated_at: NOW - 100_000,
              ...(over.row ?? {}),
            },
          ],
    managed_sessions: over.sessions ?? [
      {
        _id: "ms1",
        user_id: "u1",
        session_id: "s1",
        conversation_id: "conv1",
        last_heartbeat: NOW - 5_000,
        agent_status: "working",
        agent_status_updated_at: NOW - 30_000,
      },
    ],
    conversations: over.conversations ?? [
      {
        _id: "conv1",
        _creationTime: NOW - 600_000,
        user_id: "u1",
        title: "Fix the parser",
        agent_type: "claude",
        project_path: "/Users/me/src/codecast",
        status: "active",
        message_count: 5,
        updated_at: NOW - 5_000,
        last_message_role: "assistant",
      },
    ],
    messages: over.messages ?? [
      { _id: "m1", conversation_id: "conv1", role: "assistant", content: "Working on it", timestamp: NOW - 5_000 },
    ],
    agent_tasks: [],
  });
}

describe("resolveLiveActivityPush", () => {
  const base = {
    now: NOW,
    quiet: false,
    stateKey: "S1",
    statusKey: "conv1:working|0",
    hasStartToken: true,
    activityBound: false,
    startSentAt: null,
    lastPushAt: null,
    lastStateKey: null,
    lastStatusKey: null,
    dismissedStatusKey: null,
  };
  test("something live and nothing running starts", () => {
    expect(resolveLiveActivityPush(base)).toEqual({ action: "start" });
  });
  test("no start token and nothing bound does nothing", () => {
    expect(resolveLiveActivityPush({ ...base, hasStartToken: false })).toEqual({ action: "none" });
  });
  test("a start in flight waits out the grace", () => {
    const at = NOW - 2_000;
    expect(resolveLiveActivityPush({ ...base, startSentAt: at })).toEqual({
      action: "wait",
      at: at + LIVE_ACTIVITY_START_GRACE_MS,
    });
  });
  test("a start whose grace ran out starts again", () => {
    expect(resolveLiveActivityPush({ ...base, startSentAt: NOW - LIVE_ACTIVITY_START_GRACE_MS })).toEqual({
      action: "start",
    });
  });
  test("the picture the person swiped away never restarts by itself", () => {
    expect(resolveLiveActivityPush({ ...base, dismissedStatusKey: base.statusKey })).toEqual({ action: "none" });
    expect(resolveLiveActivityPush({ ...base, dismissedStatusKey: "conv1:waiting|0" })).toEqual({ action: "start" });
  });
  test("bound and unchanged is a no-op", () => {
    expect(resolveLiveActivityPush({ ...base, activityBound: true, lastStateKey: "S1" })).toEqual({ action: "none" });
  });
  test("a routine change inside the interval waits for it", () => {
    const last = NOW - 5_000;
    expect(
      resolveLiveActivityPush({ ...base, activityBound: true, lastStateKey: "S0", lastStatusKey: base.statusKey, lastPushAt: last }),
    ).toEqual({ action: "wait", at: last + LIVE_ACTIVITY_PUSH_INTERVAL_MS });
  });
  test("a routine change past the interval updates at normal priority", () => {
    expect(
      resolveLiveActivityPush({
        ...base,
        activityBound: true,
        lastStateKey: "S0",
        lastStatusKey: base.statusKey,
        lastPushAt: NOW - LIVE_ACTIVITY_PUSH_INTERVAL_MS,
      }),
    ).toEqual({ action: "update", urgent: false });
  });
  test("a status change updates at once, interval or not", () => {
    expect(
      resolveLiveActivityPush({ ...base, activityBound: true, lastStateKey: "S0", lastStatusKey: "conv1:waiting|0", lastPushAt: NOW - 1 }),
    ).toEqual({ action: "update", urgent: true });
  });
  test("quiet ends a bound activity and waits on an unbound start", () => {
    expect(resolveLiveActivityPush({ ...base, quiet: true, activityBound: true })).toEqual({ action: "end" });
    expect(resolveLiveActivityPush({ ...base, quiet: true, startSentAt: NOW - 1_000 })).toEqual({
      action: "wait",
      at: NOW - 1_000 + LIVE_ACTIVITY_START_GRACE_MS,
    });
    expect(resolveLiveActivityPush({ ...base, quiet: true })).toEqual({ action: "none" });
  });
});

describe("buildLiveActivityPayload", () => {
  const state = deriveLiveActivityState(
    [{ id: "a", title: "Fix the parser", agent: "claude", status: "waiting", startedAt: NOW - 1000, updatedAt: NOW }],
    NOW,
  );
  test("a start names the attributes type and carries an alert", () => {
    const p: any = buildLiveActivityPayload({ event: "start", content_state: state, urgent: true, now: NOW });
    expect(p.aps.event).toBe("start");
    expect(p.aps["attributes-type"]).toBe(LIVE_ACTIVITY_ATTRIBUTES_TYPE);
    expect(p.aps.attributes).toEqual({});
    expect(p.aps.alert.title).toBe("Fix the parser");
    expect(p.aps["content-state"]).toBe(state);
    expect(p.aps["stale-date"]).toBeGreaterThan(Math.floor(NOW / 1000));
    expect(p.aps["relevance-score"]).toBe(100);
    expect(p.aps.timestamp).toBe(Math.floor(NOW / 1000));
  });
  test("an update carries neither attributes nor alert", () => {
    const p: any = buildLiveActivityPayload({ event: "update", content_state: state, urgent: false, now: NOW });
    expect(p.aps["attributes-type"]).toBeUndefined();
    expect(p.aps.alert).toBeUndefined();
    expect(p.aps["dismissal-date"]).toBeUndefined();
  });
  test("an end names when the strip may leave", () => {
    const p: any = buildLiveActivityPayload({ event: "end", content_state: state, urgent: true, now: NOW });
    expect(p.aps["dismissal-date"]).toBeGreaterThan(Math.floor(NOW / 1000));
  });
});

describe("liveActivitySessionOf", () => {
  const conv = {
    _id: "conv1",
    _creationTime: NOW - 600_000,
    title: "Fix the parser",
    agent_type: "codex",
    project_path: "/x/codecast",
    subtitle: "parser.ts",
  };
  const verdict = (state: string, over: Rec = {}) => ({
    state,
    agentStatus: "working",
    activity: { isUnresponsive: false },
    awaitingInput: false,
    lastMsg: null,
    ...over,
  });
  test("a working row uses the pinned state's first line as its title", () => {
    const row = liveActivitySessionOf(
      { ...conv, thread_state: "Migrating the sync layer\nStatus: tests green" },
      verdict("working"),
      NOW,
    );
    expect(row).toMatchObject({ title: "Migrating the sync layer", detail: "parser.ts", project: "codecast", agent: "codex", status: "working" });
  });
  test("a waiting row leads with the question", () => {
    const row = liveActivitySessionOf(
      conv,
      verdict("needs_input", {
        agentStatus: "idle",
        awaitingInput: true,
        lastMsg: {
          role: "assistant",
          tool_calls: [{ name: "AskUserQuestion", input: JSON.stringify({ questions: [{ question: "Ship it to prod?" }] }) }],
        },
      }),
      NOW,
    );
    expect(row?.status).toBe("waiting");
    expect(row?.detail).toContain("Ship it to prod?");
  });
  test("a dead process reads as failed, with the error when there is one", () => {
    expect(liveActivitySessionOf(conv, verdict("needs_input", { agentStatus: "stopped" }), NOW)).toMatchObject({
      status: "failed",
      detail: "The agent stopped",
    });
    expect(liveActivitySessionOf({ ...conv, session_error: "usage limit" }, verdict("working"), NOW)).toMatchObject({
      status: "failed",
      detail: "usage limit",
    });
  });
  test("parked and blank rows have no place on the strip", () => {
    expect(liveActivitySessionOf(conv, verdict("dormant"), NOW)).toBeNull();
    expect(liveActivitySessionOf(conv, verdict("idle"), NOW)).toBeNull();
  });
});

describe("performLiveActivityRefresh", () => {
  test("no phone registered: nothing happens", async () => {
    freezeTime(NOW);
    const w = world({ row: null });
    expect(await performLiveActivityRefresh(w.ctx, "u1" as any)).toEqual({ action: "none", reason: "no_row" });
    expect(w.scheduled).toHaveLength(0);
  });

  test("a live session and a start token: one start push, then a sweep", async () => {
    freezeTime(NOW);
    const w = world();
    expect(await performLiveActivityRefresh(w.ctx, "u1" as any)).toEqual({ action: "start" });
    const [push] = pushes(w);
    expect(push.args).toMatchObject({ event: "start", token: "start-token", environment: "sandbox", urgent: true });
    expect(push.args.content_state.headline).toBe("Fix the parser");
    expect(push.args.content_state.sessions[0]).toMatchObject({ id: "conv1", status: "working", project: "codecast" });
    expect(push.args.alert.title).toBe("Fix the parser");
    const row = w.tables.live_activities[0];
    expect(row.start_sent_at).toBe(NOW);
    expect(row.last_status_key).toBe("conv1:working|0");
    expect(sweeps(w)).toHaveLength(1);
    expect(sweeps(w)[0].delay).toBe(LIVE_ACTIVITY_SWEEP_INTERVAL_MS);
  });

  test("before the device reports the id, a second refresh waits instead of starting again", async () => {
    freezeTime(NOW);
    const w = world({ row: { start_sent_at: NOW - 2_000, last_state_key: "old", last_status_key: "conv1:working|0", refresh_due_at: NOW } });
    expect(await performLiveActivityRefresh(w.ctx, "u1" as any, NOW)).toEqual({ action: "wait" });
    expect(pushes(w)).toHaveLength(0);
    expect(sweeps(w)[0].delay).toBe(LIVE_ACTIVITY_START_GRACE_MS - 2_000);
  });

  test("a fire whose due stamp moved on stands down", async () => {
    freezeTime(NOW);
    const w = world({ row: { refresh_due_at: NOW + 5 } });
    expect(await performLiveActivityRefresh(w.ctx, "u1" as any, NOW)).toEqual({ action: "none", reason: "superseded" });
    expect(w.scheduled).toHaveLength(0);
  });

  test("bound and unchanged pushes nothing but keeps the sweep alive", async () => {
    freezeTime(NOW);
    const w = world();
    await performLiveActivityRefresh(w.ctx, "u1" as any);
    const key = w.tables.live_activities[0].last_state_key;
    w.scheduled.length = 0;
    await w.ctx.db.patch("la1", { activity_id: "act1", activity_token: "act-token", start_sent_at: undefined });
    expect(await performLiveActivityRefresh(w.ctx, "u1" as any)).toEqual({ action: "none" });
    expect(pushes(w)).toHaveLength(0);
    expect(sweeps(w)).toHaveLength(1);
    expect(w.tables.live_activities[0].last_state_key).toBe(key);
  });

  test("the agent settles into waiting: an urgent update through the activity token", async () => {
    freezeTime(NOW);
    const w = world({ row: { activity_id: "act1", activity_token: "act-token", last_state_key: "S0", last_status_key: "conv1:working|0", last_push_at: NOW - 1 } });
    await w.ctx.db.patch("ms1", { agent_status: "idle", agent_status_updated_at: NOW - 60_000 });
    expect(await performLiveActivityRefresh(w.ctx, "u1" as any)).toEqual({ action: "update" });
    const [push] = pushes(w);
    expect(push.args).toMatchObject({ event: "update", token: "act-token", activity_id: "act1", urgent: true });
    expect(push.args.content_state.status).toBe("waiting");
    expect(push.args.content_state.headline).toBe("Fix the parser");
    expect(push.args.content_state.sessions[0].status).toBe("waiting");
    expect(w.tables.live_activities[0].last_status_key).toBe("conv1:waiting|0");
  });

  test("a reworded title inside the interval waits for it", async () => {
    freezeTime(NOW);
    const w = world({ row: { activity_id: "act1", activity_token: "act-token", last_state_key: "S0", last_status_key: "conv1:working|0", last_push_at: NOW - 3_000 } });
    expect(await performLiveActivityRefresh(w.ctx, "u1" as any)).toEqual({ action: "wait" });
    expect(pushes(w)).toHaveLength(0);
    expect(sweeps(w)[0].delay).toBe(LIVE_ACTIVITY_PUSH_INTERVAL_MS - 3_000);
  });

  test("the last session is killed: the activity ends and the binding clears", async () => {
    freezeTime(NOW);
    const w = world({ row: { activity_id: "act1", activity_token: "act-token", last_state_key: "S0", last_status_key: "conv1:working|0" } });
    await w.ctx.db.patch("conv1", { inbox_killed_at: NOW });
    expect(await performLiveActivityRefresh(w.ctx, "u1" as any)).toEqual({ action: "end" });
    const [push] = pushes(w);
    expect(push.args).toMatchObject({ event: "end", token: "act-token", activity_id: "act1" });
    expect(push.args.content_state.headline).toBe("All clear");
    const row = w.tables.live_activities[0];
    expect(row.activity_id).toBeUndefined();
    expect(row.activity_token).toBeUndefined();
    expect(row.last_state_key).toBeUndefined();
    expect(sweeps(w)).toHaveLength(0);
  });

  test("a finished session lingers, and the sweep is armed for its expiry", async () => {
    freezeTime(NOW);
    const w = world({ row: { activity_id: "act1", activity_token: "act-token" } });
    // The daemon carries a `cast state --status done` as the settle status.
    await w.ctx.db.patch("ms1", { agent_status: "done", agent_status_updated_at: NOW - 60_000 });
    await w.ctx.db.patch("conv1", { thread_state: "Shipped the fix", thread_state_status: "done", thread_state_at: NOW - 60_000 });
    expect(await performLiveActivityRefresh(w.ctx, "u1" as any)).toEqual({ action: "update" });
    expect(pushes(w)[0].args.content_state.sessions[0]).toMatchObject({ status: "done", title: "Shipped the fix" });
    // The linger is 90s from the transition, 60s ago: the sweep fires in 30s.
    expect(sweeps(w)[0].delay).toBe(30_000);
  });

  test("the Lock Screen switch off ends a running activity", async () => {
    freezeTime(NOW);
    const w = world({
      row: { activity_id: "act1", activity_token: "act-token", last_state_key: "S0" },
      user: { notification_preferences: { live_activity: false } },
    });
    expect(await performLiveActivityRefresh(w.ctx, "u1" as any)).toEqual({ action: "end" });
  });

  test("subagents, hidden rows and fleet workers never reach the strip", async () => {
    freezeTime(NOW);
    const w = world({ row: { activity_id: "act1", activity_token: "act-token", last_state_key: "S0" } });
    await w.ctx.db.patch("conv1", { is_subagent: true });
    expect(await performLiveActivityRefresh(w.ctx, "u1" as any)).toEqual({ action: "end" });
  });
});

describe("scheduleLiveActivityRefresh", () => {
  test("no row, or a row with nothing to address, schedules nothing", async () => {
    freezeTime(NOW);
    const none = world({ row: null });
    expect(await scheduleLiveActivityRefresh(none.ctx, "u1" as any, { urgent: true })).toBe(false);
    const bare = world({ row: { push_to_start_token: undefined } });
    expect(await scheduleLiveActivityRefresh(bare.ctx, "u1" as any, { urgent: true })).toBe(false);
    expect(bare.scheduled).toHaveLength(0);
  });
  test("urgent fires now and stamps the row; a routine ask yields to it", async () => {
    freezeTime(NOW);
    const w = world();
    expect(await scheduleLiveActivityRefresh(w.ctx, "u1" as any, { urgent: true })).toBe(true);
    expect(w.scheduled[0]).toMatchObject({ delay: 0, args: { user_id: "u1", due: NOW } });
    expect(w.tables.live_activities[0].refresh_due_at).toBe(NOW);
    expect(await scheduleLiveActivityRefresh(w.ctx, "u1" as any, {})).toBe(false);
    expect(w.scheduled).toHaveLength(1);
  });
  test("an urgent ask supersedes a routine one already pending", async () => {
    freezeTime(NOW);
    const w = world({ row: { activity_id: "act1", activity_token: "t", refresh_due_at: NOW + 40_000 } });
    expect(await scheduleLiveActivityRefresh(w.ctx, "u1" as any, { urgent: true })).toBe(true);
    expect(w.tables.live_activities[0].refresh_due_at).toBe(NOW);
  });
});
