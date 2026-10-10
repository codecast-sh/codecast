// The line workspace's actions (line-workspace.md LW4): a push records where a
// graph lives and a version per new hash; a save and a try go to the machine
// that pushed it, and only for its owner or someone who pushed the same graph;
// a try's cases settle from the daemon's reports; an ask files the cause with
// its words and starts nothing it cannot.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";

const api = anyApi as any;
setDefaultTimeout(120_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./dispatch.ts": () => import("./dispatch"),
  "./workflows.ts": () => import("./workflows"),
  "./lineActions.ts": () => import("./lineActions"),
  "./lineWorkspace.ts": () => import("./lineWorkspace"),
};

const ORIGIN = (h: string) => ({
  device_id: "dev-ana", root: "/Users/ana/src/union", file: "outreach/line/agentwatch.cast",
  files: [{ node: "investigate", prompt: "outreach/line/agentwatch/investigate.md" }],
  graph_hash: `g-${h}`, nodes: [{ id: "investigate", h }, { id: "bind", h: "b1" }],
});
const NODES = [
  { id: "investigate", label: "Investigate", shape: "box", type: "agent", prompt: "Find the mechanism behind $bind.json.cluster_id.", backend: "session", agent: "claude" },
  { id: "bind", label: "Bind", shape: "parallelogram", type: "command", script: "bun bind" },
];

async function seed() {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "T", created_at: now, invite_code: "x" } as any);
    const ana = await ctx.db.insert("users", { name: "Ana", email: "ana@example.com", active_team_id: team } as any);
    const bo = await ctx.db.insert("users", { name: "Bo", email: "bo@example.com", active_team_id: team } as any);
    for (const u of [ana, bo]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: now } as any);
    await ctx.db.insert("api_tokens", { user_id: ana, token_hash: await hashToken("tok-ana"), name: "cli", created_at: now, last_used_at: now } as any);
    await ctx.db.insert("api_tokens", { user_id: bo, token_hash: await hashToken("tok-bo"), name: "cli", created_at: now, last_used_at: now } as any);
    await ctx.db.insert("devices", { user_id: ana, device_id: "dev-ana", created_at: now, last_seen: now } as any);
    const project = await ctx.db.insert("projects", { title: "Agent Quality", user_id: ana, team_id: team, workspace: `team:${team}`, created_at: now, updated_at: now } as any);
    const task = await ctx.db.insert("tasks", { title: "Bookings stall", short_id: "ct-1", user_id: ana, team_id: team, workspace: `team:${team}`, project_id: project, status: "open", created_at: now, updated_at: now } as any);
    const conv = await ctx.db.insert("conversations", {
      session_id: "sess-inv", short_id: "jx7inv1", user_id: ana, title: "Investigate", agent_type: "claude_code", status: "completed", message_count: 2, started_at: now, updated_at: now,
      thread_state: "A stale lock in the queue.\n\n```json\n{\"cause\":\"stale-lock\"}\n```", thread_state_result: JSON.stringify({ cause: "stale-lock" }),
    } as any);
    await ctx.db.insert("messages", { conversation_id: conv, role: "user", content: "# Task: Investigate\nFind the mechanism behind c-42.", timestamp: now + 1 } as any);
    return { team, ana, bo, project, task };
  });
  const as = (u: string) => t.withIdentity({ subject: `${u}|test` });
  const dispatch = (u: string, action: string, args: unknown[]) => as(u).mutation(api.dispatch.dispatch, { action, args });
  const push = (token: string, h: string, origin = true) => t.mutation(api.workflows.upsert, { api_token: token, name: "agentwatch", slug: "agentwatch", source: "digraph agentwatch {}", nodes: NODES, edges: [], ...(origin ? { origin: ORIGIN(h) } : {}) });
  return { t, ...ids, as, dispatch, push };
}

async function withRun(t: any, s: { ana: any; team: any; task: any }, workflowId: any, h = "i1") {
  return await t.run((ctx: any) => ctx.db.insert("workflow_runs", {
    user_id: s.ana, workflow_id: workflowId, task_id: s.task, status: "completed", workspace: `team:${s.team}`, team_id: s.team,
    node_statuses: [{ node_id: "investigate", status: "completed", outcome: "success", session_id: "jx7inv1" }],
    graph_nodes: [{ id: "investigate", h }], created_at: Date.now(), updated_at: Date.now(),
  }));
}

describe("a pushed graph's origin and versions", () => {
  test("a push from a file records where it lives and a version per new hash, naming the steps that moved", async () => {
    const { t, push } = await seed();
    const { id } = await push("tok-ana", "i1");
    await push("tok-ana", "i1");
    await push("tok-ana", "i2");
    await push("tok-ana", "i2", false);
    const row: any = await t.run((ctx) => ctx.db.get(id));
    expect(row.origin.file).toBe("outreach/line/agentwatch.cast");
    expect(row.origin.graph_hash).toBe("g-i2");
    const versions = await t.run((ctx) => ctx.db.query("workflow_versions").collect());
    expect(versions.map((v) => v.graph_hash)).toEqual(["g-i1", "g-i2"]);
    expect(versions[1].changed).toEqual(["investigate"]);
  });

  test("a teammate who reads a run of the graph reads its versions", async () => {
    const s = await seed();
    const { id } = await s.push("tok-ana", "i1");
    await withRun(s.t, s, id);
    const read = await s.as(String(s.bo)).query(api.lineActions.versions, { workflow_id: id });
    expect(read).toHaveLength(1);
  });
});

describe("saving a step", () => {
  test("the owner's save goes to the machine that pushed it, under the request id", async () => {
    const s = await seed();
    const { id } = await s.push("tok-ana", "i1");
    const res = await s.dispatch(String(s.ana), "editLineGraph", ["req-1", String(id), { node: "investigate", text: "New text.", base_hash: "i1", base_text: "Old text." }]);
    const cmd: any = await s.t.run((ctx) => ctx.db.query("daemon_commands").first());
    expect(cmd).toMatchObject({ command: "line_graph_edit", target_device_id: "dev-ana", request_id: "req-1" });
    expect(JSON.parse(cmd.args)).toEqual({ root: "/Users/ana/src/union", file: "outreach/line/agentwatch.cast", node: "investigate", field: "prompt", text: "New text.", base_hash: "i1", base_text: "Old text." });
    expect(JSON.stringify(res)).toContain(String(cmd._id));
  });

  test("a teammate's graph is refused, with how to edit it", async () => {
    const s = await seed();
    const { id } = await s.push("tok-ana", "i1");
    await expect(s.dispatch(String(s.bo), "editLineGraph", ["req-2", String(id), { node: "investigate", text: "x" }])).rejects.toThrow(/teammate's machine/);
    const e = await s.as(String(s.bo)).query(api.lineActions.editability, { workflow_id: id });
    expect(e).toMatchObject({ editable: false });
    expect((await s.as(String(s.ana)).query(api.lineActions.editability, { workflow_id: id })).editable).toBe(true);
  });

  test("a graph pushed from no file says to push it from its checkout", async () => {
    const s = await seed();
    const { id } = await s.push("tok-ana", "i1", false);
    await expect(s.dispatch(String(s.ana), "editLineGraph", ["req-3", String(id), { node: "investigate", text: "x" }])).rejects.toThrow(/cast workflow push/);
  });
});

describe("trying an edit", () => {
  test("each case is queued with its old decision, and its brief goes to the graph's machine; reports settle it", async () => {
    const s = await seed();
    const { id } = await s.push("tok-ana", "i2");
    const run = await withRun(s.t, s, id, "i1");
    await s.dispatch(String(s.ana), "tryLineStep", ["try-1", String(id), { node: "investigate", text: "Find it in one line.", runs: [String(run)], base_hash: "i2", base_text: "Find it." }]);
    const rows = await s.t.run((ctx) => ctx.db.query("line_tries").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "queued", project_id: s.project, older_text: true, model: "opus", old: { outcome: "success", words: "A stale lock in the queue.", result: { cause: "stale-lock" } } });
    const cmd: any = await s.t.run((ctx) => ctx.db.query("daemon_commands").first());
    const args = JSON.parse(cmd.args);
    expect(cmd.command).toBe("line_try");
    expect(args).toMatchObject({ try_id: "try-1", node: "investigate", old_template: "Find it.", new_template: "Find it in one line." });
    expect(args.cases).toEqual([{ row_id: String(rows[0]._id), run_id: String(run), received: "# Task: Investigate\nFind the mechanism behind c-42." }]);

    // Bo's machine cannot write Ana's case; Ana's reports move it, and a settled case stays settled.
    expect(await s.t.mutation(api.lineActions.reportTry, { api_token: "tok-bo", row_id: rows[0]._id, report: { status: "running" } })).toEqual({ error: "Not found" });
    await s.t.mutation(api.lineActions.reportTry, { api_token: "tok-ana", row_id: rows[0]._id, report: { status: "running", via: "patch" } });
    await s.t.mutation(api.lineActions.reportTry, { api_token: "tok-ana", row_id: rows[0]._id, report: { status: "done", decision: { status: "done", words: "A race.", result: { cause: "race" } }, cost_usd: 0.4, refused: ["state --status done -"] } });
    await s.t.mutation(api.lineActions.reportTry, { api_token: "tok-ana", row_id: rows[0]._id, report: { status: "running" } });
    const feed = await s.as(String(s.bo)).query(api.lineActions.tries, { project_id: s.project });
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ status: "done", via: "patch", new: { result: { cause: "race" } }, cost_usd: 0.4, key: `try-1:${run}` });
  });

  test("a try needs cases the viewer can read that reached the step, at most eight", async () => {
    const s = await seed();
    const { id } = await s.push("tok-ana", "i1");
    await expect(s.dispatch(String(s.ana), "tryLineStep", ["try-2", String(id), { node: "investigate", text: "x", runs: [] }])).rejects.toThrow(/at least one case/);
    await expect(s.dispatch(String(s.ana), "tryLineStep", ["try-3", String(id), { node: "bind", text: "x", runs: ["a"] }])).rejects.toThrow(/not an agent's step/);
  });
});

describe("asking an agent", () => {
  test("files the line cause with the words; with no lead it says why it did not start", async () => {
    const s = await seed();
    const res: any = await s.dispatch(String(s.ana), "askLineAgent", ["ask-1", String(s.project), { subject: "line:station:investigate", title: "Stop calling races locks", detail_md: "Stop calling races locks.\n\n## Labeled cases\n\n- **Wrong**: ct-1" }]);
    const task: any = await s.t.run((ctx) => ctx.db.query("tasks").withIndex("by_client_key", (q: any) => q.eq("user_id", s.ana).eq("client_key", "ask-1")).first());
    expect(task).toMatchObject({ category: "line", project_id: s.project });
    expect(JSON.stringify(res)).toContain("No role leads this project");
  });
});
