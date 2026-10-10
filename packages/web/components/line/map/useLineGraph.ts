"use client";
// Which of a project's graphs to draw, and that graph ready for the map
// (lib/line/lineGraphs). Codecast's line comes from the project's own copy,
// the repo's or the shipped one (useProjectStations); any other graph from
// the row its newest run ran (workflow_runs.graphOfRun), or, when that row
// cannot be read, from the stations its runs recorded. The map view and the
// trace read the same answer.
import { useMemo } from "react";
import { useRunGraph } from "../../../hooks/useSyncWorkflows";
import { graphForMap, graphFromIds, isCodecastLine, pickGraph, projectGraphs, type GraphEdgeIn, type GraphNodeIn, type GraphRun } from "../../../lib/line/lineGraphs";
import type { LineGraph } from "../../../lib/line/lineMap";
import { useProjectStations } from "../settings/LineStations";

/** `waiting` (the queue's task ids) labels each graph by the waiting causes it holds. */
export function useLineGraph(projectId: string | null, runs: ReadonlyArray<GraphRun>, signals: ReadonlyArray<{ task_id: string; source: string }>, asked: string | null | undefined, waiting?: ReadonlySet<string>) {
  const graphs = useMemo(() => (projectId ? projectGraphs(runs, signals, undefined, waiting) : []), [projectId, runs, signals, waiting]);
  const graphKey = pickGraph(graphs, asked);
  const picked = graphs.find((g) => g.key === graphKey) ?? null;
  const ownLine = isCodecastLine(graphKey);
  const stations = useProjectStations(projectId ?? "");
  const row = useRunGraph(ownLine ? null : picked?.runId, ownLine ? null : picked?.workflowId);
  const source: { nodes: GraphNodeIn[]; edges: GraphEdgeIn[] } | null = useMemo(() => {
    if (!projectId) return null;
    if (ownLine) return { nodes: stations.nodes, edges: stations.edges };
    if (row?.nodes?.length) return { nodes: row.nodes, edges: row.edges ?? [] };
    return graphFromIds(picked?.nodeIds ?? []);
  }, [projectId, ownLine, stations.nodes, stations.edges, row, picked]);
  const graph = useMemo(() => (source ? (ownLine ? source : graphForMap(source.nodes, source.edges)) as LineGraph : null), [source, ownLine]);
  /** The graph's own row could not be read: its stations come from what its runs recorded. */
  const unread = !ownLine && row === null;
  return { graphs, graphKey, picked, ownLine, source, graph, unread, row };
}
