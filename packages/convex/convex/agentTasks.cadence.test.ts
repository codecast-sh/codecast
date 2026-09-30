import { expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { applyRunNow, applyTaskUpdate, claimTask, completeTaskRun, failTaskRun, nextArmingAfterRun, skipTaskRun } from "./agentTasks";

// A recurring trigger re-arms on its cadence, never from when the run
// finished: a daily check used to slide later by its own runtime every day and
// arrive just past the 24 hour window its evidence had to fall in.

const D = 86_400_000;
const M = 60_000;

async function fixture(patch: Record<string, unknown> = {}) {
  const task = { _id: "agent_tasks_one", user_id: "users_one", title: "Daily check", prompt: "Check", short_id: "tr-1", status: "scheduled", schedule_type: "recurring", interval_ms: D, run_at: Date.now() - 5_000, run_count: 0, retry_count: 0, max_retries: 3, ...patch };
  const tables = { agent_tasks: [task], users: [{ _id: "users_one" }], api_tokens: [{ _id: "api_tokens_one", user_id: "users_one", token_hash: await hashToken("test") }] };
  const db = makeFakeDb(tables);
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: "users_one|session" }) }, scheduler: { runAfter: async () => null } } as any;
  const args = { api_token: "test", task_id: task._id, daemon_id: "daemon-one" } as any;
  return { ctx, db, task: task as any, args };
}
const claim = (ctx: any, args: any) => (claimTask as any)._handler(ctx, args);
const complete = (ctx: any, args: any) => (completeTaskRun as any)._handler(ctx, args);

test("the next slot is counted from the armed slot, not from the finish", () => {
  const recurring = { schedule_type: "recurring" as const, interval_ms: D };
  const slot = 1_000 * D;
  // A run that took 40 minutes still re-arms exactly one day after its slot.
  expect(nextArmingAfterRun({ ...recurring, run_at: slot }, slot + 40 * M)).toMatchObject({ status: "scheduled", run_at: slot + D });
  // Thirty days of 40 minute runs land on the thirtieth slot, not 20 hours past it.
  let runAt = slot;
  for (let day = 0; day < 30; day++) runAt = nextArmingAfterRun({ ...recurring, run_at: runAt }, runAt + 40 * M).run_at;
  expect(runAt).toBe(slot + 30 * D);
  // A run that outlasts its interval skips the slots it missed and takes the next one.
  expect(nextArmingAfterRun({ ...recurring, run_at: slot }, slot + 2.5 * D).run_at).toBe(slot + 3 * D);
  // Finishing exactly on a slot arms the one after it: nothing fires twice at one instant.
  expect(nextArmingAfterRun({ ...recurring, run_at: slot }, slot + D).run_at).toBe(slot + 2 * D);
  // A kept slot wins over a run_at a detour moved, and is spent by the arming.
  expect(nextArmingAfterRun({ ...recurring, run_at: slot + 7 * M, cadence_slot_at: slot }, slot + 9 * M)).toEqual({ status: "scheduled", run_at: slot + D, cadence_slot_at: undefined });
  // Other schedule types are untouched.
  expect(nextArmingAfterRun({ schedule_type: "once", run_at: slot }, slot + M)).toEqual({ status: "completed" });
  expect(nextArmingAfterRun({ schedule_type: "event" }, slot)).toEqual({ status: "scheduled", run_at: undefined });
});

test("a completed run re-arms one interval after its slot", async () => {
  const { ctx, task, args } = await fixture();
  const slot = task.run_at;
  await claim(ctx, args);
  await complete(ctx, args);
  expect(task.status).toBe("scheduled");
  expect(task.run_at).toBe(slot + D);
  expect(task.run_count).toBe(1);
});

test("a precheck skip re-arms on the same cadence", async () => {
  const { ctx, task, args } = await fixture({ precheck: "exit 1" });
  const slot = task.run_at;
  await claim(ctx, args);
  expect(await (skipTaskRun as any)._handler(ctx, { ...args, command: "exit 1", exit_code: 1, timed_out: false, duration_ms: 2, reason: "precheck exited 1" })).toBe(true);
  expect(task.run_at).toBe(slot + D);
});

test("a retry leaves the cadence for its backoff and the run after it returns", async () => {
  const { ctx, task, args } = await fixture();
  const slot = task.run_at;
  await claim(ctx, args);
  await (failTaskRun as any)._handler(ctx, { ...args, error: "boom" });
  expect(task.run_at).toBeGreaterThan(slot);
  expect(task.cadence_slot_at).toBe(slot);
  // A second failure keeps the first slot, not the backoff time.
  await claim(ctx, args);
  await (failTaskRun as any)._handler(ctx, { ...args, error: "boom" });
  expect(task.cadence_slot_at).toBe(slot);
  await claim(ctx, args);
  await complete(ctx, args);
  expect(task.run_at).toBe(slot + D);
  expect(task.cadence_slot_at).toBeUndefined();
});

test("a manual run ahead of the next slot leaves that slot standing", async () => {
  const slot = Date.now() + 6 * 3_600_000;
  const { ctx, task, args } = await fixture({ run_at: slot });
  await applyRunNow(ctx, task);
  expect(task.run_at).toBeLessThan(slot);
  expect(task.cadence_slot_at).toBe(slot);
  await claim(ctx, args);
  await complete(ctx, args);
  expect(task.run_at).toBe(slot);
  expect(task.cadence_slot_at).toBeUndefined();
});

test("a new schedule starts a new cadence: a slot kept from a detour is dropped", async () => {
  const { ctx, task } = await fixture({ run_at: Date.now() + 3_600_000 });
  await applyRunNow(ctx, task);
  expect(task.cadence_slot_at).toBeDefined();
  const runAt = Date.now() + 2 * D;
  await applyTaskUpdate(ctx, task, { run_at: runAt }, { userId: "users_one" as any, source: "web" });
  expect(task.run_at).toBe(runAt);
  expect(task.cadence_slot_at).toBeUndefined();
});
