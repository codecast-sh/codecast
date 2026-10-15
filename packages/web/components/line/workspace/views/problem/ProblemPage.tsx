"use client";
// One problem's page (line-journeys.md LJ8.3). Its job: decide whether this
// problem is real and is being handled. Top to bottom: what is wrong in one
// line; its life on one time axis (findings, runs, the deploys that carried a
// fix, and whether it came back after); where its newest run stands (StageTrack, the one statement of state);
// the act band (what waits on a person, answerable here, or the facts that
// show nothing is owed); the findings as real things, each opened in place;
// and what the line did about it, run by run. Nothing else.
import { useCallback, useMemo, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";
import { useCollectionRows } from "../../../../../hooks/useCollectionRows";
import { useEventListener } from "../../../../../hooks/useEventListener";
import { useOpenFixDecision } from "../../../../../hooks/useFixDecision";
import { useTabActive } from "../../../../../hooks/usePagePresence";
import { workspaceRows } from "../../../../../hooks/useWorkspaceCollection";
import { useDecisionDetail, useSyncDecisionDetail } from "../../../../../hooks/useSyncDecisionDetail";
import { useSyncTaskSignals } from "../../../../../hooks/useSyncSignals";
import { decisionRef } from "../../../../../lib/line/fixDecision";
import { lineFilterParam } from "../../../../../lib/line/lineWorkspaceUrl";
import { needOfCase, stoppedAsk } from "../../../../../lib/line/lineNeeds";
import type { LineIssue } from "../../../../../lib/line/lineModel";
import { errorWords, problemHeadName } from "../../../../../lib/line/problemTable";
import { errorTitle } from "@codecast/shared/contracts/ingest";
import { bandLine, cameBack, citedMerge, landingOutput, movedOut, problemBand, problemHeading, problemStatement, runMovedTo, statementAdds, sinceCloseGroups, workRows, type BandNote, type BandTask } from "../../../../../lib/line/problemPage";
import { stageTrack, type StageOf } from "../../../../../lib/line/stageTrack";
import { causeDoubt } from "../../../../../lib/line/lineTrace";
import { failCause } from "../../../../../lib/line/runReport";
import { homeExpectation, offTopicComebacks, withoutOffTopic, type TopicSignal } from "../../../../../lib/line/timeline";
import { taskByRef } from "../../../../../lib/taskRef";
import { activeWorkspaceKeyOf, workspaceKeyOfRow } from "../../../../../lib/workspaceScope";
import { hasOpenModal } from "../../../../../shortcuts";
import { keyBelongsElsewhere } from "../../../../../shortcuts/keyOwnership";
import { useInboxStore } from "../../../../../store/inboxStore";
import type { ReaderSignal } from "../../../widgets/FindingReader";
import { StageTrack } from "../../../widgets/StageTrack";
import { useLineNav } from "../../../widgets/parts";
import { LineDecisionPrefetch } from "../../../widgets/LineDecision";
import type { LineViewProps } from "../types";
import { ProblemBand } from "./ProblemBand";
import { ProblemFindings, type FixMark } from "./ProblemFindings";
import { ProblemWork } from "./ProblemWork";
import { TimelineChart, TimeRangeSeg, useTimelineDomain, type TimelinePick } from "../timeline/TimelineChart";
import type { CauseHistory } from "../../../../../lib/line/causeHistory";
import "./problem.css";
import "../timeline/timeline.css";

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
  const plainTask = useInboxStore((s) => {
    if (issue || !selection.case) return null;
    const c = selection.case;
    const tasks = (s as unknown as { tasks?: Record<string, { _id: string; short_id?: string; cause?: unknown }> }).tasks ?? {};
    const t = taskByRef(tasks, c);
    return t && !t.cause ? t : null;
  });

  // A task the store holds that no finding raised (filed by hand, then run on the line) has no problem page: the
  // address hands over to the task itself, whole, and Back skips this hop.
  const { replacePath } = useLineNav();
  const taskPage = plainTask && workspace.ready ? `/tasks/${plainTask.short_id ?? plainTask._id}` : null;
  useWatchEffect(() => { if (taskPage) replacePath?.(taskPage); }, [taskPage, replacePath]);

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
    // A task no finding raised is opening on its own page (above).
    if (plainTask) return <div className="lw-skeleton" aria-busy data-line-view="problem" data-line-problem-task={plainTask.short_id ?? plainTask._id}>{[70, 92, 54].map((w, i) => <i key={i} style={{ width: `${w}%` }} />)}</div>;
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
  const movedTitles = useInboxStore((st) => moves.length ? moves.map((m) => taskByRef(st.tasks as Record<string, { _id: string; short_id?: string; title?: string }>, m.to)?.title ?? "").join("\n") : "");
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
    return run ? landingOutput(rows?.[run.id]?.node_statuses) : null;
  });
  const stageOf = useCallback<StageOf>((node) => model.steps[node]?.stage ?? null, [model.steps]);
  const labelOf = useCallback((id: string) => model.steps[id]?.label, [model.steps]);
  // Grounding's doubt that the findings match the problem (ct-58022: a removal request filed under calling hours).
  const doubt = useMemo(() => (task ? causeDoubt(task as Parameters<typeof causeDoubt>[0]) : null), [task]);

  const isTrial = useCallback((runId: string) => workspace.trialRuns.has(runId), [workspace.trialRuns]);
  const holderName = task?.assignee ? workspace.names.get(task.assignee) ?? null : null;
  // Who answered the newest run's card, from the decision itself (the record LineDecision reads): the line's own card
  // rows do not say who.
  const answered = h.attempts[h.attempts.length - 1]?.card;
  const answeredRef = answered?.status === "answered" ? answered.ref ?? answered.decisionId : undefined;
  useSyncDecisionDetail(answeredRef);
  const answeredDetail = useDecisionDetail(answeredRef);
  const approverId = (answeredDetail?.decision as { answered_by?: { id?: string } | null } | undefined)?.answered_by?.id ?? answered?.answeredBy ?? null;
  const approver = approverId ? workspace.names.get(approverId) ?? null : null;
  const band = useMemo(() => problemBand({
    issue, history: h, run, need, row, task, now, stageOf, shipOutput, notes, holderName, approver,
    decision: openDecision ? { ref: decisionRef(openDecision), since: openDecision.created_at ?? null, mine } : null,
    // A trial project's runs start under its dispatcher, not a lead's switch: it is on, unless its dispatcher holds.
    lineOn: projectId && workspace.trialProjects.has(projectId) ? true : admission ? admission.on : null, idle: projectId ? workspace.trialHeld?.get(projectId) ?? null : null,
    offTopic: offTopic.size, trial: !!newestId && isTrial(newestId),
  }), [issue, h, run, need, row, task, now, stageOf, shipOutput, notes, holderName, approver, openDecision, mine, admission, projectId, workspace.trialProjects, workspace.trialHeld, offTopic, newestId, isTrial]);
  const line = bandLine(band);
  const waiting = band.kind === "need" || band.kind === "decision" || band.kind === "unanswered";
  // A fix that waits on an answer, or was asked and never answered, stands at Present: nothing after it counts as done.
  const atPresent = band.kind === "decision" || band.kind === "unanswered" || (band.kind === "need" && (band.need === "decision" || band.need === "reask" || band.need === "lapsed"));
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
    // The divider names the moment it marks (findings above it came after); when is the band's to say.
    if (band.kind === "production") return { at: band.liveAt, words: "Went live", live: true };
    // Merged and not live: the band's facts and the stage line say so; a divider would only say it a third time.
    // Closed without a fix: what came after the close is its own group, each finding marked as since.
    if (band.kind === "returned") return { at: band.at, words: "Closed", live: true };
    return null;
  }, [band]);
  // The findings since such a close, grouped by what each says is wrong, so the band can say what kept coming.
  const sinceGroups = useMemo(() => (band.kind === "returned" ? sinceCloseGroups(signals, band.at) : undefined), [band, signals]);
  // The newest commit a finding names as merged, which is not this fix's merge (it has none on record).
  const cited = useMemo(() => (band.kind === "approved" ? citedMerge(signals, null, null) : null), [band, signals]);
  // Runs whose builder handed off for review, by the reading the band's review need uses (runReport failCause).
  const reviewSig = useInboxStore((st) => {
    const rows = (st as unknown as { workflowRuns?: Record<string, Parameters<typeof failCause>[0] & { status?: string }> }).workflowRuns;
    return full.attempts.flatMap((a) => {
      const raw = rows?.[a.runId];
      const key = raw?.status === "failed" ? failCause(raw).key : "";
      return key.startsWith("review:") ? [`${a.runId}=${key.slice(7)}`] : [];
    }).join(",");
  });
  const review = useMemo(() => {
    const m = new Map(reviewSig ? reviewSig.split(",").map((x) => x.split("=") as [string, string]) : []);
    return (runId: string) => { const step = m.get(runId); return step ? model.steps[step]?.label ?? step : null; };
  }, [reviewSig, model.steps]);
  // Runs that stopped after a step finished with nothing next (the go-on ask's own reading): done, not failed.
  const stallSig = useInboxStore((st) => {
    const rows = (st as unknown as { workflowRuns?: Record<string, Parameters<typeof failCause>[0] & { status?: string }> }).workflowRuns;
    return JSON.stringify(full.attempts.flatMap((a) => {
      const raw = rows?.[a.runId];
      const fail = raw?.status === "failed" ? failCause(raw) : null;
      const ask = stoppedAsk(fail);
      return ask ? [[a.runId, { step: ask.step, node: fail?.step ?? null, next: ask.next }]] : [];
    }));
  });
  const stalled = useMemo(() => { const m = new Map<string, { step: string; node: string | null; next: string | null }>(JSON.parse(stallSig)); return (runId: string) => m.get(runId) ?? null; }, [stallSig]);
  const work = useMemo(() => workRows(full, model.runs, { movedTo, parked: band.kind === "parked" ? line.text : null, trial: isTrial, review, stalled }), [full, model.runs, movedTo, band.kind, line.text, isTrial, review, stalled]);

  // The live run took over from one that stalled after a finished step: the band says what became of its go-on.
  const replaces = useMemo(() => {
    const live = work.find((w) => w.live);
    const r = live ? work.find((w) => w.replaced?.by === live.runId) : undefined;
    return r?.replaced ? { n: r.n, step: r.replaced.step, redone: r.replaced.redone } : null;
  }, [work]);

  const onRun = useCallback((runId: string, taskId: string | null) => select({ run: runId, step: null, decision: null }, taskId ?? issue.id), [select, issue.id]);
  const onStep = useCallback((runId: string, step: string | null) => select({ run: runId, step, decision: null }, issue.id), [select, issue.id]);
  const onProblem = useCallback((taskId: string) => { if (taskId !== issue.id) select({ case: taskId, run: null, finding: null, decision: null }); }, [select, issue.id]);
  const notStarted = { case: null, run: null, finding: null, status: "notstarted", project: project ? lineFilterParam(project, workspace.projects) : null } as const;
  // The heading in full: a title stored cut at its cap reads from the expectation its findings restate whole.
  const title = useMemo(() => problemHeading(issue.title, signals), [issue.title, signals]);
  const description = (task as { description?: string | null } | null)?.description ?? null;
  const statement = useMemo(() => problemStatement(issue.title, description, signals), [issue.title, description, signals]);
  // Its written name, else for a title stored cut its first whole clause (the name its list row uses too), else the
  // title whole; never a cut. The statement follows whole when it says more.
  // A problem filed from an error group names what failed in the product's own words; its error is the line under it.
  const fromErrors = /\bgroup eg-\d+/.test(description ?? "");
  const errWords = errorWords(issue.title, fromErrors);
  const heading = problemHeadName(issue, { fromErrors, whole: title });
  const errorLine = errWords ? errorTitle(issue.title).error : null;
  const total = Math.max(issue.findings, signals.length);
  // Problems merged into this one: a finding a run split off to one of them came back with it, and its row says so.
  // Merged problems share this one's workspace.
  const mergedSig = useInboxStore((st) => JSON.stringify(workspaceRows<{ short_id?: string; title?: string; cause?: { merged_into?: string } | null }>("tasks", st.tasks as Record<string, never>, (task ? workspaceKeyOfRow(task as { workspace?: string | null }) : null) ?? activeWorkspaceKeyOf(st))
    .filter((t) => t.cause?.merged_into === issue.id && t.short_id).map((t) => ({ ref: t.short_id!, title: t.title ?? "" }))));
  const back = useMemo(() => cameBack(signals, JSON.parse(mergedSig)), [signals, mergedSig]);

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
      {/* One name on every page (the list's, the reader's, this one); the statement it names follows whole. */}
      <h2 className="pp-title">{heading}</h2>
      {errorLine ? <p className="pp-statement" data-pp-error><code>{errorLine}</code></p> : statementAdds(statement, heading, signals) && <p className="pp-statement">{statement}</p>}
      <ProblemTimeline history={h} labelOf={labelOf} now={now} offTopic={offTopic} signals={signals} selectedRun={selection.run ?? null}
        onRun={(runId) => onRun(runId, issue.id)} onFinding={(ref) => select({ finding: ref }, undefined, { push: true })} />
      {/* A closed problem's band states when and how in its facts: the line would only say it twice. */}
      <StageTrack stages={stages} line={band.kind === "closed" ? null : line} onStage={run ? (step) => onStep(run.id, step) : undefined} />

      <ProblemBand
        band={band} need={need} taskId={issue.id} taskRef={issue.ref} title={title} projectId={projectId} projectTitle={project?.title ?? null}
        admission={admission} startable={!!task?.goal_ref && !task?.assignee} askFocus={selection.ask} now={now}
        onProblem={onProblem} onRun={onRun} onStep={onStep}
        notStartedHref={href(notStarted)} onNotStarted={() => select(notStarted)}
        sinceGroups={sinceGroups} findings={Math.max(issue.findings, signals.length)} cited={cited} replaces={replaces}
      />

      <ProblemFindings title={title} problem={band.kind === "closed" ? null : issue.ref ?? null} doubt={doubt?.mismatch ? doubt.why : null} emptied={moves.length > 0} signals={signals} expected={total} ready={ready} fix={fix} home={home} back={back} finding={selection.finding} onFinding={(ref, opened) => select({ finding: ref }, undefined, opened ? { push: true } : { replace: true })} />
      <ProblemWork rows={work} now={now} bandShowsNewest={waiting} onRun={(runId) => onRun(runId, issue.id)} onProblem={onProblem} row={selection.row} onRow={(row) => select({ row }, undefined, { replace: true })} />
      <NeighbourDecisions ids={[prev, next]} />
    </div>
  );
}

/** The problem's life on one axis, leading its page: findings, runs, merges, the deploys that carried a fix, the watch
 *  after it, and what came back. A bar or a comeback opens its newest finding below; a run opens the run. */
function ProblemTimeline({ history: h, labelOf, now, offTopic, signals, selectedRun, onRun, onFinding }: {
  history: CauseHistory; labelOf: (id: string) => string | undefined; now: number; offTopic: ReadonlySet<number>;
  signals: ReadonlyArray<ReaderSignal>; selectedRun: string | null; onRun: (runId: string) => void; onFinding: (ref: string) => void;
}) {
  const { range, pickRange, domain, onZoom, onReset } = useTimelineDomain(h, now);
  const [pick, setPick] = useState<TimelinePick | null>(null);
  const onPick = useCallback((p: TimelinePick) => {
    if (p.kind === "attempt") { onRun(p.runId); return; }
    setPick(p);
    const back = p.kind === "comeback" ? [...h.regressions, ...h.recurrences].find((r) => r.afterRunId === p.runId) : null;
    const [from, to] = p.kind === "bucket" ? [p.from, p.to] : back ? [back.at, back.until ?? Infinity] : [0, 0];
    const at = (s: ReaderSignal) => s.observed_at || s.created_at;
    const inSpan = signals.filter((s) => at(s) >= from && at(s) < to);
    // A bucket opens its newest finding; a comeback its first, the one that said the fix did not hold.
    const s = p.kind === "bucket" ? inSpan.reduce<ReaderSignal | null>((m, x) => (!m || at(x) > at(m) ? x : m), null) : inSpan.reduce<ReaderSignal | null>((m, x) => (!m || at(x) < at(m) ? x : m), null);
    if (!s) return;
    const ref = s.short_id ?? s._id;
    onFinding(ref);
    requestAnimationFrame(() => document.querySelector(`[data-line-finding="${CSS.escape(ref)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }, [h, signals, onRun, onFinding]);
  return (
    <section className="pp-timeline lwt-vars" data-line-problem-timeline="">
      <div className="pp-timeline-h"><TimeRangeSeg range={range} pick={pickRange} /></div>
      <TimelineChart history={h} labelOf={labelOf} domain={domain} now={now} selectedRun={selectedRun} pick={pick} onPick={onPick} onZoom={onZoom} onReset={onReset} offTopic={offTopic} />
    </section>
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

