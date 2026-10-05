"use client";
// A cause's story on its task page (the-line-model.md LM7, the-line-end-to-end
// LE16), in one block headed by the station strip: where it is now beside the
// current status, the goal it serves and how it was rated, the signals behind
// it, the card's answer, and every run with what it came to. Each fact is read
// from its one home (the task row, the signals, the runs); the card itself
// stays in the task's decisions below, so it is drawn once. A task the line
// never ran on gets the strip alone.
import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { StationStrip } from "./StationStrip";
import { isLineRun, lineRunOutcome } from "@codecast/shared/contracts/changeCard";
import type { TaskItem } from "../../store/inboxStore";
import { useSyncSignals, useWorkspaceSignals } from "../../hooks/useSyncSignals";
import { useGoalChip } from "../../hooks/useGoalChip";
import { useForeignWorkspace } from "../../hooks/useForeignWorkspace";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { ageShort, type LineCauseTask, type LineSignal } from "../../lib/lineFlow";
import { lineTabHref } from "../../lib/lineSettings";
import { causeWhere, choiceWords, shortDay, type ReportRun, type ReportTask } from "../../lib/line/runReport";
import { CauseRunList, ReportChip, answerTone, useCauseRuns } from "../line/RunReport";
import { cn } from "../../lib/utils";

type StoryTask = TaskItem & LineCauseTask & ReportTask & { review_verdict?: { verdict: string } | null };

const SIGNALS_SHOWN = 4;

/** The block, for a cause or a task the line has run on; the station strip
 *  alone otherwise. */
export function TaskLineStory({ task }: { task: StoryTask }) {
  const runs = useCauseRuns(task._id);
  const lineRuns = useMemo(() => runs.filter((r) => isLineRun(r.node_statuses)), [runs]);
  if (!task.cause && lineRuns.length === 0) return <StationStrip task={task as any} />;
  return <Story task={task} runs={lineRuns} />;
}

const TONE: Record<string, string> = { shipped: "text-sol-green", closed: "text-sol-text-muted", live: "text-sol-cyan", waiting: "text-sol-yellow", failed: "text-sol-red", calm: "text-sol-text" };

function Story({ task, runs }: { task: StoryTask; runs: ReportRun[] }) {
  useSyncSignals();
  const now = useCoarseNow(60_000);
  const allSignals = useWorkspaceSignals();
  const signals = useMemo(() => allSignals.filter((s) => s.task_id === task._id).sort((a, b) => b.created_at - a.created_at), [allSignals, task._id]);
  const goalWords = useGoalChip(task.goal_ref);
  // Signals live in the cause's workspace: from another one the count still
  // stands (task.cause) and links to the project's line, named by where it lives.
  const foreign = useForeignWorkspace(task as { workspace?: string | null; team_id?: string | null });
  const project = useInboxStore((st) => (task.project_id ? ((st.projects as Record<string, { _id: string; short_id?: string }>)[task.project_id] ?? null) : null));
  const latest = runs[0] ?? null;

  // Reopened: a signal flagged as reopening the cause after its newest ship.
  const lastShip = runs.map((r) => lineRunOutcome(r.node_statuses as any)).find((o) => o?.kind === "shipped")?.at ?? 0;
  const reopened = signals.some((s) => s.reopened && s.created_at > lastShip);
  const where = causeWhere(task, latest, reopened, now);

  const goal = task.goal_ref !== undefined ? goalWords : null;
  const cardRun = runs.find((r) => r.gate_decision_short_id && r.gate_node_id === "decide");
  const answer = cardRun?.gate_answer ? choiceWords(cardRun.gate_answer) : null;
  const sources = [...new Set(signals.map((s) => s.source))];

  return (
    <section className="mb-6 rounded-lg border border-sol-border/30 bg-sol-bg-alt/10" data-task-line-story>
      <StationStrip task={task as any} embedded aside={<span className={cn("text-[13px] font-medium", TONE[where.tone])} data-cause-where>{where.text}</span>} />
      <div className="px-4 pb-3 pt-1 space-y-3">
        {(goal || task.risk || task.category || task.readiness) && (
          <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-[12px]" data-cause-ground>
            {goal && <><dt className="text-sol-text-dim">Goal</dt><dd className={cn("min-w-0 truncate", goal.kind === "project" || goal.kind === "initiative" ? "text-sol-text" : "text-sol-text-dim")}>{goal.label}</dd></>}
            {(task.risk || task.category) && <><dt className="text-sol-text-dim">Kind</dt><dd className="text-sol-text-muted">{[task.category, task.risk && `${task.risk} risk`].filter(Boolean).join(" · ")}</dd></>}
            {task.readiness && <><dt className="text-sol-text-dim">Readiness</dt><Readiness readiness={task.readiness} note={task.readiness_note} /></>}
          </dl>
        )}

        {/* The count from the cause, with the signals behind it when this workspace can read them. */}
        {task.cause && (signals.length > 0 || task.cause.signal_count > 0) && (
          <div data-cause-signals>
            <div className="text-[12px] text-sol-text-muted">
              {task.cause.signal_count} {task.cause.signal_count === 1 ? "signal" : "signals"} since {shortDay(task.cause.first_seen)}
              {sources.length > 0 && <span className="text-sol-text-dim"> · from {sources.join(", ")}</span>}
              {signals.length === 0 && (project
                ? <Link href={lineTabHref(project.short_id ?? project._id)} className="text-sol-text-dim hover:text-sol-blue hover:underline" data-cause-signals-elsewhere> · on the project's line{foreign ? ` in ${foreign.name}` : ""}</Link>
                : foreign ? <span className="text-sol-text-dim"> · held in {foreign.name}</span> : null)}
            </div>
            <ul className="mt-1 space-y-0.5">
              {signals.slice(0, SIGNALS_SHOWN).map((s) => <SignalRow key={s._id} s={s} now={now} />)}
              {signals.length > SIGNALS_SHOWN && <li className="text-[11px] text-sol-text-dim pl-1">and {signals.length - SIGNALS_SHOWN} more in the last two weeks</li>}
            </ul>
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
      </div>
    </section>
  );
}

/** Readiness in one line; the note opens in full on a click. */
function Readiness({ readiness, note }: { readiness: string; note?: string | null }) {
  const [open, setOpen] = useState(false);
  const tone = readiness === "ready" ? "text-sol-text-muted" : "text-sol-yellow";
  const words = readiness.replace(/_/g, " ");
  if (!note) return <dd className={tone}>{words}</dd>;
  return (
    <dd className="min-w-0">
      <button type="button" onClick={() => setOpen((o) => !o)} className={cn("w-full text-left", open ? "whitespace-normal" : "truncate block")} aria-expanded={open} title={open ? undefined : note} data-cause-readiness>
        <span className={tone}>{words}</span>
        <span className="text-sol-text-dim">: {note}</span>
      </button>
    </dd>
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
