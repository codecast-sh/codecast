"use client";
// A run's own session is its log (is_workflow_primary): while the run lives
// the composer answers its gates, and once the run has ended nothing reads
// what is typed there. So an ended run's log shows how the run ended and
// where its record lives (the run, its trace, its decisions) in place of a
// composer that talks to nobody. Decisions are discussed on the decision
// itself, with the session that owns it (decisionDiscussion.ts).
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { RunOutcomeText } from "../line/RunReport";
import { decisionHref, runHref } from "../../lib/decisionLinks";
import { lineTraceHref } from "../../lib/line/lineMapUrl";
import type { ReportRun } from "../../lib/line/runReport";

const ENDED = new Set(["completed", "failed", "cancelled"]);

/** Whether a session is an ended run's log: the composer gives way to the bar.
 *  Only the log the run created (session `wf-<runId>`) has no agent behind it.
 *  A real session that hosted the run is also stamped is_workflow_primary, and
 *  its agent still reads what is typed there, so it keeps its composer. */
export function isEndedRunLog(conversation: { is_workflow_primary?: boolean; session_id?: string } | null | undefined, run: { _id?: string; status?: string } | null | undefined): boolean {
  return !!conversation?.is_workflow_primary && !!run?._id && conversation.session_id === `wf-${run._id}` && !!run.status && ENDED.has(run.status);
}

type RunDecision = { id: string; href: string; label: string; status: string };

// The run's decisions in the store, as a string signature so the bar wakes
// only when one of them changes.
function useRunDecisions(runId: string, gateDecisionId?: string, gateShortId?: string): RunDecision[] {
  const sig = useInboxStore((s) =>
    Object.values(s.sessionDecisions ?? {})
      .filter((d) => d.workflow_run_id === runId || (!!gateDecisionId && d._id === gateDecisionId))
      .sort((a, b) => a.created_at - b.created_at)
      .map((d) => `${d._id}\u0001${decisionHref(d)}\u0001${d.short_id ?? "decision"}\u0001${d.status}`)
      .join("\u0002"),
  );
  const rows: RunDecision[] = sig ? sig.split("\u0002").map((r) => { const [id, href, label, status] = r.split("\u0001"); return { id, href, label, status }; }) : [];
  // The run's last gate, when this device holds no row for it (asked of someone else).
  if (gateDecisionId && !rows.some((r) => r.id === gateDecisionId)) rows.push({ id: gateDecisionId, href: `/decisions/${gateShortId ?? gateDecisionId}`, label: gateShortId ?? "Its last decision", status: "" });
  return rows;
}

const chip = "inline-flex items-center gap-0.5 rounded-md border border-sol-border/50 px-2 py-0.5 text-[11.5px] text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt transition-colors";

export function RunLogEndedBar({ run }: { run: ReportRun & { gate_decision_id?: string } }) {
  const decisions = useRunDecisions(run._id, run.gate_decision_id, run.gate_decision_short_id);
  return (
    <div className="border-t border-sol-border/40 bg-sol-bg px-4 py-3" data-run-log-ended>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px]">
        <span className="text-sol-text-dim">This run has ended.</span>
        <RunOutcomeText run={run} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Link href={runHref(run._id)} className={chip}>Open the run<ArrowUpRight className="h-3 w-3" /></Link>
        {run.task_id && <Link href={lineTraceHref(run._id)} className={chip} title="Follow its cause through the line, step by step">Trace<ArrowUpRight className="h-3 w-3" /></Link>}
        {decisions.map((d) => (
          <Link key={d.id} href={d.href} className={chip} title="Open the decision; discuss it there with the session that owns it">
            {d.label}{d.status && d.status !== "pending" ? <span className="text-sol-text-dim"> · {d.status}</span> : null}
          </Link>
        ))}
      </div>
      <p className="mt-2 text-[12px] text-sol-text-dim">Nothing reads messages here now. To ask about a decision, open it and use Discuss.</p>
    </div>
  );
}
