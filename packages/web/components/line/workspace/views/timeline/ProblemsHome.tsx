"use client";
// Problems (line-journeys.md LJ8.2): what is wrong with the product and
// whether it is getting better. The figures say it, the trend shows it, and
// the table lists every problem under its one status. A figure or a chip
// narrows the table; a row, or a problem's segment in the trend, opens the
// problem; a bar of the trend lists that day's problems. With no problems at all the page is one empty state. Under Failed each
// cause is a heading that starts its problems again; under Not started each
// project is a heading with its line's start control, the control's one home.
// The filter, sort, window and search are the URL's, so Back returns to them.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import { useEventListener } from "../../../../../hooks/useEventListener";
import { useTabActive } from "../../../../../hooks/usePagePresence";
import { useTrialHref, useTrialProjects, useTrialRuns, type TrialRunRow } from "../../../../../hooks/useSyncTrial";
import { trialRunLimit } from "../../../../../lib/line/trialStopLedgers";
import { TrialStopActs } from "../../../../trial/TrialStopActs";
import { hasOpenModal } from "../../../../../shortcuts";
import { keyBelongsElsewhere } from "../../../../../shortcuts/keyOwnership";
import { BEFORE_WORDS, OVERVIEW_RANGES, DEFAULT_RANGE } from "../../../../../lib/line/problemsOverview";
import { bucketWords } from "../../../../../lib/line/timeline";
import { gateOpenWords, STATUS_LABELS, STATUS_ORDER, type StatusKey } from "../../../../../lib/line/problemStatus";
import { emptyWays, problemListName, type ProblemSort, type ProblemSub } from "../../../../../lib/line/problemTable";
import { StartTheseAgain } from "./StartTheseAgain";
import { LineStartControl } from "../../../../consequential/lineStart";
import { useLineAdmission } from "../../../map/useLineAdmission";
import { admissionHold, notReadyReasons, startableCause, trialHold, type LineCauseTask } from "../../../../../lib/lineFlow";
import { processName } from "../../../../../lib/line/lineGraphs";
import type { ProblemRow } from "../../../../../lib/line/problemTable";
import type { LineViewProps } from "../types";
import { StartRunAct } from "../../../widgets/StartRunAct";
import { CloseProblem } from "../problem/CloseProblem";
import { MergeFixAct } from "../problem/MergeFixAct";
import { MergeAct } from "../../../widgets/WaitingItem";
import { dayWords } from "../../../../../lib/line/problemPage";
import { answerProblem } from "../problem/AskBlock";
import { ProblemFigures, type FigureKey } from "./ProblemFigures";
import { ProblemsTrend } from "./ProblemsTrend";
import { ProblemTable, ProblemTableHead } from "./ProblemTable";
import type { ProblemList } from "./useProblemList";
import "./problems.css";
import "./overview.css";

/** Where this list's scroll is kept: its address without what is open in it. */
function scrollKey(): string {
  if (typeof window === "undefined") return "";
  const q = new URLSearchParams(window.location.search);
  for (const k of ["case", "run", "step", "steptab", "decision", "ask", "finding"]) q.delete(k);
  return `lwp-scroll:${window.location.pathname}?${q.toString()}`;
}

export function ProblemsHome({ list, workspace, selection, select, href, drawerOpen }: Pick<LineViewProps, "workspace" | "selection" | "select" | "href" | "drawerOpen"> & { list: ProblemList }) {
  const { filter, sort, range, counts, sections, figures, overview } = list;
  const found = filter.found ?? null;
  const foundKey = found === "more" ? "more" : found ? String(found.from) : null;
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const setStatus = useCallback((status: StatusKey | null) => select({ status, quiet: null }), [select]);
  const setSort = useCallback((s: ProblemSort) => select({ sort: s }), [select]);
  const open = useCallback((id: string) => select({ case: id, run: null }), [select]);
  const caseHref = useCallback((id: string) => href({ case: id, run: null }), [href]);
  // The list spans every process unless narrowed: a row then names its own, as For you's rows do.
  const processTitles = useMemo(() => new Map(workspace.processes.map((g) => [g.key, processName(g.key, g.title).title])), [workspace.processes]);
  const spans = !list.process && new Set(workspace.problems.map((i) => i.process)).size > 1;
  const processOf = useMemo(() => (spans ? (r: ProblemRow) => processTitles.get((r.issue as { process?: string }).process ?? "") ?? "" : undefined), [spans, processTitles]);

  // The box holds what is typed; the address follows it, so the list narrows as the address does.
  const [typed, setTyped] = useState(filter.q);
  const urlQ = useRef(filter.q);
  if (urlQ.current !== filter.q) { urlQ.current = filter.q; if (typed.trim() !== filter.q) setTyped(filter.q); }
  const setQuery = useCallback((q: string) => { setTyped(q); select({ q: q.trim() || null }); }, [select]);

  // The scroll is this list's own: kept per address, back where it was when the person returns from a problem.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const key = scrollKey();
    if (!el || !key) return;
    // Storage off or full: the list opens at its top.
    const store = (() => { try { return window.sessionStorage; } catch { return null; } })();
    const saved = Number(store?.getItem(key) ?? 0);
    if (saved > 0) el.scrollTop = saved;
    return () => { try { store?.setItem(key, String(Math.round(el.scrollTop))); } catch { /* full */ } };
  }, [filter.status, filter.quiet, filter.q, foundKey, sort, range]);

  // J and K walk the rows while focus is in the list; / finds. Enter on a row is the link's own.
  const moveRow = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const down = e.key === "j" || e.key === "ArrowDown";
    if ((!down && e.key !== "k" && e.key !== "ArrowUp") || e.metaKey || e.ctrlKey || e.altKey) return;
    const at = (e.target as HTMLElement).closest?.(".lwp-row");
    if (!at) return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(".lwp-row")];
    const to = rows[rows.indexOf(at as HTMLElement) + (down ? 1 : -1)];
    if (to) { e.preventDefault(); to.focus(); to.scrollIntoView({ block: "nearest" }); }
  }, []);
  const active = useTabActive();
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!active || drawerOpen || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
    if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); }
    // From anywhere outside the list, J lands on its first row.
    else if (e.key === "j" && !(e.target as HTMLElement | null)?.closest?.(".lwp-row")) { const first = scrollRef.current?.querySelector<HTMLElement>(".lwp-row"); if (first) { e.preventDefault(); first.focus(); } }
  });

  // One failure cause started again: the review names how many runs, what they cost and how long one takes.
  // `ask`: the runs ask again (Needs a new ask), so the review says so.
  const [again, setAgain] = useState<(ProblemSub & { ask?: boolean }) | null>(null);
  const [refused, setRefused] = useState<{ key: string; words: string } | null>(null);

  // Trial problems: each one's latest run, and the limit (runs used, spend cap) that refuses any new run in its trial.
  const isTrialRow = useCallback((r: ProblemRow) => !!r.projectId && workspace.trialProjects.has(r.projectId), [workspace.trialProjects]);
  const trialRuns = useTrialRuns();
  const trialRunOf = useMemo(() => new Map<string, TrialRunRow>(trialRuns.map((t) => [t.task_short_id, t])), [trialRuns]);
  const trialProjects = useTrialProjects();
  const trialLimits = useMemo(() => new Map(trialProjects.map((p) => [p._id, trialRunLimit(p.dispatch?.held)])), [trialProjects]);

  const subAct = useCallback((status: StatusKey, sub: ProblemSub) => {
    if (status === "failed") {
      // Runs that failed on an open problem with the line itself would fail the same way again: its fix is the act, and
      // starting them again waits until it lands.
      const held = sub.heldBy?.[0];
      if (held) return <a className="lw-act" data-primary="" href={caseHref(held.id)} data-line-fix-first={held.issue.ref ?? held.id} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); open(held.id); }}>Fix {held.issue.ref ?? "it"} first</a>;
      // A trial problem's run is started again from its trial (lineTrial.rerun, from main), never through a lead's line:
      // its acts are its row's, the ones /trial offers; the heading says when the trial refuses any new run.
      const trial = sub.rows.filter(isTrialRow);
      // A row with a built fix waiting lands it from its row; starting it again would prove it from the start.
      const line = { ...sub, rows: sub.rows.filter((r) => !isTrialRow(r) && r.stand.act !== "shipbuilt") };
      const limits = [...new Set(trial.map((r) => trialLimits.get(r.projectId ?? "")).filter((h): h is string => !!h))];
      return (
        <>
          {refused?.key === sub.key && <span className="lwp-sub-err" role="alert">{refused.words}</span>}
          {limits.map((h) => <span key={h} className="lwp-sub-why" title={`The trial starts no new run: ${h}`} data-line-trial-held="">Trial held: {h}</span>)}
          {line.rows.length > 0 && <button type="button" className="lw-act" aria-haspopup="dialog" onClick={() => setAgain(line)} data-line-start-again={sub.key}>{line.rows.length === 1 ? "Start again…" : trial.length ? `Start ${line.rows.length} again…` : "Start these again…"}</button>}
        </>
      );
    }
    if (status === "notstarted") return <ProjectStart sub={sub} workspace={workspace} twins={list.all.filter((r) => r.foldedInto && r.projectId === sub.projectId)} />;
    return null;
  }, [refused, workspace, caseHref, open, isTrialRow, trialLimits, list.all]);

  // Needs a new ask: each row's act on the row, and one reviewed press that asks again for every line problem in it.
  const rowAct = useCallback((r: ProblemRow) => {
    // A failed trial problem: the acts /trial offers its run, on its row (a new approach when the approach did not work).
    if (r.stand.status === "failed" && isTrialRow(r)) {
      const run = r.issue.ref ? trialRunOf.get(r.issue.ref) : undefined;
      if (run?.stopped) return <TrialStopActs run={run} runLimit={trialLimits.get(r.projectId ?? "") ?? null} look="row" />;
      return <TrialRerunLink projectId={r.projectId} stopped={false} held={!!trialLimits.get(r.projectId ?? "")} />;
    }
    const act = r.stand.act;
    if (!act) return null;
    // Grounding found nothing to change: the person closes it, here as on its page.
    if (act === "fixed") return <CloseProblem taskRef={r.issue.ref ?? r.id} title="Close it: main already carries its fix" label="Close as fixed" primary={false} />;
    if (act === "close") return <CloseProblem taskRef={r.issue.ref ?? r.id} title="Close it: the line found nothing to change" label="Close: nothing to change" primary={false} />;
    // A twin folded under its older problem: the line would run the same defect twice, so it merges in.
    if (act === "mergeinto" && r.dupOf && r.issue.ref) {
      const into = list.all.find((x) => x.id === r.foldedInto);
      return <MergeAct twin={r.issue.ref} into={r.dupOf} findings={r.findings} twinProjectId={r.projectId} intoProjectId={into?.projectId ?? null} />;
    }
    // Parked by every run for serving no goal: starting it again parks it again. Closing it is the act here.
    if (act === "nogoal") return <CloseProblem taskRef={r.issue.ref ?? r.id} title="Close it: it serves no goal, so every run parks it" label="Close: serves no goal" primary={false} />;
    // Opened on a finding that says nothing: closed as the reader closes it, with no evidence.
    if (act === "noevidence") return <button type="button" className="lw-act" title="Close it: no finding supports it" onClick={() => answerProblem(r.issue.ref ?? r.id, "dropped")} data-line-row-noevidence={r.issue.ref ?? r.id}>Close: no evidence</button>;
    // A question its run holds open for someone else: its page is where it can still be answered.
    if (act === "opengate") {
      return <a className="lw-act" href={caseHref(r.id)} data-line-row-opengate={r.issue.ref ?? r.id} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); open(r.id); }}>{gateOpenWords(r.stand.gate ?? "")}</a>;
    }
    if (isTrialRow(r)) return <TrialRerunLink projectId={r.projectId} stopped={false} held={!!trialLimits.get(r.projectId ?? "")} />;
    const problem = `${r.issue.ref ? `${r.issue.ref} · ` : ""}${problemListName(r.issue)}`;
    // Approved and not merged: the fix lands from its row, through the same review its page's act opens.
    // A fix an earlier run built, put to a decision nobody answered: it lands from here (the press is that yes), never
    // proved from the start again.
    if (act === "shipbuilt") return <MergeFixAct taskId={r.id} problem={problem} change={null} approved={null} primary={false} />;
    if (act === "merge") {
      const card = r.issue.history.attempts[r.issue.history.attempts.length - 1]?.card;
      const approved = [card?.ref, card?.answeredAt != null ? dayWords(card.answeredAt) : null].filter(Boolean).join(" · ") || "Yes";
      return <MergeFixAct taskId={r.id} problem={problem} change={null} approved={approved} primary={false} />;
    }
    // Its last run ended and the sweep passes it by: the same paced review a failure cause's heading opens, for this one.
    if (act === "start") return (
      <>
        {refused?.key === r.id && <span className="lwp-sub-err" role="alert">{refused.words}</span>}
        <button type="button" className="lw-act" aria-haspopup="dialog" onClick={() => setAgain({ key: r.id, label: problem, rows: [r] })} data-line-start-again={r.id}>Start again…</button>
      </>
    );
    return act === "reopen"
      ? <StartRunAct taskId={r.id} projectId={r.projectId} problem={problem} label="Reopen…" primary={false} />
      : <StartRunAct taskId={r.id} projectId={r.projectId} problem={problem} label="Ask again" priced primary={false} />;
  }, [isTrialRow, refused, trialRunOf, trialLimits, list.all, caseHref, open]);
  const sectionAct = useCallback((status: StatusKey, rows: ReadonlyArray<ProblemRow>) => {
    if (status !== "newask") return null;
    const asks = rows.filter((r) => r.stand.act === "ask" && !isTrialRow(r));
    if (asks.length < 2) return null;
    return <button type="button" className="lw-act" aria-haspopup="dialog" onClick={() => setAgain({ key: "newask", label: "Needs a new ask", rows: asks, ask: true })} data-line-ask-again-all="">Ask again for {asks.length}…</button>;
  }, [isTrialRow]);

  const figureOn: FigureKey | null = found === "more" ? "more" : filter.status === "shipped" ? (filter.quiet ? "quiet" : "shipped") : null;
  const narrowed = !!filter.status || !!filter.q || !!found;
  // A picked bar narrows the table to that day's problems; picking it again, or its chip's x, lifts it.
  const pickBar = useCallback((from: number | null) => select({ found: from == null ? null : String(from) }), [select]);
  const barHref = useCallback((from: number | null) => href({ found: from == null ? null : String(from) }), [href]);
  const finderHref = useCallback((key: string) => href({ view: "line", source: key, step: null, finding: null, case: null }), [href]);
  const openFinder = useCallback((key: string) => select({ view: "line", source: key, step: null, finding: null, case: null }), [select]);
  const chips = useMemo(() => STATUS_ORDER.filter((s) => counts.by[s] > 0 || filter.status === s), [counts, filter.status]);

  // Nothing filed in view: no figures, chart, chips or columns to read, one line says so.
  if (!list.all.length) return (
    <div className="lwp-list" data-line-problems-home="">
      <div className="lw-empty lwp-none" data-line-problems-none="empty"><b>No problems</b></div>
    </div>
  );

  return (
    <div className="lwp-list" ref={scrollRef} data-line-problems-home="">
      <div className="lwp-top">
        <ProblemFigures figures={figures} range={range} href={href} select={select} on={figureOn} />
        <div className="lw-seg lwp-win" role="group" aria-label="Window">
          {OVERVIEW_RANGES.map((r) => <button key={r} type="button" aria-pressed={range === r} onClick={() => select({ win: r === DEFAULT_RANGE ? null : r })} data-line-overview-range={r}>{r}</button>)}
        </div>
      </div>
      {overview.total > 0 && <ProblemsTrend overview={overview} picked={found && found !== "more" ? found.from : null} pick={pickBar} href={barHref}
        shifts={list.shifts} finderHref={finderHref} openFinder={openFinder} />}
      <div className="lwp-stick">
        <div className="lwp-bar">
          <div className="lwp-chips" role="group" aria-label="Status">
            <button type="button" className="lwp-chip" aria-pressed={!filter.status} onClick={() => setStatus(null)} data-line-status="all">All<span className="lw-num">{counts.all}</span></button>
            {chips.map((s) => (
              <button key={s} type="button" className="lwp-chip" data-status={s} aria-pressed={filter.status === s} onClick={() => setStatus(filter.status === s ? null : s)} data-line-status={s}>
                {STATUS_LABELS[s]}<span className="lw-num">{counts.by[s]}</span>
              </button>
            ))}
            {filter.quiet && (
              <button type="button" className="lwp-chip" aria-pressed data-line-status-quiet="" onClick={() => select({ quiet: null })}>Quiet since the fix<X aria-hidden /></button>
            )}
            {found && (
              <button type="button" className="lwp-chip" aria-pressed data-line-found={foundKey ?? ""} onClick={() => select({ found: null })} aria-label="Show every day again">
                {found === "more" ? `Found more than ${BEFORE_WORDS[range]}` : `Found ${bucketWords(found.from, list.win.step)}`}<X aria-hidden />
              </button>
            )}
          </div>
          <label className="lwp-search">
            <Search aria-hidden />
            <input ref={searchRef} value={typed} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search problems" data-line-problem-search=""
              onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (typed) setQuery(""); else e.currentTarget.blur(); } }} />
            {typed && <button type="button" className="lwp-clear" aria-label="Clear the search" onClick={() => { setQuery(""); searchRef.current?.focus(); }}><X aria-hidden /></button>}
          </label>
        </div>
        <ProblemTableHead range={range} sort={sort} onSort={setSort} grouped={!!filter.status} day={found && found !== "more" ? bucketWords(found.from, list.win.step) : null} />
      </div>
      {sections.length ? (
        // The rows are the controls; this only moves focus between them.
        <div className="lwp-rows" onKeyDown={moveRow}>
          <ProblemTable sections={sections} now={workspace.now} range={range} win={list.win} day={found && found !== "more" ? found : null} showProject={!workspace.project} projectName={list.projectName} processOf={processOf} href={caseHref} open={open} onStatus={setStatus} subAct={subAct} rowAct={rowAct} sectionAct={sectionAct} />
        </div>
      ) : (
        <div className="lw-empty lwp-none" data-line-problems-none="">
          <b>{!narrowed ? "No problems" : filter.status ? `No match under ${STATUS_LABELS[filter.status]}` : "No problem matches"}</b>
          {narrowed && <div className="lwp-none-ways">{emptyWays(counts, filter, list.searched.length, list.all.length).map((w) => w.kind === "status" ? (
            <button key={w.status} type="button" className="lwp-chip" data-status={w.status} onClick={() => setStatus(w.status)} data-line-empty-status={w.status}>{STATUS_LABELS[w.status]}<span className="lw-num">{w.n}</span></button>
          ) : w.kind === "anyday" ? (
            <button key="anyday" type="button" className="lw-act" onClick={() => select({ found: null })} data-line-empty-anyday="">Every day<span className="lw-num">{w.n}</span></button>
          ) : w.kind === "search" ? (
            <button key="search" type="button" className="lw-act" onClick={() => { setQuery(""); searchRef.current?.focus(); }} data-line-empty-search="">Clear the search</button>
          ) : (
            <button key="all" type="button" className="lw-act" onClick={() => { setTyped(""); select({ status: null, quiet: null, q: null, found: null }); }} data-line-empty-all="">Show all {w.n}</button>
          ))}</div>}
        </div>
      )}
      {again && <StartTheseAgain again={again} workspace={workspace} projectName={list.projectName} onClose={() => setAgain(null)} onRefused={(words) => setRefused({ key: again.key, words })} />}
    </div>
  );
}

/** A project's heading under Not started: its line's start control, the one place a line is turned on. A project
 *  with nobody in charge says so and links to where a lead is set; a trial project's says what its dispatcher holds on. */
function ProjectStart({ sub, workspace, twins }: { sub: ProblemSub; workspace: LineViewProps["workspace"]; /** This project's twins folded under another problem. */ twins: ReadonlyArray<ProblemRow> }) {
  const projectId = sub.projectId ?? null;
  const admit = useLineAdmission(projectId);
  // The review counts this heading's own rows: its ready ones are what the sweep would start (a problem listed under
  // Failed or Needs a new ask is still held by its run, so it is never startable), and its blocked ones say why.
  const notReady = useMemo(() => {
    const tasks = new Map((workspace.rows.tasks as LineCauseTask[]).map((t) => [t._id, t]));
    return notReadyReasons(sub.rows.filter((r) => !r.stand.ready).map((r) => tasks.get(r.id)).filter((t): t is LineCauseTask => !!t));
  }, [sub.rows, workspace.rows.tasks]);
  // A twin is listed under its older problem, never as ready, but the line's sweep does not know it is one: until it is
  // merged in, turning the line on runs the same defect twice. Said here, where the switch is, with each twin named.
  const runTwice = useMemo(() => {
    const tasks = new Map((workspace.rows.tasks as LineCauseTask[]).map((t) => [t._id, t]));
    return twins.filter((r) => { const t = tasks.get(r.id); return !!t && startableCause(t); });
  }, [twins, workspace.rows.tasks]);
  if (!projectId) return <span className="lwp-sub-note">In no project: nothing starts these</span>;
  if (workspace.trialProjects.has(projectId)) return <TrialStarts projectId={projectId} />;
  if (!admit.admission) return null;
  if (!admit.admission.role) return <a className="lw-link" href={`/projects/${projectId}`} data-line-no-lead={projectId}>No lead: set one on the project</a>;
  // Why the ready ones sit idle, in the sweep's order (line off, lead paused, today's sessions, places taken); nothing when it is taking them.
  const hold = sub.ready ? admissionHold(admit.admission) : null;
  return (
    <>
      {hold && <span className="lwp-sub-why" title={hold.why} data-line-hold={projectId}>{hold.short}</span>}
      {runTwice.length > 0 && <span className="lwp-sub-why" data-tone="warn" data-line-twins-run={runTwice.length}
        title={runTwice.map((r) => `${r.issue.ref} is the same as ${r.dupOf}`).join("\n")}>Would also run {runTwice.length === 1 ? `${runTwice[0].issue.ref}, a twin` : `${runTwice.length} twins`}: merge first</span>}
      <LineStartControl projectId={projectId} project={sub.label} admit={admit} waiting={sub.rows.length} ready={sub.ready ?? null} notReady={notReady}
        className="lw-act" label="Turn on…" triggerProps={{ "data-line-start": projectId }} />
    </>
  );
}

/** A trial problem whose run failed rather than stopped: its rerun lives on the trial page's own list, a press away;
 *  while the trial refuses new runs, the link only opens it there. */
function TrialRerunLink({ projectId, stopped, held }: { projectId: string | null; stopped: boolean; held: boolean }) {
  return <a className="lw-act" href={useTrialHref(projectId, null, stopped ? "stopped" : "failed")} data-line-trial-rerun={projectId ?? ""}>{held ? "Open in Trial" : "Rerun in Trial"}</a>;
}

/** A trial project's heading: why its problems sit idle when its dispatcher holds (runs used, spend cap, no
 *  dispatcher), read from the dispatcher's own last pass (its rows count as blocked then), and its trial page a press away. */
function TrialStarts({ projectId }: { projectId: string }) {
  const href = useTrialHref(projectId);
  const row = useTrialProjects().find((p) => p._id === projectId);
  const hold = trialHold(row?.dispatch);
  return (
    <>
      {hold && <span className="lwp-sub-why" title={row?.dispatch?.held ?? hold.why} data-line-hold={projectId}>{hold.short}</span>}
      <a className="lw-link" href={href} data-line-trial-link={projectId}>{hold ? "Trial" : "Trial: runs start on their own"}</a>
    </>
  );
}
