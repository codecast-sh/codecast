// A queued resume (cast workflow resume --queue, or an incident's close). One no
// line would ever carry out, a person's run on a machine that offers no line
// slot, resumes at once on its own machine, so it never stands in the queue for
// good ahead of the runs a line does carry out. A line's run (a role's, or one on
// a machine with a line slot) waits while Flows or Org is off, the emergency stop
// (linesRunIn), and resumes from the same row once it is on. Under convex-test
// through the sweep's own pass. Synthetic data.
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
    const role = await ctx.db.insert("org_roles", { name: "Release", handle: "release", host_user_id: me, team_id: off, scope: { project_ids: [], plan_ids: [] }, status: "active", created_at: T0, updated_at: T0 });
    // The machine with a line slot for /code/app; the laptop offers none.
    await ctx.db.insert("devices", { user_id: me, device_id: "host", platform: "linux", last_seen: T0, line_slots: [{ root: "/code/app", runs: 2 }] });
    await ctx.db.insert("devices", { user_id: me, device_id: "laptop", platform: "darwin", last_seen: T0 });
    const queued = async (teamId: any, device: string, since: number, extra: Record<string, unknown> = {}) => ctx.db.insert("workflow_runs", {
      user_id: me, workspace: `team:${teamId}`, team_id: teamId, status: "failed", current_node_id: "stopped", fail_reason: "Stopped: main stayed red",
      node_statuses: [{ node_id: "pr", status: "completed", completed_at: T0 }, { node_id: "stopped", status: "failed", completed_at: T0 }],
      runner_device: device, project_path: "/code/app", resume_queued: { at: "ci", by: me, since }, created_at: T0, updated_at: T0, ...extra,
    });
    return {
      off,
      offNoSlot: await queued(off, "laptop", T0 - 5_000),
      offSlotted: await queued(off, "host", T0 - 4_000),
      offRole: await queued(off, "host", T0 - 3_000, { org_role_id: role }),
      noSlot: await queued(on, "laptop", T0 - 2_000),
      slotted: await queued(on, "host", T0 - 1_000),
    };
  });
  return { t, ids, get: (id: any) => t.run((ctx: any) => ctx.db.get(id)) };
}

const resumed = (run: any) => {
  expect(run).toMatchObject({ status: "running", current_node_id: "ci" });
  expect(run.resume_queued).toBeUndefined();
};

describe("queued resumes in the line's sweep", () => {
  test("one outside any line resumes at once, beside one a line's slot takes; a line's waits while Flows is off, and resumes once it is on", async () => {
    const { t, ids, get } = await world();
    const res = await t.run((ctx: any) => sweepCore(ctx, T0));
    expect((res.resumed ?? []).map((r: any) => r.run_id).sort()).toEqual([ids.offNoSlot, ids.noSlot, ids.slotted].map(String).sort());
    for (const id of [ids.offNoSlot, ids.noSlot, ids.slotted]) resumed(await get(id));
    for (const id of [ids.offSlotted, ids.offRole]) expect(await get(id)).toMatchObject({ status: "failed", resume_queued: { at: "ci" } });

    await t.run((ctx: any) => ctx.db.patch(ids.off, { features: { line: true, org: true } }));
    const again = await t.run((ctx: any) => sweepCore(ctx, T0 + 1_000));
    expect((again.resumed ?? []).map((r: any) => r.run_id)).toContain(String(ids.offSlotted));
    resumed(await get(ids.offSlotted));
  });
});
