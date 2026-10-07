"use client";
// The rows one trace reads (docs/architecture/line-map.md LX4), from the
// store: the line floor every line surface mounts (useLineFloor), plus the
// cause's own runs (by task, so a run older than the floor's window still
// tells) and its signals read where the cause lives. A ref the floor does not
// hold (a run or a card fed nowhere yet) is fed by itself. Paints from the
// store; a feeder only feeds.
import { useMemo } from "react";
import { isLineRun } from "@codecast/shared/contracts/changeCard";
import { useInboxStore, type SessionDecisionItem } from "../../../store/inboxStore";
import { useCollectionRows } from "../../../hooks/useCollectionRows";
import { sig as decisionSig } from "../../../hooks/useTaskDecisions";
import { useSyncSignals, useWorkspaceSignals } from "../../../hooks/useSyncSignals";
import { useWorkflowRun } from "../../../hooks/useSyncWorkflows";
import { useDecisionDetail, useSyncDecisionDetail } from "../../../hooks/useSyncDecisionDetail";
import type { LineProject } from "../../../lib/lineFlow";
import { useProjectStations } from "../settings/LineStations";
import { buildLineTrace, resolveTraceRef, type LineTrace, type TraceRows, type TraceTask } from "../../../lib/line/lineTrace";
import type { LineGraph, MapDecision, MapRun, MapSignal } from "../../../lib/line/lineMap";
import { useGoalChip } from "../../../hooks/useGoalChip";
import { useCauseRuns } from "../RunReport";
import { useLineFloor } from "../useLineFloor";

const byId = <T extends { _id: string }>(...lists: ReadonlyArray<ReadonlyArray<T>>): T[] => {
  const out = new Map<string, T>();
  for (const list of lists) for (const r of list) out.set(r._id, r);
  return [...out.values()];
};

/** A Convex id: what a run ref is (refs with a prefix name other things). */
const looksLikeId = (ref: string) => /^[a-z0-9]{20,}$/i.test(ref);

export type LineTraceState = {
  trace: LineTrace | null;
  rows: TraceRows;
  graph: LineGraph | null;
  /** The cause's project: whose line the map draws. */
  project: LineProject | null;
  /** The floor has arrived: a missing trace is missing, not loading. */
  ready: boolean;
  now: number;
};

export function useLineTrace(ref: string): LineTraceState {
  const { now, lineRows, projects } = useLineFloor();
  const { ready } = useSyncSignals();

  // The floor's rows first: most refs resolve there.
  const floor = lineRows as unknown as TraceRows;
  const first = useMemo(() => resolveTraceRef(ref, floor), [ref, floor]);

  // A run or a card the floor does not hold is fed by itself.
  const lonelyRun = (useWorkflowRun(!first && looksLikeId(ref) ? ref : null) as MapRun | null | undefined) ?? null;
  const cardRef = !first && /^sd-/i.test(ref) ? ref : undefined;
  useSyncDecisionDetail(cardRef);
  const detail = useDecisionDetail(cardRef);

  const causeId = first?.cause._id ?? lonelyRun?.task_id ?? (detail?.decision as { task_id?: string } | undefined)?.task_id ?? null;
  const cause = useMemo(() => (causeId ? (lineRows.tasks.find((t) => t._id === causeId) as TraceTask | undefined) ?? null : null), [causeId, lineRows.tasks]);
  // The cause's signals where the cause lives, and every run on it.
  const workspace = (cause as { workspace?: string | null } | null)?.workspace ?? null;
  useSyncSignals(workspace);
  const causeSignals = useWorkspaceSignals(workspace);
  const causeRuns = useCauseRuns(causeId);
  // Every card on the cause the store holds, answered ones too (the floor
  // keeps the pending ones only), and the newest run's card fed by itself, so
  // the card step can say who answered what (useTaskDecisions reads the same rows).
  const cardWhere = useMemo(() => (d: SessionDecisionItem) => !!causeId && d.task_id === causeId, [causeId]);
  const causeCards = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where: cardWhere, sig: decisionSig });
  const newestCard = causeRuns.find((r) => r.gate_decision_short_id)?.gate_decision_short_id;
  useSyncDecisionDetail(newestCard);
  const newestDetail = useDecisionDetail(newestCard);

  const rows = useMemo<TraceRows>(() => ({
    signals: byId(floor.signals, causeSignals as MapSignal[]),
    tasks: floor.tasks,
    runs: byId(floor.runs, causeRuns as unknown as MapRun[], lonelyRun ? [lonelyRun] : []).filter((r) => r.task_id !== causeId || isLineRun(r.node_statuses as never)),
    decisions: byId(floor.decisions, causeCards as unknown as MapDecision[], [detail, newestDetail].flatMap((d) => (d?.decision ? [d.decision as unknown as MapDecision] : []))),
  }), [floor, causeSignals, causeRuns, lonelyRun, detail, newestDetail, causeCards, causeId]);

  // The project's actual line, read where the map reads it (the repo's, a
  // customized one, else the shipped line), so the path lands on its nodes.
  const projectId = cause?.project_id ?? null;
  const project = useMemo(() => (projectId ? projects.find((p) => p._id === projectId) ?? null : null), [projectId, projects]);
  const stations = useProjectStations(projectId ?? "");
  const graph = useMemo<LineGraph | null>(() => (projectId ? { nodes: stations.nodes, edges: stations.edges } : null), [projectId, stations.nodes, stations.edges]);

  // The goal the cause serves, by name (a project or a goal), never its id.
  const goal = useGoalChip(cause?.goal_ref);

  // Who answered a card, by name: a teammate, or you.
  const people = useInboxStore((s) => s.teamMembers);
  const meId = useInboxStore((s) => s.currentUser?._id ?? null);

  const trace = useMemo(() => {
    const resolved = resolveTraceRef(ref, rows) ?? (cause ? { cause, via: (lonelyRun ? "run" : "decision") as "run" | "decision", focusId: lonelyRun?._id ?? detail?.decision._id ?? cause._id } : null);
    if (!resolved) return null;
    return buildLineTrace(resolved, rows, {
      now, graph,
      goalName: (g) => (g === cause?.goal_ref && goal.kind !== "unknown" ? goal.label : null),
      answeredBy: (d) => {
        const by = (d as { answered_by?: { kind: string; id: string } }).answered_by;
        if (!by || by.kind !== "user") return null;
        if (by.id === meId) return "You";
        return (people ?? []).find((m: { _id: string; name?: string }) => String(m._id) === by.id)?.name ?? null;
      },
    });
  }, [ref, rows, cause, lonelyRun, detail, now, graph, people, meId, goal]);

  return { trace, rows, graph, project, ready, now };
}
