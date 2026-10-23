// Flows used in sessions (flows doc s975wwqd, "Sessions"; ct-69933): every
// distinct graph a session ran is kept once per workspace (session_flows),
// shown on /flows with the runs and sessions that used it, and saved to the
// team's library in one step, each save of a new graph a new version.
//
// Two run paths bring a graph here, and nothing else writes it:
//   - a Claude Code Workflow run: the daemon traces the script (the same
//     tracer as `cast flow import`) and sends the graph with its first
//     snapshot (workflow_runs.ingestSnapshot);
//   - `cast workflow run <file>` / `cast flow run` from a session: the runner
//     reports the graph's hash, and the graph is the workflows row the run
//     pushed from that file (workflow_runs.updateProgress).
// A run of a library flow as it stands, a role's line run and a shipped
// template are not "used in sessions": the library already holds them.
import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { flowBase, flowGraphAttr, publishableFlowSource, withGraphAttrs } from "@codecast/shared/contracts/flowPool";
import { LINE_SLUG_RE } from "@codecast/shared/contracts/orgProposal";
import { createDataContext } from "./data";
import { isTeamMember, parseWorkspaceKey, workspaceGrantsAccess } from "./lib/access";

import { isLineRunSlug, recordGraphVersion, upsertWorkflowFor } from "./workflows";

export type RunGraph = {
  hash: string; name: string; label?: string; source: string;
  nodes: Doc<"workflows">["nodes"]; edges: Doc<"workflows">["edges"];
  file: string; files: Doc<"session_flows">["files"]; graph_nodes: Doc<"session_flows">["graph_nodes"];
  script?: string;
};

/** A library flow in this workspace whose graph is this one, as pushed. */
async function libraryHolds(ctx: any, workspace: string, hash: string): Promise<boolean> {
  const rows: any[] = await ctx.db.query("workflows").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).collect();
  return rows.some((w) => w.origin?.graph_hash === hash && publishableFlowSource(w.source));
}

/**
 * A run used this graph: its row in the run's workspace takes the run's time,
 * or is written when this is the graph's first run there. A graph the
 * workspace's library already holds as it stands is not kept.
 */
export async function recordRunGraph(ctx: any, run: Pick<Doc<"workflow_runs">, "_id" | "workspace" | "team_id">, graph: RunGraph, from: "script" | "graph", now = Date.now()): Promise<Id<"session_flows"> | null> {
  if (!run.workspace) return null;
  const existing = await ctx.db.query("session_flows").withIndex("by_workspace_hash", (q: any) => q.eq("workspace", run.workspace).eq("graph_hash", graph.hash)).first();
  if (existing) {
    if (existing.last_run_at < now) await ctx.db.patch(existing._id, { last_run_at: now });
    return existing._id;
  }
  if (await libraryHolds(ctx, run.workspace, graph.hash)) return null;
  return await ctx.db.insert("session_flows", {
    workspace: run.workspace,
    ...(run.team_id ? { team_id: run.team_id } : {}),
    graph_hash: graph.hash,
    from,
    name: graph.name,
    ...(graph.label?.trim() ? { label: graph.label.trim() } : {}),
    source: graph.source,
    nodes: graph.nodes,
    edges: graph.edges,
    file: graph.file,
    files: graph.files,
    graph_nodes: graph.graph_nodes,
    ...(graph.script ? { script: graph.script } : {}),
    first_run_id: run._id,
    last_run_at: now,
    created_at: now,
  });
}

/**
 * The runner of a `cast workflow run` reported the graph it runs. A run a
 * session started on a graph it read from a file (the pushed row says where,
 * at this hash) is a session's flow; a role's line run, a shipped template
 * (no file) and a run from no session are not.
 */
export async function recordRoutineRunGraph(ctx: any, run: Doc<"workflow_runs">, hash: string, now = Date.now()) {
  if (run.org_role_id || !run.spawner_conversation_id || !run.workflow_id || run.graph_hash === hash) return null;
  const row = await ctx.db.get(run.workflow_id);
  if (!row?.origin || row.origin.graph_hash !== hash || isLineRunSlug(row.slug)) return null;
  return await recordRunGraph(ctx, run, {
    hash, name: row.name, label: row.label, source: row.source ?? "",
    nodes: row.nodes, edges: row.edges, file: row.origin.file, files: row.origin.files, graph_nodes: row.origin.nodes,
  }, "graph", now);
}

/** A Claude Code Workflow run's snapshot carried its traced script: the run takes its hash, and the graph its row. */
export async function recordScriptRunGraph(ctx: any, runId: Id<"workflow_runs">, existing: Doc<"workflow_runs"> | null, graph: RunGraph | undefined, now = Date.now()) {
  if (!graph || existing?.graph_hash) return null;
  await ctx.db.patch(runId, { graph_hash: graph.hash, graph_nodes: graph.graph_nodes });
  const run = await ctx.db.get(runId);
  return run ? await recordRunGraph(ctx, run, graph, "script", now) : null;
}

/** How many runs a shelf row reads: past it, the count reads as "at least". */
export const SESSION_FLOW_RUNS_CAP = 20;
/** How many flows the shelf lists, newest run first. */
const SHELF_CAP = 40;

async function viewerWorkspaceKey(ctx: any, userId: Id<"users">, teamId?: Id<"teams">): Promise<string | null> {
  if (teamId && !(await isTeamMember(ctx, userId, teamId))) return null;
  const db = await createDataContext(ctx, { userId, ...(teamId ? { workspace: "team" as const, team_id: teamId } : { workspace: "personal" as const }) });
  return db.workspaceKey;
}

/** The library row a save writes, and how many versions it has. */
async function savedOf(ctx: any, saved: Doc<"session_flows">["saved"]) {
  if (!saved) return null;
  const versions = await ctx.db.query("workflow_versions").withIndex("by_workflow_at", (q: any) => q.eq("workflow_id", saved.workflow_id)).take(500);
  return { slug: saved.slug, version: versions.length };
}

/**
 * The "Used in sessions" shelf: the workspace's session flows, newest run
 * first. Each row carries its graph as stations and routes (no station
 * text), and what its runs say: the newest run ids, how many (at least, when
 * `more`), the sessions that ran it and who, newest first.
 */
export const sessionFlows = query({
  args: { team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const key = await viewerWorkspaceKey(ctx, userId, args.team_id);
    if (!key) return [];
    const rows = await ctx.db.query("session_flows").withIndex("by_workspace_last", (q) => q.eq("workspace", key)).order("desc").take(SHELF_CAP);
    return await Promise.all(rows.map(async (f) => {
      const runs = await ctx.db.query("workflow_runs").withIndex("by_workspace_graph", (q) => q.eq("workspace", key).eq("graph_hash", f.graph_hash)).order("desc").take(SESSION_FLOW_RUNS_CAP + 1);
      const shown = runs.slice(0, SESSION_FLOW_RUNS_CAP);
      const uniq = <T,>(xs: Array<T | undefined>) => [...new Set(xs.filter((x): x is T => !!x))];
      const kind = flowGraphAttr(f.source, "kind");
      return {
        _id: f._id,
        workspace: f.workspace,
        graph_hash: f.graph_hash,
        from: f.from,
        name: f.name,
        label: f.label ?? null,
        kind: kind === "line" || kind === "segment" ? kind : null,
        base: flowBase({ source: f.source }),
        nodes: f.nodes.map(({ prompt: _p, script: _s, ...n }) => n),
        edges: f.edges,
        runs: shown.map((r) => r._id),
        run_count: shown.length,
        more: runs.length > SESSION_FLOW_RUNS_CAP,
        last_at: f.last_run_at,
        // A Workflow run's session is the one that called it; a graph run's is the session that started it.
        sessions: uniq(shown.map((r) => r.spawner_conversation_id ?? r.primary_conversation_id)),
        by: uniq(shown.map((r) => r.user_id)),
        saved: await savedOf(ctx, f.saved),
      };
    }));
  },
});

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

/**
 * Save a session's flow to the library under a name, optionally as a variant
 * of a library flow. The library row is the workspace's flow by that slug:
 * a save to a slug the library has adds a version of it, a new slug starts
 * one. The graph goes in as the session ran it, made publishable (its kind
 * stated, its draft mark dropped), with its station files, so `cast flow run`
 * materializes it as it does any published flow.
 */
export const save = mutation({
  args: { id: v.id("session_flows"), slug: v.optional(v.string()), label: v.optional(v.string()), variant_of: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not signed in");
    const flow = await ctx.db.get(args.id);
    if (!flow || !(await workspaceGrantsAccess(ctx, userId, flow.workspace))) throw new ConvexError("Flow not found");
    const ws = parseWorkspaceKey(flow.workspace);
    if (!ws) throw new ConvexError("Flow not found");
    const label = args.label?.trim() || flow.label || flow.name;
    const slug = args.slug?.trim() || flow.saved?.slug || slugOf(label);
    if (!LINE_SLUG_RE.test(slug)) throw new ConvexError("A flow's name is 1 to 64 characters of a-z, 0-9 and -");
    const variantOf = args.variant_of?.trim() || undefined;
    if (variantOf === slug) throw new ConvexError("A flow cannot be a variant of itself");
    if (flowGraphAttr(flow.source, "extends")) throw new ConvexError("This graph extends a file of its checkout; publish it from there with cast flow publish");
    const kind = flowGraphAttr(flow.source, "kind") === "segment" ? "segment" : "line";
    const source = withGraphAttrs(flow.source, { kind, label, draft: null });
    const now = Date.now();
    const origin = { device_id: "", root: "", file: flow.file, files: flow.files, graph_hash: flow.graph_hash, nodes: flow.graph_nodes };
    const graph = { name: flow.name, label, source, nodes: flow.nodes, edges: flow.edges };

    // The workspace's flow by this slug, whoever saved it first: a teammate's save is a new version of it.
    const pool: any[] = await ctx.db.query("workflows").withIndex("by_workspace", (q) => q.eq("workspace", flow.workspace)).collect();
    const held = pool.find((w) => w.slug === slug && publishableFlowSource(w.source));
    let workflowId: Id<"workflows">;
    if (held) {
      await ctx.db.patch(held._id, { ...graph, origin, ...(variantOf ? { variant_of: variantOf } : {}), updated_at: now });
      await recordGraphVersion(ctx, held._id, userId, origin, now);
      workflowId = held._id;
    } else {
      const publish = ws.type === "team" ? { workspace: "team" as const, team_id: ws.teamId } : { workspace: "personal" as const };
      workflowId = (await upsertWorkflowFor(ctx, userId, { ...graph, slug, origin, serves: undefined, publish })).id;
      if (variantOf) await ctx.db.patch(workflowId, { variant_of: variantOf });
    }
    await ctx.db.patch(flow._id, { saved: { workflow_id: workflowId, slug } });
    return { slug, version: (await savedOf(ctx, { workflow_id: workflowId, slug }))!.version };
  },
});
