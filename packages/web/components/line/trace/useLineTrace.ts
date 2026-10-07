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
import { useWorkflowBySlug, useWorkflowRun } from "../../../hooks/useSyncWorkflows";
import { useDecisionDetail, useSyncDecisionDetail } from "../../../hooks/useSyncDecisionDetail";
import { lineForkSlug } from "../../../lib/line/lineStations";
import { buildLineTrace, resolveTraceRef, type LineTrace, type TraceRows, type TraceTask } from "../../../lib/line/lineTrace";
import type { LineGraph, MapDecision, MapRun, MapSignal } from "../../../lib/line/lineMap";
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

  // The project's own line when it customized one, else the shipped line.
  const project = useMemo(() => (cause?.project_id ? projects.find((p) => p._id === cause.project_id) ?? null : null), [cause?.project_id, projects]);
  const fork = useWorkflowBySlug(project ? lineForkSlug(project as { _id: string; short_id?: string | null }) : null);
  const graph = (fork?.nodes?.length ? fork : null) as LineGraph | null;

  // Who answered a card, by name: a teammate, or you.
  const people = useInboxStore((s) => s.teamMembers);
  const meId = useInboxStore((s) => s.currentUser?._id ?? null);

  const trace = useMemo(() => {
    const resolved = resolveTraceRef(ref, rows) ?? (cause ? { cause, via: (lonelyRun ? "run" : "decision") as "run" | "decision", focusId: lonelyRun?._id ?? detail?.decision._id ?? cause._id } : null);
    if (!resolved) return null;
    return buildLineTrace(resolved, rows, {
      now, graph,
      answeredBy: (d) => {
        const by = (d as { answered_by?: { kind: string; id: string } }).answered_by;
        if (!by || by.kind !== "user") return null;
        if (by.id === meId) return "You";
        return (people ?? []).find((m: { _id: string; name?: string }) => String(m._id) === by.id)?.name ?? null;
      },
    });
  }, [ref, rows, cause, lonelyRun, detail, now, graph, people, meId]);

  return { trace, rows, graph, ready, now };
}
