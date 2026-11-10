"use client";

import { useState, useCallback, useMemo, type ReactNode } from "react";
import { ShortId } from "../../components/ShortId";
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
import { useIsModernStyle } from "../../hooks/useVisualStyle";
import { PageFrame, PageHeader } from "../../components/ui/page-header";
import { SegmentedToggle } from "../../components/SegmentedToggle";
import { RoutinesLegacyNav } from "./RoutinesLegacyNav";
import { useSyncRuns, useWorkspaceRuns, type LineRun } from "../../hooks/useSyncRuns";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { DecisionCompactCard } from "../../components/decisions/DecisionCompactCard";
import { useSyncDecisionDetail } from "../../hooks/useSyncDecisionDetail";
import { RunGate } from "../../components/WorkflowContextPanel";
import { WorkflowRunNodes } from "../../components/WorkflowRunNodes";
import { runNodeCounts, runNodeRows } from "../../lib/workflowRun";
import { compactAge } from "../../lib/threadState";
import { WorkflowsDashboardContent } from "./dashboard";
import { useLineForks, type LineForkProject } from "../../hooks/useLineForks";
import { lineRunKind } from "../../lib/line/lineStations";
import { lineSettingsHref } from "../../lib/lineSettings";
import { CustomizedLineChip } from "../../components/line/CustomizedLineChip";
import { Button } from "../../components/ui/button";
import { toast } from "sonner";
import { SwitchReview } from "../../components/consequential/ConsequentialSwitch";
import { useRunCost } from "../../components/consequential/useRunCost";
import { workflowAgentSteps, workflowRunLedger, workflowSteps } from "../../components/work/startLedgers";

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

// Node kinds in theme tokens, so a chip reads in light and dark alike.
const TYPE_BADGE: Record<string, string> = {
  agent:           "text-sol-text-muted bg-sol-bg-highlight",
  prompt:          "text-sol-violet bg-sol-violet/10",
  command:         "text-sol-green bg-sol-green/10",
  human:           "text-sol-magenta bg-sol-magenta/10",
  conditional:     "text-sol-yellow bg-sol-yellow/10",
  start:           "text-sol-blue bg-sol-blue/10",
  exit:            "text-sol-blue bg-sol-blue/10",
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
    <div className="absolute bottom-4 right-4 w-80 max-w-[calc(100%-2rem)] bg-sol-bg-alt border border-sol-border/40 rounded-xl shadow-2xl z-10 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-sol-border/30">
        <div className="flex items-center gap-2">
          <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-mono ${badgeClass}`}>
            <Icon className="w-3 h-3" />
            {node.type}
          </span>
          {node.goal_gate && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-sol-yellow/15 text-sol-yellow font-mono">goal-gate</span>
          )}
        </div>
        <button onClick={onClose} aria-label="Close" title="Close" className="p-1 -m-1 text-sol-text-dim hover:text-sol-text transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="p-4 space-y-3 max-h-72 overflow-y-auto">
        <div>
          <div className="text-meta text-sol-text-dim font-mono mb-0.5">{node.id}</div>
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
            <div className="text-mark text-sol-text-dim uppercase tracking-wider">Prompt</div>
            <div className="text-xs text-sol-text-muted bg-sol-bg rounded-lg p-3 max-h-40 overflow-y-auto leading-relaxed whitespace-pre-wrap font-mono">
              {node.prompt}
            </div>
          </div>
        )}

        {node.script && (
          <div className="space-y-1">
            <div className="text-mark text-sol-text-dim uppercase tracking-wider">Script</div>
            <div className="text-xs text-sol-green bg-sol-bg rounded-lg p-3 max-h-40 overflow-y-auto leading-relaxed whitespace-pre-wrap font-mono">
              {node.script}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function RunDialog({ workflow, onClose }: { workflow: Workflow; onClose: () => void }) {
  const [goalOverride, setGoalOverride] = useState("");
  const [projectPath, setProjectPath] = useState(() => {
    try { return localStorage.getItem("wf_last_project_path") || ""; } catch { return ""; }
  });
  const createRun = useMutation(api.workflow_runs.create);
  const [running, setRunning] = useState(false);
  // Run starts paid agent sessions: it opens the shared review first.
  const [reviewing, setReviewing] = useState(false);
  const runCost = useRunCost(null);

  const handleRun = async () => {
    setRunning(true);
    if (projectPath) {
      try { localStorage.setItem("wf_last_project_path", projectPath); } catch {}
    }
    try {
      await createRun({
        workflow_id: workflow._id,
        goal_override: goalOverride || undefined,
        project_path: projectPath || undefined,
      });
      onClose();
    } catch (e) {
      toast.error("Couldn't start the run", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="absolute top-12 right-4 z-20 w-80 max-w-[calc(100%-2rem)] bg-sol-bg-alt border border-sol-border/40 rounded-xl shadow-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-sol-border/30">
        <span className="text-xs font-semibold text-sol-text uppercase tracking-wider">Run Workflow</span>
      </div>
      <div className="p-4 space-y-3">
        <div>
          <label className="text-mark text-sol-text-dim uppercase tracking-wider block mb-1">Project path</label>
          <input
            type="text"
            value={projectPath}
            onChange={e => setProjectPath(e.target.value)}
            placeholder="/Users/you/src/myproject"
            className="w-full px-3 py-1.5 text-xs bg-sol-bg border border-sol-border/30 rounded-lg text-sol-text placeholder-sol-text-dim focus:outline-none focus:border-sol-cyan/50 font-mono"
          />
        </div>
        <div>
          <label className="text-mark text-sol-text-dim uppercase tracking-wider block mb-1">Goal override (optional)</label>
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
          <Button variant="cyan" size="sm" className="flex-1" onClick={() => setReviewing(true)} disabled={running} aria-haspopup="dialog">
            {running ? <Loader2 className="animate-spin" /> : <Play />}
            Run
          </Button>
        </div>
      </div>
      {reviewing && (
        <SwitchReview
          ledger={workflowRunLedger({
            name: workflow.name,
            subject: goalOverride.trim() || workflow.goal || workflow.name,
            agentSteps: workflowAgentSteps(workflow.nodes),
            steps: workflowSteps(workflow.nodes),
            project: projectPath.trim().split("/").filter(Boolean).pop() ?? null,
          }, runCost)}
          onClose={() => setReviewing(false)}
          onConfirm={() => { setReviewing(false); void handleRun(); }}
        />
      )}
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
  const respondToGate = useInboxStore((s) => s.respondToGate);
  const cancelRun = useMutation(api.workflow_runs.cancel);
  // The gate's decision row (the-line.md L4, L10): the queue feed holds it
  // when the viewer was asked; for anyone else the per view detail feed
  // brings it, so the panel renders the decision card and never its own
  // buttons for a decision gate. Subscribed by status only, so an unrelated
  // decision edit does not repaint.
  const gateId = run.gate_decision_id;

  const st = STATUS_STYLES[run.status] || STATUS_STYLES.pending;
  const StatusIcon = st.icon;

  // Local-first (store respondToGate): the run flips to running on the press.
  const handleChoice = (key: string) => respondToGate(run._id, key);

  const orderedNodes = workflow.nodes.filter(n => n.type !== "start" && n.type !== "exit");

  return (
    <div className="w-72 flex-shrink-0 border-l border-sol-border/20 flex flex-col bg-sol-bg-alt h-full overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-sol-border/20">
        <div className="flex items-center gap-2">
          <StatusIcon className={`w-3.5 h-3.5 flex-shrink-0 ${st.color} ${run.status === "running" ? "animate-spin" : ""}`} />
          <span className={`text-xs font-semibold capitalize ${st.color}`}>{run.status}</span>
          {(run.status === "running" || run.status === "completed" || run.status === "failed") && (
            <span className="text-meta text-sol-text-dim tabular-nums">
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
              aria-label="Cancel run"
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
          <button onClick={onClose} aria-label="Close run" title="Close" className="p-1 text-sol-text-dim hover:text-sol-text transition-colors rounded">
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {run.fail_reason && (
        <div className="flex items-start gap-1.5 px-3 py-2 bg-sol-red/5 border-b border-sol-red/15">
          <AlertCircle className="w-3 h-3 text-sol-red flex-shrink-0 mt-0.5" />
          <span className="text-meta text-sol-red/80">{run.fail_reason}</span>
        </div>
      )}

      {run.status === "paused" && gateId && (
        <div data-run-gate-card className="border-b border-sol-magenta/20 bg-sol-magenta/5 px-2 py-2">
          <div className="px-1 pb-1 text-mark text-sol-magenta font-semibold uppercase tracking-widest">Gate</div>
          <RunGate run={run} />
        </div>
      )}
      {/* Runs minted before gates were decisions carry only a prompt. */}
      {run.status === "paused" && run.gate_prompt && !gateId && (
        <div className="border-b border-sol-magenta/20 bg-sol-magenta/5 px-3 py-2 flex items-center gap-2 flex-wrap">
          <span className="text-mark text-sol-magenta font-semibold uppercase tracking-widest shrink-0">Gate</span>
          <span className="text-meta text-sol-text-muted truncate flex-1 min-w-0">{run.gate_prompt}</span>
          {run.gate_choices?.map(choice => (
            <button
              key={choice.key}
              onClick={() => handleChoice(choice.key)}
              className="shrink-0 px-1.5 py-0.5 text-meta font-mono font-medium text-sol-magenta border border-sol-magenta/30 rounded hover:bg-sol-magenta/10 transition-colors disabled:opacity-40"
            >
              [{choice.key}] {choice.label.replace(/^\[.\]\s*/, "")}
            </button>
          ))}
          {run.primary_session_id && (
            <Link href={`/conversation/${run.primary_session_id}`} className="shrink-0 text-meta text-sol-text-dim hover:text-sol-cyan transition-colors">
              reply →
            </Link>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-2">
        <div className="px-3 pb-1">
          <span className="text-mark text-sol-text-dim uppercase tracking-widest">Steps</span>
        </div>
        <WorkflowRunNodes run={run} workflow={workflow} className="px-1 space-y-2" />
      </div>

      <div className="px-3 py-2 border-t border-sol-border/15">
        <div className="text-meta text-sol-text-dim font-mono truncate">
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
        <span className="text-mark text-sol-text-dim uppercase tracking-widest">Runs</span>
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
                <StatusIcon className={`w-3 h-3 flex-shrink-0 ${st.color}`} />
                <span className="text-meta text-sol-text-muted font-mono truncate">{run._id.slice(-8)}</span>
                <span className={`text-meta ${st.color} capitalize`}>{run.status}</span>
                <span className="text-meta text-sol-text-dim ml-auto">{timeAgo(run.created_at)}</span>
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

function WorkflowsContent({ tabs }: { tabs?: ReactNode }) {
  // Store-fed (hooks/useSyncWorkflows): paints from the cache synchronously;
  // `undefined` only while the cache is empty AND the first answer is in flight.
  const { workflows: workflowRows, ready: workflowsReady } = useWorkflows();

  const mainTitlebarRef = useTitlebarHead<HTMLDivElement>();
  const railTitlebarRef = useTitlebarHead<HTMLDivElement>();
  const modern = useIsModernStyle();
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

  // Modern: the page header over the section; Classic: the section alone, under the section bar.
  const framed = (body: ReactNode) => !modern ? body : (
    <div className="flex h-full min-h-0 flex-col bg-sol-bg">
      <PageHeader legacy={null} title="Workflows" icon={Workflow} count={workflows?.length} tabs={tabs} />
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
  if (workflows === undefined) {
    return framed(<AppLoader className="min-h-[16rem] h-full" />);
  }

  if (workflows.length === 0) {
    return framed(
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
        <GitBranch className="w-8 h-8 text-sol-text-dim" />
        <div>
          <p className="text-sm text-sol-text-muted">No routines yet</p>
          <p className="text-xs text-sol-text-dim mt-1">
            Ask an agent to write one for a process you repeat.
          </p>
        </div>
      </div>
    );
  }
  return framed(
    <div className="flex h-full bg-sol-bg">
      {sidebarOpen && (
        <div className="w-52 flex-shrink-0 border-r border-sol-border/20 flex flex-col bg-sol-bg-alt">
          <div ref={railTitlebarRef} className="px-3 py-2.5 border-b border-sol-border/20">
            <span className="text-mark text-sol-text-dim uppercase tracking-widest">Routines</span>
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
                    <span className="text-meta text-sol-text-dim">{w.nodes.length} nodes</span>
                    <span className="text-meta text-sol-text-dim ml-auto flex items-center gap-0.5">
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
              <div className="ml-auto flex items-center gap-3 text-meta text-sol-text-dim">
                <span>{selected.nodes.length} nodes</span>
                <span>{selected.edges.length} edges</span>
                <span className="font-mono">{selected.slug}</span>
                <button
                  onClick={() => setShowRunDialog(v => !v)}
                  className="flex items-center gap-1 px-2 py-1 text-meta font-medium text-sol-cyan border border-sol-cyan/30 rounded-md hover:bg-sol-cyan/10 transition-colors"
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
                {selectedNode && !activeRun && !showRunDialog && (
                  <NodeDetail node={selectedNode} onClose={() => setSelectedNode(null)} />
                )}
                {showRunDialog && (
                  <RunDialog workflow={selected} onClose={() => setShowRunDialog(false)} />
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

function RunRow({ run, now, onOpen, forks }: { run: LineRun; now: number; onOpen: () => void; forks: ReadonlyMap<string, LineForkProject> }) {
  const line = lineRunKind(run, forks);
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
        <StatusIcon className={`w-3.5 h-3.5 shrink-0 ${st.color}`} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="truncate text-[13px] font-medium" style={{ color: "var(--sol-text)" }}>{run.workflow_name || run.workflow_slug || "workflow"}</span>
            <span className="shrink-0 text-meta px-1.5 min-h-[17px] inline-flex items-center rounded-md border capitalize" style={{ borderColor: `color-mix(in srgb, ${tone} 45%, transparent)`, color: tone }}>{run.status}</span>
            {line?.kind === "customized" && <CustomizedLineChip project={line.project.title} href={lineSettingsHref({ project: line.project, section: "stations" })} />}
            {node && <span className="truncate text-meta" style={{ color: "var(--sol-text-muted)" }}>· {node}</span>}
            {counts.total > 0 && (
              <span className="shrink-0 text-meta tabular-nums" style={{ color: "var(--sol-text-dim)" }} title={`${counts.done} of ${counts.total} steps done`}>
                {counts.done}/{counts.total}
              </span>
            )}
            {counts.running > 0 && <span className="shrink-0 text-meta tabular-nums" style={{ color: "var(--sol-green)" }}>{counts.running} live</span>}
            {counts.failed > 0 && <span className="shrink-0 text-meta tabular-nums" style={{ color: "var(--sol-red)" }}>{counts.failed} failed</span>}
          </span>
          <span className="mt-[2px] flex items-center gap-1.5 text-meta min-w-0" style={{ color: "var(--sol-text-dim)" }}>
            {run.task_short_id ? (
              <Link href={`/tasks/${run.task_short_id}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 min-w-0 truncate hover:underline" style={{ color: "var(--sol-text-muted)" }}>
                <CheckSquare className="w-3 h-3 shrink-0" /><span style={{ fontFamily: "var(--font-mono)" }}>{run.task_short_id}</span>{run.task_title && <span className="truncate">{run.task_title}</span>}
              </Link>
            ) : run.plan_short_id ? (
              <Link href={`/plans/${run.plan_short_id}`} onClick={(e) => e.stopPropagation()} className="hover:underline"><ShortId id={run.plan_short_id} /></Link>
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
        <span className="text-meta tabular-nums shrink-0 self-start mt-[3px]" style={{ color: "var(--sol-text-dim)" }} title={new Date(run.created_at).toLocaleString()}>{compactAge(now - run.created_at)}</span>
      </div>
    </li>
  );
}

export function RunsTab({ tabs }: { tabs?: ReactNode }) {
  const router = useRouter();
  const now = useCoarseNow(30_000);
  const { ready } = useSyncRuns(useMemo(() => ({ limit: 100 }), []));
  const runs = useWorkspaceRuns();
  const forks = useLineForks();
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  const modern = useIsModernStyle();
  const cold = !ready && runs.length === 0;
  if (cold && !modern) return <AppLoader className="min-h-[16rem] h-full" />;
  const legacy = (
    <div ref={titlebarRef} className="flex items-baseline gap-2 mb-3">
      <Workflow className="w-4 h-4 text-sol-cyan self-center" />
      <h1 className="text-lg font-semibold text-sol-text">Runs</h1>
      <span className="ml-auto text-xs text-sol-text-dim font-mono">{runs.length}</span>
    </div>
  );
  return (
    <PageFrame
      header={<PageHeader legacy={legacy} title="Workflows" icon={Workflow} count={cold ? null : runs.length} tabs={tabs} />}
      legacyScroll="h-full overflow-y-auto bg-sol-bg"
      legacyColumn="max-w-3xl mx-auto px-4 sm:px-6 py-5"
      column="max-w-3xl mx-auto px-4 sm:px-6 py-5"
    >
        {cold ? <AppLoader className="min-h-[16rem]" /> : runs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
            <Workflow className="w-8 h-8 text-sol-text-dim" />
            <p className="text-sm text-sol-text-muted">No runs yet</p>
          </div>
        ) : (
          <ul className="space-y-1">
            {runs.map((r) => <RunRow key={r._id} run={r} now={now} forks={forks} onOpen={() => router.push(`/workflows/runs/${r._id}`)} />)}
          </ul>
        )}
    </PageFrame>
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
  // Modern: each section draws the page header itself, with its own count,
  // and this switch in its tabs slot. Classic: the section bar above them.
  const modern = useIsModernStyle();
  const tabs = modern ? <SegmentedToggle value={tab} onChange={(key) => setTab(key as RoutinesTab)} items={ROUTINES_TABS} collapse /> : undefined;
  const sections = (
    <>
      {tab === "routines" && <WorkflowsContent tabs={tabs} />}
      {tab === "runs" && <RunsTab tabs={tabs} />}
      {tab === "dynamic" && <WorkflowsDashboardContent tabs={tabs} />}
    </>
  );
  if (modern) return <div className="h-full bg-sol-bg">{sections}</div>;
  return (
    <div className="h-full flex flex-col bg-sol-bg">
      <RoutinesLegacyNav tabs={ROUTINES_TABS} tab={tab} onTab={setTab} />
      <div className="flex-1 min-h-0">{sections}</div>
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
