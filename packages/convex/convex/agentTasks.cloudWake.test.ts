import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { claimTask, completeTaskRun, dispatchCloudTriggers, getDueTasks, matchTaskTriggers } from "./agentTasks";
import { hashToken } from "./apiTokens";
import crons from "./crons";
import { makeFakeDb } from "./testDb";

const NOW = 1_800_000_000_000;
const USER = "users_cloud";
const CONV = "conversations_cloud";
const DEVICE = "cloud-box";
const TOKEN = "cloud-trigger-test-token";
const HOST = { ownerUserId: USER, deviceId: DEVICE, instanceId: "i-0123456789abcdef0", region: "us-east-1" };
let previousHosts: string | undefined;
let time: ReturnType<typeof spyOn>;
let log: ReturnType<typeof spyOn>;

beforeEach(() => {
  previousHosts = process.env.CAST_CLOUD_WAKE_HOSTS;
  process.env.CAST_CLOUD_WAKE_HOSTS = JSON.stringify([HOST]);
  time = spyOn(Date, "now").mockReturnValue(NOW);
  log = spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  if (previousHosts === undefined) delete process.env.CAST_CLOUD_WAKE_HOSTS;
  else process.env.CAST_CLOUD_WAKE_HOSTS = previousHosts;
  time.mockRestore();
  log.mockRestore();
});

function task(overrides: Record<string, any> = {}) {
  return {
    _id: "agent_tasks_cloud",
    _creationTime: 1,
    user_id: USER,
    originating_conversation_id: CONV,
    title: 'Check "release"',
    prompt: "Check the release and report its status.",
    schedule_type: "once",
    status: "scheduled",
    run_at: NOW - 1,
    run_count: 0,
    retry_count: 2,
    last_run_failed: true,
    last_run_needs_attention: true,
    mode: "apply",
    created_at: 1,
    ...overrides,
  };
}

async function world(overrides: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    agent_tasks: [task()],
    conversations: [{ _id: CONV, user_id: USER, owner_device_id: DEVICE, session_id: "cloud-session", status: "active", armed_trigger_kind: "once" }],
    devices: [{ _id: "devices_cloud", user_id: USER, device_id: DEVICE, is_remote: true, last_seen: NOW - 600_000 }],
    api_tokens: [{ _id: "api_tokens_cloud", user_id: USER, token_hash: await hashToken(TOKEN) }],
    pending_messages: [],
    ...overrides,
  };
  const db = makeFakeDb(tables);
  const query = db.query.bind(db);
  const pages: Array<{ cursor: string | null; numItems: number }> = [];
  const indexes: string[] = [];
  db.query = (table: string) => {
    const builder = query(table);
    if (table !== "agent_tasks") return builder;
    const withIndex = builder.withIndex.bind(builder);
    builder.withIndex = (name: string, fn: any) => {
      indexes.push(name);
      return withIndex(name, fn);
    };
    const key = (row: any): [number, number] => [row.run_at, row._creationTime];
    const compare = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1];
    builder.paginate = async (opts: { cursor: string | null; numItems: number }) => {
      pages.push(opts);
      const after = opts.cursor ? JSON.parse(opts.cursor) : null;
      const rows = (await builder.collect())
        .sort((a: any, b: any) => compare(key(a), key(b)))
        .filter((row: any) => !after || compare(key(row), after) > 0);
      const page = rows.slice(0, opts.numItems);
      return {
        page,
        isDone: page.length === rows.length,
        continueCursor: page.length ? JSON.stringify(key(page[page.length - 1])) : opts.cursor,
      };
    };
    return builder;
  };
  const scheduled: Array<{ delay: number; name: string; args: any }> = [];
  const ctx = { db, scheduler: { runAfter: async (delay: number, ref: any, args: any) => {
    scheduled.push({ delay, name: getFunctionName(ref), args });
  } } };
  return { ctx, tables, pages, indexes, scheduled };
}

const dispatch = (ctx: any, args = {}) => (dispatchCloudTriggers as any)._handler(ctx, args);
const due = (ctx: any, limit = 5) => (getDueTasks as any)._handler(ctx, { api_token: TOKEN, limit });
const claim = (ctx: any, taskId = "agent_tasks_cloud") => (claimTask as any)._handler(ctx, {
  api_token: TOKEN, task_id: taskId, daemon_id: "laptop-daemon",
});

describe("dispatchCloudTriggers", () => {
  test("queues a once trigger on the existing rail and completes it with audit evidence", async () => {
    const { ctx, tables, pages, indexes, scheduled } = await world();
    expect(await dispatch(ctx)).toEqual({ scanned: 1, dispatched: 1, done: true });
    const [pending] = tables.pending_messages;
    expect(pending).toMatchObject({
      conversation_id: CONV, owner_user_id: USER, from_user_id: USER,
      origin: "scheduler", status: "pending", client_id: "cloud-trigger:agent_tasks_cloud:0",
      content: '<scheduled-task title="Check &quot;release&quot;" task-id="agent_tasks_cloud">Check the release and report its status.</scheduled-task>',
    });
    expect(tables.agent_tasks[0]).toMatchObject({
      status: "completed", run_count: 1, last_run_at: NOW, last_run_conversation_id: CONV,
      last_run_failed: false, last_run_needs_attention: false, retry_count: 0,
    });
    expect(tables.conversations[0]).toMatchObject({ has_pending_messages: true, armed_trigger_kind: "none" });
    expect(tables.devices[0].wake_requested_at).toBe(NOW);
    expect(tables.devices[0].cloud_wake).toMatchObject({ request_at: NOW, status: "pending", attempt: 0 });
    expect(scheduled).toContainEqual({
      delay: 0, name: "cloudWake:wake", args: { ownerUserId: USER, deviceId: DEVICE, requestAt: NOW },
    });
    expect(tables.daemon_commands ?? []).toHaveLength(0);
    expect(pages).toEqual([{ cursor: null, numItems: 50 }]);
    expect(indexes[0]).toBe("by_status_run_at");
    expect(log.mock.calls).toEqual([["cloud_trigger_dispatched", {
      task_id: "agent_tasks_cloud", conversation_id: CONV,
      pending_message_id: pending._id, client_id: pending.client_id, run_count: 1,
    }]]);
  });

  test("recurring injection advances once, clears stale run fields, and stays armed", async () => {
    const { ctx, tables } = await world({ agent_tasks: [task({
      schedule_type: "recurring", interval_ms: 60_000, run_count: 7,
      lease_holder: "old-daemon", lease_expires_at: NOW - 1,
      last_run_summary: "old summary", last_run_session_uuid: "old-session",
    })] });
    await dispatch(ctx);
    expect(tables.agent_tasks[0]).toMatchObject({ status: "scheduled", run_count: 8, run_at: NOW + 60_000, retry_count: 0 });
    for (const field of ["lease_holder", "lease_expires_at", "last_run_summary", "last_run_session_uuid"]) {
      expect(tables.agent_tasks[0][field]).toBeUndefined();
    }
    expect(tables.conversations[0].armed_trigger_kind).toBe("standing");
    expect(tables.pending_messages[0].client_id).toBe("cloud-trigger:agent_tasks_cloud:7");
    expect((await dispatch(ctx)).dispatched).toBe(0);
    time.mockReturnValue(NOW + 60_000);
    expect((await dispatch(ctx)).dispatched).toBe(1);
    expect(tables.pending_messages.map((row) => row.client_id)).toEqual([
      "cloud-trigger:agent_tasks_cloud:7", "cloud-trigger:agent_tasks_cloud:8",
    ]);
  });

  test("an event arms through the existing matcher and waits for another event after dispatch", async () => {
    const { ctx, tables } = await world({ agent_tasks: [task({
      schedule_type: "event", run_at: undefined, event_filter: { event_type: "pr_merged" },
    })] });
    expect((await dispatch(ctx)).dispatched).toBe(0);
    expect(await (matchTaskTriggers as any)._handler(ctx, { event_type: "pr_merged" })).toBe(1);
    expect((await dispatch(ctx)).dispatched).toBe(1);
    expect(tables.agent_tasks[0]).toMatchObject({ status: "scheduled", run_count: 1 });
    expect(tables.agent_tasks[0].run_at).toBeUndefined();
    expect(tables.conversations[0].armed_trigger_kind).toBe("standing");
    expect((await dispatch(ctx)).dispatched).toBe(0);
    expect(await due(ctx)).toEqual([]);
    expect(await claim(ctx)).toBeNull();
  });

  test.each(["paused", "completed", "failed", "running"])("does not dispatch a %s trigger", async (status) => {
    const { ctx, tables } = await world({ agent_tasks: [task({ status, canceled_on_kill_at: NOW - 10 })] });
    expect(await dispatch(ctx)).toEqual({ scanned: 0, dispatched: 0, done: true });
    expect(tables.pending_messages).toHaveLength(0);
    expect(tables.agent_tasks[0].run_count).toBe(0);
    expect(await claim(ctx)).toBeNull();
  });

  test.each([undefined, 0, -1, NOW + 1])("ignores a trigger whose run_at is %s", async (run_at) => {
    const { ctx, tables } = await world({ agent_tasks: [task({ run_at })] });
    expect(await dispatch(ctx)).toEqual({ scanned: 0, dispatched: 0, done: true });
    expect(tables.pending_messages).toHaveLength(0);
  });

  test("repeated dispatch does not enqueue or count the same one-shot run twice", async () => {
    const { ctx, tables } = await world();
    await dispatch(ctx);
    expect((await dispatch(ctx)).dispatched).toBe(0);
    expect(tables.pending_messages).toHaveLength(1);
    expect(tables.agent_tasks[0].run_count).toBe(1);
    expect(log.mock.calls).toHaveLength(1);
  });

  test.each(["pending", "delivered"])("reuses an existing %s row with the stable client id", async (status) => {
    const { ctx, tables } = await world({ pending_messages: [{
      _id: "pending_messages_existing", conversation_id: CONV,
      client_id: "cloud-trigger:agent_tasks_cloud:0", status, content: "original",
    }] });
    await dispatch(ctx);
    expect(tables.pending_messages).toHaveLength(1);
    expect(tables.pending_messages[0].content).toBe("original");
    expect(tables.agent_tasks[0].run_count).toBe(1);
    expect(log.mock.calls[0][1].pending_message_id).toBe("pending_messages_existing");
  });

  test.each([false, true])("matches the scheduler filing note and rail semantics for hidden=%s", async (hidden) => {
    const { ctx, tables } = await world();
    Object.assign(tables.conversations[0], { inbox_stashed_at: 100, inbox_stash_hidden: hidden });
    await dispatch(ctx);
    expect(tables.pending_messages[0].content).toEndWith(
      "\n\nThis session is STASHED: the user will not see this run or its output. End your turn with cast state --status done|dormant to stay quietly out of their inbox; declare --status blocked ONLY if a human must act — that returns the session to their inbox.</scheduled-task>",
    );
    expect(tables.conversations[0].inbox_stashed_at).toBe(hidden ? 100 : undefined);
  });

  test("killed filing takes precedence over stale stash when building the prompt", async () => {
    const { ctx, tables } = await world();
    Object.assign(tables.conversations[0], { inbox_stashed_at: 100, inbox_killed_at: 200 });
    await dispatch(ctx);
    expect(tables.pending_messages[0].content).not.toContain("STASHED");
  });

  test("continues past a full page of noncloud triggers", async () => {
    const local = Array.from({ length: 50 }, (_, i) => task({
      _id: `agent_tasks_local_${i}`, _creationTime: i + 1, originating_conversation_id: undefined,
    }));
    const { ctx, tables, scheduled, pages } = await world({ agent_tasks: [...local, task({ _creationTime: 51 })] });
    expect(await dispatch(ctx)).toEqual({ scanned: 50, dispatched: 0, done: false });
    const continuation = scheduled.find((call) => call.name === "agentTasks:dispatchCloudTriggers")!;
    expect(continuation).toMatchObject({ delay: 0, args: { cursor: JSON.stringify([NOW - 1, 50]) } });
    expect(await dispatch(ctx, continuation.args)).toEqual({ scanned: 1, dispatched: 1, done: true });
    expect(pages).toHaveLength(2);
    expect(tables.pending_messages).toHaveLength(1);
    expect(local.every((row) => row.status === "scheduled")).toBe(true);
  });

  test("drains multiple cloud pages even as completed rows leave the due index", async () => {
    const tasks = Array.from({ length: 101 }, (_, i) => task({ _id: `agent_tasks_${i}`, _creationTime: i + 1 }));
    const { ctx, tables, scheduled } = await world({ agent_tasks: tasks });
    expect(await dispatch(ctx)).toEqual({ scanned: 50, dispatched: 50, done: false });
    const next = () => scheduled.filter((call) => call.name === "agentTasks:dispatchCloudTriggers").at(-1)!.args;
    expect(await dispatch(ctx, next())).toEqual({ scanned: 50, dispatched: 50, done: false });
    expect(await dispatch(ctx, next())).toEqual({ scanned: 1, dispatched: 1, done: true });
    expect(tables.pending_messages).toHaveLength(101);
    expect(new Set(tables.pending_messages.map((row) => row.client_id)).size).toBe(101);
    expect(tables.conversations[0].armed_trigger_kind).toBe("none");
  });

  test("an enqueue failure does not advance the trigger", async () => {
    const { ctx, tables } = await world();
    tables.conversations[0].execution_protocol_state = "fenced";
    await expect(dispatch(ctx)).rejects.toThrow("EXECUTION_PROTOCOL_INVARIANT");
    expect(tables.agent_tasks[0]).toMatchObject({ status: "scheduled", run_count: 0, run_at: NOW - 1 });
    expect(tables.pending_messages).toHaveLength(0);
  });

  test("the cron invokes the internal mutation every 60 seconds", () => {
    const job = (crons as any).crons["dispatch due cloud triggers"];
    expect(job.schedule).toEqual({ type: "interval", seconds: 60 });
    expect(job.name).toBe("agentTasks:dispatchCloudTriggers");
    expect((dispatchCloudTriggers as any).isInternal).toBe(true);
  });
});

describe("cloud trigger authorization and daemon exclusion", () => {
  test.each([undefined, "", "[]", "malformed-json"])("missing, empty or invalid server configuration (%s) skips all DB work and keeps legacy scheduling", async (config) => {
    if (config === undefined) delete process.env.CAST_CLOUD_WAKE_HOSTS;
    else process.env.CAST_CLOUD_WAKE_HOSTS = config;
    const { ctx } = await world();
    const query = spyOn(ctx.db, "query");
    expect(await dispatch(ctx)).toEqual({ scanned: 0, dispatched: 0, done: true });
    expect(query).not.toHaveBeenCalled();
    expect(await due(ctx)).toHaveLength(1);
    expect((await claim(ctx)).status).toBe("running");
    query.mockRestore();
  });

  test.each([
    "unapproved-device", "unapproved-user", "cross-owner", "local-device", "missing-device",
    "wrong-device-owner", "missing-conversation", "missing-owner-device", "spawn",
  ])("denies server dispatch for %s and retains legacy scheduling", async (reason) => {
    const { ctx, tables } = await world();
    if (reason === "unapproved-device") process.env.CAST_CLOUD_WAKE_HOSTS = JSON.stringify([{ ...HOST, deviceId: "other-cloud" }]);
    if (reason === "unapproved-user") process.env.CAST_CLOUD_WAKE_HOSTS = JSON.stringify([{ ...HOST, ownerUserId: "users_other" }]);
    if (reason === "cross-owner") {
      tables.conversations[0].user_id = "users_other";
      tables.devices[0].user_id = "users_other";
      process.env.CAST_CLOUD_WAKE_HOSTS = JSON.stringify([{ ...HOST, ownerUserId: "users_other" }]);
    }
    if (reason === "local-device") tables.devices[0].is_remote = false;
    if (reason === "missing-device") tables.devices.length = 0;
    if (reason === "wrong-device-owner") tables.devices[0].user_id = "users_other";
    if (reason === "missing-conversation") tables.conversations.length = 0;
    if (reason === "missing-owner-device") delete tables.conversations[0].owner_device_id;
    if (reason === "spawn") {
      delete tables.agent_tasks[0].originating_conversation_id;
      tables.agent_tasks[0].created_by_conversation_id = CONV;
    }
    expect((await dispatch(ctx)).dispatched).toBe(0);
    expect(tables.pending_messages).toHaveLength(0);
    expect(tables.agent_tasks[0].run_count).toBe(0);
    expect(await due(ctx)).toHaveLength(1);
    expect((await claim(ctx)).status).toBe("running");
  });

  test("getDueTasks excludes server-owned triggers before applying the limit; claimTask blocks stale laptop reads", async () => {
    const { ctx, tables } = await world({ agent_tasks: [task(), task({
      _id: "agent_tasks_spawn", originating_conversation_id: undefined,
    })] });
    expect((await due(ctx, 1)).map((row: any) => row._id)).toEqual(["agent_tasks_spawn"]);
    expect(await claim(ctx)).toBeNull();
    expect(tables.agent_tasks[0].status).toBe("scheduled");
    expect((await claim(ctx, "agent_tasks_spawn")).status).toBe("running");
    expect((await dispatch(ctx)).dispatched).toBe(1);
  });

  test("a once trigger accepts a late agent summary without another run or rearming", async () => {
    const { ctx, tables } = await world();
    await dispatch(ctx);
    expect(await (completeTaskRun as any)._handler(ctx, {
      api_token: TOKEN, task_id: "agent_tasks_cloud", summary: "Release verified", conversation_id: CONV,
    })).toBe(true);
    expect(tables.agent_tasks[0]).toMatchObject({ status: "completed", run_count: 1, last_run_summary: "Release verified" });
    expect(tables.conversations[0].armed_trigger_kind).toBe("none");
    expect(tables.pending_messages).toHaveLength(1);
  });
});
