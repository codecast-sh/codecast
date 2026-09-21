"use client";
import { useMemo } from "react";
import Link from "next/link";
import { ArrowUpRight, GitBranch } from "lucide-react";
import { classifySession, useTrackedStore, type TaskItem } from "../../store/inboxStore";
import { useTeamTaskStatusList, statusVisual } from "../../lib/taskStatuses";
import { useWorkflow, useWorkflowRun } from "../../hooks/useSyncWorkflows";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { decisionHref } from "../../lib/decisionLinks";
import { ORG_STATE_META } from "../org/orgMeta";
import { useTaskHold } from "../../hooks/useTaskDecisions";
import {
  currentStationIndex,
  formatElapsed,
  handWorkState,
  heldDecisionFor,
  isLiveRun,
  lineChipText,
  runForTask,
  runLiveNode,
  stationLabel,
  stationOf,
  stationOrder,
  type LineTask,
} from "../../lib/taskLine";

// The task page as the line (docs/architecture/the-line.md L3, L5, L10): the
// team's statuses in order as a strip, the current one highlighted, a held
// marker on it when a blocking decision is bound there, and under it the
// run's live node, the hand working it, the elapsed time and the verdict.

const VERDICT_TONE: Record<string, string> = {
  approve: "border-sol-green/40 text-sol-green",
  changes: "border-sol-yellow/40 text-sol-yellow",
  reject: "border-sol-red/40 text-sol-red",
};

export function ReviewVerdictChip({ verdict, className = "" }: { verdict: { verdict: string; note?: string } | null | undefined; className?: string }) {
  if (!verdict) return null;
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] ${VERDICT_TONE[verdict.verdict] ?? "border-sol-border text-sol-text-dim"} ${className}`}
      title={verdict.note ? `Review: ${verdict.verdict}. ${verdict.note}` : `Review: ${verdict.verdict}`}
      data-review-verdict={verdict.verdict}
    >
      review · {verdict.verdict}
    </span>
  );
}

/** The hand: the session a run started for the node, as a link with its
 *  state as a stripe. Reads the live store row when the client holds it,
 *  else the run's own enrichment. */
function HandLink({ conversationId, sessionId, fallbackTitle, isActive }: { conversationId?: string; sessionId?: string; fallbackTitle?: string; isActive?: boolean }) {
  const s = useTrackedStore([
    (st) => {
      const r = conversationId ? st.sessions[conversationId] : sessionId ? Object.values(st.sessions).find((x: any) => x.session_id === sessionId) : undefined;
      return r ? `${r._id}|${r.title}|${r.is_idle ? 1 : 0}|${r.agent_status ?? ""}|${r.awaiting_input ? 1 : 0}|${r.is_unresponsive ? 1 : 0}|${r.is_connected ? 1 : 0}` : "";
    },
  ]);
  const row = conversationId ? s.sessions[conversationId] : sessionId ? Object.values(s.sessions).find((x: any) => x.session_id === sessionId) : undefined;
  const state = handWorkState(row ? classifySession(row) : null, { is_active: isActive });
  const meta = ORG_STATE_META[state];
  const href = `/conversation/${row?._id ?? conversationId ?? sessionId}`;
  return (
    <Link href={href} className="inline-flex items-center gap-1.5 min-w-0 max-w-[16rem] hover:text-sol-blue" title={`${meta.label}: open the session`} data-hand-state={state}>
      <span className="w-[3px] h-3 rounded-full shrink-0" style={{ background: meta.color }} aria-hidden />
      <span className="truncate">{row?.title || fallbackTitle || "the hand"}</span>
      <ArrowUpRight className="w-3 h-3 shrink-0 text-sol-text-dim" />
    </Link>
  );
}

export function StationStrip({ task }: { task: TaskItem & LineTask }) {
  const statuses = useTeamTaskStatusList(task.team_id);
  const stations = useMemo(() => stationOrder(statuses), [statuses]);
  const cur = currentStationIndex(task, stations);
  const held = useTaskHold(task);
  // Feeder and reader in one: the task's run, enriched with node sessions.
  const run = useWorkflowRun(task.workflow_run_id);
  // workflow_runs.get hands back the raw row: the node label lives on the
  // workflow, so resolve it there, the same way the run panel below does.
  const workflow = useWorkflow(run?.workflow_id);
  const node = runLiveNode(run, workflow?.nodes);
  const live = isLiveRun(run);
  const now = useCoarseNow(30_000);
  const elapsed = live ? formatElapsed(node?.started_at, now) : null;
  const verdict = task.review_verdict ?? null;
  const showDetail = (live && node) || verdict;

  return (
    <div className="mb-4 rounded-lg border border-sol-border/30 bg-sol-bg-alt/20" data-station-strip={stations[cur]?.id ?? ""}>
      <div className="flex items-center overflow-x-auto px-2 pt-2 pb-1.5 [scrollbar-width:thin]" role="list" aria-label="Stations">
        {stations.map((s, i) => {
          const v = statusVisual(s, stations);
          const Icon = v.icon;
          const isCur = i === cur;
          const tone = isCur ? `${v.bg} ${v.border} ${v.color}` : i < cur ? "border-transparent text-sol-text-muted" : "border-transparent text-sol-text-dim";
          return (
            <div key={s.id} className="flex items-center shrink-0" role="listitem" data-station={s.id} data-current={isCur || undefined}>
              {i > 0 && <span className={`w-3 h-px shrink-0 ${i <= cur ? "bg-sol-border" : "bg-sol-border/40"}`} aria-hidden />}
              <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] whitespace-nowrap ${tone}`} aria-current={isCur ? "step" : undefined}>
                <Icon className="w-3.5 h-3.5" />
                {s.name}
                {isCur && held && (
                  <Link
                    href={decisionHref(held)}
                    className="ml-1 inline-flex items-center gap-1 px-1.5 py-px rounded border border-sol-yellow/40 text-[10px] text-sol-yellow hover:bg-sol-yellow/10"
                    title={`Held here by ${held.short_id ?? "a decision"}: ${held.question}`}
                    data-held-by={held.short_id ?? held._id}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse" />
                    held · {held.short_id ?? "decision"}
                  </Link>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {showDetail && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2 text-[11px] text-sol-text-muted" data-station-detail>
          {live && node && (
            <span className="inline-flex items-center gap-1.5 min-w-0" title={run?.workflow_name ? `Run of ${run.workflow_name}` : "Run"} data-live-node={node.id}>
              <GitBranch className="w-3 h-3 text-sol-violet shrink-0" />
              <span className="text-sol-violet truncate">{node.label}</span>
              {run?.status === "paused" && <span className="text-sol-orange">at a gate</span>}
            </span>
          )}
          {live && node && (node.session?._id || node.session_id) && (
            <HandLink conversationId={node.session?._id} sessionId={node.session_id} fallbackTitle={node.session?.title} isActive={node.session?.is_active} />
          )}
          {elapsed && <span className="text-sol-text-dim" title="Time on this node">{elapsed}</span>}
          <ReviewVerdictChip verdict={verdict} />
        </div>
      )}
    </div>
  );
}

/** L10: the list row's chip. "held at <station>" when a blocking decision
 *  holds the task, else "at <station> · <node>" for a live run, else nothing.
 *  Subscribes to the chip text alone, so a row wakes only when it changes. */
// One index per collection object: the store hands out a new collection ref
// only when a row changed, so every chip in a long list reads its task's rows
// in constant time instead of scanning the whole collection on each tick.
const byTaskIndex = new WeakMap<object, Map<string, any[]>>();
function rowsByTask(collection: Record<string, any>, keep: (row: any) => boolean): Map<string, any[]> {
  const cached = byTaskIndex.get(collection);
  if (cached) return cached;
  const index = new Map<string, any[]>();
  for (const key in collection) {
    const row = collection[key];
    if (!row?.task_id || !keep(row)) continue;
    const list = index.get(row.task_id) ?? [];
    list.push(row);
    index.set(row.task_id, list);
  }
  byTaskIndex.set(collection, index);
  return index;
}
const isOpenHold = (d: any) => d.status === "pending" && !!d.blocking;
const anyRun = () => true;

export function TaskLineChip({ task, className = "" }: { task: TaskItem & LineTask; className?: string }) {
  const statuses = useTeamTaskStatusList(task.team_id);
  const station = stationLabel(stationOf(task), statuses);
  const dep = useMemo(() => (st: any) => {
    const held = heldDecisionFor(task, rowsByTask(st.sessionDecisions, isOpenHold).get(task._id) ?? []);
    const named = task.workflow_run_id ? st.workflowRuns[task.workflow_run_id] : undefined;
    const runs = rowsByTask(st.workflowRuns, anyRun).get(task._id) ?? [];
    const run = runForTask(task, named && !runs.includes(named) ? [named, ...runs] : runs);
    const text = lineChipText({ station, held, run });
    return text ? `${text}|${held ? "held" : run!.status}` : "";
  }, [task._id, task.status, task.status_id, task.workflow_run_id, station]);
  const s = useTrackedStore([dep]);
  const [text, tone] = dep(s).split("|");
  if (!text) return null;
  const held = tone === "held";
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] shrink-0 truncate max-w-[14rem] ${held ? "border-sol-yellow/40 text-sol-yellow" : tone === "paused" ? "border-sol-orange/40 text-sol-orange" : "border-sol-violet/40 text-sol-violet"} ${className}`}
      title={held ? "A blocking decision holds this task at its station" : "On the line: the run's current node"}
      data-task-line-chip={held ? "held" : "run"}
    >
      {held ? <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse" /> : <GitBranch className="w-3 h-3" />}
      {text}
    </span>
  );
}
