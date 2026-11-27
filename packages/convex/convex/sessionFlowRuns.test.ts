import { expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { forConversation, forTeam } from "./sessionFlowRuns";
import { enrichRun } from "./workflow_runs";

// A session's change runs (flows.md FL4): the flows of the pool that take a branch, and a flow the session wrote for
// its own change, which names no kind but lands the branch through the ship segment. Synthetic data only.

const TEAM = "team_1";
const WS = `team:${TEAM}`;
const ME = "user_me";
const CONV = "conv_1";

const own = `digraph land_built_change {\n  graph [label="Built change", takes="task,branch", draft="jx7dhj9"]\n  check [flow="check"]\n  land [label="Land", flow="ship"]\n  start -> check -> land -> exit\n}`;
const pool = `digraph change {\n  graph [kind="line", takes="task,branch"]\n}`;
const segment = `digraph check {\n  graph [kind="segment", takes="branch"]\n  verify [flow="checker"]\n}`;

function world() {
  const run = (id: string, workflow: string, created: number) => ({
    _id: id, workflow_id: workflow, user_id: ME, workspace: WS, team_id: TEAM, spawner_conversation_id: CONV,
    status: "completed", created_at: created, updated_at: created, node_statuses: [], merge: { sha: "a".repeat(40), at: created },
  });
  const t: Record<string, any[]> = {
    users: [{ _id: ME, name: "Ana" }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "member" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    conversations: [{ _id: CONV, user_id: ME, team_id: TEAM, title: "s" }],
    tasks: [],
    workflows: [{ _id: "wf_own", source: own, slug: "land-built-change" }, { _id: "wf_pool", source: pool, slug: "change" }, { _id: "wf_seg", source: segment, slug: "check" }],
    workflow_runs: [run("run_own", "wf_own", 3), run("run_pool", "wf_pool", 2), run("run_seg", "wf_seg", 1)],
  };
  const ctx = { db: makeFakeDb(t), auth: { getUserIdentity: async () => ({ subject: `${ME}|sess` }) } } as any;
  return ctx;
}

test("a session's own landing flow counts as its change run beside the pool's; a segment run alone does not", async () => {
  const ctx = world();
  const runs = await (forConversation as any)._handler(ctx, { conversation_id: CONV });
  expect(runs.map((r: any) => [r._id, r.takes_change])).toEqual([["run_own", true], ["run_pool", true]]);
  // The inbox card reads each session's newest change run: the one its own flow made.
  const team = await (forTeam as any)._handler(ctx, { team_id: TEAM });
  expect(team.map((r: any) => r._id)).toEqual(["run_own"]);
});

test("a live run of a project's change flow that only extends the library's counts, an ended one does not", async () => {
  const ctx = world();
  const t = (ctx.db as any);
  await t.insert("workflows", { _id: "wf_ext", source: `digraph change {\n  graph [extends="change"]\n}`, slug: "change" });
  const base = { workflow_id: "wf_ext", workflow_name: "change", user_id: ME, workspace: WS, team_id: TEAM, spawner_conversation_id: CONV, node_statuses: [] };
  await t.insert("workflow_runs", { ...base, _id: "run_ext_live", status: "running", current_node_id: "deploy__wait", created_at: 5, updated_at: 5 });
  await t.insert("workflow_runs", { ...base, _id: "run_ext_done", status: "failed", created_at: 4, updated_at: 4 });
  const ids = (await (forConversation as any)._handler(ctx, { conversation_id: CONV })).map((r: any) => r._id);
  expect(ids).toContain("run_ext_live");
  expect(ids).not.toContain("run_ext_done");
  // The team feed (the phone's) carries it too: it is the session's newest change run.
  const team = (await (forTeam as any)._handler(ctx, { team_id: TEAM })).map((r: any) => r._id);
  expect(team).toEqual(["run_ext_live"]);
});

test("every run row says whether it carries a change, whichever feed brought it", async () => {
  const ctx = world();
  // The team's run lists feed the same collection as the session's: a segment run there reads as no change.
  expect((await enrichRun(ctx, await ctx.db.get("run_seg"))).takes_change).toBe(false);
  expect((await enrichRun(ctx, await ctx.db.get("run_own"))).takes_change).toBe(true);
});
