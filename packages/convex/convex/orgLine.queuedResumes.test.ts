// A queued resume (cast workflow resume --queue, or an incident's close) that no
// line would ever carry out: a workspace with Flows off, or a person's run on a
// machine that offers no line slot. The line's sweep resumes it at once on its
// own machine, so it never stands in the queue for good ahead of the runs a line
// does carry out. Under convex-test through the sweep's own pass. Synthetic data.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { sweepCore } from "./orgLine";

const T0 = Date.now();

async function world() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx: any) => {
    const me = await ctx.db.insert("users", { name: "Ana" });
    const team = (features: Record<string, boolean>) => ctx.db.insert("teams", { name: "Acme", created_at: T0, features });
    const [off, on] = [await team({ line: false, org: true }), await team({ line: true, org: true })];
    for (const t of [off, on]) await ctx.db.insert("team_memberships", { user_id: me, team_id: t, role: "member", joined_at: T0 });
    // The machine with a line slot for /code/app; the laptop offers none.
    await ctx.db.insert("devices", { user_id: me, device_id: "host", platform: "linux", last_seen: T0, line_slots: [{ root: "/code/app", runs: 2 }] });
    await ctx.db.insert("devices", { user_id: me, device_id: "laptop", platform: "darwin", last_seen: T0 });
    const queued = async (teamId: any, device: string, since: number) => ctx.db.insert("workflow_runs", {
      user_id: me, workspace: `team:${teamId}`, team_id: teamId, status: "failed", current_node_id: "stopped", fail_reason: "Stopped: main stayed red",
      node_statuses: [{ node_id: "pr", status: "completed", completed_at: T0 }, { node_id: "stopped", status: "failed", completed_at: T0 }],
      runner_device: device, project_path: "/code/app", resume_queued: { at: "ci", by: me, since }, created_at: T0, updated_at: T0,
    });
    return {
      flowsOff: await queued(off, "laptop", T0 - 3_000),
      noSlot: await queued(on, "laptop", T0 - 2_000),
      slotted: await queued(on, "host", T0 - 1_000),
    };
  });
  return { t, ids, get: (id: any) => t.run((ctx: any) => ctx.db.get(id)) };
}

describe("a queued resume no line carries out", () => {
  test("resumes at once on its own machine, beside one a line's slot takes", async () => {
    const { t, ids, get } = await world();
    const res = await t.run((ctx: any) => sweepCore(ctx, T0));
    expect((res.resumed ?? []).map((r: any) => r.run_id).sort()).toEqual([ids.flowsOff, ids.noSlot, ids.slotted].map(String).sort());
    for (const id of [ids.flowsOff, ids.noSlot, ids.slotted]) {
      const run: any = await get(id);
      expect(run).toMatchObject({ status: "running", current_node_id: "ci" });
      expect(run.resume_queued).toBeUndefined();
    }
  });
});
