// The fix attribution store and the rates read from it (docs/architecture/regret.md).
import { describe, expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { liveAtFor, recordCore, regretChanges } from "./landedChanges";

const DAY = 86_400_000;
const NOW = 200 * DAY;
const TEAM = "teams_union";
const WS = `team:${TEAM}`;
const sha = (c: string) => c.repeat(40);

function world() {
  const db: any = makeFakeDb({
    users: [{ _id: "users_ashot", name: "Ashot" }],
    team_memberships: [{ _id: "tm1", user_id: "users_ashot", team_id: TEAM }],
    conversations: [{ _id: "conversations_line", user_id: "users_ashot", team_id: TEAM, workflow_run_id: "workflow_runs_1", title: "build" }],
    org_roles: [{ _id: "org_roles_aq", handle: "agent-quality", team_id: TEAM }],
    workflow_runs: [{
      _id: "workflow_runs_1", workspace: WS, org_role_id: "org_roles_aq", workflow_name: "agentwatch", task_id: "tasks_1",
      merge: { sha: sha("a"), branch: "b", into: "main", at: 150 * DAY },
      node_statuses: [{ node_id: "check__check", status: "completed", outcome: "success" }],
    }],
    commits: [{ _id: "commits_a", sha: sha("a"), repository: "union-ai/union-mobile", main_at: 150 * DAY + 5 }],
    deploys: [{ _id: "deploys_1", workspace: WS, status: "live", created_at: 151 * DAY, live_at: 151 * DAY, cut_at: 150 * DAY + 10 }],
    signals: [],
    file_changes: [],
    landed_changes: [],
  }, { indexes: schemaIndexes(schema as any) });
  return { db };
}

describe("recordCore", () => {
  test("a change is recorded once with its place on main, and a fix links to the change whose lines it changed, once", async () => {
    const ctx = world();
    const changes = [
      { sha: sha("a"), subject: "feat: thing", committed_at: 150 * DAY },
      { sha: sha("b"), subject: "fix: thing", committed_at: 155 * DAY, fix_reason: "subject_fix" },
    ];
    const fixes = [{ sha: sha("b"), at: 155 * DAY, introduced: [{ sha: sha("a"), lines: 4 }, { sha: sha("c"), lines: 2 }] }];
    expect(await recordCore(ctx, "users_ashot" as any, { team_id: TEAM as any, repository: "Union-AI/union-mobile", changes, fixes }, NOW)).toEqual({ inserted: 2, linked: 1 });
    // A second night re-sends the same overlap: nothing doubles.
    expect(await recordCore(ctx, "users_ashot" as any, { team_id: TEAM as any, repository: "union-ai/union-mobile", changes, fixes }, NOW)).toEqual({ inserted: 0, linked: 0 });
    const rows = await ctx.db.query("landed_changes").collect();
    const a = rows.find((r: any) => r.sha === sha("a"));
    expect(a.landed_at).toBe(150 * DAY + 5);
    expect(a.fixed_by).toEqual([{ sha: sha("b"), at: 155 * DAY, lines: 4, top: 4 }]);
    expect(rows.find((r: any) => r.sha === sha("b")).fix_reason).toBe("subject_fix");
  });

  test("a link recorded before `top` gains it when the trace comes again, without a second link", async () => {
    const ctx = world();
    await recordCore(ctx, "users_ashot" as any, { team_id: TEAM as any, repository: "union-ai/union-mobile", changes: [{ sha: sha("a"), subject: "feat", committed_at: 150 * DAY }], fixes: [] }, NOW);
    const row = (await ctx.db.query("landed_changes").collect())[0];
    await ctx.db.patch(row._id, { fixed_by: [{ sha: sha("b"), at: 155 * DAY, lines: 1 }] });
    expect(await recordCore(ctx, "users_ashot" as any, { team_id: TEAM as any, repository: "union-ai/union-mobile", changes: [], fixes: [{ sha: sha("b"), at: 155 * DAY, introduced: [{ sha: sha("a"), lines: 1 }, { sha: sha("e"), lines: 6 }] }] }, NOW)).toEqual({ inserted: 0, linked: 0 });
    expect((await ctx.db.get(row._id)).fixed_by).toEqual([{ sha: sha("b"), at: 155 * DAY, lines: 1, top: 6 }]);
  });

  test("a Claude Code workflow run is no flow: its commit landed outside any", async () => {
    const ctx = world();
    await ctx.db.insert("workflow_runs", { workspace: WS, run_kind: "workflow", workflow_name: "desk-sweep", merge: { sha: sha("f"), branch: "b", into: "main", at: 160 * DAY } });
    await recordCore(ctx, "users_ashot" as any, { team_id: TEAM as any, repository: "union-ai/union-mobile", changes: [{ sha: sha("f"), subject: "x", committed_at: 160 * DAY }], fixes: [] }, NOW);
    expect((await regretChanges(ctx, WS, NOW)).find((c) => c.sha === sha("f"))).toMatchObject({ through: "outside", flow: "" });
  });

  test("regretChanges joins the run, its role, the live deploy and the checks it passed", async () => {
    const ctx = world();
    await recordCore(ctx, "users_ashot" as any, {
      team_id: TEAM as any, repository: "union-ai/union-mobile",
      changes: [{ sha: sha("a"), subject: "feat", committed_at: 150 * DAY }, { sha: sha("d"), subject: "docs", committed_at: 160 * DAY }],
      fixes: [],
    }, NOW);
    const out = await regretChanges(ctx, WS, NOW);
    const a = out.find((c) => c.sha === sha("a"))!;
    expect(a).toMatchObject({ through: "line", role_handle: "agent-quality", flow: "agentwatch", live_at: 151 * DAY, checks: ["agentwatch/check__check"] });
    expect(out.find((c) => c.sha === sha("d"))).toMatchObject({ through: "outside", flow: "", role_id: null, live_at: null });
  });
});

describe("liveAtFor", () => {
  test("a placed deploy holds what reached main by its cut; an unplaced one by time", () => {
    expect(liveAtFor(10, [{ cut_at: 9, live_at: 20 }, { cut_at: 12, live_at: 30 }])).toBe(30);
    expect(liveAtFor(10, [{ cut_at: null, live_at: 25 }])).toBe(25);
    expect(liveAtFor(10, [{ cut_at: null, live_at: 5 }])).toBeNull();
  });
});
