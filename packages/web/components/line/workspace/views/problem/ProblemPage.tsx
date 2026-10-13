"use client";
// One problem's page (line-journeys.md LJ8.3). Its job: decide whether this
// problem is real and is being handled. Top to bottom: what is wrong in one
// line; where its newest run stands (StageTrack, the one statement of state);
// the act band (what waits on a person, answerable here, or the facts that
// show nothing is owed); the findings as real things, each opened in place;
// and what the line did about it, run by run. Nothing else.
import { useCallback, useMemo } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { useCollectionRows } from "../../../../../hooks/useCollectionRows";
import { useEventListener } from "../../../../../hooks/useEventListener";
import { useOpenFixDecision } from "../../../../../hooks/useFixDecision";
import { useTabActive } from "../../../../../hooks/usePagePresence";
import { useSyncTaskSignals } from "../../../../../hooks/useSyncSignals";
import { decisionRef } from "../../../../../lib/line/fixDecision";
import { lineFilterParam } from "../../../../../lib/line/lineWorkspaceUrl";
import { needOfCase } from "../../../../../lib/line/lineNeeds";
import type { LineIssue } from "../../../../../lib/line/lineModel";
import { bandLine, dayWords, movedOut, problemBand, problemHeading, runMovedTo, workRows, type BandNote, type BandTask } from "../../../../../lib/line/problemPage";
import { stageTrack, type StageOf } from "../../../../../lib/line/stageTrack";
import { homeExpectation, offTopicComebacks, withoutOffTopic, type TopicSignal } from "../../../../../lib/line/timeline";
import { hasOpenModal } from "../../../../../shortcuts";
import { keyBelongsElsewhere } from "../../../../../shortcuts/keyOwnership";
import { useInboxStore } from "../../../../../store/inboxStore";
import type { ReaderSignal } from "../../../widgets/FindingReader";
import { StageTrack } from "../../../widgets/StageTrack";
import { LineDecisionPrefetch } from "../../../widgets/LineDecision";
import type { LineViewProps } from "../types";
import { ProblemBand } from "./ProblemBand";
import { ProblemFindings, type FixMark } from "./ProblemFindings";
import { ProblemWork } from "./ProblemWork";
import "./problem.css";

const signalSig = (s: ReaderSignal & { retired?: unknown }) => `${s._id}|${s.observed_at ?? 0}|${s.subject ?? ""}|${s.judge ?? ""}|${s.judge_review?.state ?? ""}|${(s.detail_md ?? "").length}|${s.retired ? 1 : 0}`;
/** Focus inside a decision or a need's reader: its own keys answer it, so the page's keys stand down (LJ5). */
const inReader = (t: EventTarget | null) => !!(t as Element | null)?.closest?.(".ld, .lwn, .ask");

export type ProblemPageProps = LineViewProps & {
  /** The list the person came from, in its order: what the arrows walk. */
  order?: ReadonlyArray<string>;
};

export function ProblemPage({ model, workspace, selection, select, href, order }: ProblemPageProps) {
  const ids = useMemo(() => order ?? model.issues.map((i) => i.id), [order, model.issues]);
  const issue = selection.case ? model.issues.find((i) => i.id === selection.case || i.ref === selection.case) ?? null : null;
  const at = issue ? ids.indexOf(issue.id) : -1;
  const prev = at > 0 ? ids[at - 1] : null;
  const next = at >= 0 ? ids[at + 1] ?? null : null;
  const open = useCallback((id: string | null) => select({ case: id, run: null, finding: null, decision: null }), [select]);
  const active = useTabActive();

  // Esc returns to the list; j and k walk it. None of them reaches into a decision or an answer box.
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!active || !issue || selection.run || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target) || inReader(e.target)) return;
    if (e.key === "Escape" && !selection.step) { e.preventDefault(); open(null); }
    // A key walk rewrites the current history entry, so Back leaves the problems rather than retracing them.
    else if (e.key === "j" && next) { e.preventDefault(); select({ case: next, run: null, finding: null }, undefined, { replace: true }); }
    else if (e.key === "k" && prev) { e.preventDefault(); select({ case: prev, run: null, finding: null }, undefined, { replace: true }); }
  });

  // A problem of another workspace settles on its own project's floor (LineWorkspace): until the floor answers it is
  // cold, not missing. Once it has, a name nothing here holds is not found, with the way back.
  if (!issue) {
    if (!workspace.ready) return <div className="lw-skeleton" aria-busy data-line-view="problem">{[70, 92, 54].map((w, i) => <i key={i} style={{ width: `${w}%` }} />)}</div>;
    return <div className="lw-empty" data-line-view="problem" data-line-problem-missing={selection.case ?? ""}><b>Not found</b><span className="pp-ref">{selection.case}</span><button type="button" className="lw-act" onClick={() => open(null)}>All problems</button></div>;
  }
  return <ProblemBody key={issue.id} issue={issue} model={model} workspace={workspace} selection={selection} select={select} href={href} prev={prev} next={next} open={open} />;
}

function ProblemBody({ issue, model, workspace, selection, select, href, prev, next, open }: Pick<LineViewProps, "model" | "workspace" | "selection" | "select" | "href"> & {
  issue: LineIssue; prev: string | null; next: string | null; open: (id: string | null) => void;
}) {
  const now = workspace.now;
  // Every finding on the problem: its own feed brings the ones the workspace's window does not hold.
  const { ready } = useSyncTaskSignals(issue.id);
  const where = useMemo(() => (s: ReaderSignal & { retired?: unknown }) => s.task_id === issue.id && !s.retired, [issue.id]);
  const signals = useCollectionRows<ReaderSignal>("signals", { where, sig: signalSig });

  // The history with the drift taken out: a finding after a fix that cites another expectation did not bring the problem back.
  const offTopic = useMemo(() => offTopicComebacks(issue.history, signals as ReadonlyArray<TopicSignal>), [issue.history, signals]);
  const home = useMemo(() => homeExpectation(issue.history, signals as ReadonlyArray<TopicSignal>), [issue.history, signals]);
  const full = useMemo(() => withoutOffTopic(issue.history, offTopic), [issue.history, offTopic]);

  const task = useInboxStore((st) => (st.tasks as unknown as Record<string, BandTask & { comments?: BandNote[] }>)[issue.id] ?? null);
  const notes = task?.comments;
  // Runs whose findings were moved to another problem after they ran: their work is that problem's. They stay in Work,
  // marked and linked there, and never set this problem's state.
  const moves = useMemo(() => movedOut(notes ?? []), [notes]);
  const movedTitles = useInboxStore((st) => moves.length ? moves.map((m) => (Object.values(st.tasks) as Array<{ short_id?: string; title?: string }>).find((t) => t.short_id === m.to)?.title ?? "").join("\n") : "");
  const movedTo = useCallback((a: (typeof full.attempts)[number]) => {
    if (!moves.length) return null;
    const titles = movedTitles.split("\n");
    return runMovedTo(a, moves, (ref) => titles[moves.findIndex((m) => m.to === ref)] || null);
  }, [moves, movedTitles]);
  const h = useMemo(() => {
    const keep = full.attempts.filter((a) => !movedTo(a));
    return keep.length === full.attempts.length ? full : { ...full, attempts: keep };
  }, [full, movedTo]);
  const projectId = task?.project_id ?? null;
  const project = projectId ? workspace.projects.find((p) => p._id === projectId) ?? null : null;
  const admission = projectId ? workspace.admissions.get(projectId) ?? null : null;
  const rollup = projectId ? workspace.allRollups.find((r) => r.key === projectId) ?? null : null;
  const need = needOfCase(workspace.needs, issue.id);
  const openDecision = useOpenFixDecision(issue.id);
  // Whom the open decision waits on: the viewer when it is in their own queue, or when its detail (fed by the decision
  // the band draws) names them among those asked; unknown until one of the two is read.
  const mine = useInboxStore((st): boolean | null => {
    if (!openDecision) return null;
    if ((st.sessionDecisions as unknown as Record<string, unknown> | undefined)?.[openDecision._id]) return true;
    const me = String(st.currentUser?._id ?? "");
    const detail = Object.values((st as unknown as { decisionDetails?: Record<string, { decision?: { _id: string; asked_user_ids?: string[]; user_id?: string } }> }).decisionDetails ?? {}).find((x) => x.decision?._id === openDecision._id)?.decision;
    if (!detail || !me) return null;
    return detail.asked_user_ids?.length ? detail.asked_user_ids.includes(me) : detail.user_id === me;
  });
  const row = useMemo(() => {
    for (const g of workspace.inbox) if (g.kind === "failed" || g.kind === "stalled") { const r = g.rows.find((x) => x.caseId === issue.id); if (r) return r; }
    return null;
  }, [workspace.inbox, issue.id]);
  const newestId = h.attempts[h.attempts.length - 1]?.runId ?? null;
  const run = useMemo(() => {
    const id = issue.runs.find((r) => !newestId || r === newestId || h.attempts.some((a) => a.runId === r)) ?? null;
    return id ? model.runs.find((r) => r.id === id) ?? null : null;
  }, [issue.runs, model.runs, h.attempts, newestId]);
  // What the newest run's ship step printed, whole (the model keeps only its first line).
  const shipOutput = useInboxStore((st) => {
    const rows = (st as unknown as { workflowRuns?: Record<string, { node_statuses?: Array<{ node_id: string; result_preview?: string }> }> }).workflowRuns;
    const nodes = run ? rows?.[run.id]?.node_statuses ?? [] : [];
    return [...nodes].reverse().find((n) => n.node_id === "ship" || n.node_id === "merge")?.result_preview ?? null;
  });
  const stageOf = useCallback<StageOf>((node) => model.steps[node]?.stage ?? null, [model.steps]);

  const band = useMemo(() => problemBand({
    issue, history: h, run, need, row, task, now, stageOf, shipOutput, notes,
    decision: openDecision ? { ref: decisionRef(openDecision), since: openDecision.created_at ?? null, mine } : null,
    lineOn: admission ? admission.on : null, ready: rollup?.ready ?? null, blocked: rollup ? rollup.notReadyIds.length : null, offTopic: offTopic.size,
  }), [issue, h, run, need, row, task, now, stageOf, shipOutput, notes, openDecision, mine, admission, rollup, offTopic]);
  const line = bandLine(band);
  const waiting = band.kind === "need" || band.kind === "decision";
  // A fix that waits on an answer, or was asked and never answered, stands at Present: nothing after it counts as done.
  const atPresent = band.kind === "decision" || (band.kind === "need" && (band.need === "decision" || band.need === "reask" || band.need === "lapsed"));
  const stoppedAt = band.kind === "need" && band.need === "stopped" ? run?.visits.find((v) => v.label === band.step || v.node === band.step) ?? null : null;
  // An escalated run stands at the step that handed it back.
  const handedNode = band.kind === "escalated" ? run?.visits.find((v) => v.label === band.step || v.node.toLowerCase() === band.step.toLowerCase())?.node ?? band.step.toLowerCase() : null;
  const stages = useMemo(() => stageTrack(run, stageOf, {
    // Approved and not merged: it stands at Ship.
    at: atPresent ? "decide" : band.kind === "approved" ? "ship" : stoppedAt ? stageOf(stoppedAt.node) ?? null : handedNode ? stageOf(handedNode) ?? null : null,
    failed: band.kind === "failed",
  }), [run, stageOf, atPresent, stoppedAt, handedNode, band.kind]);

  // The newest fix: where the findings divide into before and after.
  const fix = useMemo<FixMark | null>(() => {
    if (band.kind === "production") return { at: band.liveAt, words: `In production ${dayWords(band.liveAt)}`, live: true };
    if (band.kind === "merged") return { at: band.mergedAt, words: band.recorded === "known" ? `Merged ${dayWords(band.mergedAt)}, not in production` : `Merged ${dayWords(band.mergedAt)}`, live: false };
    return null;
  }, [band]);
  const work = useMemo(() => workRows(full, model.runs, { movedTo, parked: band.kind === "parked" ? line.text : null }), [full, model.runs, movedTo, band.kind, line.text]);

  const onRun = useCallback((runId: string, taskId: string | null) => select({ run: runId, step: null, decision: null }, taskId ?? issue.id), [select, issue.id]);
  const onStep = useCallback((runId: string, step: string | null) => select({ run: runId, step, decision: null }, issue.id), [select, issue.id]);
  const onProblem = useCallback((taskId: string) => { if (taskId !== issue.id) select({ case: taskId, run: null, finding: null, decision: null }); }, [select, issue.id]);
  const notStarted = { case: null, run: null, finding: null, status: "notstarted", project: project ? lineFilterParam(project, workspace.projects) : null } as const;
  // The heading in full: a title stored cut at its cap reads from the expectation its findings restate whole.
  const title = useMemo(() => problemHeading(issue.title, signals), [issue.title, signals]);
  const total = Math.max(issue.findings, signals.length);

  return (
    <div className="pp" data-line-view="problem" data-line-problem={issue.id} data-band={band.kind === "need" ? band.need : band.kind}>
      <div className="pp-crumbs">
        <button type="button" className="lw-link pp-back" onClick={() => open(null)}><ArrowLeft className="w-3.5 h-3.5" aria-hidden />Problems</button>
        {issue.ref && <span className="pp-ref">{issue.ref}</span>}
        {project && <span className="pp-project">{project.title}</span>}
        <span className="lw-spacer" />
        <button type="button" className="lw-iconbtn" disabled={!prev} onClick={() => prev && open(prev)} aria-label="Previous problem"><ChevronLeft className="w-4 h-4" /></button>
        <button type="button" className="lw-iconbtn" disabled={!next} onClick={() => next && open(next)} aria-label="Next problem"><ChevronRight className="w-4 h-4" /></button>
      </div>
      <h2 className="pp-title">{title}</h2>
      {/* A closed problem's band states when and how in its facts, and a withdrawn card's banner says "Withdrawn": the
          line would only say it twice. */}
      <StageTrack stages={stages} line={band.kind === "closed" || (band.kind === "need" && band.withdrawn) ? null : line} onStage={run ? (step) => onStep(run.id, step) : undefined} />

      <ProblemBand
        band={band} need={need} taskId={issue.id} taskRef={issue.ref} title={title} projectId={projectId} projectTitle={project?.title ?? null}
        admission={admission} startable={!!task?.goal_ref && !task?.assignee} askFocus={selection.ask} now={now}
        onProblem={onProblem} onRun={onRun} onStep={onStep}
        notStartedHref={href(notStarted)} onNotStarted={() => select(notStarted)}
      />

      <ProblemFindings title={title} signals={signals} expected={total} ready={ready} fix={fix} home={home} finding={selection.finding} onFinding={(ref) => select({ finding: ref })} />
      <ProblemWork rows={work} bandShowsNewest={waiting} onRun={(runId) => onRun(runId, issue.id)} onProblem={onProblem} />
      <NeighbourDecisions ids={[prev, next]} />
    </div>
  );
}

/** The open decisions of the problems either side in the list, fed ahead of a walk (j, k, the arrows), so the next page's
 *  band paints from the store instead of waiting on the decision's detail. */
function NeighbourDecisions({ ids }: { ids: ReadonlyArray<string | null> }) {
  const a = useOpenFixDecision(ids[0]);
  const b = useOpenFixDecision(ids[1]);
  const refs = useMemo(() => [a, b].flatMap((d) => (d ? [decisionRef(d)] : [])), [a, b]);
  return refs.length ? <LineDecisionPrefetch ids={refs} /> : null;
}

