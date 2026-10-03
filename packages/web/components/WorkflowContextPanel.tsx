import { useWorkflow, useWorkflowRun } from "../hooks/useSyncWorkflows";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import Link from "next/link";
import { useState } from "react";
import { useTrackedStore } from "../store/inboxStore";
import { DecisionCompactCard } from "./decisions/DecisionCompactCard";
import { useSyncDecisionDetail } from "../hooks/useSyncDecisionDetail";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { compactAge } from "../lib/threadState";
import { runNodeCounts, runNodeRows } from "../lib/workflowRun";
import { WorkflowRunNodes } from "./WorkflowRunNodes";
import { LivePulseDot } from "./SessionActivityLine";
import { RailChip, RailDetail } from "./ContextRail";
import {
  GitBranch,
  Pause,
} from "lucide-react";

const STATUS_COLOR: Record<string, string> = {
  pending: "text-sol-text-dim",
  running: "text-sol-yellow",
  paused: "text-sol-orange",
  completed: "text-sol-green",
  failed: "text-sol-red",
};

export function WorkflowContextPanel({ workflowRunId }: { workflowRunId: Id<"workflow_runs"> }) {
  // Store-fed (hooks/useSyncWorkflows): paints from cached rows on the first
  // frame instead of popping in a round-trip late.
  const run = useWorkflowRun(workflowRunId);
  const workflow = useWorkflow(run?.workflow_id);
  if (!run) return null;
  return <WorkflowRunPanel run={run} workflow={workflow} />;
}

/** One run as the context panel draws it, from the rows it is given (the
 *  marketing hero passes fixtures). */
export function WorkflowRunPanel({ run, workflow, defaultExpanded = false }: { run: any; workflow?: any | null; defaultExpanded?: boolean }) {
  // Same default as PlanContextPanel: the header already carries the run in
  // aggregate, the session rows come on a click.
  const [expanded, setExpanded] = useState(defaultExpanded);
  const now = useCoarseNow(30_000);
  // A gate is a decision (the-line.md L4, L10): the panel renders the
  // decision card for the run's gate_decision_id, never its own buttons.
  // The row rides the sessionDecisions collection; until it lands, a link.

  const statusColor = STATUS_COLOR[run.status] || "text-sol-text-dim";
  // A run the sweep started from a shipped template has no stored graph
  // (L9): its node statuses are the node list then.
  const rows = runNodeRows(run, workflow);
  const counts = runNodeCounts(rows);
  const name = workflow?.name ?? run.workflow_name ?? "run";
  const alive = run.status === "running" || run.status === "paused" || run.status === "pending";
  const current = alive ? rows.find((r) => r.current) : undefined;
  const age = run.updated_at ? compactAge(now - run.updated_at) : null;
  const runHref = `/workflows/runs/${run._id}`;

  return (
    <div data-cc-context-panel className="contents">
      <RailChip data-cc-rail-item="workflow" open={expanded} onToggle={() => setExpanded(!expanded)} title={`${name} · ${run.status}${current ? ` · at ${current.label}` : ""}`}>
        <GitBranch className="w-3.5 h-3.5 text-sol-violet flex-shrink-0" />
        <span className="min-w-0 truncate font-medium text-sol-violet">{name}</span>
        {/* The step gives way before the name does. */}
        {current && <span className="min-w-0 truncate flex-shrink-[100] text-sol-text-dim">{current.label}</span>}
        {run.status === "paused" ? (
          <span className={`flex items-center gap-1 flex-shrink-0 ${statusColor}`}><Pause className="w-2.5 h-2.5" /> gate</span>
        ) : counts.running > 0 ? (
          <span className="flex items-center gap-1 flex-shrink-0 text-sol-green tabular-nums"><LivePulseDot className="w-1.5 h-1.5" />{counts.running}</span>
        ) : (
          <span className={`flex-shrink-0 ${statusColor}`}>{run.status}</span>
        )}
        {counts.failed > 0 && <span className="flex-shrink-0 text-sol-red tabular-nums">{counts.failed} failed</span>}
        <span className="text-sol-text-dim tabular-nums flex-shrink-0">{counts.done}/{counts.total}</span>
      </RailChip>

      {expanded && (
        <RailDetail data-cc-context-panel="">
        <div className="px-3 py-2 space-y-2">
          <div className="mx-1 flex items-center gap-2 text-xs">
            <span className="font-medium text-sol-text">{name}</span>
            <span className={statusColor}>{run.status}</span>
            {current && <span className="min-w-0 truncate text-sol-text-muted">at {current.label}</span>}
            <span className="ml-auto flex items-center gap-2 flex-shrink-0 text-sol-text-dim tabular-nums">
              {counts.sessions > 0 && <span>{counts.sessions} session{counts.sessions === 1 ? "" : "s"}</span>}
              {age && <span>{age}</span>}
            </span>
          </div>
          {run.fail_reason && (
            <p className="mx-1 text-[11px] text-sol-red bg-sol-red/10 rounded px-2 py-1 border border-sol-red/20">
              {run.fail_reason}
            </p>
          )}

          {run.status === "paused" && <RunGate run={run} className="mx-1 space-y-1.5" />}

          <WorkflowRunNodes run={run} workflow={workflow} />

          <Link
            href={runHref}
            className="block mx-1 text-[10px] text-sol-violet hover:underline pt-1"
          >
            Open the run
          </Link>
        </div>
        </RailDetail>
      )}
    </div>
  );
}

// A paused run's gate, one way everywhere (the-line.md L4, L10): the decision
// card for the run's gate_decision_id from the sessionDecisions store; a link
// to the decision page until the row lands; the stored prompt only for a run
// that predates gates as decisions.
export function RunGate({ run, className }: {
  run: { gate_decision_id?: string; gate_decision_short_id?: string; gate_prompt?: string; gate_response?: string };
  className?: string;
}) {
  const gateDecisionId = run.gate_decision_id;
  // The queue feed holds the row when the viewer was asked; the per view
  // detail feed brings it for anyone else who can read the run.
  useSyncDecisionDetail(gateDecisionId);
  const s = useTrackedStore([
    (st) => (gateDecisionId ? st.sessionDecisions[gateDecisionId] : undefined),
    (st) => (gateDecisionId ? (st as any).decisionDetails?.[gateDecisionId]?.decision : undefined),
  ]);
  const gateDecision = gateDecisionId ? (s.sessionDecisions[gateDecisionId] ?? (s as any).decisionDetails?.[gateDecisionId]?.decision) : undefined;
  return (
    <div className={className ?? "space-y-1.5"} data-run-gate={gateDecisionId ?? ""}>
      {gateDecision ? (
        <DecisionCompactCard decision={gateDecision} showTask={false} />
      ) : gateDecisionId ? (
        <Link
          href={`/decisions/${run.gate_decision_short_id ?? gateDecisionId}`}
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-sol-yellow/40 text-[11px] text-sol-text hover:bg-sol-yellow/10"
        >
          <Pause className="w-3 h-3 text-sol-orange" />
          Answer the gate{run.gate_decision_short_id ? ` · ${run.gate_decision_short_id}` : ""}
        </Link>
      ) : run.gate_prompt ? (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-sol-magenta font-semibold">Gate</span>
          <span className="text-[10px] text-sol-text-muted truncate flex-1">{run.gate_prompt}</span>
          {run.gate_response
            ? <span className="text-[10px] text-sol-green">Responded: {run.gate_response}</span>
            : <span className="text-[10px] text-sol-text-dim">· reply in the conversation</span>}
        </div>
      ) : null}
    </div>
  );
}
