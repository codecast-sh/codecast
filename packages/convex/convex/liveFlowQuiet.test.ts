import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { closesQuiet, quietWords, sweep } from "./liveFlowQuiet";
import { recursAfterFix } from "./findingGroups";

// The quiet close of a live flow's bar (sd-1700): a problem under the bar that
// waited the bar's days with no new finding closes, and later evidence reopens it.

const HOST = "u".repeat(31) + "h";
const TEAM = "teams_acme" as any;
const DAY = 86_400_000;
const NOW = Date.now();
const bar = { score: 60, findings: 3, quiet_days: 14 };

const problem = (id: string, score: number | null, findings: number, ageDays: number, over: Record<string, any> = {}) => ({
  _id: `tasks_${id}`, short_id: `ct-${id}`, title: `Problem ${id}`, status: "open", priority: "medium", source: "signal", readiness: "ready", goal_ref: "pj-1",
  user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, created_at: NOW - ageDays * DAY, updated_at: NOW - ageDays * DAY,
  cause: { signal_count: findings, first_seen: NOW - ageDays * DAY, last_seen: NOW - ageDays * DAY, fingerprints: ["f"], ...(score == null ? {} : { scored: { score, harm: 2, reach: 2, fixability: 2, reason: "r", root_cause: "c", at: 1, version: "1" } }) },
  ...over,
});

function fixtures(tasks: any[], flow: Record<string, any> = {}) {
  const db = makeFakeDb({
    users: [{ _id: HOST, name: "Host", email: "host@x.ai" }],
    team_memberships: [{ _id: "m1", user_id: HOST, team_id: TEAM, role: "admin", joined_at: 1 }],
    teams: [{ _id: TEAM, name: "Acme" }],
    tasks,
    signals: tasks.map((t) => ({ _id: `signals_${t._id}`, short_id: `sg-${t.short_id}`, task_id: t._id, workspace: t.workspace, source: "judge:agent-review", title: "f", fingerprint: "f", created_at: 1 })),
    live_flows: [{ _id: "live_flows_1", workspace: `team:${TEAM}`, team_id: TEAM, workflow_id: "workflows_spine", on: true, bar: { ...bar, by: "jx7hand", at: 1 }, changed_by: HOST, changed_at: 1, created_at: 1, ...flow }],
    task_comments: [],
    task_history: [],
    entity_subscriptions: [],
    workflow_runs: [],
    session_decisions: [],
  });
  const ctx = { db, scheduler: { runAfter: async () => null } } as any;
  return { ctx, tables: db._tables as Record<string, any[]> };
}

describe("the quiet close of a live flow's bar", () => {
  test("closes only what waited under the bar with no new finding for its days", async () => {
    const { ctx, tables } = fixtures([
      problem("quiet", 30, 1, 20),
      problem("recent", 30, 1, 3),
      problem("over", 70, 1, 20),
      problem("many", 30, 3, 20),
      problem("mine", 30, 1, 20, { assignee: "org_roles_lead" }),
      problem("joined", 30, 1, 20, { cause: { signal_count: 1, first_seen: 1, last_seen: NOW - 20 * DAY, joined_at: NOW - 2 * DAY, fingerprints: ["f"], scored: { score: 30 } } }),
    ]);
    expect(await (sweep as any)._handler(ctx, { flow: "live_flows_1" })).toEqual({ closed: 1 });
    const byId = new Map(tables.tasks.map((t) => [t.short_id, t]));
    expect(byId.get("ct-quiet")).toMatchObject({ status: "dropped", cause: { dissolved: { quiet: true, note: quietWords(problem("quiet", 30, 1, 20) as any, bar) } } });
    expect(byId.get("ct-quiet")!.cause.dissolved.fixed_at).toBe(byId.get("ct-quiet")!.closed_at);
    for (const id of ["ct-recent", "ct-over", "ct-many", "ct-mine", "ct-joined"]) expect(byId.get(id)!.status).toBe("open");
    // Its finding retired with it, and its note says what held it and that a new finding reopens it.
    expect(tables.signals.find((s) => s._id === "signals_tasks_quiet")).toMatchObject({ task_id: undefined, retired: { task_id: "tasks_quiet" } });
    expect(tables.task_comments.map((c) => c.text)).toEqual(["Closed quiet: scored 30 on 1 finding, under the flow's bar (score 60+ or 3+ findings), and no new finding in 14 days. A new finding reopens it."]);
    // Evidence from after the close is new: grouping reopens the problem with it; older evidence stays its history.
    expect(recursAfterFix(byId.get("ct-quiet")!, NOW + 1000)).toBe(true);
    expect(recursAfterFix(byId.get("ct-quiet")!, NOW - DAY)).toBe(false);
  });

  test("one the line found nothing to change in closes after the same quiet days, whatever it scored", async () => {
    const { ctx, tables } = fixtures([problem("nothing", 82, 4, 20, { readiness: "not_actionable" }), problem("fresh", 82, 4, 3, { readiness: "not_actionable" })]);
    expect(await (sweep as any)._handler(ctx, { flow: "live_flows_1", readiness: "not_actionable" })).toEqual({ closed: 1 });
    expect(tables.tasks.map((t) => [t.short_id, t.status])).toEqual([["ct-nothing", "dropped"], ["ct-fresh", "open"]]);
    expect(tables.task_comments.map((c) => c.text)).toEqual(["Closed quiet: the line found nothing to change, and no new finding in 14 days. A new finding reopens it."]);
  });

  test("a flow that is off, or sets no bar, closes nothing", async () => {
    for (const flow of [{ on: false }, { bar: undefined }]) {
      const { ctx, tables } = fixtures([problem("quiet", 30, 1, 20)], flow);
      expect(await (sweep as any)._handler(ctx, { flow: "live_flows_1" })).toEqual({ closed: 0 });
      expect(tables.tasks[0].status).toBe("open");
    }
    expect(closesQuiet(problem("run", 30, 1, 20, { workflow_run_id: "workflow_runs_1" }) as any, bar, NOW)).toBe(false);
  });
});
