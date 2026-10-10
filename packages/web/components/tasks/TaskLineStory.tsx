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
import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { findingStepId } from "../../lib/line/loopSteps";
import { lineLabelKey } from "../../lib/line/lineLabels";
import { StationStrip } from "./StationStrip";
import { isLineRun, lineRunOutcome } from "@codecast/shared/contracts/changeCard";
import { isExpectationId } from "@codecast/shared/contracts/expectations";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { expectationsHref } from "../../lib/expectations/view";
import { lineRefHref } from "../../lib/line/lineWorkspaceUrl";
import type { TaskItem } from "../../store/inboxStore";
import { useSyncSignals, useWorkspaceSignals } from "../../hooks/useSyncSignals";
import { useGoalChip } from "../../hooks/useGoalChip";
import { useSyncDecisionDetail, useDecisionDetail } from "../../hooks/useSyncDecisionDetail";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { admissionHold, ageShort, findingJudgeWords, findingReviewWords, type LineCauseTask, type LineSignal } from "../../lib/lineFlow";
import { finderWords } from "../../lib/line/lineTrace";
import { cardName, causeWhere, choiceWords, runPath, shortDay, type ReportRun, type ReportTask } from "../../lib/line/runReport";
import { CauseRunList, PhaseStrip, ReportChip, answerTone, useCauseRuns } from "../line/RunReport";
import { useLineAdmission } from "../line/map/useLineAdmission";
import { LineStartSwitch } from "../line/map/LineStartSwitch";
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
  // A line that starts nothing until a person acts says so, with its switch at hand (LL5).
  const admit = useLineAdmission(task.project_id ?? null);
  const stopped = admit.admission ? admissionHold(admit.admission)?.stopped ?? null : null;
  const where = causeWhere(task, latest, reopened, now, stopped);
  const [switchOpen, setSwitchOpen] = useState(false);
  const offLine = !!stopped && !!admit.admission?.role && !admit.admission.role.paused && !admit.admission.on && where.text.startsWith("Not started");

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
  // The where sentence, and the trace (line-map.md LX4): the cause's whole story, step by step.
  const whereLine = (
    <span className="inline-flex items-baseline gap-3 min-w-0">
      <span className={cn("text-[13px] font-medium", TONE[where.tone])} data-cause-where>{where.text}</span>
      {(offLine || switchOpen) && (
        <button type="button" onClick={() => setSwitchOpen((o) => !o)} aria-expanded={switchOpen} className="shrink-0 text-[11.5px] text-sol-blue hover:underline" data-cause-start-switch>
          {switchOpen ? "Hide the switch" : "Start problems on their own"}
        </button>
      )}
      <Link href={lineRefHref(task.short_id || task._id)} className="shrink-0 inline-flex items-center gap-0.5 text-[11.5px] text-sol-text-dim hover:text-sol-blue" title="This problem's life on its line: every report, every attempt to fix it, ships, deploys and what came back" data-cause-trace>Timeline<ArrowUpRight className="w-3 h-3" /></Link>
    </span>
  );
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
      {switchOpen && admit.admission?.role && (
        <div className="mx-4 mb-2 mt-1 rounded-md border border-sol-border/40 bg-sol-bg-alt/40 px-3 py-2" data-cause-switch-panel>
          <LineStartSwitch admit={admit} compact />
        </div>
      )}
      <div className="px-4 pb-3 pt-1 space-y-3">
        {(goal || kind || readiness || cited.length > 0) && (
          <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-[12px]" data-cause-ground>
            {goal && <><dt className="text-sol-text-dim">Goal</dt><dd className={cn("min-w-0 truncate", goal.kind === "project" || goal.kind === "initiative" || goal.kind === "line" ? "text-sol-text" : "text-sol-text-dim")}>{goal.label}</dd></>}
            {lines !== undefined && cited.map((id) => <ExpectationRow key={id} id={id} line={(lines as ExpectationLine[] | null)?.find((l) => l.id === id)} />)}
            {kind && <><dt className="text-sol-text-dim">Kind</dt><dd className="text-sol-text-muted">{kind}</dd></>}
            {readiness && <><dt className="text-sol-text-dim">Readiness</dt><dd className={readiness === "ready" ? "text-sol-text-muted" : "text-sol-yellow"} title={task.readiness_note ?? undefined} data-cause-readiness>{readinessWords(readiness, task.readiness_note)}</dd></>}
          </dl>
        )}

        {/* The count from the cause, with the signals behind it when this workspace can read them. */}
        {task.cause && (signals.length > 0 || task.cause.signal_count > 0) && (
          <div data-cause-signals>
            <div className="text-[12px] text-sol-text-muted">
              {task.cause.signal_count} {task.cause.signal_count === 1 ? "report" : "reports"} since {shortDay(task.cause.first_seen)}
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
 *  project's expectations. Drawn once the words are read; a bare id says
 *  nothing to a person (LL6), so a line that is gone says so instead. */
function ExpectationRow({ id, line }: { id: string; line?: ExpectationLine }) {
  // The words are the row; the line's id is for the hover, never trailing text (LL6).
  return (
    <>
      <dt className="text-sol-text-dim">Expects</dt>
      <dd className="min-w-0" data-cause-expectation={id}>
        {line
          ? (
            <Link href={expectationsHref(line.project_short_id ?? line.project_id, id)} className="text-sol-text leading-snug hover:text-sol-blue hover:underline decoration-sol-border" title={`${id}, in the expectations of ${line.project_title}`}>
              {line.text}{line.status === "retired" && <span className="text-sol-text-dim"> (retired since)</span>}
            </Link>
          )
          : <span className="text-sol-text-dim" title={id}>Expectation not found</span>}
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

/** A finding behind the problem: the row opens its trace (line-map.md LX4),
 *  and the arrow goes back to where it was seen. A judge's finding also says,
 *  under its title, what the judge saw in its own words, and where a finding
 *  marked wrong stands (learning-loop.md LL3, LL11). */
function SignalRow({ s, now }: { s: LineSignal; now: number }) {
  const judged = findingJudgeWords(s);
  const said = s.judge ? finderWords(s.detail_md, isExpectationId(s.subject) ? s.subject! : null) : null;
  const review = findingReviewWords(s);
  return (
    <li className="flex items-baseline gap-1 rounded hover:bg-sol-bg-alt/60 min-w-0" data-cause-signal={s.short_id ?? s._id}>
      <Link href={lineRefHref(s.short_id || s._id)} className="flex-1 min-w-0 px-1 py-0.5 text-[12px]" title="This finding's problem on its line" data-signal-trace>
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="w-20 shrink-0 truncate text-sol-text-dim" title={s.source}>{s.source}</span>
          <span className="min-w-0 truncate text-sol-text">{s.title}</span>
          {judged && <span className="shrink-0 text-sol-text-dim" data-signal-judge>{judged}</span>}
          {s.reopened && <span className="shrink-0 text-sol-red">reopened it</span>}
          <span className="ml-auto shrink-0 text-sol-text-dim tabular-nums">{ageShort(now - s.created_at)} ago</span>
        </span>
        {said && <span className="block pl-[5.5rem] truncate text-[11.5px] text-sol-text-muted" title={said} data-signal-said>{said}</span>}
        {review && <span className={cn("block pl-[5.5rem] text-[11.5px] leading-snug", s.judge_review?.state === "failed" ? "text-sol-red" : s.judge_review?.state === "diagnosed" ? "text-sol-text-muted" : "text-sol-yellow")} data-signal-review>{review}</span>}
      </Link>
      {s.judge && !s.case_of && <WrongControl s={s} />}
      {s.evidence_url && (
        <a href={s.evidence_url} target="_blank" rel="noreferrer" className="shrink-0 px-1 text-sol-text-dim hover:text-sol-blue" title="Where it was seen" data-signal-evidence>
          <ArrowUpRight className="w-3 h-3" />
        </a>
      )}
    </li>
  );
}

/** Marks a judge's finding wrong (learning-loop.md LL4): the finding is the
 *  judge step's decision, so this is the line's own label on it
 *  (labelDecision, line-workspace.md LW4), which starts the judge's diagnosis.
 *  Once the finding carries a review, its line under the title says where it
 *  stands, so the control steps aside unless the mark is this person's to undo. */
function WrongControl({ s }: { s: LineSignal }) {
  const step = findingStepId(s);
  const me = useInboxStore((st) => (st as { currentUser?: { _id: string } | null }).currentUser?._id ?? null);
  const key = me ? lineLabelKey(s._id, step, me) : null;
  const mine = useInboxStore((st) => {
    if (!key) return null;
    const labels = (st as { lineLabels?: Record<string, { key: string; verdict: string }> }).lineLabels ?? {};
    for (const l of Object.values(labels)) if (l.key === key) return l.verdict;
    return null;
  });
  const label = (verdict: "wrong" | null) => useInboxStore.getState().labelDecision(s._id, step, verdict);
  const btn = "shrink-0 rounded px-1.5 py-0.5 text-[11px] text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sol-blue/40";
  if (mine === "wrong") {
    return (
      <span className="shrink-0 inline-flex items-baseline gap-1 text-[11px]" data-signal-marked>
        <span className="text-sol-yellow">Marked wrong</span>
        <button type="button" onClick={() => label(null)} className={btn}>Undo</button>
      </span>
    );
  }
  if (s.judge_review && s.judge_review.state !== "failed") return null;
  return (
    <button type="button" onClick={() => label("wrong")} className={btn} title={`The ${s.judge} judge got this one wrong: a session finds out why and fixes the judge`} data-signal-wrong>
      Mark wrong
    </button>
  );
}
