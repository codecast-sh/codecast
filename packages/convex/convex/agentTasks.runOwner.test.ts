import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { claimTask, completeTaskRun, failTaskRun, reclaimStaleTasks } from "./agentTasks";
import { hashToken } from "./apiTokens";
import { makeFakeDb } from "./testDb";

// A once trigger armed from a session and run fresh (`--spawn`) is that
// session's worker: the run nests under it, and the outcomes the owner must
// act on (a death, a failure, a limit park's resume) reach the owner as a
// turn, never as a loose inbox card nobody owns. tr-887 on 2026-09-18 is the
// shape these pin: three runs into one usage limit, three cards, no report.

const NOW = 1_800_000_000_000;
const USER = "users_owner";
const OWNER = "conversations_owner";
const RUN = "conversations_run";
const RUN_UUID = "run-uuid-1";
const TOKEN = "run-owner-test-token";
const DAEMON = "laptop-daemon";
let time: ReturnType<typeof spyOn>;

beforeEach(() => { time = spyOn(Date, "now").mockReturnValue(NOW); });
afterEach(() => { time.mockRestore(); });

function task(overrides: Record<string, any> = {}) {
  return {
    _id: "agent_tasks_owned",
    _creationTime: 1,
    user_id: USER,
    short_id: "tr-887",
    created_by_conversation_id: OWNER,
    title: "Report how session parking behaved",
    prompt: "Report it.",
    schedule_type: "once",
    status: "running",
    lease_holder: DAEMON,
    lease_expires_at: NOW + 60_000,
    run_at: NOW - 1,
    run_count: 0,
    retry_count: 0,
    max_retries: 3,
    mode: "apply",
    created_at: 1,
    ...overrides,
  };
}

async function world(overrides: Record<string, any> = {}, tableOverrides: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    agent_tasks: [task(overrides)],
    conversations: [
      { _id: OWNER, user_id: USER, session_id: "owner-session", status: "active", owner_device_id: "laptop" },
      { _id: RUN, user_id: USER, session_id: RUN_UUID, status: "active", short_id: "jx74v0r", agent_task_id: "agent_tasks_owned" },
    ],
    devices: [{ _id: "devices_laptop", user_id: USER, device_id: "laptop", is_remote: false, last_seen: NOW - 1000,
      cc_accounts: { profiles: [{ name: "a", usage: { session: { resets_at: NOW + 3_600_000 } } }] } }],
    api_tokens: [{ _id: "api_tokens_owner", user_id: USER, token_hash: await hashToken(TOKEN) }],
    pending_messages: [],
    ...tableOverrides,
  };
  const db = makeFakeDb(tables);
  const ctx = { db, scheduler: { runAfter: async () => {} } };
  return { ctx, tables };
}

const complete = (ctx: any, args: Record<string, any>) => (completeTaskRun as any)._handler(ctx, {
  api_token: TOKEN, task_id: "agent_tasks_owned", ...args,
});
const fail = (ctx: any, args: Record<string, any> = {}) => (failTaskRun as any)._handler(ctx, {
  api_token: TOKEN, task_id: "agent_tasks_owned", daemon_id: DAEMON, run_session_uuid: RUN_UUID, ...args,
});
const run = (tables: Record<string, any[]>) => tables.conversations.find((c) => c._id === RUN);
const wakes = (tables: Record<string, any[]>) => tables.pending_messages.filter((m) => m.conversation_id === OWNER);

describe("a once spawn run and its owner", () => {
  test("the run nests under the session that armed the trigger", async () => {
    const { ctx, tables } = await world();
    await complete(ctx, { summary: "All parked and resumed.", run_session_uuid: RUN_UUID });
    expect(run(tables)).toMatchObject({ agent_task_id: "agent_tasks_owned", parent_conversation_id: OWNER, is_subagent: true });
  });

  test("a clean report is posted to the owner without a wake", async () => {
    const { ctx, tables } = await world();
    await complete(ctx, { summary: "All parked and resumed.", run_session_uuid: RUN_UUID });
    expect(wakes(tables)).toHaveLength(0);
    expect(tables.agent_tasks[0].status).toBe("completed");
  });

  test("--wake turns a clean report into the owner's turn", async () => {
    const { ctx, tables } = await world({ wake_creator: true });
    await complete(ctx, { summary: "All parked and resumed.", run_session_uuid: RUN_UUID });
    expect(wakes(tables)).toHaveLength(1);
    expect(wakes(tables)[0].content).toContain("All parked and resumed.");
    expect(wakes(tables)[0].origin).toBe("scheduler");
  });

  test("--needs-attention wakes the owner", async () => {
    const { ctx, tables } = await world();
    await complete(ctx, { summary: "One park never resumed.", needs_attention: true, run_session_uuid: RUN_UUID });
    expect(wakes(tables)).toHaveLength(1);
    expect(wakes(tables)[0].content).toContain("needs attention");
  });

  test("a run that ends without reporting wakes the owner", async () => {
    const { ctx, tables } = await world();
    await complete(ctx, { daemon_id: DAEMON, run_session_uuid: RUN_UUID });
    expect(wakes(tables)).toHaveLength(1);
    expect(wakes(tables)[0].content).toContain("ended without reporting");
  });

  test("the terminal failure wakes the owner; the retries before it do not", async () => {
    const { ctx, tables } = await world({ retry_count: 1 });
    await fail(ctx, { error: "Exceeded max runtime (10min)" });
    expect(tables.agent_tasks[0]).toMatchObject({ status: "scheduled", retry_count: 2 });
    expect(wakes(tables)).toHaveLength(0);

    Object.assign(tables.agent_tasks[0], { status: "running", lease_holder: DAEMON });
    await fail(ctx, { error: "Exceeded max runtime (10min)" });
    expect(tables.agent_tasks[0].status).toBe("failed");
    expect(wakes(tables)).toHaveLength(1);
    expect(wakes(tables)[0].content).toContain("Exceeded max runtime");
    expect(wakes(tables)[0].content).toContain("jx74v0r");
  });

});

// A repeating spawn schedule has no owner, because a line per firing would
// bury the creator's thread. It still has a PARENT: the run nests under the
// session that armed it, so an hourly job is read under that session instead
// of being a card an hour. Nesting hides the row from the inbox, so the
// outcomes nobody would otherwise see — a death, an ask, a terminal failure —
// wake the parent. A clean report stays silent, which is the point of --spawn.
describe("a recurring spawn run and its parent", () => {
  const recurring = (overrides: Record<string, any> = {}) =>
    world({ schedule_type: "recurring", interval_ms: 3_600_000, ...overrides });

  test("the run nests under the session that armed the trigger", async () => {
    const { ctx, tables } = await recurring();
    await complete(ctx, { summary: "Nothing to report.", run_session_uuid: RUN_UUID });
    expect(run(tables)).toMatchObject({ parent_conversation_id: OWNER, is_subagent: true });
  });

  test("a clean report wakes nobody and posts nowhere", async () => {
    const { ctx, tables } = await recurring();
    await complete(ctx, { summary: "Nothing to report.", run_session_uuid: RUN_UUID });
    expect(wakes(tables)).toHaveLength(0);
  });

  test("--needs-attention wakes the parent", async () => {
    const { ctx, tables } = await recurring();
    await complete(ctx, { summary: "The collector is returning 403.", needs_attention: true, run_session_uuid: RUN_UUID });
    expect(wakes(tables)).toHaveLength(1);
    expect(wakes(tables)[0].content).toContain("The collector is returning 403.");
  });

  test("a run that ends without reporting wakes the parent", async () => {
    const { ctx, tables } = await recurring();
    await complete(ctx, { daemon_id: DAEMON, run_session_uuid: RUN_UUID });
    expect(wakes(tables)).toHaveLength(1);
    expect(wakes(tables)[0].content).toContain("ended without reporting");
  });

  test("the terminal failure wakes the parent; the retries before it do not", async () => {
    const { ctx, tables } = await recurring({ retry_count: 1 });
    await fail(ctx, { error: "boom" });
    expect(wakes(tables)).toHaveLength(0);

    Object.assign(tables.agent_tasks[0], { status: "running", lease_holder: DAEMON });
    await fail(ctx, { error: "boom" });
    expect(wakes(tables)).toHaveLength(1);
    expect(wakes(tables)[0].content).toContain("boom");
  });

  // Nesting under a session nobody reads would hide the run outright, which is
  // strictly worse than the loose card it replaces.
  test("a killed parent leaves the run a visible card", async () => {
    const { ctx, tables } = await world(
      { schedule_type: "recurring", interval_ms: 3_600_000 },
      {
        conversations: [
          { _id: OWNER, user_id: USER, session_id: "owner-session", status: "active", owner_device_id: "laptop", inbox_killed_at: NOW - 1000 },
          { _id: RUN, user_id: USER, session_id: RUN_UUID, status: "active", short_id: "jx74v0r", agent_task_id: "agent_tasks_owned" },
        ],
      },
    );
    await complete(ctx, { summary: "Nothing to report.", run_session_uuid: RUN_UUID });
    expect(run(tables).parent_conversation_id).toBeUndefined();
    expect(run(tables).is_subagent).toBeUndefined();
  });
});

describe("a run parked at a usage limit", () => {
  const parked = () => world({}, {
    conversations: [
      { _id: OWNER, user_id: USER, session_id: "owner-session", status: "active", owner_device_id: "laptop" },
      { _id: RUN, user_id: USER, session_id: RUN_UUID, status: "active", short_id: "jx74v0r", pending_api_error_kind: "limit" },
    ],
  });

  test("the daemon's timeout re-arms the trigger at the window reset instead of spending a retry", async () => {
    const { ctx, tables } = await parked();
    await fail(ctx, { error: "Exceeded max runtime (10min)" });
    expect(tables.agent_tasks[0]).toMatchObject({
      status: "scheduled",
      retry_count: 0,
      run_at: NOW + 3_600_000 + 120_000,
      parked_run_session_uuid: RUN_UUID,
      last_run_failed: true,
    });
    expect(tables.agent_tasks[0].lease_holder).toBeUndefined();
    expect(wakes(tables)).toHaveLength(0);
  });

  test("the process ending on the banner is the same park, not a completion", async () => {
    const { ctx, tables } = await parked();
    await complete(ctx, { daemon_id: DAEMON, run_session_uuid: RUN_UUID });
    expect(tables.agent_tasks[0]).toMatchObject({ status: "scheduled", parked_run_session_uuid: RUN_UUID, run_count: 0 });
    expect(wakes(tables)).toHaveLength(0);
  });

  test("with no reset reported the park waits an hour", async () => {
    const { ctx, tables } = await parked();
    tables.devices[0].cc_accounts = { profiles: [{ name: "a" }] };
    await fail(ctx, { error: "Exceeded max runtime (10min)" });
    expect(tables.agent_tasks[0].run_at).toBe(NOW + 3_600_000 + 120_000);
  });

  test("the next claim hands the daemon the session to resume, once", async () => {
    const { ctx, tables } = await parked();
    await fail(ctx, { error: "Exceeded max runtime (10min)" });
    const claimed = await (claimTask as any)._handler(ctx, { api_token: TOKEN, task_id: "agent_tasks_owned", daemon_id: DAEMON });
    expect(claimed.parked_run_session_uuid).toBe(RUN_UUID);
    expect(tables.agent_tasks[0].parked_run_session_uuid).toBeUndefined();
  });
});

// The daemon that held a run's lease restarted mid-run (2026-09-19, tr-917):
// its monitor is gone, the lease lapses, and the sweep must judge the run by
// its conversation, not re-fire it. A run whose agent already stopped is
// finished work; a run parked at a limit is a park. Only a run still going
// (or never linked) is worth a retry.
describe("a lapsed lease on a spawn run", () => {
  const lapsed = (conv: Record<string, any> = {}, agentStatus?: string) => world({ lease_expires_at: NOW - 1 }, {
    conversations: [
      { _id: OWNER, user_id: USER, session_id: "owner-session", status: "active", owner_device_id: "laptop" },
      { _id: RUN, user_id: USER, session_id: RUN_UUID, status: "active", short_id: "jx74v0r", agent_task_id: "agent_tasks_owned", ...conv },
    ],
    managed_sessions: agentStatus ? [{ _id: "managed_run", user_id: USER, session_id: RUN_UUID, conversation_id: RUN, agent_status: agentStatus }] : [],
  });
  const reclaim = (ctx: any) => (reclaimStaleTasks as any)._handler(ctx, {});

  test("a run whose agent stopped settles as an unreported exit and wakes the owner", async () => {
    const { ctx, tables } = await lapsed({}, "stopped");
    await reclaim(ctx);
    expect(tables.agent_tasks[0]).toMatchObject({ status: "completed", retry_count: 0, run_count: 1 });
    expect(wakes(tables)).toHaveLength(1);
    expect(wakes(tables)[0].content).toContain("ended without reporting");
    expect(run(tables).parent_conversation_id).toBe(OWNER);
  });

  test("a run parked at a limit re-arms at the reset", async () => {
    const { ctx, tables } = await lapsed({ pending_api_error_kind: "limit" });
    await reclaim(ctx);
    expect(tables.agent_tasks[0]).toMatchObject({ status: "scheduled", retry_count: 0, run_at: NOW + 3_600_000 + 120_000, parked_run_session_uuid: RUN_UUID });
    expect(wakes(tables)).toHaveLength(0);
  });

  test("a run still going is retried as before", async () => {
    const { ctx, tables } = await lapsed({}, "working");
    await reclaim(ctx);
    expect(tables.agent_tasks[0]).toMatchObject({ status: "scheduled", retry_count: 1, run_at: NOW });
    expect(wakes(tables)).toHaveLength(0);
  });
});
