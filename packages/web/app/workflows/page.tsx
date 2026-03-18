"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { WorkflowGraphView, type WFNode, type WFEdge } from "../../components/WorkflowGraphView";
import { GitBranch, Clock, ChevronRight, X, Terminal, Bot, User, Zap, GitFork, Merge, Play, Pause, CheckCircle, XCircle, Loader2 } from "lucide-react";

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
    started_at?: number;
    completed_at?: number;
  }>;
  goal_override?: string;
  gate_prompt?: string;
  gate_choices?: Array<{ key: string; label: string; target: string }>;
  gate_response?: string;
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
            <div className="text-xs text-sol-text-muted bg-sol-bg rounded-lg p-3 max-h-40 overflow-y-auto leading-relaxed whitespace-pre-wrap font-mono border border-sol-border/20">
              {node.prompt}
            </div>
          </div>
        )}

        {node.script && (
          <div className="space-y-1">
            <div className="text-[10px] text-sol-text-dim uppercase tracking-wider">Script</div>
            <div className="text-xs text-sol-green bg-sol-bg rounded-lg p-3 max-h-40 overflow-y-auto leading-relaxed whitespace-pre-wrap font-mono border border-sol-border/20">
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
  const createRun = useMutation(api.workflow_runs.create);
  const [running, setRunning] = useState(false);

  const handleRun = async () => {
    setRunning(true);
    await createRun({
      workflow_id: workflowId,
      goal_override: goalOverride || undefined,
    });
    setRunning(false);
    onClose();
  };

  return (
    <div className="absolute top-12 right-4 z-20 w-72 bg-sol-bg-alt border border-sol-border/40 rounded-xl shadow-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-sol-border/30">
        <span className="text-xs font-semibold text-sol-text uppercase tracking-wider">Run Workflow</span>
      </div>
      <div className="p-4 space-y-3">
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

function GatePanel({ run }: { run: WorkflowRun }) {
  const respondToGate = useMutation(api.workflow_runs.respondToGate);
  const [responding, setResponding] = useState(false);

  if (run.status !== "paused" || !run.gate_prompt) return null;

  const handleChoice = async (key: string) => {
    setResponding(true);
    await respondToGate({ id: run._id as any, response: key });
    setResponding(false);
  };

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 w-80 bg-sol-bg-alt border-2 border-sol-magenta/50 rounded-xl shadow-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-sol-magenta/30 bg-sol-magenta/5">
        <span className="text-xs font-semibold text-sol-magenta uppercase tracking-wider">Human Gate</span>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-sm text-sol-text">{run.gate_prompt}</p>
        {run.gate_choices && (
          <div className="flex flex-col gap-2">
            {run.gate_choices.map(choice => (
              <button
                key={choice.key}
                onClick={() => handleChoice(choice.key)}
                disabled={responding}
                className="w-full px-3 py-2 text-xs font-medium text-sol-text border border-sol-border/30 rounded-lg hover:bg-sol-bg-highlight hover:border-sol-magenta/40 transition-colors disabled:opacity-50 text-left"
              >
                <span className="font-mono text-sol-magenta mr-2">[{choice.key}]</span>
                {choice.label.replace(/^\[.\]\s*/, "")}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RunsPanel({ workflowId, activeRunId, onSelectRun }: {
  workflowId: string;
  activeRunId: string | null;
  onSelectRun: (id: string | null) => void;
}) {
  const runs = useQuery(api.workflow_runs.listForWorkflow, { workflow_id: workflowId }) as WorkflowRun[] | undefined;

  if (!runs || runs.length === 0) return null;

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
            <button
              key={run._id}
              onClick={() => onSelectRun(isActive ? null : run._id)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                isActive ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-highlight/40"
              }`}
            >
              <StatusIcon className={`w-3 h-3 flex-shrink-0 ${st.color} ${run.status === "running" ? "animate-spin" : ""}`} />
              <span className="text-[10px] text-sol-text-muted font-mono truncate">{run._id.slice(-8)}</span>
              <span className={`text-[10px] ${st.color} capitalize`}>{run.status}</span>
              <span className="text-[10px] text-sol-text-dim ml-auto">{timeAgo(run.created_at)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function WorkflowsContent() {
  const workflows = useQuery(api.workflows.webList) as Workflow[] | undefined;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<WFNode | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showRunDialog, setShowRunDialog] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const selected = workflows?.find(w => w._id === selectedId) ?? (workflows?.[0] ?? null);

  const activeRun = useQuery(
    api.workflow_runs.get,
    activeRunId ? { id: activeRunId } : "skip"
  ) as WorkflowRun | null | undefined;

  const nodeStatuses = activeRun?.node_statuses
    ? Object.fromEntries(
        activeRun.node_statuses.map(ns => [ns.node_id, ns.status])
      )
    : undefined;

  const currentNodeId = activeRun?.current_node_id;

  if (workflows === undefined) {
    return (
      <div className="flex items-center justify-center h-full text-sol-text-dim text-sm">
        Loading...
      </div>
    );
  }

  if (workflows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
        <GitBranch className="w-8 h-8 text-sol-text-dim" />
        <div>
          <p className="text-sm text-sol-text-muted">No workflows yet</p>
          <p className="text-xs text-sol-text-dim mt-1">
            Push a workflow with <code className="font-mono text-sol-text-muted">cast workflow push</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full bg-sol-bg">
      {sidebarOpen && (
        <div className="w-52 flex-shrink-0 border-r border-sol-border/20 flex flex-col bg-sol-bg-alt">
          <div className="px-3 py-2.5 border-b border-sol-border/20">
            <span className="text-[10px] text-sol-text-dim uppercase tracking-widest">Workflows</span>
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
            <div className="flex items-center gap-3 px-4 py-2.5 border-b border-sol-border/20 bg-sol-bg-alt flex-shrink-0">
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

            <div className="flex-1 min-h-0 relative">
              <WorkflowGraphView
                nodes={selected.nodes}
                edges={selected.edges}
                selectedNodeId={selectedNode?.id}
                onNodeSelect={setSelectedNode}
                nodeStatuses={nodeStatuses}
                currentNodeId={currentNodeId}
              />
              {selectedNode && (
                <NodeDetail node={selectedNode} onClose={() => setSelectedNode(null)} />
              )}
              {showRunDialog && (
                <RunDialog workflowId={selected._id} onClose={() => setShowRunDialog(false)} />
              )}
              {activeRun && activeRun.status === "paused" && (
                <GatePanel run={activeRun} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function WorkflowsPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <WorkflowsContent />
      </DashboardLayout>
    </AuthGuard>
  );
}
