// Flows used in sessions (ct-69933): each distinct graph a team session ran
// is kept once, listed with the runs and sessions that used it, and saved to
// the team's library under a name, a new graph under the same name a new
// version. Run through the real mutations under convex-test.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { publishableFlowSource, flowGraphAttr, flowBase } from "@codecast/shared/contracts/flowPool";

const api = anyApi as any;
const TOKEN = "f".repeat(64);
const T0 = 1_790_000_000_000;

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./workflow_runs.ts": () => import("./workflow_runs"),
  "./workflows.ts": () => import("./workflows"),
  "./flowLibrary.ts": () => import("./flowLibrary"),
};

const SOURCE = `digraph review_fix {\n  graph [label="Review and fix", draft="jx7abcd"]\n  start [shape=Mdiamond]\n  review [label="Review", prompt="@review-fix/review.md"]\n  done [shape=Msquare]\n  start -> review\n  review -> done\n}\n`;
const nodes = [
  { id: "start", label: "start", shape: "Mdiamond", type: "start" },
  { id: "review", label: "Review", shape: "box", type: "session", prompt: "Review the change." },
  { id: "done", label: "done", shape: "Msquare", type: "exit" },
];
const edges = [{ from: "start", to: "review" }, { from: "review", to: "done" }];
const origin = (hash: string) => ({
  device_id: "dev-1", root: "/repo", file: ".codecast/flows/review-fix.cast",
  files: [{ node: "review", prompt: ".codecast/flows/review-fix/review.md" }],
  graph_hash: hash, nodes: [{ id: "review", h: hash.slice(0, 8) }],
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Founder" } as any);
    const mate = await ctx.db.insert("users", { name: "Mate" } as any);
    const stranger = await ctx.db.insert("users", { name: "Stranger" } as any);
    const team = await ctx.db.insert("teams", { name: "Union", created_at: T0 } as any);
    await ctx.db.insert("team_memberships", { user_id: owner, team_id: team, role: "admin", joined_at: T0 } as any);
    await ctx.db.insert("team_memberships", { user_id: mate, team_id: team, role: "member", joined_at: T0 } as any);
    await ctx.db.insert("api_tokens", { user_id: owner, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    const conv = await ctx.db.insert("conversations", { user_id: owner, team_id: team, session_id: "sess-team", agent_type: "claude_code", status: "active", started_at: T0, updated_at: T0, message_count: 1 } as any);
    const wf = await ctx.db.insert("workflows", {
      user_id: owner, workspace: `user:${owner}`, name: "review_fix", slug: "review-fix", source: SOURCE, nodes, edges, origin: origin("aaaaaaaaaaaaaaaa"), created_at: T0, updated_at: T0,
    } as any);
    return { owner, mate, stranger, team, conv, wf, workspace: `team:${team}` };
  });
  /** A `cast workflow run` from the team session, its runner reporting the graph. */
  const runGraph = async (hash = "aaaaaaaaaaaaaaaa", extra: Record<string, any> = {}) => {
    const runId = await t.run((ctx) => ctx.db.insert("workflow_runs", {
      user_id: ids.owner, workspace: ids.workspace, team_id: ids.team, workflow_id: ids.wf, workflow_name: "review_fix", status: "running", node_statuses: [],
      spawner_conversation_id: ids.conv, created_at: T0, updated_at: T0, ...extra,
    } as any));
    await t.mutation(api.workflow_runs.updateProgress, { api_token: TOKEN, run_id: runId, current_node_id: "start", node_id: "start", node_status: "running", graph_hash: hash, graph_nodes: [] });
    return runId;
  };
  const shelf = (user = ids.mate) => t.withIdentity({ subject: user }).query(api.flowLibrary.sessionFlows, { team_id: ids.team });
  return { t, ids, runGraph, shelf };
}

describe("used in sessions", () => {
  test("a graph a team session ran is kept once, with every run and session that used it", async () => {
    const { t, ids, runGraph, shelf } = await setup();
    const first = await runGraph();
    const second = await runGraph();
    const rows = await shelf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "review_fix", from: "graph", run_count: 2, more: false, saved: null, kind: null, base: null });
    expect(rows[0].runs.map(String).sort()).toEqual([String(first), String(second)].sort());
    expect(rows[0].sessions.map(String)).toEqual([String(ids.conv)]);
    expect(rows[0].by.map(String)).toEqual([String(ids.owner)]);
    // The list carries the graph's shape, never its stations' text.
    expect(rows[0].nodes.find((n: any) => n.id === "review")).not.toHaveProperty("prompt");
    // A second report of the same graph by the same run adds nothing.
    await t.mutation(api.workflow_runs.updateProgress, { api_token: TOKEN, run_id: first, current_node_id: "review", node_id: "review", node_status: "running", graph_hash: "aaaaaaaaaaaaaaaa" });
    expect(await t.run((ctx) => ctx.db.query("session_flows").collect())).toHaveLength(1);
    // A person outside the team reads nothing.
    expect(await shelf(ids.stranger)).toEqual([]);
  });

  test("a role's line run, a shipped template and a run from no session are not collected", async () => {
    const { t, ids, runGraph, shelf } = await setup();
    const role = await t.run((ctx) => ctx.db.insert("org_roles", { team_id: ids.team, name: "Lead", handle: "lead", created_at: T0 } as any));
    await runGraph("aaaaaaaaaaaaaaaa", { org_role_id: role });
    await runGraph("aaaaaaaaaaaaaaaa", { spawner_conversation_id: undefined });
    await runGraph("bbbbbbbbbbbbbbbb"); // the pushed row holds another graph: no file behind this one
    expect(await shelf()).toEqual([]);
  });

  test("a Claude Code Workflow run brings its traced script", async () => {
    const { t, ids, shelf } = await setup();
    const graph = { hash: "cccccccccccccccc", name: "ship_widget", label: "Ship widget", source: SOURCE.replace(`draft="jx7abcd"`, `kind="line", draft="imported"`), nodes, edges, file: ".codecast/flows/ship-widget.cast", files: [], graph_nodes: [], script: "export const meta = { name: 'ship-widget' }" };
    const snap = { api_token: TOKEN, external_run_id: "wf_1", session_id: "sess-team", workflow_name: "ship-widget", status: "running", phases: [], agents: [] };
    await t.mutation(api.workflow_runs.ingestSnapshot, { ...snap, graph });
    await t.mutation(api.workflow_runs.ingestSnapshot, { ...snap, status: "completed" });
    const rows = await shelf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "ship_widget", label: "Ship widget", from: "script", kind: "line", run_count: 1 });
    expect(rows[0].sessions.map(String)).toEqual([String(ids.conv)]);
    const stored = await t.run((ctx) => ctx.db.query("session_flows").first());
    expect(stored!.script).toContain("ship-widget");
  });

  test("save puts it in the team's library; a new graph under the same name is its next version", async () => {
    const { t, ids, runGraph, shelf } = await setup();
    await runGraph();
    const [row] = await shelf();
    const saved = await t.withIdentity({ subject: ids.mate }).mutation(api.flowLibrary.save, { id: row._id, label: "Review and fix", variant_of: "union-fix" });
    expect(saved).toEqual({ slug: "review-and-fix", version: 1 });
    const pool = await t.withIdentity({ subject: ids.owner }).query(api.workflows.webPool, { team_id: ids.team });
    const lib = pool.find((w: any) => w.slug === "review-and-fix");
    expect(lib).toBeTruthy();
    expect(lib.workspace).toBe(ids.workspace);
    expect(publishableFlowSource(lib.source)).toBe(true);
    expect(flowGraphAttr(lib.source, "label")).toBe("Review and fix");
    expect(flowBase(lib)).toBe("union-fix");
    expect(lib.origin.files).toEqual(origin("x").files);
    expect((await shelf())[0].saved).toEqual({ slug: "review-and-fix", version: 1 });

    // The session ran an improved graph; saving it under the same name is version 2 of the same row.
    await t.run((ctx) => ctx.db.patch(ids.wf, { origin: origin("dddddddddddddddd") } as any));
    await runGraph("dddddddddddddddd");
    const rows = await shelf();
    expect(rows).toHaveLength(2);
    const newer = rows.find((r: any) => r.graph_hash === "dddddddddddddddd");
    expect(await t.withIdentity({ subject: ids.owner }).mutation(api.flowLibrary.save, { id: newer._id, slug: "review-and-fix" })).toEqual({ slug: "review-and-fix", version: 2 });
    const libs = await t.run((ctx) => ctx.db.query("workflows").collect());
    expect(libs.filter((w: any) => w.slug === "review-and-fix")).toHaveLength(1);

    // A run of the saved library flow as it stands counts on the flow it came from.
    await runGraph("dddddddddddddddd");
    expect((await shelf()).find((r: any) => r.graph_hash === "dddddddddddddddd").run_count).toBe(2);
    await expect(t.withIdentity({ subject: ids.stranger }).mutation(api.flowLibrary.save, { id: newer._id })).rejects.toThrow(/not found/);
  });
});
