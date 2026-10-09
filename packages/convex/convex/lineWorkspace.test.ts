// The line workspace's labels and a station's received input
// (line-workspace.md LW2, LW4): a label lands where its run lives, one per
// person per decision, a null verdict takes it back, and only someone who can
// read the run can label it or read what its station was given.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";

const api = anyApi as any;

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./dispatch.ts": () => import("./dispatch"),
  "./lineWorkspace.ts": () => import("./lineWorkspace"),
};

async function seed() {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "T", created_at: now, invite_code: "x" } as any);
    const ana = await ctx.db.insert("users", { name: "Ana", email: "ana@example.com", active_team_id: team } as any);
    const bo = await ctx.db.insert("users", { name: "Bo", email: "bo@example.com", active_team_id: team } as any);
    const eve = await ctx.db.insert("users", { name: "Eve" } as any);
    for (const u of [ana, bo]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: now } as any);
    const project = await ctx.db.insert("projects", { title: "Agent Quality", user_id: ana, team_id: team, workspace: `team:${team}`, created_at: now, updated_at: now } as any);
    const task = await ctx.db.insert("tasks", { title: "Cause", short_id: "ct-1", user_id: ana, team_id: team, workspace: `team:${team}`, project_id: project, status: "open", created_at: now, updated_at: now } as any);
    // Ana's station session, private to her: Bo reads it through the run.
    const conv = await ctx.db.insert("conversations", {
      session_id: "sess-dissolve", short_id: "jx7aaaa", user_id: ana, is_private: true, title: "Dissolve", agent_type: "claude_code", status: "completed", message_count: 2, started_at: now, updated_at: now,
    } as any);
    await ctx.db.insert("messages", { conversation_id: conv, role: "user", content: "You are the first look at one cluster.\n\nCluster: c-42", timestamp: now + 1 } as any);
    await ctx.db.insert("messages", { conversation_id: conv, role: "assistant", content: "Looking.", timestamp: now + 2 } as any);
    const run = await ctx.db.insert("workflow_runs", {
      user_id: ana, task_id: task, status: "completed", workspace: `team:${team}`, team_id: team,
      node_statuses: [{ node_id: "dissolve", status: "completed", session_id: "jx7aaaa", started_at: now, completed_at: now + 60_000 }],
      created_at: now, updated_at: now,
    } as any);
    return { team, ana, bo, eve, project, run, conv };
  });
  const as = (u: string) => t.withIdentity({ subject: `${u}|test` });
  const dispatch = (u: string, action: string, args: unknown[]) => as(u).mutation(api.dispatch.dispatch, { action, args });
  return { t, ...ids, as, dispatch };
}

describe("line labels", () => {
  test("a label lands in the run's workspace with its project, one per person, and is read by the team", async () => {
    const { t, team, ana, bo, project, run, as, dispatch } = await seed();
    await dispatch(String(ana), "labelDecision", [String(run), "dissolve", "wrong", "It closed a live cluster"]);
    await dispatch(String(ana), "labelDecision", [String(run), "dissolve", "right", null]);
    await dispatch(String(bo), "labelDecision", [String(run), "dissolve", "wrong", "Missed the residue"]);
    const rows = await t.run((ctx) => ctx.db.query("line_labels").collect());
    expect(rows).toHaveLength(2);
    const mine = rows.find((r) => String(r.by) === String(ana))!;
    expect(mine).toMatchObject({ workspace: `team:${team}`, team_id: team, project_id: project, node_id: "dissolve", verdict: "right" });
    expect(mine.note).toBeUndefined();

    const read = await as(String(bo)).query(api.lineWorkspace.labels, { team_id: team });
    expect(read.map((r: any) => r.verdict).sort()).toEqual(["right", "wrong"]);
    expect(read.every((r: any) => r.key.startsWith(`${run}:dissolve:`))).toBe(true);
  });

  test("a null verdict takes the viewer's label back and leaves a teammate's", async () => {
    const { t, ana, bo, run, dispatch } = await seed();
    await dispatch(String(ana), "labelDecision", [String(run), "dissolve", "wrong", "x"]);
    await dispatch(String(bo), "labelDecision", [String(run), "dissolve", "right", null]);
    await dispatch(String(ana), "labelDecision", [String(run), "dissolve", null, null]);
    const rows = await t.run((ctx) => ctx.db.query("line_labels").collect());
    expect(rows.map((r) => String(r.by))).toEqual([String(bo)]);
  });

  test("someone who cannot read the run can neither label it nor read its labels", async () => {
    const { team, ana, eve, run, as, dispatch } = await seed();
    await dispatch(String(ana), "labelDecision", [String(run), "dissolve", "wrong", "x"]);
    await expect(dispatch(String(eve), "labelDecision", [String(run), "dissolve", "right", null])).rejects.toThrow();
    await expect(as(String(eve)).query(api.lineWorkspace.labels, { team_id: team })).rejects.toThrow();
    expect(await as(String(eve)).query(api.lineWorkspace.labels, {})).toEqual([]);
  });

  test("a step the run never had is refused, and a stub run id is dropped", async () => {
    const { ana, run, dispatch } = await seed();
    await expect(dispatch(String(ana), "labelDecision", [String(run), "nope", "right", null])).rejects.toThrow(/No such step/);
    await expect(dispatch(String(ana), "labelDecision", ["temp_run", "dissolve", "right", null])).resolves.toBeNull();
  });
});

describe("a station's received input", () => {
  test("is its session's first user message, for the owner and for a teammate who reads the run", async () => {
    const { ana, bo, run, conv, as } = await seed();
    const own = await as(String(ana)).query(api.lineWorkspace.stationInput, { conversation_id: conv });
    expect(own).toMatchObject({ _id: String(conv), found: true, truncated: false });
    expect(own.text).toContain("Cluster: c-42");
    expect(await as(String(bo)).query(api.lineWorkspace.stationInput, { conversation_id: conv })).toBeNull();
    const viaRun = await as(String(bo)).query(api.lineWorkspace.stationInput, { conversation_id: conv, run_id: run });
    expect(viaRun?.text).toBe(own.text);
  });

  test("a stranger reads nothing, run or no run", async () => {
    const { eve, run, conv, as } = await seed();
    expect(await as(String(eve)).query(api.lineWorkspace.stationInput, { conversation_id: conv, run_id: run })).toBeNull();
  });
});
