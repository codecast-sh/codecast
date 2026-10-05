import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { armedTriggerRows, makeFakeDb } from "../testDb";
import { scheduleTriggerMatch } from "./triggerMatch";

function ctxWith(agentTasks: any[]) {
  const scheduled: Array<{ name: string; args: any }> = [];
  const db = makeFakeDb({ agent_tasks: agentTasks });
  const scheduler = { runAfter: async (_ms: number, fn: any, args: any) => void scheduled.push({ name: getFunctionName(fn), args }) };
  return { ctx: { db, scheduler }, scheduled };
}

describe("scheduleTriggerMatch", () => {
  test("an event nobody armed a trigger on schedules nothing", async () => {
    const { ctx, scheduled } = ctxWith(armedTriggerRows("pr_merged"));
    await scheduleTriggerMatch(ctx, { event_type: "check_run", action: "completed", repository: "a/b" });
    expect(scheduled).toEqual([]);
  });

  test("an armed trigger gets the firing, with the event's args", async () => {
    const { ctx, scheduled } = ctxWith(armedTriggerRows("check_run"));
    await scheduleTriggerMatch(ctx, { event_type: "check_run", action: "completed", repository: "a/b" });
    expect(scheduled).toEqual([{ name: "agentTasks:matchTaskTriggers", args: { event_type: "check_run", action: "completed", repository: "a/b" } }]);
  });

  test("a running trigger counts only for an event that carries a ref", async () => {
    const running = armedTriggerRows("error_new").map((row) => ({ ...row, status: "running" }));
    const bare = ctxWith(running);
    await scheduleTriggerMatch(bare.ctx, { event_type: "error_new" });
    expect(bare.scheduled).toEqual([]);

    const withRef = ctxWith(running);
    await scheduleTriggerMatch(withRef.ctx, { event_type: "error_new", event_ref: { title: "Boom" } });
    expect(withRef.scheduled).toHaveLength(1);
  });
});
