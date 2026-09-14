import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { activationInstructions, type TemplateReceipt } from "./orgTemplateRun";

const repo = path.dirname(fs.realpathSync(path.resolve(import.meta.dir, "../../../node_modules")));
const backend = path.join(repo, "packages/convex/convex");
const { applyTaskUpdate, resumeTask } = await import(path.join(backend, "agentTasks.ts"));
const { makeFakeDb } = await import(path.join(backend, "testDb.ts"));
const { hashToken } = await import(path.join(backend, "apiTokens.ts"));

test("activation procedure resets year-ahead run_at while paused, then actual backend resume preserves the corrected date", async () => {
  const interval = 3 * 86400000;
  const farFuture = Date.now() + 365 * 86400000;
  const task = { _id: "agent_tasks_one", user_id: "users_one", short_id: "tr-1", schedule_type: "recurring", interval_ms: interval, status: "paused", run_at: farFuture, precheck: "exit 1" };
  const token = "template-activation-fixture";
  const tables = { agent_tasks: [task], agent_task_revisions: [], api_tokens: [{ _id: "api_tokens_one", user_id: "users_one", token_hash: await hashToken(token) }] };
  const ctx = { db: makeFakeDb(tables) };
  const actor = { userId: "users_one", source: "cli" };
  const instructions = activationInstructions({ instance: "growth", project: { dir: repo } } as TemplateReceipt, task);
  expect(instructions.commands[0]).toBe("cast trigger update 'tr-1' --every '259200s' --precheck ''");
  await applyTaskUpdate(ctx, task, { precheck: "" }, actor);
  await resumeTask._handler(ctx, { api_token: token, task_id: task._id });
  expect(task.run_at).toBe(farFuture);
  task.status = "paused";
  const before = Date.now();
  await applyTaskUpdate(ctx, task, { schedule_type: "recurring", interval_ms: interval, precheck: "" }, actor);
  expect(task.status).toBe("paused");
  expect(task.precheck).toBeUndefined();
  expect(task.run_at).toBeGreaterThanOrEqual(before + interval);
  expect(task.run_at).toBeLessThanOrEqual(Date.now() + interval);
  const correctedRunAt = task.run_at;
  await resumeTask._handler(ctx, { api_token: token, task_id: task._id });
  expect(task.status).toBe("scheduled");
  expect(task.run_at).toBe(correctedRunAt);
  expect(task.interval_ms).toBe(interval);
  expect(instructions.commands.at(-1)).toBe("cast trigger resume 'tr-1'");
});
