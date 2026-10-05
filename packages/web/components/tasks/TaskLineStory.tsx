"use client";
// A cause's story on its task page (the-line-model.md LM7, the-line-end-to-end
// LE16), in one block under the station strip: where it is now, the goal it
// serves and how it was rated, the signals behind it, the card's answer, and
// every run with what it came to. Each fact is read from its one home (the
// task row, the signals, the runs); the card itself stays in the task's
// decisions below, so it is drawn once.
import { useMemo } from "react";
import { ArrowUpRight } from "lucide-react";
import { isLineRun, lineRunOutcome } from "@codecast/shared/contracts/changeCard";
import type { TaskItem } from "../../store/inboxStore";
import { useSyncSignals, useWorkspaceSignals } from "../../hooks/useSyncSignals";
import { useInitiatives } from "../../hooks/useInitiatives";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { goalChip, ageShort, type GoalRow, type LineCauseTask, type LineSignal } from "../../lib/lineFlow";
import { causeWhere, choiceWords, shortDay, type ReportRun, type ReportTask } from "../../lib/line/runReport";
import { CauseRunList, ReportChip, answerTone, useCauseRuns } from "../line/RunReport";
import { cn } from "../../lib/utils";

type StoryTask = TaskItem & LineCauseTask & ReportTask & { review_verdict?: { verdict: string } | null };

const SIGNALS_SHOWN = 4;

/** The block, for a cause or a task the line has run on; nothing otherwise. */
export function TaskLineStory({ task }: { task: StoryTask }) {
  const runs = useCauseRuns(task._id);
  const lineRuns = useMemo(() => runs.filter((r) => isLineRun(r.node_statuses)), [runs]);
  if (!task.cause && lineRuns.length === 0) return null;
  return <Story task={task} runs={lineRuns} />;
}

const TONE: Record<string, string> = { shipped: "text-sol-green", closed: "text-sol-text-muted", live: "text-sol-cyan", waiting: "text-sol-yellow", failed: "text-sol-red", calm: "text-sol-text" };

function Story({ task, runs }: { task: StoryTask; runs: ReportRun[] }) {
  useSyncSignals();
  const now = useCoarseNow(60_000);
  const allSignals = useWorkspaceSignals();
  const signals = useMemo(() => allSignals.filter((s) => s.task_id === task._id).sort((a, b) => b.created_at - a.created_at), [allSignals, task._id]);
  const initiatives = useInitiatives();
  const projects = useWorkspaceCollection<GoalRow & { _id: string }>("projects");
  const latest = runs[0] ?? null;

  // Reopened: a signal flagged as reopening the cause after its newest ship.
  const lastShip = runs.map((r) => lineRunOutcome(r.node_statuses as any)).find((o) => o?.kind === "shipped")?.at ?? 0;
  const reopened = signals.some((s) => s.reopened && s.created_at > lastShip);
  const where = causeWhere(task, latest, reopened, now);

  const goal = task.goal_ref !== undefined ? goalChip(task.goal_ref, initiatives as GoalRow[], projects) : null;
  const cardRun = runs.find((r) => r.gate_decision_short_id && r.gate_node_id === "decide");
  const answer = cardRun?.gate_answer ? choiceWords(cardRun.gate_answer) : null;
  const sources = [...new Set(signals.map((s) => s.source))];

  return (
    <section className="mb-6 rounded-lg border border-sol-border/30 bg-sol-bg-alt/10 px-4 py-3 space-y-3" data-task-line-story>
      <div className="flex items-baseline gap-3 flex-wrap">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-sol-text-dim">The line</h3>
        <span className={cn("text-[13.5px] font-medium", TONE[where.tone])} data-cause-where>{where.text}</span>
      </div>

      {(goal || task.risk || task.category || task.readiness) && (
        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1 text-[12px]" data-cause-ground>
          {goal && <><dt className="text-sol-text-dim">Goal</dt><dd className={cn("min-w-0 truncate", goal.kind === "parked" || goal.kind === "ungrounded" ? "text-sol-text-dim" : "text-sol-text")} title={goal.ref}>{goal.label}</dd></>}
          {(task.risk || task.category) && <><dt className="text-sol-text-dim">Kind</dt><dd className="text-sol-text-muted">{[task.category, task.risk && `${task.risk} risk`].filter(Boolean).join(" · ")}</dd></>}
          {task.readiness && <><dt className="text-sol-text-dim">Readiness</dt><dd className={task.readiness === "ready" ? "text-sol-text-muted" : "text-sol-yellow"}>{task.readiness.replace(/_/g, " ")}{task.readiness_note ? `: ${task.readiness_note}` : ""}</dd></>}
        </dl>
      )}

      {task.cause && (
        <div data-cause-signals>
          <div className="text-[12px] text-sol-text-muted">
            {task.cause.signal_count} {task.cause.signal_count === 1 ? "signal" : "signals"} since {shortDay(task.cause.first_seen)}
            {sources.length > 0 && <span className="text-sol-text-dim"> · from {sources.join(", ")}</span>}
          </div>
          {signals.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {signals.slice(0, SIGNALS_SHOWN).map((s) => <SignalRow key={s._id} s={s} now={now} />)}
              {signals.length > SIGNALS_SHOWN && <li className="text-[11px] text-sol-text-dim pl-1">and {signals.length - SIGNALS_SHOWN} more in the last two weeks</li>}
            </ul>
          )}
        </div>
      )}

      {cardRun && (
        <div className="flex items-center gap-2 text-[12px]" data-cause-card>
          <span className="text-sol-text-dim">Card</span>
          <ReportChip href={`/decisions/${cardRun.gate_decision_short_id}`} tone={answerTone(answer)}>
            {cardRun.gate_decision_short_id} · {answer ? `answered ${answer}` : cardRun.gate_decision_status === "pending" ? "waiting on an answer" : cardRun.gate_decision_status ?? "asked"}
          </ReportChip>
        </div>
      )}

      {runs.length > 0 && (
        <div data-cause-run-list>
          <div className="text-[12px] text-sol-text-dim mb-0.5">{runs.length === 1 ? "One run" : `${runs.length} runs`}, newest first</div>
          <CauseRunList runs={runs} task={task} />
        </div>
      )}
    </section>
  );
}

function SignalRow({ s, now }: { s: LineSignal; now: number }) {
  const body = (
    <>
      <span className="w-14 shrink-0 text-sol-text-dim">{s.source}</span>
      <span className="min-w-0 truncate text-sol-text">{s.title}</span>
      {s.reopened && <span className="shrink-0 text-sol-red">reopened it</span>}
      <span className="ml-auto shrink-0 text-sol-text-dim tabular-nums">{ageShort(now - s.created_at)} ago</span>
      {s.evidence_url && <ArrowUpRight className="w-3 h-3 shrink-0 text-sol-text-dim" />}
    </>
  );
  const cls = "flex items-baseline gap-2 px-1 py-0.5 rounded text-[12px] min-w-0";
  return (
    <li data-cause-signal={s.short_id ?? s._id}>
      {s.evidence_url
        ? <a href={s.evidence_url} target="_blank" rel="noreferrer" className={cn(cls, "hover:bg-sol-bg-alt/60")} title="Where it was seen">{body}</a>
        : <div className={cls}>{body}</div>}
    </li>
  );
}
