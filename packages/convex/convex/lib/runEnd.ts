// A run that ends, however it ends (its runner's last report, a cancel, a gate
// dismissed or withdrawn, a judge-fix card closed), closes every station it
// still marks running. Otherwise the station it stopped at keeps its spinner
// and its clock counting forever (deploy__wait on ct-98114, 70h after a 502
// failed the run). A leaf with no imports, so every writer of a run's end can
// take it.

export type RunEnd = "completed" | "failed";

type Station = { status: string; outcome?: string; completed_at?: number };

/** The stations once the run ends: each still running takes the run's end as its status, "stopped" as its outcome. */
export function closeRunningStations<N extends Station>(nodes: ReadonlyArray<N>, end: RunEnd, now: number): N[] {
  return nodes.map((n) => (n.status === "running" ? { ...n, status: end, outcome: n.outcome ?? "stopped", completed_at: now } : n));
}

/** The fields that end a run: its status and its stations closed. */
export function endRunFields<N extends Station>(run: { node_statuses: ReadonlyArray<N> }, end: RunEnd, now: number): { status: RunEnd; node_statuses: N[] } {
  return { status: end, node_statuses: closeRunningStations(run.node_statuses, end, now) };
}
