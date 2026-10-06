"use client";
// A cause's story on its task page (the-line-model.md LM7, the-line-end-to-end
// LE16), in one block: the station strip while a run is live, else the newest
// run's phases at a glance; where the cause is now; the goal it serves (when
// that is more than its project), the expectation its signals say it breaks
// and how it was rated; the signals behind it,
// read in the cause's own workspace; the card by what it decided; and every
// run with what it came to. Each fact is read from its one home (the task row,
// the signals, the runs, the decision); the card itself stays in the task's
// decisions below, so it is drawn once. A task the line never ran on gets the
// strip alone.
import { useMemo } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { StationStrip } from "./StationStrip";
import { isLineRun, lineRunOutcome } from "@codecast/shared/contracts/changeCard";
import { isExpectationId } from "@codecast/shared/contracts/expectations";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { lineTabHref } from "../../lib/lineSettings";
import type { TaskItem } from "../../store/inboxStore";
import { useSyncSignals, useWorkspaceSignals } from "../../hooks/useSyncSignals";
import { useGoalChip } from "../../hooks/useGoalChip";
import { useSyncDecisionDetail, useDecisionDetail } from "../../hooks/useSyncDecisionDetail";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { ageShort, type LineCauseTask, type LineSignal } from "../../lib/lineFlow";
import { cardName, causeWhere, choiceWords, runPath, shortDay, type ReportRun, type ReportTask } from "../../lib/line/runReport";
import { CauseRunList, PhaseStrip, ReportChip, answerTone, useCauseRuns } from "../line/RunReport";
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
  // The signals are read where the cause lives, whichever workspace is active.
  const workspace = (task as { workspace?: string | null }).workspace ?? null;
  useSyncSignals(workspace);
  const now = useCoarseNow(60_000);
  const allSignals = useWorkspaceSignals(workspace);
  const signals = useMemo(() => allSignals.filter((s) => s.task_id === task._id).sort((a, b) => b.created_at - a.created_at), [allSignals, task._id]);
  const goalWords = useGoalChip(task.goal_ref);
  const latest = runs[0] ?? null;

  // Reopened: a signal flagged as reopening the cause after its newest ship.
  const lastShip = runs.map((r) => lineRunOutcome(r.node_statuses as any)).find((o) => o?.kind === "shipped")?.at ?? 0;
  const reopened = signals.some((s) => s.reopened && s.created_at > lastShip);
  const where = causeWhere(task, latest, reopened, now);

  // The goal row says what the project chip above does not: a goal that is
  // the project itself is already said there.
  const goal = task.goal_ref !== undefined && task.goal_ref !== task.project_id ? goalWords : null;
  const cardRun = runs.find((r) => r.gate_decision_short_id && r.gate_node_id === "decide");
  const answer = cardRun?.gate_answer ? choiceWords(cardRun.gate_answer) : null;
  useSyncDecisionDetail(cardRun?.gate_decision_short_id);
  const card = useDecisionDetail(cardRun?.gate_decision_short_id)?.decision?.card ?? null;
  const sources = [...new Set(signals.map((s) => s.source))];
  // A finder that judges behavior names the line it broke as the signal's
  // subject (LM5); the words are read from that line's own document.
  const cited = useMemo(() => [...new Set(signals.map((s) => s.subject).filter(isExpectationId))], [signals]);
  const { data: lines } = useQueryNoThrow((api as any).expectations.lines, cited.length > 0 && workspace ? { workspace, ids: cited } : "skip");
  const live = !!latest && (latest.status === "running" || latest.status === "paused" || latest.status === "pending");
  // Once no run is live, the newest run's shape stands in for the strip.
  const phases = useMemo(() => (latest && !live ? runPath(latest, null, task) : null), [latest, live, task]);
  const watching = task.status === "done" && !!task.watch_until && task.watch_until > now;
  const whereLine = <span className={cn("text-[13px] font-medium", TONE[where.tone])} data-cause-where>{where.text}</span>;
  // Readiness is about admission: once the cause is closed it has no more to say.
  const readiness = task.status === "done" || task.status === "dropped" ? null : task.readiness ?? null;
  const kind = [task.category, task.risk && `${task.risk} risk`].filter(Boolean).join(" · ");

  return (
    <section className="mb-6 rounded-lg border border-sol-border/30 bg-sol-bg-alt/10" data-task-line-story>
      {live ? <StationStrip task={task as any} embedded aside={whereLine} /> : (
        <div className="px-4 pt-3 pb-1 space-y-2" data-cause-head>
          {phases && <PhaseStrip phases={phases} tail={watching ? <span className="inline-flex items-center gap-1.5" data-strip-watch><span className="w-1.5 h-1.5 rounded-full bg-sol-cyan animate-pulse" aria-hidden />Watch</span> : undefined} />}
          <div>{whereLine}</div>
        </div>
      )}
      <div className="px-4 pb-3 pt-1 space-y-3">
        {(goal || kind || readiness || cited.length > 0) && (
          <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-[12px]" data-cause-ground>
            {goal && <><dt className="text-sol-text-dim">Goal</dt><dd className={cn("min-w-0 truncate", goal.kind === "project" || goal.kind === "initiative" ? "text-sol-text" : "text-sol-text-dim")}>{goal.label}</dd></>}
            {cited.map((id) => <ExpectationRow key={id} id={id} line={(lines as ExpectationLine[] | undefined)?.find((l) => l.id === id)} />)}
            {kind && <><dt className="text-sol-text-dim">Kind</dt><dd className="text-sol-text-muted">{kind}</dd></>}
            {readiness && <><dt className="text-sol-text-dim">Readiness</dt><dd className={readiness === "ready" ? "text-sol-text-muted" : "text-sol-yellow"} title={task.readiness_note ?? undefined} data-cause-readiness>{readinessWords(readiness, task.readiness_note)}</dd></>}
          </dl>
        )}

        {/* The count from the cause, with the signals behind it when this workspace can read them. */}
        {task.cause && (signals.length > 0 || task.cause.signal_count > 0) && (
          <div data-cause-signals>
            <div className="text-[12px] text-sol-text-muted">
              {task.cause.signal_count} {task.cause.signal_count === 1 ? "signal" : "signals"} since {shortDay(task.cause.first_seen)}
              {sources.length > 0 && <span className="text-sol-text-dim"> · from {sources.join(", ")}</span>}
            </div>
            <ul className="mt-1 space-y-0.5">
              {signals.slice(0, SIGNALS_SHOWN).map((s) => <SignalRow key={s._id} s={s} now={now} />)}
              {signals.length > SIGNALS_SHOWN && <li className="text-[11px] text-sol-text-dim pl-1">and {signals.length - SIGNALS_SHOWN} more in the last two weeks</li>}
            </ul>
          </div>
        )}

        {cardRun && (
          <div className="flex items-center gap-2 text-[12px] min-w-0" data-cause-card>
            <span className="shrink-0 text-sol-text-dim">Card</span>
            <ReportChip href={`/decisions/${cardRun.gate_decision_short_id}`} tone={answerTone(answer)} title="Open the decision">
              {cardName(answer, card, cardRun.gate_decision_status === "pending")}
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

type ExpectationLine = { id: string; text: string; status: "active" | "retired"; project_id: string; project_short_id?: string; project_title: string };

/** The line a cause breaks: its words, and its id opening it among the
 *  project's expectations. Until the words arrive the id stands alone. */
function ExpectationRow({ id, line }: { id: string; line?: ExpectationLine }) {
  const chip = "shrink-0 font-mono text-[11px] text-sol-text-dim";
  return (
    <>
      <dt className="text-sol-text-dim">Expects</dt>
      <dd className="min-w-0 flex items-baseline gap-2" data-cause-expectation={id}>
        {line && <span className="min-w-0 text-sol-text leading-snug">{line.text}{line.status === "retired" && <span className="text-sol-text-dim"> (retired since)</span>}</span>}
        {line
          ? <Link href={`${lineTabHref(line.project_short_id ?? line.project_id)}#${id}`} className={cn(chip, "hover:text-sol-blue hover:underline")} title={`Open this line in the expectations of ${line.project_title}`}>{id}</Link>
          : <span className={chip}>{id}</span>}
      </dd>
    </>
  );
}

/** Readiness in one short sentence; the ground note behind it shows on hover. */
function readinessWords(readiness: string, note?: string | null): string {
  if (readiness === "ready") return "Ready to build.";
  // A note's first clause says what is missing.
  const why = note?.split(/[;.]\s/)[0]?.trim();
  return `Not ready${why ? `: ${why.charAt(0).toLowerCase()}${why.slice(1)}` : ""}.`.replace(/\.\.$/, ".");
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
