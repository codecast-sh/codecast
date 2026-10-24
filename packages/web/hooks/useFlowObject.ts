// A flow as one object in a transcript (flows doc s975wwqd, "Sessions"; ct-69934):
// the graph a run ran or a session defined, and where it stands with the
// library. Web (FlowFence) and the phone (FlowCard) both read a flow through
// these hooks, so the two draw the same graph and offer the same Save.
//
// The graph a run ran is its own workflows row (graphOfRun, readable by anyone
// who may read the run); the library's copy by slug only when the row cannot
// be read. Save is the team's session-flow row for that graph (convex
// flowLibrary.sessionFlows, matched by graph hash and workspace): a graph the
// library holds as it stands is never collected, so it has no row and no Save.
import { useMemo } from "react";
import { usePoolFlowRows, useRunGraph, useWorkflowBySlug } from "./useSyncWorkflows";
import { useSessionFlows, type SessionFlow } from "./useLiveFlow";
import { appPool, flowBySlug, flowOfRun, pushedFlow, type AppFlow } from "../lib/line/flowPool";

/** Where a flow stands with the library: savable (its session-flow row), saved under a slug, or the library's own. */
export type FlowLibraryState =
  | { kind: "save"; id: string; variantOf: string | null }
  | { kind: "saved"; slug: string; version: number }
  | { kind: "library"; slug: string }
  | null;

type RunRow = { _id: string; workflow_id?: string | null; graph_hash?: string | null; workspace?: string | null; workflow_slug?: string | null; workflow_name?: string | null; workflow_label?: string | null };

function usePool(): AppFlow[] {
  const rows = usePoolFlowRows();
  return useMemo(() => appPool(rows), [rows]);
}

/** The team's session-flow row for a graph, by its hash, in the workspace the run belongs to. */
function useSessionFlowOf(workspace: string | null | undefined, hash: string | null | undefined): SessionFlow | null {
  const { flows: rows } = useSessionFlows(hash ? workspace : null);
  return useMemo(() => (hash ? rows.find((r) => r.graph_hash === hash && r.workspace === workspace) ?? null : null), [rows, hash, workspace]);
}

function libraryState(flow: AppFlow | null, row: SessionFlow | null): FlowLibraryState {
  if (row) return row.saved ? { kind: "saved", slug: row.saved.slug, version: row.saved.version } : { kind: "save", id: row._id, variantOf: row.base ?? flow?.base ?? null };
  return flow && (flow.where === "shipped" || flow.where === "team") ? { kind: "library", slug: flow.slug } : null;
}

/**
 * The flow one run ran, drawn from the graph it ran, and its standing with the library.
 * `flow` is undefined while nothing is known yet, null when the viewer cannot read any copy.
 */
export function useRunFlow(run: RunRow | null | undefined): { flow: AppFlow | null | undefined; library: FlowLibraryState } {
  const pool = usePool();
  const row = useRunGraph(run?._id ?? null, run?.workflow_id ?? null);
  const session = useSessionFlowOf(run?.workspace, run?.graph_hash);
  const flow = useMemo(() => {
    if (!run) return undefined;
    // The library's copy when it is the same flow: it knows its kind, label and place (shipped, the team's).
    const named = flowOfRun(pool, run);
    if (row && !(named && named.where !== "pushed" && row.slug === named.slug && sameGraph(row, named))) return { ...pushedFlow(row), ...(run.workflow_label ? { label: run.workflow_label } : {}) };
    if (named) return named;
    if (session) return pushedFlow({ ...session, slug: session.name, source: null, variant_of: session.base });
    return row === undefined ? undefined : null;
  }, [run, pool, row, session]);
  return { flow, library: libraryState(flow ?? null, session) };
}

/** A flow by name: the library's, else the viewer's own graph of that name (one this session defined, pushed as its draft). */
export function useNamedFlow(slug: string): { flow: AppFlow | null | undefined; library: FlowLibraryState } {
  const pool = usePool();
  const inPool = flowBySlug(pool, slug);
  const own = useWorkflowBySlug(inPool ? null : slug);
  const flow = useMemo(() => inPool ?? (own ? pushedFlow(own) : own === null ? null : undefined), [inPool, own]);
  return { flow, library: libraryState(flow ?? null, null) };
}

const sameGraph = (row: { nodes: ReadonlyArray<{ id: string }> }, flow: AppFlow) =>
  row.nodes.length === flow.nodes.length && row.nodes.every((n, i) => n.id === flow.nodes[i]?.id);
