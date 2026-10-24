import { v } from "convex/values";

// A graph's stations and routes as a workflows row stores them, and as a
// session's graph is kept (session_flows): one shape, so the web draws either.
export const workflowNodeValidator = v.object({
  id: v.string(),
  label: v.string(),
  shape: v.string(),
  type: v.string(),
  prompt: v.optional(v.string()),
  script: v.optional(v.string()),
  reasoning_effort: v.optional(v.string()),
  model: v.optional(v.string()),
  max_visits: v.optional(v.number()),
  max_retries: v.optional(v.number()),
  retry_target: v.optional(v.string()),
  goal_gate: v.optional(v.boolean()),
  // The CLI pushes these three; a validator without them rejected every push
  // that named a backend (the run then went unrendered in the web UI).
  backend: v.optional(v.string()),
  agent: v.optional(v.string()),
  isolated: v.optional(v.boolean()),
  // the-line.md L8: a run the daemon executes from this copy must match a
  // local run, so every attribute the runner reads is stored.
  definition: v.optional(v.string()),
  reviewer: v.optional(v.boolean()),
  timeout: v.optional(v.number()),
  temperature: v.optional(v.number()),
  doc: v.optional(v.string()),
  category: v.optional(v.string()),
  card: v.optional(v.string()),
  asker: v.optional(v.string()),
});

export const workflowEdgeValidator = v.object({
  from: v.string(),
  to: v.string(),
  label: v.optional(v.string()),
  condition: v.optional(v.string()),
});

/** Each station's text file, repo-relative, for a graph that reads them (`@file`). */
export const graphFilesValidator = v.array(v.object({ node: v.string(), prompt: v.optional(v.string()), script: v.optional(v.string()) }));

/** Each station's own hash in a graph (cli parser.graphNodeHashes). */
export const graphNodeHashesValidator = v.array(v.object({ id: v.string(), h: v.string() }));

/** One version of a flow whole (ct-70169): what a library run materializes and a restore writes back. */
export const workflowSnapshotValidator = v.object({
  name: v.string(),
  label: v.optional(v.string()),
  goal: v.optional(v.string()),
  source: v.string(),
  nodes: v.array(workflowNodeValidator),
  edges: v.array(workflowEdgeValidator),
  file: v.string(),
  files: graphFilesValidator,
});

/** A graph as a run path hands it over. */
export const runGraphValidator = v.object({
  hash: v.string(),
  name: v.string(),
  label: v.optional(v.string()),
  source: v.string(),
  nodes: v.array(workflowNodeValidator),
  edges: v.array(workflowEdgeValidator),
  file: v.string(),
  files: graphFilesValidator,
  graph_nodes: graphNodeHashesValidator,
  script: v.optional(v.string()),
});

// workflow_runs.ingestSnapshot's args: a Claude Code Workflow run as the
// daemon reads it from the runtime's snapshot (cli daemon.ts).
export const ingestSnapshotArgs = {
  api_token: v.string(),
  external_run_id: v.string(),
  session_id: v.string(),
  project_path: v.optional(v.string()),
  workflow_name: v.string(),
  status: v.string(),
  phases: v.array(v.object({ title: v.string(), detail: v.optional(v.string()) })),
  agents: v.array(v.object({
    agent_id: v.string(),
    label: v.optional(v.string()),
    phase: v.optional(v.string()),
    state: v.string(),
    tokens: v.optional(v.number()),
    duration_ms: v.optional(v.number()),
    started_at: v.optional(v.number()),
    result_preview: v.optional(v.string()),
    last_tool_name: v.optional(v.string()),
    last_tool_summary: v.optional(v.string()),
  })),
  total_tokens: v.optional(v.number()),
  agent_count: v.optional(v.number()),
  started_at: v.optional(v.number()),
  // The script as a graph (cli flowImport.traceScriptGraph), sent until the
  // run holds its hash (flowLibrary.recordScriptRunGraph).
  graph: v.optional(runGraphValidator),
};
