import { expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { applyRunNow, claimTask, completeTaskRun, failTaskRun, reclaimStaleTasks, skipTaskRun, webListRuns } from "./agentTasks";

async function fixture() {
  const task = { _id: "agent_tasks_one", user_id: "users_one", title: "Audit", prompt: "Inspect", short_id: "tr-1", status: "scheduled", schedule_type: "recurring", interval_ms: 60_000, run_at: 1, run_count: 0, retry_count: 0, max_retries: 3, precheck: "exit 1" };
  const tables = { agent_tasks: [task], users: [{ _id: "users_one" }], api_tokens: [{ _id: "api_tokens_one", user_id: "users_one", token_hash: await hashToken("test") }] };
  const db = makeFakeDb(tables);
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: "users_one|session" }) }, scheduler: { runAfter: async () => null } } as any;
  const args = { api_token: "test", task_id: task._id, daemon_id: "daemon-one" } as any;
  return { ctx, db, task: task as any, args };
}

test("manual request is consumed by claim; completed recurring runs return to gated cadence", async () => {
  const { ctx, task, args } = await fixture();
  await applyRunNow(ctx, task);
  expect(task.requested_run_source).toBe("manual");
  const claimed = await (claimTask as any)._handler(ctx, args);
  expect(claimed.last_run_source).toBe("manual");
  expect(task.requested_run_source).toBeUndefined();
  expect(task.lease_holder).toBe("daemon-one");
  expect(await (claimTask as any)._handler(ctx, { ...args, daemon_id: "other" })).toBeNull();
  await (completeTaskRun as any)._handler(ctx, args);
  expect(task.status).toBe("scheduled");
  expect((await (claimTask as any)._handler(ctx, args)).last_run_source).toBe("recurring");
});

test("manual failure retry and stale lease reclaim retain the request source", async () => {
  const { ctx, task, args } = await fixture();
  await applyRunNow(ctx, task);
  await (claimTask as any)._handler(ctx, args);
  await (failTaskRun as any)._handler(ctx, { ...args, error: "test failure" });
  expect(task.requested_run_source).toBe("manual");
  expect((await (claimTask as any)._handler(ctx, args)).last_run_source).toBe("manual");
  task.lease_expires_at = Date.now() - 1;
  expect(await (reclaimStaleTasks as any)._handler(ctx, {})).toBe(1);
  expect((await (claimTask as any)._handler(ctx, args)).last_run_source).toBe("manual");
});

test("precheck skip records the claimed source and preserves lease ownership", async () => {
  const { ctx, db, task, args } = await fixture();
  await (claimTask as any)._handler(ctx, args);
  const result = { ...args, command: "exit 1", exit_code: 1, timed_out: false, duration_ms: 2, reason: "precheck exited 1", source: "scheduled" };
  expect(await (skipTaskRun as any)._handler(ctx, { ...result, daemon_id: "other" })).toBe(false);
  expect(task.status).toBe("running");
  expect(await (skipTaskRun as any)._handler(ctx, result)).toBe(true);
  expect(task.status).toBe("scheduled");
  expect(task.run_count).toBe(0);
  expect(task.lease_holder).toBeUndefined();
  const skip = db._inserted.find((r: any) => r.table === "agent_task_precheck_skips").doc;
  expect(skip.source).toBe("recurring");
  const history = await (webListRuns as any)._handler(ctx, { task_id: task._id });
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ kind: "skipped_precheck", source: "recurring" });
});
