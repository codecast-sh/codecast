"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../../../components/AuthGuard";
import { DashboardLayout } from "../../../../components/DashboardLayout";
import {
  Bot, Terminal, User, Zap, GitFork, Merge, GitBranch,
  Clock, CheckCircle, XCircle, Loader2, Pause, ExternalLink,
  Timer, AlertCircle, ChevronLeft,
} from "lucide-react";

const api = _api as any;

interface NodeStatus {
  node_id: string;
  status: "pending" | "running" | "completed" | "failed";
  outcome?: string;
  session_id?: string;
  started_at?: number;
  completed_at?: number;
}

interface WorkflowRun {
  _id: string;
  workflow_id: string;
  status: "pending" | "running" | "paused" | "completed" | "failed";
  current_node_id?: string;
  node_statuses: NodeStatus[];
  primary_session_id?: string;
  goal_override?: string;
  gate_prompt?: string;
  gate_choices?: Array<{ key: string; label: string; target: string }>;
  gate_response?: string;
  fail_reason?: string;
  created_at: number;
  updated_at: number;
}

interface WFNode {
  id: string;
  label: string;
  type: string;
  prompt?: string;
  script?: string;
}

interface Workflow {
  _id: string;
  name: string;
  slug: string;
  goal?: string;
  nodes: WFNode[];
}

const TYPE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  agent: Bot,
  prompt: Zap,
  command: Terminal,
  human: User,
  conditional: GitFork,
  parallel_fanout: GitFork,
  parallel_fanin: Merge,
  start: GitBranch,
  exit: GitBranch,
};

const STATUS_STYLES: Record<string, { icon: React.ComponentType<{ className?: string }>; color: string; bg: string }> = {
  pending:   { icon: Clock,        color: "text-sol-text-dim",   bg: "bg-sol-text-dim/10" },
  running:   { icon: Loader2,      color: "text-sol-cyan",       bg: "bg-sol-cyan/10" },
  paused:    { icon: Pause,        color: "text-sol-yellow",     bg: "bg-sol-yellow/10" },
  completed: { icon: CheckCircle,  color: "text-sol-green",      bg: "bg-sol-green/10" },
  failed:    { icon: XCircle,      color: "text-sol-red",        bg: "bg-sol-red/10" },
};

function formatDuration(startMs: number, endMs?: number): string {
  const ms = (endMs ?? Date.now()) - startMs;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function RunDetailContent({ runId }: { runId: string }) {
  const run = useQuery(api.workflow_runs.get, { id: runId }) as WorkflowRun | null | undefined;
  const workflow = useQuery(
    api.workflows.webGet,
    run ? { id: run.workflow_id } : "skip"
  ) as Workflow | null | undefined;

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

  if (run === undefined || workflow === undefined) {
    return (
      <div className="flex items-center justify-center h-full text-sol-text-dim text-sm">
        Loading...
      </div>
    );
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
  const duration = formatDuration(run.created_at, isActive ? undefined : run.updated_at);

  const displayNodes = workflow?.nodes.filter(n => n.type !== "start" && n.type !== "exit") ?? [];

  return (
    <div className="flex flex-col h-full overflow-hidden bg-sol-bg">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-sol-border/20 bg-sol-bg-alt flex-shrink-0">
        <Link href="/workflows" className="text-sol-text-dim hover:text-sol-text transition-colors">
          <ChevronLeft className="w-4 h-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-sol-text">
              {workflow?.name ?? "..."}
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

        {run.status === "paused" && run.gate_prompt && (
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
          <div className="px-4 py-2.5 border-b border-sol-border/15 flex items-center justify-between">
            <span className="text-[10px] text-sol-text-dim uppercase tracking-widest font-semibold">Stage Timeline</span>
            <span className="text-[10px] text-sol-text-dim">{displayNodes.length} stages</span>
          </div>
          <div className="divide-y divide-sol-border/10">
            {displayNodes.map((node) => {
              const ns = run.node_statuses.find(s => s.node_id === node.id);
              const isCurrentNode = run.current_node_id === node.id && run.status === "running";
              const NodeIcon = TYPE_ICONS[node.type] || Bot;

              let statusIcon = null;
              let statusColor = "text-sol-text-dim/40";

              if (ns?.status === "completed") {
                statusIcon = <CheckCircle className="w-4 h-4 text-sol-green/80" />;
                statusColor = "text-sol-green/80";
              } else if (ns?.status === "failed") {
                statusIcon = <XCircle className="w-4 h-4 text-sol-red/80" />;
                statusColor = "text-sol-red/80";
              } else if (ns?.status === "running" || isCurrentNode) {
                statusIcon = <Loader2 className="w-4 h-4 text-sol-cyan animate-spin" />;
                statusColor = "text-sol-cyan";
              } else {
                statusIcon = <div className="w-2.5 h-2.5 rounded-full bg-sol-border/30 mx-[3px]" />;
              }

              const nodeDuration = ns?.started_at ? formatDuration(ns.started_at, ns.completed_at) : null;

              return (
                <div
                  key={node.id}
                  className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                    isCurrentNode ? "bg-sol-cyan/5 border-l-2 border-l-sol-cyan" :
                    ns?.status === "failed" ? "bg-sol-red/4 border-l-2 border-l-sol-red/30" :
                    ns?.status === "completed" ? "border-l-2 border-l-sol-green/20" :
                    "border-l-2 border-l-transparent"
                  }`}
                >
                  <div className="flex-shrink-0 w-5 flex items-center justify-center">
                    {statusIcon}
                  </div>
                  <NodeIcon className={`w-3.5 h-3.5 flex-shrink-0 ${statusColor}`} />
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm ${ns ? "text-sol-text" : "text-sol-text-dim/60"} ${isCurrentNode ? "font-medium" : ""}`}>
                      {node.label}
                    </div>
                    {nodeDuration && (
                      <div className="flex items-center gap-1 mt-0.5">
                        <Timer className="w-2.5 h-2.5 text-sol-text-dim/50" />
                        <span className="text-[10px] text-sol-text-dim tabular-nums">{nodeDuration}</span>
                      </div>
                    )}
                  </div>
                  {ns?.session_id && (
                    <Link
                      href={`/conversation/${ns.session_id}`}
                      className="flex-shrink-0 flex items-center gap-1 text-[10px] text-sol-text-dim hover:text-sol-cyan transition-colors"
                      title="View session"
                    >
                      <ExternalLink className="w-3 h-3" />
                      session
                    </Link>
                  )}
                </div>
              );
            })}
            {displayNodes.length === 0 && (
              <div className="px-4 py-4 text-xs text-sol-text-dim text-center">No stages</div>
            )}
          </div>
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
