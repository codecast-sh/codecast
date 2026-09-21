"use client";

import { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation } from "convex/react";
import { useSyncWorkflowRuns, useWorkflowRun, useWorkflowRuns, useWorkflows } from "../../hooks/useSyncWorkflows";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../components/AuthGuard";
import { AppLoader } from "../../components/AppLoader";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ContextChatInput } from "../../components/ContextChatInput";
import { WorkflowGraphView, type WFNode, type WFEdge } from "../../components/WorkflowGraphView";
import { GitBranch, Clock, ChevronRight, X, Terminal, Bot, User, Zap, GitFork, Merge, Play, Pause, CheckCircle, XCircle, Loader2, ExternalLink, Square, Timer, AlertCircle, CheckSquare, ListChecks, MessageCircleQuestionMark, Workflow } from "lucide-react";
import { useTitlebarHead } from "../../hooks/useTitlebarHead";
import { useSyncRuns, useWorkspaceRuns, type LineRun } from "../../hooks/useSyncRuns";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useTrackedStore } from "../../store/inboxStore";
import { DecisionCompactCard } from "../../components/decisions/DecisionCompactCard";
import { useSyncDecisionDetail } from "../../hooks/useSyncDecisionDetail";
import { RunGate } from "../../components/WorkflowContextPanel";
import { WorkflowRunNodes } from "../../components/WorkflowRunNodes";
import { runNodeCounts, runNodeRows } from "../../lib/workflowRun";
import { compactAge } from "../../lib/threadState";
import { cn } from "../../lib/utils";
import { WorkflowsDashboardContent } from "./dashboard";

const api = _api as any;

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
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

interface Workflow {
  _id: string;
  name: string;
  slug: string;
  goal?: string;
  nodes: WFNode[];
  edges: WFEdge[];
  model_stylesheet?: string;
  created_at: number;
  updated_at: number;
}

interface WorkflowRun {
  _id: string;
  workflow_id: string;
  status: "pending" | "running" | "paused" | "completed" | "failed";
  current_node_id?: string;
  node_statuses: Array<{
    node_id: string;
    status: "pending" | "running" | "completed" | "failed";
    outcome?: string;
    session_id?: string;
    started_at?: number;
    completed_at?: number;
  }>;
  primary_session_id?: string;
  goal_override?: string;
  gate_prompt?: string;
  gate_choices?: Array<{ key: string; label: string; target: string }>;
  gate_response?: string;
  // the-line.md L4: the gate is a decision; the panel renders its card.
  gate_decision_id?: string;
  gate_decision_short_id?: string;
  fail_reason?: string;
  created_at: number;
  updated_at: number;
}

const TYPE_BADGE: Record<string, string> = {
  agent:           "text-[#93a1a1] bg-[#073642] dark:text-[#94a3b8] dark:bg-[#1e293b]",
  prompt:          "text-[#6c71c4] bg-[#1e1b4b]/30 dark:text-[#a5b4fc] dark:bg-[#1e1b4b]",
  command:         "text-[#859900] bg-[#1a2008]/30 dark:text-[#86efac] dark:bg-[#0f1f10]",
  human:           "text-[#d33682] bg-[#3a0820]/20 dark:text-[#d8b4fe] dark:bg-[#1e0b3a]",
  conditional:     "text-[#b58900] bg-[#2d2000]/20 dark:text-[#fcd34d] dark:bg-[#1c1500]",
  start:           "text-[#268bd2] bg-[#0a1e3a]/20 dark:text-[#93c5fd] dark:bg-[#0c1e3a]",
  exit:            "text-[#268bd2] bg-[#0a1e3a]/20 dark:text-[#93c5fd] dark:bg-[#0c1e3a]",
};

const STATUS_STYLES: Record<string, { icon: React.ComponentType<{ className?: string }>; color: string }> = {
  pending:   { icon: Clock,       color: "text-sol-text-dim" },
  running:   { icon: Loader2,     color: "text-sol-cyan" },
  paused:    { icon: Pause,       color: "text-sol-yellow" },
  completed: { icon: CheckCircle, color: "text-sol-green" },
  failed:    { icon: XCircle,     color: "text-sol-red" },
};

function NodeDetail({ node, onClose }: { node: WFNode; onClose: () => void }) {
  const Icon = TYPE_ICONS[node.type] || Bot;
  const badgeClass = TYPE_BADGE[node.type] || TYPE_BADGE.agent;

  return (
    <div className="absolute bottom-4 right-4 w-80 bg-sol-bg-alt border border-sol-border/40 rounded-xl shadow-2xl z-10 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-sol-border/30">
        <div className="flex items-center gap-2">
          <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-mono ${badgeClass}`}>
            <Icon className="w-3 h-3" />
            {node.type}
          </span>
          {node.goal_gate && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-[#78350f]/30 text-sol-yellow font-mono">goal-gate</span>
          )}
        </div>
        <button onClick={onClose} className="text-sol-text-dim hover:text-sol-text transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="p-4 space-y-3 max-h-72 overflow-y-auto">
        <div>
          <div className="text-[10px] text-sol-text-dim font-mono mb-0.5">{node.id}</div>
          <div className="text-sm font-semibold text-sol-text">{node.label}</div>
        </div>

        {(node.max_visits !== undefined || node.retry_target || node.model || node.reasoning_effort) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {node.max_visits !== undefined && (
              <div className="text-xs text-sol-text-dim">max_visits <span className="text-sol-text-muted">{node.max_visits}</span></div>
            )}
            {node.retry_target && (
              <div className="text-xs text-sol-text-dim">{"retry \u2192 "}<span className="text-sol-text-muted font-mono">{node.retry_target}</span></div>
            )}
            {node.model && (
              <div className="text-xs text-sol-text-dim">model <span className="text-sol-text-muted font-mono">{node.model.split("-").slice(-2).join("-")}</span></div>
            )}
            {node.reasoning_effort && (
              <div className="text-xs text-sol-text-dim">effort <span className="text-sol-text-muted">{node.reasoning_effort}</span></div>
            )}
          </div>
        )}

        {node.prompt && (
          <div className="space-y-1">
            <div className="text-[10px] text-sol-text-dim uppercase tracking-wider">Prompt</div>
            <div className="text-xs text-sol-text-muted bg-sol-bg rounded-lg p-3 max-h-40 overflow-y-auto leading-relaxed whitespace-pre-wrap font-mono">
              {node.prompt}
            </div>
          </div>
        )}

        {node.script && (
          <div className="space-y-1">
            <div className="text-[10px] text-sol-text-dim uppercase tracking-wider">Script</div>
            <div className="text-xs text-sol-green bg-sol-bg rounded-lg p-3 max-h-40 overflow-y-auto leading-relaxed whitespace-pre-wrap font-mono">
              {node.script}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function RunDialog({ workflowId, onClose }: { workflowId: string; onClose: () => void }) {
  const [goalOverride, setGoalOverride] = useState("");
  const [projectPath, setProjectPath] = useState(() => {
    try { return localStorage.getItem("wf_last_project_path") || ""; } catch { return ""; }
  });
  const createRun = useMutation(api.workflow_runs.create);
  const [running, setRunning] = useState(false);

  const handleRun = async () => {
    setRunning(true);
    if (projectPath) {
      try { localStorage.setItem("wf_last_project_path", projectPath); } catch {}
    }
    await createRun({
      workflow_id: workflowId,
      goal_override: goalOverride || undefined,
      project_path: projectPath || undefined,
    });
    setRunning(false);
    onClose();
  };

  return (
    <div className="absolute top-12 right-4 z-20 w-80 bg-sol-bg-alt border border-sol-border/40 rounded-xl shadow-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-sol-border/30">
        <span className="text-xs font-semibold text-sol-text uppercase tracking-wider">Run Workflow</span>
      </div>
      <div className="p-4 space-y-3">
        <div>
          <label className="text-[10px] text-sol-text-dim uppercase tracking-wider block mb-1">Project path</label>
          <input
            type="text"
            value={projectPath}
            onChange={e => setProjectPath(e.target.value)}
            placeholder="/Users/you/src/myproject"
            className="w-full px-3 py-1.5 text-xs bg-sol-bg border border-sol-border/30 rounded-lg text-sol-text placeholder-sol-text-dim focus:outline-none focus:border-sol-cyan/50 font-mono"
          />
        </div>
        <div>
          <label className="text-[10px] text-sol-text-dim uppercase tracking-wider block mb-1">Goal override (optional)</label>
          <input
            type="text"
            value={goalOverride}
            onChange={e => setGoalOverride(e.target.value)}
            placeholder="Override the workflow goal..."
            className="w-full px-3 py-1.5 text-xs bg-sol-bg border border-sol-border/30 rounded-lg text-sol-text placeholder-sol-text-dim focus:outline-none focus:border-sol-cyan/50"
          />
        </div>
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 px-3 py-1.5 text-xs text-sol-text-muted border border-sol-border/30 rounded-lg hover:bg-sol-bg-highlight transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleRun}
            disabled={running}
            className="flex-1 px-3 py-1.5 text-xs font-medium text-sol-bg bg-sol-cyan rounded-lg hover:bg-sol-cyan/80 transition-colors disabled:opacity-50 flex items-center justify-center gap-1"
          >
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            Run
          </button>
        </div>
      </div>
    </div>
  );
}


function formatDuration(startMs: number, endMs?: number): string {
  const ms = (endMs ?? Date.now()) - startMs;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function ActiveRunPanel({ run, workflow, onClose }: { run: WorkflowRun; workflow: Workflow; onClose: () => void }) {
  const respondToGate = useMutation(api.workflow_runs.respondToGate);
  const cancelRun = useMutation(api.workflow_runs.cancel);
  const [responding, setResponding] = useState(false);
  // The gate's decision row (the-line.md L4, L10): the queue feed holds it
  // when the viewer was asked; for anyone else the per view detail feed
  // brings it, so the panel renders the decision card and never its own
  // buttons for a decision gate. Subscribed by status only, so an unrelated
  // decision edit does not repaint.
  const gateId = run.gate_decision_id;

  const st = STATUS_STYLES[run.status] || STATUS_STYLES.pending;
  const StatusIcon = st.icon;

  const handleChoice = async (key: string) => {
    setResponding(true);
    await respondToGate({ id: run._id as any, response: key });
    setResponding(false);
  };

  const orderedNodes = workflow.nodes.filter(n => n.type !== "start" && n.type !== "exit");

  return (
    <div className="w-72 flex-shrink-0 border-l border-sol-border/20 flex flex-col bg-sol-bg-alt h-full overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-sol-border/20">
        <div className="flex items-center gap-2">
          <StatusIcon className={`w-3.5 h-3.5 flex-shrink-0 ${st.color} ${run.status === "running" ? "animate-spin" : ""}`} />
          <span className={`text-xs font-semibold capitalize ${st.color}`}>{run.status}</span>
          {(run.status === "running" || run.status === "completed" || run.status === "failed") && (
            <span className="text-[10px] text-sol-text-dim tabular-nums">
              {formatDuration(run.created_at, run.status !== "running" ? run.updated_at : undefined)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(run.status === "running" || run.status === "paused" || run.status === "pending") && (
            <button
              onClick={() => cancelRun({ id: run._id as any })}
              className="p-1 text-sol-text-dim hover:text-sol-red transition-colors rounded"
              title="Cancel run"
            >
              <Square className="w-3 h-3" />
            </button>
          )}
          <Link href={`/workflows/runs/${run._id}`} className="p-1 text-sol-text-dim hover:text-sol-cyan transition-colors rounded" title="View run permalink">
            <ExternalLink className="w-3 h-3" />
          </Link>
          {run.primary_session_id && (
            <Link href={`/conversation/${run.primary_session_id}`} className="p-1 text-sol-text-dim hover:text-sol-cyan transition-colors rounded" title="View session">
              <ExternalLink className="w-3 h-3" />
            </Link>
          )}
          <button onClick={onClose} className="p-1 text-sol-text-dim hover:text-sol-text transition-colors rounded">
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {run.fail_reason && (
        <div className="flex items-start gap-1.5 px-3 py-2 bg-sol-red/5 border-b border-sol-red/15">
          <AlertCircle className="w-3 h-3 text-sol-red flex-shrink-0 mt-0.5" />
          <span className="text-[11px] text-sol-red/80">{run.fail_reason}</span>
        </div>
      )}

      {run.status === "paused" && gateId && (
        <div data-run-gate-card className="border-b border-sol-magenta/20 bg-sol-magenta/5 px-2 py-2">
          <div className="px-1 pb-1 text-[9px] text-sol-magenta font-semibold uppercase tracking-widest">Gate</div>
          <RunGate run={run} />
        </div>
      )}
      {/* Runs minted before gates were decisions carry only a prompt. */}
      {run.status === "paused" && run.gate_prompt && !gateId && (
        <div className="border-b border-sol-magenta/20 bg-sol-magenta/5 px-3 py-2 flex items-center gap-2 flex-wrap">
          <span className="text-[9px] text-sol-magenta font-semibold uppercase tracking-widest shrink-0">Gate</span>
          <span className="text-[10px] text-sol-text-muted truncate flex-1 min-w-0">{run.gate_prompt}</span>
          {run.gate_choices?.map(choice => (
            <button
              key={choice.key}
              onClick={() => handleChoice(choice.key)}
              disabled={responding}
              className="shrink-0 px-1.5 py-0.5 text-[10px] font-mono font-medium text-sol-magenta border border-sol-magenta/30 rounded hover:bg-sol-magenta/10 transition-colors disabled:opacity-40"
            >
              [{choice.key}] {choice.label.replace(/^\[.\]\s*/, "")}
            </button>
          ))}
          {run.primary_session_id && (
            <Link href={`/conversation/${run.primary_session_id}`} className="shrink-0 text-[9px] text-sol-text-dim hover:text-sol-cyan transition-colors">
              reply →
            </Link>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-2">
        <div className="px-3 pb-1">
          <span className="text-[9px] text-sol-text-dim uppercase tracking-widest">Steps</span>
        </div>
        <WorkflowRunNodes run={run} workflow={workflow} className="px-1 space-y-2" />
      </div>

      <div className="px-3 py-2 border-t border-sol-border/15">
        <div className="text-[9px] text-sol-text-dim font-mono truncate">
          {run._id.slice(-12)} · {new Date(run.created_at).toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}

function RunsPanel({ workflowId, activeRunId, onSelectRun }: {
  workflowId: string;
  activeRunId: string | null;
  onSelectRun: (id: string | null) => void;
}) {
  // Store-fed: the panel paints from cached runs; the feeder overlays this
  // workflow's newest window.
  useSyncWorkflowRuns(workflowId);
  const runWhere = useCallback((r: any) => r.workflow_id === workflowId, [workflowId]);
  const runs = useWorkflowRuns(runWhere) as WorkflowRun[];
  const cancelRun = useMutation(api.workflow_runs.cancel);

  if (runs.length === 0) return null;

  return (
    <div className="border-t border-sol-border/20 bg-sol-bg-alt">
      <div className="px-3 py-1.5 border-b border-sol-border/10">
        <span className="text-[10px] text-sol-text-dim uppercase tracking-widest">Runs</span>
      </div>
      <div className="max-h-32 overflow-y-auto">
        {runs.map(run => {
          const st = STATUS_STYLES[run.status] || STATUS_STYLES.pending;
          const StatusIcon = st.icon;
          const isActive = activeRunId === run._id;
          return (
            <div key={run._id} className={`flex items-center transition-colors ${isActive ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-highlight/40"}`}>
              <button
                onClick={() => onSelectRun(isActive ? null : run._id)}
                className="flex-1 flex items-center gap-2 px-3 py-1.5 text-left min-w-0"
              >
                <StatusIcon className={`w-3 h-3 flex-shrink-0 ${st.color} ${run.status === "running" ? "animate-spin" : ""}`} />
                <span className="text-[10px] text-sol-text-muted font-mono truncate">{run._id.slice(-8)}</span>
                <span className={`text-[10px] ${st.color} capitalize`}>{run.status}</span>
                <span className="text-[10px] text-sol-text-dim ml-auto">{timeAgo(run.created_at)}</span>
              </button>
              <Link
                href={`/workflows/runs/${run._id}`}
                className="px-2 py-1.5 text-sol-text-dim hover:text-sol-cyan transition-colors"
                title="View run detail"
                onClick={e => e.stopPropagation()}
              >
                <ExternalLink className="w-3 h-3" />
              </Link>
              {(run.status === "running" || run.status === "paused" || run.status === "pending") && (
                <button
                  onClick={(e) => { e.stopPropagation(); cancelRun({ id: run._id as any }); }}
                  className="px-2 py-1.5 text-sol-text-dim hover:text-sol-red transition-colors"
                  title="Stop run"
                >
                  <Square className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WorkflowsContent() {
  // Store-fed (hooks/useSyncWorkflows): paints from the cache synchronously;
  // `undefined` only while the cache is empty AND the first answer is in flight.
  const { workflows: workflowRows, ready: workflowsReady } = useWorkflows();
  
  const mainTitlebarRef = useTitlebarHead<HTMLDivElement>();
  const railTitlebarRef = useTitlebarHead<HTMLDivElement>();
  const workflows = (workflowsReady || workflowRows.length > 0 ? workflowRows : undefined) as Workflow[] | undefined;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<WFNode | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showRunDialog, setShowRunDialog] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const selected = workflows?.find(w => w._id === selectedId) ?? (workflows?.[0] ?? null);

  const getWorkflowContextBody = useCallback(() => {
    if (!selected) return "";
    const parts = [`Workflow: ${selected.name}`];
    if (selected.goal) parts.push(`Goal: ${selected.goal}`);
    parts.push(`Nodes: ${selected.nodes.map((n: WFNode) => `${n.id} (${n.type}: ${n.label})`).join(", ")}`);
    return parts.join("\n");
  }, [selected]);

  const activeRun = useWorkflowRun(activeRunId) as WorkflowRun | null | undefined;

  const nodeStatuses = activeRun?.node_statuses
    ? Object.fromEntries(
        activeRun.node_statuses.map(ns => [ns.node_id, ns.status])
      )
    : undefined;

  const currentNodeId = activeRun?.current_node_id;

  if (workflows === undefined) {
    return <AppLoader className="min-h-[16rem] h-full" />;
  }

  if (workflows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
        <GitBranch className="w-8 h-8 text-sol-text-dim" />
        <div>
          <p className="text-sm text-sol-text-muted">No routines yet</p>
          <p className="text-xs text-sol-text-dim mt-1">
            Push a routine with <code className="font-mono text-sol-text-muted">cast workflow push</code>
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full bg-sol-bg">
      {sidebarOpen && (
        <div className="w-52 flex-shrink-0 border-r border-sol-border/20 flex flex-col bg-sol-bg-alt">
          <div ref={railTitlebarRef} className="px-3 py-2.5 border-b border-sol-border/20">
            <span className="text-[10px] text-sol-text-dim uppercase tracking-widest">Routines</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {workflows.map(w => {
              const isActive = selected?._id === w._id;
              return (
                <button
                  key={w._id}
                  onClick={() => { setSelectedId(w._id); setSelectedNode(null); setActiveRunId(null); }}
                  className={`w-full text-left px-3 py-3 transition-all border-l-2 ${
                    isActive
                      ? "bg-sol-bg-highlight border-l-sol-cyan"
                      : "border-l-transparent hover:bg-sol-bg-highlight/60"
                  }`}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <GitBranch className={`w-3 h-3 flex-shrink-0 ${isActive ? "text-sol-cyan" : "text-sol-text-dim"}`} />
                    <span className={`text-sm truncate ${isActive ? "text-sol-text font-medium" : "text-sol-text-muted"}`}>
                      {w.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 pl-[18px]">
                    <span className="text-[10px] text-sol-text-dim">{w.nodes.length} nodes</span>
                    <span className="text-[10px] text-sol-text-dim ml-auto flex items-center gap-0.5">
                      <Clock className="w-2.5 h-2.5" />
                      {timeAgo(w.updated_at)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
          {selected && (
            <RunsPanel
              workflowId={selected._id}
              activeRunId={activeRunId}
              onSelectRun={setActiveRunId}
            />
          )}
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col relative">
        {selected && (
          <>
            <div ref={mainTitlebarRef} className="flex items-center gap-3 px-4 py-2.5 border-b border-sol-border/20 bg-sol-bg-alt flex-shrink-0">
              <button
                onClick={() => setSidebarOpen(v => !v)}
                className="text-sol-text-dim hover:text-sol-text-muted transition-colors"
                title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
              >
                <ChevronRight className={`w-4 h-4 transition-transform ${sidebarOpen ? "rotate-180" : ""}`} />
              </button>
              <div className="min-w-0">
                <span className="text-sm font-semibold text-sol-text">{selected.name}</span>
                {selected.goal && (
                  <span className="text-xs text-sol-text-dim ml-2">{selected.goal}</span>
                )}
              </div>
              <div className="ml-auto flex items-center gap-3 text-[10px] text-sol-text-dim">
                <span>{selected.nodes.length} nodes</span>
                <span>{selected.edges.length} edges</span>
                <span className="font-mono">{selected.slug}</span>
                <button
                  onClick={() => setShowRunDialog(v => !v)}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-sol-cyan border border-sol-cyan/30 rounded-md hover:bg-sol-cyan/10 transition-colors"
                >
                  <Play className="w-3 h-3" />
                  Run
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0 flex">
              <div className="flex-1 relative min-w-0">
                <WorkflowGraphView
                  key={selected._id}
                  nodes={selected.nodes}
                  edges={selected.edges}
                  selectedNodeId={selectedNode?.id}
                  onNodeSelect={setSelectedNode}
                  nodeStatuses={nodeStatuses}
                  currentNodeId={currentNodeId}
                />
                {selectedNode && !activeRun && (
                  <NodeDetail node={selectedNode} onClose={() => setSelectedNode(null)} />
                )}
                {showRunDialog && (
                  <RunDialog workflowId={selected._id} onClose={() => setShowRunDialog(false)} />
                )}
              </div>
              {activeRun && (
                <ActiveRunPanel
                  run={activeRun}
                  workflow={selected}
                  onClose={() => setActiveRunId(null)}
                />
              )}
            </div>

            <ContextChatInput
              contextType="workflow"
              contextTitle={selected.name}
              getContextBody={getWorkflowContextBody}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- runs across workflows (the-line.md L8, L10)

const RUN_TONE: Record<string, string> = {
  pending: "var(--sol-text-dim)", running: "var(--sol-cyan)", paused: "var(--sol-yellow)", completed: "var(--sol-green)", failed: "var(--sol-red)",
};

function RunRow({ run, now, onOpen }: { run: LineRun; now: number; onOpen: () => void }) {
  const st = STATUS_STYLES[run.status] || STATUS_STYLES.pending;
  const StatusIcon = st.icon;
  const tone = RUN_TONE[run.status] ?? RUN_TONE.pending;
  const node = run.status === "completed" || run.status === "failed" ? null : (run.current_node_label || run.current_node_id || null);
  const gateOpen = !!run.gate_decision_short_id && run.status === "paused";
  const counts = runNodeCounts(runNodeRows(run));
  return (
    <li>
      <div
        role="link"
        tabIndex={0}
        data-run-row={run._id}
        onClick={onOpen}
        onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}
        className="group w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-xl transition-colors hover:bg-sol-bg-highlight/70 cursor-pointer"
      >
        <span className="w-[3px] self-stretch rounded-full shrink-0" style={{ background: tone }} aria-hidden />
        <StatusIcon className={`w-3.5 h-3.5 shrink-0 ${st.color} ${run.status === "running" ? "animate-spin" : ""}`} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="truncate text-[13px] font-medium" style={{ color: "var(--sol-text)" }}>{run.workflow_name || run.workflow_slug || "workflow"}</span>
            <span className="shrink-0 text-[10px] px-1.5 h-[17px] inline-flex items-center rounded-md border capitalize" style={{ borderColor: `color-mix(in srgb, ${tone} 45%, transparent)`, color: tone }}>{run.status}</span>
            {node && <span className="truncate text-[11px]" style={{ color: "var(--sol-text-muted)" }}>· {node}</span>}
            {counts.total > 0 && (
              <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--sol-text-dim)" }} title={`${counts.done} of ${counts.total} steps done`}>
                {counts.done}/{counts.total}
              </span>
            )}
            {counts.running > 0 && <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--sol-green)" }}>{counts.running} live</span>}
            {counts.failed > 0 && <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--sol-red)" }}>{counts.failed} failed</span>}
          </span>
          <span className="mt-[2px] flex items-center gap-1.5 text-[10.5px] min-w-0" style={{ color: "var(--sol-text-dim)" }}>
            {run.task_short_id ? (
              <Link href={`/tasks/${run.task_short_id}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 min-w-0 truncate hover:underline" style={{ color: "var(--sol-text-muted)" }}>
                <CheckSquare className="w-3 h-3 shrink-0" /><span style={{ fontFamily: "var(--font-mono)" }}>{run.task_short_id}</span>{run.task_title && <span className="truncate">{run.task_title}</span>}
              </Link>
            ) : run.plan_short_id ? (
              <Link href={`/plans/${run.plan_short_id}`} onClick={(e) => e.stopPropagation()} className="hover:underline" style={{ fontFamily: "var(--font-mono)" }}>{run.plan_short_id}</Link>
            ) : (
              <span style={{ fontFamily: "var(--font-mono)" }}>{run._id.slice(-8)}</span>
            )}
            {run.gate_decision_short_id && (
              <Link href={`/decisions/${run.gate_decision_short_id}`} onClick={(e) => e.stopPropagation()} data-run-gate className="inline-flex items-center gap-1 shrink-0 px-1.5 h-[16px] rounded-md hover:underline" style={{ background: gateOpen ? "color-mix(in srgb, var(--sol-magenta) 14%, transparent)" : "color-mix(in srgb, var(--sol-border) 30%, transparent)", color: gateOpen ? "var(--sol-magenta)" : "var(--sol-text-dim)" }}>
                <MessageCircleQuestionMark className="w-3 h-3" /> gate · {run.gate_decision_short_id}
              </Link>
            )}
          </span>
        </span>
        <span className="text-[10.5px] tabular-nums shrink-0 self-start mt-[3px]" style={{ color: "var(--sol-text-dim)" }} title={new Date(run.created_at).toLocaleString()}>{compactAge(now - run.created_at)}</span>
      </div>
    </li>
  );
}

export function RunsTab() {
  const router = useRouter();
  const now = useCoarseNow(30_000);
  const { ready } = useSyncRuns(useMemo(() => ({ limit: 100 }), []));
  const runs = useWorkspaceRuns();
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  if (!ready && runs.length === 0) return <AppLoader className="min-h-[16rem] h-full" />;
  return (
    <div className="h-full overflow-y-auto bg-sol-bg">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5">
        <div ref={titlebarRef} className="flex items-baseline gap-2 mb-3">
          <Workflow className="w-4 h-4 text-sol-cyan self-center" />
          <h1 className="text-lg font-semibold text-sol-text">Runs</h1>
          <span className="text-xs text-sol-text-dim">every passage along a line, newest first</span>
          <span className="ml-auto text-xs text-sol-text-dim font-mono">{runs.length}</span>
        </div>
        {runs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
            <Workflow className="w-8 h-8 text-sol-text-dim" />
            <p className="text-sm text-sol-text-muted">No runs yet</p>
            <p className="text-xs text-sol-text-dim max-w-xs">A run starts when a role's sweep picks up a task, or with <code className="font-mono text-sol-text-muted">cast workflow run</code>.</p>
          </div>
        ) : (
          <ul className="space-y-1">
            {runs.map((r) => <RunRow key={r._id} run={r} now={now} onOpen={() => router.push(`/workflows/runs/${r._id}`)} />)}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the page: three tabs

type RoutinesTab = "routines" | "runs" | "dynamic";
const ROUTINES_TABS: { key: RoutinesTab; label: string; icon: any }[] = [
  { key: "routines", label: "Routines", icon: GitBranch },
  { key: "runs", label: "Runs", icon: ListChecks },
  { key: "dynamic", label: "Dynamic", icon: Workflow },
];

function RoutinesContent() {
  const searchParams = useSearchParams();
  const initial = searchParams?.get("tab") as RoutinesTab | null;
  const [tab, setTab] = useState<RoutinesTab>(initial && ROUTINES_TABS.some((t) => t.key === initial) ? initial : "routines");
  return (
    <div className="h-full flex flex-col bg-sol-bg">
      <nav className="shrink-0 flex items-center gap-1 px-3 border-b border-sol-border/20 overflow-x-auto cq-no-scrollbar" aria-label="Workflow sections">
        {ROUTINES_TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              data-routines-tab={t.key}
              onClick={() => setTab(t.key)}
              className={cn("relative shrink-0 inline-flex items-center gap-1.5 h-9 px-2.5 text-[12.5px] transition-colors", active ? "font-semibold" : "hover:bg-sol-bg-highlight/60")}
              style={{ color: active ? "var(--sol-text)" : "var(--sol-text-muted)" }}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="w-3.5 h-3.5" style={{ color: active ? "var(--sol-cyan)" : undefined }} />
              {t.label}
              {active && <span className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full" style={{ background: "var(--sol-cyan)" }} />}
            </button>
          );
        })}
      </nav>
      <div className="flex-1 min-h-0">
        {tab === "routines" && <WorkflowsContent />}
        {tab === "runs" && <RunsTab />}
        {tab === "dynamic" && <WorkflowsDashboardContent />}
      </div>
    </div>
  );
}

export default function WorkflowsPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <RoutinesContent />
      </DashboardLayout>
    </AuthGuard>
  );
}
