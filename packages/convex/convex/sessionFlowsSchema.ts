// A graph a session ran (flows doc "used in sessions", ct-69933): one row
// per distinct graph per workspace, written by the run path the first time
// a run reports it (flowLibrary.recordRunGraph): a Claude Code Workflow
// script as the daemon traced it, or a .cast graph `cast workflow run` read
// from a file. Who ran it, in which sessions and how often are the runs'
// own facts, read through workflow_runs.by_workspace_graph; this row holds
// the graph, the newest run's time as the shelf's sort key, and where it
// was saved to the library.

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { graphFilesValidator, graphNodeHashesValidator, workflowEdgeValidator, workflowNodeValidator } from "./lib/workflowGraphValidators";

export const sessionFlowTables = {
  session_flows: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    graph_hash: v.string(),
    from: v.union(v.literal("script"), v.literal("graph")),
    name: v.string(),
    label: v.optional(v.string()),
    source: v.string(),
    nodes: v.array(workflowNodeValidator),
    edges: v.array(workflowEdgeValidator),
    // Where the graph and its station files sit, repo-relative, so a saved
    // copy materializes the way a pushed one does (cli flowPool.materializePushedFlow).
    file: v.string(),
    files: graphFilesValidator,
    graph_nodes: graphNodeHashesValidator,
    // The Claude Code Workflow script itself, for a graph traced from one.
    script: v.optional(v.string()),
    first_run_id: v.id("workflow_runs"),
    last_run_at: v.number(),
    saved: v.optional(v.object({ workflow_id: v.id("workflows"), slug: v.string() })),
    created_at: v.number(),
  })
    .index("by_workspace_hash", ["workspace", "graph_hash"])
    .index("by_workspace_last", ["workspace", "last_run_at"]),
};
