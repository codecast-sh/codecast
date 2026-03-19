import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import Link from "next/link";
import { useState } from "react";
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

const api = _api as any;

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
  const run = useQuery(api.workflow_runs.get, { id: workflowRunId });
  const workflow = useQuery(
    api.workflows.webGet,
    run?.workflow_id ? { id: run.workflow_id } : "skip"
  );
  const respondToGate = useMutation(api.workflow_runs.respondToGate);
  const [expanded, setExpanded] = useState(true);
  const [responding, setResponding] = useState(false);

  if (!run || !workflow) return null;

  const statusColor = STATUS_COLOR[run.status] || "text-sol-text-dim";
  const doneCount = run.node_statuses.filter((n: any) => n.status === "completed").length;
  const totalNodes = workflow.nodes.length;

  const handleGateResponse = async (key: string) => {
    setResponding(true);
    try {
      await respondToGate({ id: workflowRunId, response: key });
    } finally {
      setResponding(false);
    }
  };

  return (
    <div className="border-b border-sol-border/30 bg-sol-bg-alt/20">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2 text-xs hover:bg-sol-bg-alt/40 transition-colors"
      >
        <GitBranch className="w-3.5 h-3.5 text-sol-violet flex-shrink-0" />
        <span className="font-medium text-sol-violet truncate">{workflow.name}</span>
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

          {run.status === "paused" && run.gate_prompt && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] text-sol-magenta font-semibold">Gate</span>
                <span className="text-[10px] text-sol-text-muted truncate flex-1">{run.gate_prompt}</span>
              </div>
              {!run.gate_response ? (
                <div className="flex flex-wrap gap-1">
                  {run.gate_choices?.map((choice: any) => (
                    <button
                      key={choice.key}
                      onClick={() => handleGateResponse(choice.key)}
                      disabled={responding}
                      className="px-1.5 py-0.5 rounded text-[10px] font-mono font-medium text-sol-magenta border border-sol-magenta/30 hover:bg-sol-magenta/10 transition-colors disabled:opacity-50"
                    >
                      [{choice.key}] {choice.label.replace(/^\[.\]\s*/, "")}
                    </button>
                  ))}
                  <span className="text-[10px] text-sol-text-dim">· reply in conversation</span>
                </div>
              ) : (
                <p className="text-[10px] text-sol-green">Responded: {run.gate_response}</p>
              )}
            </div>
          )}

          <div className="space-y-0.5">
            {workflow.nodes.map((node: any) => {
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
