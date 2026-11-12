import { expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { applyReactivate, applyRunNow, applyTaskUpdate, claimTask, completeTaskRun, failTaskRun, injectFrame, insertTask, passTaskPrecheck, skipTaskRun } from "./agentTasks";

// `cast trigger add --precheck ... --precheck-mode changes|state`: the daemon
// keeps what the gate compares against on the trigger row and hands a waking
// gate's message to the run through it.
async function fixture(mode: "changes" | "state") {
  const task = { _id: "agent_tasks_one", user_id: "users_one", title: "Watch", prompt: "Look at it", short_id: "tr-1", status: "scheduled", schedule_type: "recurring", interval_ms: 60_000, run_at: 1, run_count: 0, retry_count: 0, max_retries: 3, mode: "apply", precheck: "gh pr list", precheck_mode: mode };
  const tables = { agent_tasks: [task], users: [{ _id: "users_one" }], api_tokens: [{ _id: "api_tokens_one", user_id: "users_one", token_hash: await hashToken("test") }] };
  const db = makeFakeDb(tables);
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: "users_one|session" }) }, scheduler: { runAfter: async () => null } } as any;
  const args = { api_token: "test", task_id: task._id, daemon_id: "daemon-one" } as any;
  const skip = { ...args, command: "gh pr list", precheck_mode: mode, exit_code: 0, timed_out: false, duration_ms: 2, source: "recurring" };
  return { ctx, task: task as any, args, skip };
}

test("a skipped firing keeps the gate's state; a waking one keeps it and hands its message to the run", async () => {
  const { ctx, task, args, skip } = await fixture("state");
  await (claimTask as any)._handler(ctx, args);
  expect(await (skipTaskRun as any)._handler(ctx, { ...skip, reason: "precheck said not yet", precheck_state: '{"seen":3}' })).toBe(true);
  expect(task.precheck_state).toBe('{"seen":3}');

  const claimed = await (claimTask as any)._handler(ctx, args);
  expect(claimed.precheck_state).toBe('{"seen":3}');
  // Only the daemon holding the firing writes it.
  expect(await (passTaskPrecheck as any)._handler(ctx, { ...args, daemon_id: "other", precheck_state: "{}" })).toBe(false);
  expect(await (passTaskPrecheck as any)._handler(ctx, { ...args, command: "gh pr list", precheck_mode: "state", precheck_state: '{"seen":4}', message: "PR #9 opened" })).toBe(true);
  expect(task.precheck_state).toBe('{"seen":4}');
  expect(task.precheck_message).toBe("PR #9 opened");
  // The frame an inject run is delivered in carries it, fenced as data.
  const frame = await (injectFrame as any)._handler(ctx, { api_token: "test", task_id: task._id });
  expect(frame).toContain("What this trigger's precheck reported when it woke this run");
  expect(frame).toContain("PR #9 opened");

  await (completeTaskRun as any)._handler(ctx, args);
  // A manual run is not gated, and carries no stale message.
  await applyRunNow(ctx, task);
  const manual = await (claimTask as any)._handler(ctx, args);
  expect(manual.precheck_message).toBeUndefined();
  expect(task.precheck_message).toBeUndefined();
  expect(task.precheck_state).toBe('{"seen":4}');
});

test("a skip with no state leaves the stored one alone", async () => {
  const { ctx, task, args, skip } = await fixture("changes");
  task.precheck_state = "sha256:abc";
  await (claimTask as any)._handler(ctx, args);
  await (skipTaskRun as any)._handler(ctx, { ...skip, reason: "precheck output unchanged" });
  expect(task.precheck_state).toBe("sha256:abc");
});

test("changing the gate or how it is read starts it from nothing", async () => {
  const { ctx, task } = await fixture("changes");
  const actor = { userId: "users_one", source: "cli" } as const;
  task.precheck_state = "sha256:abc";
  await applyTaskUpdate(ctx, task, { interval_ms: 120_000 }, actor);
  expect(task.precheck_state).toBe("sha256:abc");
  const moved = await applyTaskUpdate(ctx, task, { precheck_mode: "state" }, actor);
  expect(moved.changed).toEqual(["precheck_mode"]);
  expect(task.precheck_mode).toBe("state");
  expect(task.precheck_state).toBeUndefined();
  task.precheck_state = "{}";
  await applyTaskUpdate(ctx, task, { precheck_mode: "exit" }, actor);
  expect(task.precheck_mode).toBeUndefined();
  expect(task.precheck_state).toBeUndefined();
  task.precheck_state = "x";
  await applyTaskUpdate(ctx, task, { precheck: "git rev-parse HEAD" }, actor);
  expect(task.precheck_state).toBeUndefined();
});

test("an answer from a gate edited mid-firing does not overwrite the new gate's fresh state", async () => {
  const { ctx, task, args, skip } = await fixture("changes");
  await (claimTask as any)._handler(ctx, args);
  // While the firing runs, the gate is switched to a state gate.
  await applyTaskUpdate(ctx, task, { precheck_mode: "state" }, { userId: "users_one", source: "cli" });
  expect(task.precheck_state).toBeUndefined();
  await (skipTaskRun as any)._handler(ctx, { ...skip, reason: "precheck output recorded", precheck_state: "sha256:old" });
  expect(task.precheck_state).toBeUndefined();
  // Removing the gate removes its mode too.
  await applyTaskUpdate(ctx, task, { precheck: "" }, { userId: "users_one", source: "cli" });
  expect(task.precheck).toBeUndefined();
  expect(task.precheck_mode).toBeUndefined();
});

test("a failed run's retry keeps the message it was woken with; completing the firing clears it", async () => {
  const { ctx, task, args } = await fixture("changes");
  await (claimTask as any)._handler(ctx, args);
  await (passTaskPrecheck as any)._handler(ctx, { ...args, command: "gh pr list", precheck_mode: "changes", precheck_state: "sha256:pr9", message: "PR #9 opened" });
  await (failTaskRun as any)._handler(ctx, { ...args, error: "agent crashed" });
  expect(task.status).toBe("scheduled");
  const retry = await (claimTask as any)._handler(ctx, args);
  expect(retry.precheck_message).toBe("PR #9 opened");
  expect(task.precheck_message).toBe("PR #9 opened");
  await (completeTaskRun as any)._handler(ctx, args);
  expect(task.precheck_message).toBeUndefined();
});

test("a mode for a trigger with no gate is not stored", async () => {
  const { ctx, task } = await fixture("changes");
  delete task.precheck;
  delete task.precheck_mode;
  await applyTaskUpdate(ctx, task, { precheck_mode: "state" }, { userId: "users_one", source: "cli" });
  expect(task.precheck_mode).toBeUndefined();
});

test("a revived trigger's first firing is gated again and carries no dead run's message", async () => {
  const { ctx, task } = await fixture("changes");
  Object.assign(task, { status: "failed", retry_count: 3, precheck_message: "PR #9 opened", precheck_state: "sha256:pr9" });
  await applyReactivate(ctx, task);
  expect(task.retry_count).toBe(0);
  expect(task.precheck_state).toBeUndefined();
  expect(task.precheck_message).toBeUndefined();
});

test("a changes gate on a trigger that fires once is refused: it would only ever record", async () => {
  const { ctx, task } = await fixture("changes");
  await expect(insertTask(ctx, "users_one" as any, { title: "t", prompt: "p", schedule_type: "once", run_at: Date.now() + 60_000, precheck: "git rev-parse HEAD", precheck_mode: "changes" } as any)).rejects.toThrow("needs a trigger that fires more than once");
  await expect(applyTaskUpdate(ctx, task, { schedule_type: "once", run_at: Date.now() + 60_000 }, { userId: "users_one", source: "cli" } as any)).rejects.toThrow("needs a trigger that fires more than once");
});

// ct-92447: a monitor's prechecks almost always skip, so lost leases piled up across days and the third retired it.
test("a recorded skip is a healthy firing: earlier lost leases stop counting", async () => {
  const { ctx, task, args, skip } = await fixture("changes");
  task.retry_count = 2;
  await (claimTask as any)._handler(ctx, args);
  await (skipTaskRun as any)._handler(ctx, { ...skip, reason: "precheck output unchanged" });
  expect(task.retry_count).toBe(0);
});
