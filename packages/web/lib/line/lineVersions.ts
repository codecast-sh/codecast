// What each version of the line delivered (docs/architecture/the-line-end-to-end.md LE14, keyed by graph_hash): its
// runs, what they ended as, what its cards say it cost, and what it changed from the version before. The project's
// Line tab reads it. Pure: no store, no React.
import { isLineRun } from "@codecast/shared/contracts/changeCard";
import { runEnd } from "@codecast/shared/contracts/causeHistory";
import { SHIPPED_LINE } from "./shippedLine.generated";
import { stepLabel, type ReportRun } from "./runReport";

export type LineVersion = { hash: string; first: number; last: number; runs: number; shipped: number; revised: number; dropped: number; stopped: number; reopened: number; billedUsd: number | null; listUsd: number | null; live: number; nodes: ReportRun["graph_nodes"] | null; change: string };

const stationName = (id: string) => stepLabel({ id, label: SHIPPED_LINE.nodes.find((n) => n.id === id)?.label });
const names = (ids: string[]) => (ids.length > 2 ? `${ids.length} stations` : ids.map(stationName).join(" and "));

/** What one version changed from the one before it, in words: "Prove
 *  edited", "Eval added, Unscored removed". Read from each station's hash. */
export function versionChange(nodes: ReportRun["graph_nodes"] | null, prev: ReportRun["graph_nodes"] | null | undefined): string {
  if (prev === undefined) return "First recorded version";
  if (!nodes?.length || !prev?.length) return "Edited; which stations was not recorded yet";
  const was = new Map(prev.map((n) => [n.id, n.h]));
  const now = new Map(nodes.map((n) => [n.id, n.h]));
  const edited = nodes.filter((n) => was.has(n.id) && was.get(n.id) !== n.h).map((n) => n.id);
  const added = nodes.filter((n) => !was.has(n.id)).map((n) => n.id);
  const removed = prev.filter((n) => !now.has(n.id)).map((n) => n.id);
  const parts = [edited.length ? `${names(edited)} edited` : "", added.length ? `${names(added)} added` : "", removed.length ? `${names(removed)} removed` : ""].filter(Boolean);
  return parts.length ? parts.join(", ") : "Flow settings edited";
}

/**
 * One row per graph the project's line ran, newest first: its runs, how many
 * shipped, were sent back to revise, were dropped, stopped before an answer,
 * and whose cause reopened in watch after it shipped, what its cards say it
 * cost, and what it changed from the version before. A run that recorded no
 * hash (before LE14) groups as "unrecorded".
 */
export function lineVersions(runs: ReadonlyArray<ReportRun>, reopenedAt: (taskId: string) => number[]): LineVersion[] {
  const out = new Map<string, LineVersion>();
  for (const r of runs) {
    if (!isLineRun(r)) continue;
    const hash = r.graph_hash || "unrecorded";
    const v = out.get(hash) ?? { hash, first: r.created_at, last: r.created_at, runs: 0, shipped: 0, revised: 0, dropped: 0, stopped: 0, reopened: 0, billedUsd: null, listUsd: null, live: 0, nodes: null, change: "" };
    v.runs++;
    v.first = Math.min(v.first, r.created_at);
    v.last = Math.max(v.last, r.created_at);
    if (!v.nodes && r.graph_nodes?.length) v.nodes = r.graph_nodes;
    const end = runEnd(r);
    if (end?.kind === "shipped") {
      v.shipped++;
      if (r.task_id && reopenedAt(r.task_id).some((t) => t > end.at)) v.reopened++;
    }
    if (end?.kind === "dropped") v.dropped++;
    if (r.node_statuses?.find((n) => n.node_id === "reopen")?.status === "completed") v.revised++;
    if (r.status === "failed" && end?.kind !== "shipped" && end?.kind !== "dropped") v.stopped++;
    if (r.status === "running" || r.status === "paused" || r.status === "pending") v.live++;
    if (typeof r.card_billed_usd === "number") {
      v.billedUsd = (v.billedUsd ?? 0) + r.card_billed_usd;
      v.listUsd = (v.listUsd ?? 0) + (r.card_list_usd ?? 0);
    }
    out.set(hash, v);
  }
  // Each recorded version against the one that ran before it.
  const recorded = [...out.values()].filter((v) => v.hash !== "unrecorded").sort((a, b) => a.first - b.first);
  recorded.forEach((v, i) => { v.change = versionChange(v.nodes, i === 0 ? undefined : recorded[i - 1].nodes); });
  const unrecorded = out.get("unrecorded");
  if (unrecorded) unrecorded.change = "Runs from before versions were recorded";
  return [...out.values()].sort((a, b) => b.last - a.last);
}

/** lineVersions over one project's scoped rows: a shipped cause counts as
 *  reopened when a signal marked reopened reached it after the ship. */
export function projectLineVersions(rows: { runs: ReadonlyArray<unknown>; signals: ReadonlyArray<{ task_id?: string | null; reopened?: boolean | null; created_at: number }> }): LineVersion[] {
  const by = new Map<string, number[]>();
  for (const s of rows.signals) if (s.reopened && s.task_id) by.set(s.task_id, [...(by.get(s.task_id) ?? []), s.created_at]);
  return lineVersions(rows.runs as ReadonlyArray<ReportRun>, (taskId) => by.get(taskId) ?? []);
}
