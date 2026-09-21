"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { RunGate } from "../../../../components/WorkflowContextPanel";
import { WorkflowRunNodes } from "../../../../components/WorkflowRunNodes";
import { formatRunDuration, runNodeCounts, runNodeRows } from "../../../../lib/workflowRun";
import { useMutation } from "convex/react";
import { useWorkflow, useWorkflowRun } from "../../../../hooks/useSyncWorkflows";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../../../components/AuthGuard";
import { AppLoader } from "../../../../components/AppLoader";
import { DashboardLayout } from "../../../../components/DashboardLayout";
import {
  Clock, CheckCircle, XCircle, Loader2, Pause, ExternalLink,
  Timer, AlertCircle, ChevronLeft, User,
} from "lucide-react";
import { useTitlebarHead } from "../../../../hooks/useTitlebarHead";

const api = _api as any;

interface WorkflowRun {
  _id: string;
  workflow_id?: string;
  workflow_name?: string;
  status: "pending" | "running" | "paused" | "completed" | "failed";
  current_node_id?: string;
  node_statuses: any[];
  primary_session_id?: string;
  goal_override?: string;
  gate_prompt?: string;
  gate_decision_id?: string;
  gate_decision_short_id?: string;
  gate_choices?: Array<{ key: string; label: string; target: string }>;
  gate_response?: string;
  fail_reason?: string;
  created_at: number;
  updated_at: number;
}

interface Workflow {
  _id: string;
  name: string;
  slug: string;
  goal?: string;
  nodes: any[];
}

const STATUS_STYLES: Record<string, { icon: React.ComponentType<{ className?: string }>; color: string; bg: string }> = {
  pending:   { icon: Clock,        color: "text-sol-text-dim",   bg: "bg-sol-text-dim/10" },
  running:   { icon: Loader2,      color: "text-sol-cyan",       bg: "bg-sol-cyan/10" },
  paused:    { icon: Pause,        color: "text-sol-yellow",     bg: "bg-sol-yellow/10" },
  completed: { icon: CheckCircle,  color: "text-sol-green",      bg: "bg-sol-green/10" },
  failed:    { icon: XCircle,      color: "text-sol-red",        bg: "bg-sol-red/10" },
};

function RunDetailContent({ runId }: { runId: string }) {
  // Store-fed (hooks/useSyncWorkflows): the run and its workflow paint from
  // the cache; the feeders keep them fresh.
  const run = useWorkflowRun(runId) as WorkflowRun | null | undefined;
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  const workflow = useWorkflow(run?.workflow_id) as Workflow | null | undefined;

  const respondToGate = useMutation(api.workflow_runs.respondToGate);
  const [gateText, setGateText] = useState("");
  const [responding, setResponding] = useState(false);

  const handleGateResponse = async (text: string) => {
    if (!text.trim()) return;
    setResponding(true);
    await respondToGate({ id: runId as any, response: text.trim() });
    setResponding(false);
    setGateText("");
  };

  // A run started from a shipped template stores no workflow row (the-line.md
  // L9): only wait for the graph when the run names one.
  if (run === undefined || (run?.workflow_id && workflow === undefined)) {
    return <AppLoader className="min-h-[16rem] h-full" />;
  }

  if (run === null) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <p className="text-sol-text-muted text-sm">Run not found</p>
        <Link href="/workflows" className="text-xs text-sol-cyan hover:underline">Back to workflows</Link>
      </div>
    );
  }

  const st = STATUS_STYLES[run.status] || STATUS_STYLES.pending;
  const StatusIcon = st.icon;
  const isActive = run.status === "running" || run.status === "paused";
  const duration = formatRunDuration(run.created_at, isActive ? undefined : run.updated_at);
  const counts = runNodeCounts(runNodeRows(run, workflow));

  return (
    <div className="flex flex-col h-full overflow-hidden bg-sol-bg">
      <div ref={titlebarRef} className="flex items-center gap-3 px-5 py-3 border-b border-sol-border/20 bg-sol-bg-alt flex-shrink-0">
        <Link href="/workflows" className="text-sol-text-dim hover:text-sol-text transition-colors">
          <ChevronLeft className="w-4 h-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-sol-text">
              {workflow?.name ?? run.workflow_name ?? "run"}
            </span>
            <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${st.color} ${st.bg}`}>
              <StatusIcon className={`w-3 h-3 ${run.status === "running" ? "animate-spin" : ""}`} />
              {run.status}
            </span>
            <span className="flex items-center gap-1 text-xs text-sol-text-dim">
              <Timer className="w-3 h-3" />
              {duration}
            </span>
          </div>
          {run.goal_override && (
            <p className="text-xs text-sol-text-dim mt-0.5 truncate">{run.goal_override}</p>
          )}
        </div>
        <span className="text-[10px] text-sol-text-dim font-mono flex-shrink-0">{run._id.slice(-12)}</span>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {run.fail_reason && (
          <div className="flex items-start gap-2 px-4 py-3 bg-sol-red/8 border border-sol-red/20 rounded-xl">
            <AlertCircle className="w-4 h-4 text-sol-red flex-shrink-0 mt-0.5" />
            <div>
              <div className="text-[10px] text-sol-red uppercase tracking-wider font-semibold mb-0.5">Failure reason</div>
              <p className="text-sm text-sol-red/80">{run.fail_reason}</p>
            </div>
          </div>
        )}

        {run.status === "paused" && run.gate_decision_id && (
          <RunGate run={run} className="rounded-xl border border-sol-yellow/30 bg-sol-yellow/5 p-3" />
        )}

        {run.status === "paused" && run.gate_prompt && !run.gate_decision_id && (
          <div className="border border-sol-magenta/25 bg-sol-magenta/5 rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-sol-magenta/20 flex items-center gap-2">
              <User className="w-3.5 h-3.5 text-sol-magenta" />
              <span className="text-[10px] text-sol-magenta uppercase tracking-widest font-semibold">Human Gate — awaiting response</span>
            </div>
            <div className="px-4 py-3 space-y-3">
              <p className="text-sm text-sol-text">{run.gate_prompt}</p>
              {run.gate_choices && run.gate_choices.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {run.gate_choices.map(choice => (
                    <button
                      key={choice.key}
                      onClick={() => handleGateResponse(choice.key)}
                      disabled={responding}
                      className="px-3 py-1.5 text-xs font-medium text-sol-text border border-sol-border/30 rounded-lg hover:bg-sol-bg-highlight hover:border-sol-magenta/40 transition-colors disabled:opacity-50"
                    >
                      <span className="font-mono text-sol-magenta mr-1">[{choice.key}]</span>
                      {choice.label.replace(/^\[.\]\s*/, "")}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex gap-2 items-end">
                <textarea
                  value={gateText}
                  onChange={e => setGateText(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleGateResponse(gateText); } }}
                  placeholder="Type your response… (⌘↵ to send)"
                  rows={3}
                  disabled={responding}
                  className="flex-1 px-3 py-2 text-sm bg-sol-bg border border-sol-border/40 rounded-lg text-sol-text placeholder-sol-text-dim/50 focus:outline-none focus:border-sol-magenta/50 resize-none disabled:opacity-50"
                />
                <button
                  onClick={() => handleGateResponse(gateText)}
                  disabled={responding || !gateText.trim()}
                  className="px-3 py-2 text-xs font-medium text-sol-magenta border border-sol-magenta/30 rounded-lg hover:bg-sol-magenta/10 transition-colors disabled:opacity-40 whitespace-nowrap"
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        )}

        {run.gate_response && run.status !== "paused" && (
          <div className="border border-sol-border/20 bg-sol-bg-alt rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-sol-border/15">
              <span className="text-[10px] text-sol-text-dim uppercase tracking-widest font-semibold">Gate Response</span>
            </div>
            <div className="px-4 py-3">
              <p className="text-sm text-sol-text-muted">{run.gate_response}</p>
            </div>
          </div>
        )}

        <div className="border border-sol-border/20 bg-sol-bg-alt rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-sol-border/15 flex items-center gap-3">
            <span className="text-[10px] text-sol-text-dim uppercase tracking-widest font-semibold">Steps</span>
            <span className="ml-auto text-[10px] text-sol-text-dim tabular-nums">{counts.done}/{counts.total} done</span>
            {counts.running > 0 && <span className="text-[10px] text-sol-green tabular-nums">{counts.running} live</span>}
            {counts.failed > 0 && <span className="text-[10px] text-sol-red tabular-nums">{counts.failed} failed</span>}
            {counts.sessions > 0 && <span className="text-[10px] text-sol-text-dim tabular-nums">{counts.sessions} session{counts.sessions === 1 ? "" : "s"}</span>}
          </div>
          <WorkflowRunNodes run={run} workflow={workflow} className="p-2 space-y-2" />
        </div>

        <div className="flex items-center justify-between text-[10px] text-sol-text-dim font-mono pb-2">
          <span>started {new Date(run.created_at).toLocaleString()}</span>
          {run.primary_session_id && (
            <Link href={`/conversation/${run.primary_session_id}`} className="flex items-center gap-1 hover:text-sol-cyan transition-colors">
              <ExternalLink className="w-3 h-3" />
              primary session
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

export default function WorkflowRunPage() {
  const params = useParams<{ id: string }>();
  const id = params.id!;
  return (
    <AuthGuard>
      <DashboardLayout>
        <RunDetailContent runId={id} />
      </DashboardLayout>
    </AuthGuard>
  );
}
