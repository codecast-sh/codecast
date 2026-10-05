"use client";

import { useMemo, useState } from "react";
import { ShareControl } from "../../../../components/ShareControl";
import Link from "next/link";
import { useParams } from "next/navigation";
import { RunGate } from "../../../../components/WorkflowContextPanel";
import { WorkflowRunNodes } from "../../../../components/WorkflowRunNodes";
import { formatRunDuration } from "../../../../lib/workflowRun";
import { WorkflowGraphView, type WFNode, type NodeStatus } from "../../../../components/WorkflowGraphView";
import { ChangeCardView, answererNameOf } from "../../../../components/decisions/ChangeCardView";
import { CauseRunList, ReportChip, ReportSection, RunOutcomeText, RunPathView, answerTone, useCauseRuns } from "../../../../components/line/RunReport";
import { runPath, cardName, choiceWords, shortDay, type ReportRun, type ReportTask } from "../../../../lib/line/runReport";
import { SHIPPED_LINE } from "../../../../lib/line/shippedLine.generated";
import { isLineRun } from "@codecast/shared/contracts/changeCard";
import { useDecisionDetail, useSyncDecisionDetail } from "../../../../hooks/useSyncDecisionDetail";
import { useCoarseNow } from "../../../../hooks/useCoarseNow";
import { lineTabHref } from "../../../../lib/lineSettings";
import { useWorkflow, useWorkflowRun } from "../../../../hooks/useSyncWorkflows";
import { useInboxStore } from "../../../../store/inboxStore";
import { useForeignWorkspace } from "../../../../hooks/useForeignWorkspace";
import { AuthGuard } from "../../../../components/AuthGuard";
import { AppLoader } from "../../../../components/AppLoader";
import { DashboardLayout } from "../../../../components/DashboardLayout";
import {
  Clock, CheckCircle, XCircle, Loader2, Pause, ExternalLink,
  ChevronLeft, ChevronRight, User,
} from "lucide-react";
import { useTitlebarHead } from "../../../../hooks/useTitlebarHead";

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
  gate_decision_status?: string;
  gate_choices?: Array<{ key: string; label: string; target: string }>;
  gate_response?: string;
  gate_answer?: string;
  gate_node_id?: string;
  task_id?: string;
  task_short_id?: string;
  task_title?: string;
  fail_reason?: string;
  merge?: { sha: string; branch: string; into: string; at: number; pr_url?: string };
  card_cost_usd?: number;
  created_at: number;
  updated_at: number;
}

interface Workflow {
  _id: string;
  name: string;
  slug: string;
  goal?: string;
  nodes: any[];
  edges?: any[];
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

  const respondToGate = useInboxStore((s) => s.respondToGate);
  const [gateText, setGateText] = useState("");
  const [graphOpen, setGraphOpen] = useState(false);

  // The report's facts, each from its one home: the cause (the store's task
  // row), the answered gate and its card (the decision's detail feeder), and
  // every run on the same cause.
  const task = useInboxStore((s) => (run?.task_id ? (s.tasks as Record<string, any>)[run.task_id] : undefined)) as (ReportTask & { _id: string; title?: string; project_id?: string | null }) | undefined;
  const decisionRef = run?.gate_decision_short_id ?? run?.gate_decision_id;
  useSyncDecisionDetail(decisionRef);
  const detail = useDecisionDetail(decisionRef);
  const meId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const causeRuns = useCauseRuns(run?.task_id);
  // Re-render each minute so the outcome's watch day stays true.
  useCoarseNow(60_000);
  // Who answered the card, named in the path's Decide row.
  const answeredBy = detail?.decision?.status === "answered" ? answererNameOf(detail, meId) : null;
  const phases = useMemo(() => (run ? runPath(run as ReportRun, workflow, task, { answeredBy }) : []), [run, workflow, task, answeredBy]);
  // The project's Line tab, by its short id, named by its workspace when the
  // viewer is in another one (that page asks to switch there).
  const project = useInboxStore((s) => (task?.project_id ? ((s.projects as Record<string, { _id: string; short_id?: string; workspace?: string | null; team_id?: string | null }>)[task.project_id] ?? null) : null));
  const projectForeign = useForeignWorkspace(project);
  const projectTitle = useInboxStore((s) => (task?.project_id ? ((s.projects as Record<string, { title?: string }>)[task.project_id]?.title ?? null) : null));

  // Local-first (store respondToGate): the run flips to running on the press.
  const handleGateResponse = (text: string) => {
    if (!text.trim()) return;
    respondToGate(runId, text.trim());
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
  const line = isLineRun(run.node_statuses);
  const ended = run.status === "completed" || run.status === "failed";

  // The answered gate, in words (never a raw key), and its card.
  const decision = detail?.decision;
  const answer = run.gate_answer ? choiceWords(run.gate_answer) : null;
  const card = decision?.card ?? null;
  const prUrl = run.merge?.pr_url ?? card?.diff.pr;
  const taskRef = task?.short_id ?? run.task_short_id;
  const projectId = task?.project_id ?? null;
  // What the run cost, beside how long it took: the card's sum of its sessions.
  const costUsd = card?.cost.usd ?? run.card_cost_usd ?? null;
  // The card by what it decided; its key stays behind the link.
  const cardChip = run.gate_decision_short_id ? cardName(answer, card?.headline, run.status === "paused") : null;
  const earlier = causeRuns.filter((r) => r._id !== run._id);

  // The graph behind the toggle: the run's stored workflow, else the shipped
  // line for a line run, with each station's state painted on it.
  const graph = workflow?.nodes?.length ? workflow : line ? SHIPPED_LINE : null;
  const nodeStatuses = Object.fromEntries((run.node_statuses ?? []).map((n: any) => [n.node_id, n.status as NodeStatus]));
  // A line run says its state in the line's word (Shipped, Watching), the
  // same fact as the outcome sentence; another workflow keeps the engine's.
  // One duration: the card's agent minutes when the run has a card (its foot
  // says the same), else the wall time.
  const agentMin = card?.cost.minutes ?? null;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-sol-bg">
      <div ref={titlebarRef} className="flex items-center gap-3 px-5 py-3 border-b border-sol-border/20 bg-sol-bg-alt flex-shrink-0">
        <Link href={line ? "/line" : "/workflows"} className="text-sol-text-dim hover:text-sol-text transition-colors" title={line ? "Back to the line" : "Back to workflows"}>
          <ChevronLeft className="w-4 h-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-sol-text truncate">
              {run.task_title ?? task?.title ?? workflow?.name ?? run.workflow_name ?? "run"}
            </span>
            {/* A line run's state is the outcome sentence below; another workflow keeps the engine's word. */}
            {line ? null : (
              <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${st.color} ${st.bg}`}>
                <StatusIcon className={`w-3 h-3 ${run.status === "running" ? "animate-spin" : ""}`} />
                {run.status}
              </span>
            )}
          </div>
          {/* What ran, and how long and what it cost unless the card below says so. */}
          <p className="text-xs text-sol-text-dim mt-0.5 truncate" data-run-subtitle>
            {line ? `Line run${projectTitle ? ` on ${projectTitle}` : ""}` : `Run of ${workflow?.name ?? run.workflow_name ?? "a workflow"}`}
            {run.goal_override && !run.task_title ? `: ${run.goal_override}` : ""}
            {!card && (agentMin != null && !isActive
              ? <span title="Agent time summed over the run's sessions"> · {agentMin} agent min</span>
              : <span title="Wall time, start to end"> · {duration}</span>)}
            {!card && costUsd != null && costUsd > 0 && <span title="What the run's sessions cost"> · ${costUsd.toFixed(2)}</span>}
          </p>
        </div>
        <ShareControl label="workflow run" path={`/workflows/runs/${run._id}`} publicShare={{ kind: "run", id: run._id, token: (run as any).share_token }} />
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[60rem] mx-auto px-5 py-5 space-y-7">
          {/* What the run did and what is true now, then where each fact lives. */}
          <section data-run-report-head>
            <p className="text-[17px] leading-snug font-medium">
              <RunOutcomeText run={run as ReportRun} task={task} />
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {taskRef && <ReportChip href={`/tasks/${taskRef}`} title={run.task_title ?? task?.title}>{taskRef}{(run.task_title ?? task?.title) ? ` · ${run.task_title ?? task?.title}` : ""}</ReportChip>}
              {/* One chip for the card: it scrolls to the card below, which links its decision. */}
              {cardChip && (
                <ReportChip href={card ? "#run-card" : `/decisions/${run.gate_decision_short_id}`} tone={answer ? answerTone(answer) : "default"} title={card ? "The change and its proof, below" : "The decision this run asked"}>
                  {cardChip}
                </ReportChip>
              )}
              {/* What changed: the pull request when there is one, else the card's diff below. */}
              {card && (prUrl
                ? <ReportChip href={prUrl} external title="The change on GitHub">+{card.diff.added} −{card.diff.removed} in {card.diff.files} {card.diff.files === 1 ? "file" : "files"}</ReportChip>
                : <ReportChip href="#run-card-diff" title="The change's diff, on the card below">+{card.diff.added} −{card.diff.removed} in {card.diff.files} {card.diff.files === 1 ? "file" : "files"}</ReportChip>)}
              {line && (
                <ReportChip href={projectId ? lineTabHref(project?.short_id ?? projectId) : "/line"} title={`This project's line: its flow, stations and versions${projectForeign ? `, read from ${projectForeign.name}` : ""}`}>
                  {projectId ? "Line tab" : "the line"}
                </ReportChip>
              )}
            </div>
          </section>

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
                    className="flex-1 px-3 py-2 text-sm bg-sol-bg border border-sol-border/40 rounded-lg text-sol-text placeholder-sol-text-dim/50 focus:outline-none focus:border-sol-magenta/50 resize-none disabled:opacity-50"
                  />
                  <button
                    onClick={() => handleGateResponse(gateText)}
                    disabled={!gateText.trim()}
                    className="px-3 py-2 text-xs font-medium text-sol-magenta border border-sol-magenta/30 rounded-lg hover:bg-sol-magenta/10 transition-colors disabled:opacity-40 whitespace-nowrap"
                  >
                    Send
                  </button>
                </div>
              </div>
            </div>
          )}

          <ReportSection title="The path">
            <RunPathView phases={phases} ended={ended} />
          </ReportSection>

          {card && (
            <ReportSection
              title="The card"
              id="run-card"
              aside={run.gate_decision_short_id ? <Link href={`/decisions/${run.gate_decision_short_id}`} className="hover:text-sol-blue hover:underline" title={run.gate_decision_short_id} data-run-card-decision>Open the decision</Link> : undefined}
            >
              {/* Who answered is the path's Decide row and what shipped is the
                  outcome above, so an answered card carries no footer. */}
              <ChangeCardView card={card} density="inline" recommend={decision?.status !== "answered"} diffAnchor="run-card-diff" />
            </ReportSection>
          )}

          {earlier.length > 0 && (
            <ReportSection title={`${earlier.some((r) => r.created_at > run.created_at) ? "Other" : "Earlier"} runs on ${taskRef ?? "this cause"}`}>
              <CauseRunList runs={earlier} current={run._id} newest={Math.max(run.created_at, ...earlier.map((r) => r.created_at))} />
            </ReportSection>
          )}

          <section data-run-graph>
            <button type="button" onClick={() => setGraphOpen((o) => !o)} className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-sol-text-dim hover:text-sol-text-muted" aria-expanded={graphOpen} data-run-graph-toggle>
              <ChevronRight className={`w-3 h-3 transition-transform ${graphOpen ? "rotate-90" : ""}`} />
              {graphOpen ? "Hide the graph" : "Show the graph"}
            </button>
            {graphOpen && (
              <div className="mt-2 space-y-2">
                {graph && (
                  <div className="rounded-xl overflow-hidden border border-sol-border/30" style={{ height: 300 }}>
                    <WorkflowGraphView nodes={graph.nodes as WFNode[]} edges={(graph.edges ?? []) as any} nodeStatuses={nodeStatuses} currentNodeId={isActive ? run.current_node_id : undefined} fitPadding={0.08} fitLayers={6} fitAround={isActive ? run.current_node_id : undefined} minimap={false} />
                  </div>
                )}
                <div className="border border-sol-border/20 bg-sol-bg-alt rounded-xl overflow-hidden">
                  <WorkflowRunNodes run={run} workflow={workflow} className="p-2 space-y-2" />
                </div>
              </div>
            )}
          </section>

          <div className="flex items-center justify-between text-[11px] text-sol-text-dim pb-2">
            <span title={new Date(run.created_at).toLocaleString()}>started {shortDay(run.created_at)}, {new Date(run.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
            {run.primary_session_id && (
              <Link href={`/conversation/${run.primary_session_id}`} className="flex items-center gap-1 hover:text-sol-cyan transition-colors">
                <ExternalLink className="w-3 h-3" />
                primary session
              </Link>
            )}
          </div>
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
