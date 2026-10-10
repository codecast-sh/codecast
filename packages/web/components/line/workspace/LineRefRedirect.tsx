"use client";
// `/line/trace/<ref>`: any ref the line knows (a problem, a finding, a
// fingerprint, a run, a card) opens its place in the project's workspace
// (line-workspace.md LW1). A problem or a finding opens the problem's
// Timeline; a run opens Replay on that run; a card opens Replay on the run
// that asked it, at the card. The ref resolves from the store (the line floor,
// the held task, a run or card fed by itself); the address is replaced, so
// Back skips this hop.
import { useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import { useInboxStore } from "../../../store/inboxStore";
import { useSyncSignals } from "../../../hooks/useSyncSignals";
import { useWorkflowRun } from "../../../hooks/useSyncWorkflows";
import { useDecisionDetail, useSyncDecisionDetail } from "../../../hooks/useSyncDecisionDetail";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { graphKeyOf, type GraphRun } from "../../../lib/line/lineGraphs";
import { lineWorkspaceTarget, resolveTraceRef, type TraceRows } from "../../../lib/line/lineTrace";
import { lineRefOf, lineWorkspaceHref } from "../../../lib/line/lineWorkspaceUrl";
import { useCauseRuns } from "../RunReport";
import { useLineFloor, useProjectWorkspace } from "../useLineFloor";
import "./workspace.css";

/** A Convex id: what a run ref is (refs with a prefix name other things). */
const looksLikeId = (ref: string) => /^[a-z0-9]{20,}$/i.test(ref);

type HeldTask = { _id: string; short_id?: string; workspace?: string | null; team_id?: string | null; project_id?: string | null };

/** The task a ref names wherever the store holds it: a cause in another team's workspace is not in the active floor. */
function heldTask(tasks: Record<string, HeldTask> | undefined, ref: string): HeldTask | null {
  if (!tasks || !ref) return null;
  if (tasks[ref]) return tasks[ref];
  if (!/^ct-/i.test(ref)) return null;
  for (const id in tasks) if (tasks[id]?.short_id === ref) return tasks[id];
  return null;
}

export function LineRefRedirect({ refParam }: { refParam: string }) {
  const ref = lineRefOf(refParam ?? "");
  const router = useRouter();
  const held = useInboxStore((s) => heldTask(s.tasks as unknown as Record<string, HeldTask>, ref));
  const elsewhere = useProjectWorkspace(held);
  const { lineRows } = useLineFloor(elsewhere ? held?.project_id ?? null : undefined, elsewhere);
  const { ready } = useSyncSignals();
  const floor = lineRows as unknown as TraceRows;
  const first = useMemo(() => resolveTraceRef(ref, floor), [ref, floor]);

  // A run or a card the floor does not hold is fed by itself.
  const lonelyRun = (useWorkflowRun(!first && looksLikeId(ref) ? ref : null) as (GraphRun & { _id: string; task_id?: string }) | null | undefined) ?? null;
  const cardRef = !first && /^sd-/i.test(ref) ? ref : undefined;
  useSyncDecisionDetail(cardRef);
  const detail = useDecisionDetail(cardRef);

  const causeId = first?.cause._id ?? held?._id ?? lonelyRun?.task_id ?? (detail?.decision as { task_id?: string } | undefined)?.task_id ?? null;
  const causeRuns = useCauseRuns(causeId);
  const cause = useInboxStore((s) => (causeId ? (s.tasks as unknown as Record<string, HeldTask>)[causeId] ?? null : null));
  // The address names a project the way the line pages do: its short id when it has one.
  const projectParam = useInboxStore((s) => {
    const id = cause?.project_id ?? held?.project_id ?? null;
    return id ? (s.projects as Record<string, { short_id?: string }> | undefined)?.[id]?.short_id ?? id : null;
  });

  const to = useMemo(() => {
    if (!causeId || !projectParam) return null;
    const runs = [...floor.runs, ...(causeRuns as unknown as TraceRows["runs"]), ...(lonelyRun ? [lonelyRun as unknown as TraceRows["runs"][number]] : [])];
    const card = (detail?.decision ?? null) as TraceRows["decisions"][number] | null;
    const resolved = first ?? { cause: { _id: causeId } as TraceRows["tasks"][number], via: lonelyRun ? "run" as const : card ? "decision" as const : "cause" as const, focusId: lonelyRun?._id ?? card?._id ?? causeId };
    const target = lineWorkspaceTarget(resolved, { decisions: card ? [...floor.decisions, card] : floor.decisions });
    const run = target.run ? runs.find((r) => r._id === target.run) ?? null : null;
    const graphRun = run ?? (causeRuns[0] as unknown as GraphRun | undefined) ?? null;
    return lineWorkspaceHref(projectParam, {
      view: target.run ? "replay" : "timeline",
      case: causeId,
      run: target.run,
      step: target.atCard ? CARD_GATE_NODE_ID : null,
      graph: graphRun ? graphKeyOf(graphRun as GraphRun) : null,
    });
  }, [projectParam, causeId, floor, causeRuns, lonelyRun, detail, first]);

  useWatchEffect(() => { if (to) router.replace(to); }, [to, router]);

  const missing = ready && !to && !causeId;
  return (
    <div className="lw" data-line-ref={ref} data-line-ref-missing={missing ? "" : undefined}>
      {missing ? (
        <div className="lw-empty">
          <b>Nothing on the line matches {ref || "that ref"}</b>
          A problem (ct-N), a finding (sg-N), a run or a card (sd-N) opens its place on its project's line.
          {" "}<Link href="/line" className="lw-link">Every project's line</Link>
        </div>
      ) : cause && !cause.project_id ? (
        <div className="lw-empty">
          <b>{held?.short_id ?? ref} is on no project's line</b>
          A problem opens on the line of the project it is filed under. <Link href={`/tasks/${held?.short_id ?? causeId}`} className="lw-link">Open the problem</Link>
        </div>
      ) : (
        <div className="lw-skeleton" aria-busy>{[60, 86, 48].map((w, i) => <i key={i} style={{ width: `${w}%` }} />)}</div>
      )}
    </div>
  );
}
