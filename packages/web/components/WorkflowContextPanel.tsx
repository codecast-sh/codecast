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
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
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
  // Same default as PlanContextPanel: the header already carries the run in
  // aggregate, the session rows come on a click.
  const [expanded, setExpanded] = useState(false);
  const now = useCoarseNow(30_000);
  // A gate is a decision (the-line.md L4, L10): the panel renders the
  // decision card for the run's gate_decision_id, never its own buttons.
  // The row rides the sessionDecisions collection; until it lands, a link.
  if (!run) return null;

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
    <div data-cc-context-panel className="border-b border-sol-border/30 bg-sol-bg-alt/20">
      <div className="flex items-center gap-1 pr-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="min-w-0 flex-1 flex items-center gap-2 px-4 py-2 text-xs hover:bg-sol-bg-alt/40 transition-colors"
        >
          <GitBranch className="w-3.5 h-3.5 text-sol-violet flex-shrink-0" />
          <span className="font-medium text-sol-violet truncate">{name}</span>
          <span className={`text-[10px] font-medium ${statusColor} flex-shrink-0`}>
            {run.status === "paused" ? (
              <span className="flex items-center gap-1"><Pause className="w-2.5 h-2.5" /> gate</span>
            ) : run.status}
          </span>
          {current && (
            <span className="min-w-0 truncate text-[10px] text-sol-text-muted" title={`At step ${current.label}`}>
              · {current.label}
            </span>
          )}
          <div className="flex items-center gap-1.5 ml-auto flex-shrink-0">
            {counts.running > 0 && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-sol-green/15 text-sol-green text-[10px]">
                <LivePulseDot className="w-1.5 h-1.5" />
                {counts.running} live
              </span>
            )}
            {counts.failed > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-sol-red/10 text-sol-red text-[10px]">{counts.failed} failed</span>
            )}
            <div className="w-12 h-1.5 rounded-full bg-sol-bg-highlight overflow-hidden">
              <div
                className="h-full rounded-full bg-sol-violet transition-all"
                style={{ width: counts.total > 0 ? `${(counts.done / counts.total) * 100}%` : "0%" }}
              />
            </div>
            <span className="text-sol-text-dim tabular-nums">{counts.done}/{counts.total}</span>
            {counts.sessions > 0 && (
              <span className="text-sol-text-dim/70 tabular-nums">{counts.sessions} session{counts.sessions === 1 ? "" : "s"}</span>
            )}
            {age && <span className="text-sol-text-dim/70 tabular-nums">{age}</span>}
            {expanded ? <ChevronDown className="w-3 h-3 text-sol-text-dim" /> : <ChevronRight className="w-3 h-3 text-sol-text-dim" />}
          </div>
        </button>
        <Link
          href={runHref}
          className="p-1 rounded text-sol-text-dim hover:text-sol-violet hover:bg-sol-bg-alt transition-colors flex-shrink-0"
          title="Open the run"
          aria-label="Open the run"
        >
          <ExternalLink className="w-3 h-3" />
        </Link>
      </div>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
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
