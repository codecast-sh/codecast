import { useWorkflow, useWorkflowRun } from "../hooks/useSyncWorkflows";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import Link from "next/link";
import { useState } from "react";
import { useTrackedStore } from "../store/inboxStore";
import { DecisionCompactCard } from "./decisions/DecisionCompactCard";
import { useSyncDecisionDetail } from "../hooks/useSyncDecisionDetail";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  Circle,
  CircleDot,
  CheckCircle2,
  XCircle,
  Clock,
  Pause,
} from "lucide-react";

const STATUS_COLOR: Record<string, string> = {
  pending: "text-sol-text-dim",
  running: "text-sol-yellow",
  paused: "text-sol-orange",
  completed: "text-sol-green",
  failed: "text-sol-red",
};

const NODE_ICON: Record<string, any> = {
  pending: Circle,
  running: CircleDot,
  completed: CheckCircle2,
  failed: XCircle,
};

const NODE_COLOR: Record<string, string> = {
  pending: "text-sol-text-dim",
  running: "text-sol-yellow animate-pulse",
  completed: "text-sol-green",
  failed: "text-sol-red",
};

export function WorkflowContextPanel({ workflowRunId }: { workflowRunId: Id<"workflow_runs"> }) {
  // Store-fed (hooks/useSyncWorkflows): paints from cached rows on the first
  // frame instead of popping in a round-trip late.
  const run = useWorkflowRun(workflowRunId);
  const workflow = useWorkflow(run?.workflow_id);
  // Same default as PlanContextPanel — header already has name, status, progress.
  const [expanded, setExpanded] = useState(false);
  // A gate is a decision (the-line.md L4, L10): the panel renders the
  // decision card for the run's gate_decision_id, never its own buttons.
  // The row rides the sessionDecisions collection; until it lands, a link.
  if (!run) return null;

  const statusColor = STATUS_COLOR[run.status] || "text-sol-text-dim";
  const doneCount = run.node_statuses.filter((n: any) => n.status === "completed").length;
  // A run the sweep started from a shipped template has no stored graph
  // (L9): its node statuses are the node list then.
  const nodes: Array<{ id: string; label: string }> = workflow?.nodes ?? run.node_statuses.map((n: any) => ({ id: n.node_id, label: n.label ?? n.node_id }));
  const totalNodes = nodes.length;
  const name = workflow?.name ?? run.workflow_name ?? "run";

  return (
    <div data-cc-context-panel className="border-b border-sol-border/30 bg-sol-bg-alt/20">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2 text-xs hover:bg-sol-bg-alt/40 transition-colors"
      >
        <GitBranch className="w-3.5 h-3.5 text-sol-violet flex-shrink-0" />
        <span className="font-medium text-sol-violet truncate">{name}</span>
        <span className={`text-[10px] font-medium ml-1 ${statusColor}`}>
          {run.status === "paused" ? (
            <span className="flex items-center gap-1"><Pause className="w-2.5 h-2.5" /> gate</span>
          ) : run.status}
        </span>
        <div className="flex items-center gap-1.5 ml-auto">
          <div className="w-12 h-1.5 rounded-full bg-sol-bg-highlight overflow-hidden">
            <div
              className="h-full rounded-full bg-sol-violet transition-all"
              style={{ width: totalNodes > 0 ? `${(doneCount / totalNodes) * 100}%` : "0%" }}
            />
          </div>
          <span className="text-sol-text-dim">{doneCount}/{totalNodes}</span>
          {expanded ? <ChevronDown className="w-3 h-3 text-sol-text-dim" /> : <ChevronRight className="w-3 h-3 text-sol-text-dim" />}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          {run.fail_reason && (
            <p className="text-[11px] text-sol-red bg-sol-red/10 rounded px-2 py-1 border border-sol-red/20">
              {run.fail_reason}
            </p>
          )}

          {run.status === "paused" && <RunGate run={run} />}

          <div className="space-y-0.5">
            {nodes.map((node: any) => {
              const nodeStatus = run.node_statuses.find((n: any) => n.node_id === node.id);
              const status = nodeStatus?.status || "pending";
              const Icon = NODE_ICON[status] || Circle;
              const color = NODE_COLOR[status] || "text-sol-text-dim";
              const isCurrent = run.current_node_id === node.id;

              return (
                <div
                  key={node.id}
                  className={`flex items-center gap-2 py-0.5 px-1.5 rounded text-xs ${isCurrent ? "bg-sol-bg-alt/50" : ""}`}
                >
                  <Icon className={`w-3 h-3 flex-shrink-0 ${color}`} />
                  <span className={`truncate ${status === "completed" ? "line-through text-sol-text-dim" : status === "failed" ? "text-sol-red" : isCurrent ? "text-sol-text" : "text-sol-text-muted"}`}>
                    {node.label}
                  </span>
                  {nodeStatus?.session_id && status !== "completed" && (
                    <Link
                      href={`/conversation/${nodeStatus.session_id}`}
                      className="ml-auto text-[10px] text-sol-cyan hover:underline flex-shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      view
                    </Link>
                  )}
                  {status === "running" && (
                    <Clock className="w-2.5 h-2.5 text-sol-yellow ml-auto animate-spin" />
                  )}
                </div>
              );
            })}
          </div>

          <Link
            href={`/workflows`}
            className="block text-[10px] text-sol-violet hover:underline pt-1"
          >
            View workflow run
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
