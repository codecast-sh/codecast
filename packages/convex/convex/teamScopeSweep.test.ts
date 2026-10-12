import { describe, expect, test } from "bun:test";
import { sweepPage } from "./teamScopeSweep";
import { makeFakeDb } from "./testDb";

// A task whose access key the reconciler rewrites may sit on a dependency
// edge or parent link into its old workspace, which readiness cannot read
// across (task-graph.md TG4): the sweep schedules the same cut a visibility
// move does.

const OWNER = "u_owner";
const TEAM = "t_team";

function fixture() {
  const scheduled: any[] = [];
  const db = makeFakeDb({
    tasks: [
      // Stored team key, but no team tag and no linked conversation: personal.
      { _id: "task_stale", short_id: "ct-1", user_id: OWNER, workspace: `team:${TEAM}` },
      { _id: "task_fine", short_id: "ct-2", user_id: OWNER, workspace: `user:${OWNER}` },
    ],
  });
  const ctx = { db, scheduler: { runAfter: async (_ms: number, _fn: unknown, args: any) => { if (args?.task_ids) scheduled.push(args); } } } as any;
  return { db, ctx, scheduled };
}

const run = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);

describe("teamScopeSweep", () => {
  test("applying a task's new key schedules the cut of its crossed edges", async () => {
    const { db, ctx, scheduled } = fixture();
    await run(sweepPage, ctx, { table: "tasks", apply: true });
    expect(db._tables.tasks.find((t: any) => t._id === "task_stale").workspace).toBe(`user:${OWNER}`);
    expect(scheduled).toEqual([{ task_ids: ["task_stale"] }]);
  });

  test("a report changes nothing and schedules nothing", async () => {
    const { ctx, scheduled } = fixture();
    const page = await run(sweepPage, ctx, { table: "tasks" });
    expect(page.stale).toBe(1);
    expect(scheduled).toEqual([]);
  });
});
