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
import { useInboxStore } from "../../../../../store/inboxStore";
import { isRefusedDispatchError } from "../../../../../store/mutativeMiddleware";
import { hasOpenModal } from "../../../../../shortcuts";
import { keyBelongsElsewhere } from "../../../../../shortcuts/keyOwnership";
import { BEFORE_WORDS, OVERVIEW_RANGES, DEFAULT_RANGE } from "../../../../../lib/line/problemsOverview";
import { bucketWords } from "../../../../../lib/line/timeline";
import { STATUS_LABELS, STATUS_ORDER, type StatusKey } from "../../../../../lib/line/problemStatus";
import { problemListName, type ProblemSort, type ProblemSub } from "../../../../../lib/line/problemTable";
import { aboutWords, useRunDuration } from "../../../../../lib/line/runDuration";
import { SwitchReview } from "../../../../consequential/ConsequentialSwitch";
import { startTheseAgainLedger } from "../../../../consequential/ledgers";
import { LineStartControl } from "../../../../consequential/lineStart";
import { useRunCost } from "../../../../consequential/useRunCost";
import { useLineAdmission, useLineAdmissions } from "../../../map/useLineAdmission";
import { admissionHold, notReadyReasons, startAgainPlan, trialHold, type LineCauseTask } from "../../../../../lib/lineFlow";
import { processName } from "../../../../../lib/line/lineGraphs";
import type { ProblemRow } from "../../../../../lib/line/problemTable";
import type { LineViewProps } from "../types";
import { StartRunAct } from "../../../widgets/StartRunAct";
import { CloseProblem } from "../problem/ProblemBand";
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
  const againProject = again?.rows[0]?.projectId ?? null;
  const cost = useRunCost(againProject);
  const againProjects = useMemo(() => [...new Set((again?.rows ?? []).map((r) => r.projectId).filter((p): p is string => !!p))].sort(), [again]);
  // What the start goes past, per project its runs belong to: the first line that is off or short of places says so.
  const againLines = useLineAdmissions(useMemo(() => againProjects.map((id) => ({ _id: id, workspace: (workspace.projects.find((p) => p._id === id) as { workspace?: string | null } | undefined)?.workspace ?? null })), [againProjects, workspace.projects]));
  // Each project's line paces its own: the first ones in the heading's order, up to what Turn on would start now; the
  // rest stay under the heading. A project with no admission yet starts nothing until it answers.
  const againPlan = useMemo(() => {
    if (!again) return null;
    const plans = new Map(againProjects.map((id) => [id, startAgainPlan(againLines.get(id), again.rows.filter((r) => r.projectId === id).length)]));
    const left = new Map([...plans].map(([id, p]) => [id, p.now]));
    const starting = again.rows.filter((r) => { const n = r.projectId ? left.get(r.projectId) ?? 0 : 1; if (n <= 0) return false; if (r.projectId) left.set(r.projectId, n - 1); return true; });
    const all = [...plans.values()];
    return { starting, rest: again.rows.length - starting.length, hold: all.map((p) => p.hold).find(Boolean) ?? null, slots: all.find((p) => p.slots != null)?.slots ?? null };
  }, [again, againProjects, againLines]);
  const duration = useRunDuration(againProjects);
  const startThese = useCallback(() => {
    if (!again || !againPlan) return;
    const key = again.key;
    setAgain(null);
    setRefused(null);
    for (const r of againPlan.starting) {
      useInboxStore.getState().startLineCause(r.id).catch((e: unknown) => {
        if (isRefusedDispatchError(e)) setRefused({ key, words: (e instanceof Error ? e.message : String(e ?? "")).replace(/^.*ConvexError:\s*/, "").split("\n")[0] || "The server refused it" });
      });
    }
  }, [again, againPlan]);

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
      const line = trial.length ? { ...sub, rows: sub.rows.filter((r) => !isTrialRow(r)) } : sub;
      const limits = [...new Set(trial.map((r) => trialLimits.get(r.projectId ?? "")).filter((h): h is string => !!h))];
      return (
        <>
          {refused?.key === sub.key && <span className="lwp-sub-err" role="alert">{refused.words}</span>}
          {limits.map((h) => <span key={h} className="lwp-sub-why" title={`The trial starts no new run: ${h}`} data-line-trial-held="">Trial held: {h}</span>)}
          {line.rows.length > 0 && <button type="button" className="lw-act" aria-haspopup="dialog" onClick={() => setAgain(line)} data-line-start-again={sub.key}>{line.rows.length === 1 ? "Start again…" : trial.length ? `Start ${line.rows.length} again…` : "Start these again…"}</button>}
        </>
      );
    }
    if (status === "notstarted") return <ProjectStart sub={sub} workspace={workspace} />;
    return null;
  }, [refused, workspace, caseHref, open, isTrialRow, trialLimits]);

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
    if (act === "close") return <CloseProblem taskRef={r.issue.ref ?? r.id} title="Close it: grounding found nothing to change" label="Close: nothing to change" primary={false} />;
    // Opened on a finding that says nothing: closed as the reader closes it, with no evidence.
    if (act === "noevidence") return <button type="button" className="lw-act" title="Close it: no finding supports it" onClick={() => answerProblem(r.issue.ref ?? r.id, "dropped")} data-line-row-noevidence={r.issue.ref ?? r.id}>Close: no evidence</button>;
    if (isTrialRow(r)) return <TrialRerunLink projectId={r.projectId} stopped={false} held={!!trialLimits.get(r.projectId ?? "")} />;
    const problem = `${r.issue.ref ? `${r.issue.ref} · ` : ""}${problemListName(r.issue)}`;
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
  }, [isTrialRow, refused, trialRunOf, trialLimits]);
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
      {overview.total > 0 && <ProblemsTrend overview={overview} picked={found && found !== "more" ? found.from : null} pick={pickBar} href={barHref} />}
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
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- the rows are the controls; this only moves focus between them
        <div className="lwp-rows" onKeyDown={moveRow}>
          <ProblemTable sections={sections} now={workspace.now} range={range} day={found && found !== "more" ? found : null} showProject={!workspace.project} projectName={list.projectName} processOf={processOf} href={caseHref} open={open} onStatus={setStatus} subAct={subAct} rowAct={rowAct} sectionAct={sectionAct} />
        </div>
      ) : (
        <div className="lw-empty lwp-none" data-line-problems-none="">
          <b>{narrowed ? "No problem matches" : "No problems"}</b>
          {narrowed && <button type="button" className="lw-act" onClick={() => { setTyped(""); select({ status: null, quiet: null, q: null, found: null }); }}>Show all {list.all.length}</button>}
        </div>
      )}
      {again && (
        <SwitchReview
          ledger={startTheseAgainLedger({
            name: again.ask ? "Ask again" : undefined, cause: again.label, count: againPlan?.starting.length ?? 0, rest: againPlan?.rest ?? again.rows.length, slots: againPlan?.slots ?? null,
            first: againPlan?.starting.map((r) => problemListName(r.issue)), projects: [...new Set(again.rows.map((r) => list.projectName(r.projectId)).filter(Boolean))],
            cost, about: duration ? aboutWords(duration) : null, hold: againPlan?.hold ?? null,
          })}
          onClose={() => setAgain(null)} onConfirm={startThese} />
      )}
    </div>
  );
}

/** A project's heading under Not started: its line's start control, the one place a line is turned on. A project
 *  with nobody in charge says so and links to where a lead is set; a trial project's says what its dispatcher holds on. */
function ProjectStart({ sub, workspace }: { sub: ProblemSub; workspace: LineViewProps["workspace"] }) {
  const projectId = sub.projectId ?? null;
  const admit = useLineAdmission(projectId);
  // The review counts this heading's own rows: its ready ones are what the sweep would start (a problem listed under
  // Failed or Needs a new ask is still held by its run, so it is never startable), and its blocked ones say why.
  const notReady = useMemo(() => {
    const tasks = new Map((workspace.rows.tasks as LineCauseTask[]).map((t) => [t._id, t]));
    return notReadyReasons(sub.rows.filter((r) => !r.stand.ready).map((r) => tasks.get(r.id)).filter((t): t is LineCauseTask => !!t));
  }, [sub.rows, workspace.rows.tasks]);
  if (!projectId) return <span className="lwp-sub-note">In no project: nothing starts these</span>;
  if (workspace.trialProjects.has(projectId)) return <TrialStarts projectId={projectId} />;
  if (!admit.admission) return null;
  if (!admit.admission.role) return <a className="lw-link" href={`/projects/${projectId}`} data-line-no-lead={projectId}>No lead: set one on the project</a>;
  // Why the ready ones sit idle, in the sweep's order (line off, lead paused, today's sessions, places taken); nothing when it is taking them.
  const hold = sub.ready ? admissionHold(admit.admission) : null;
  return (
    <>
      {hold && <span className="lwp-sub-why" title={hold.why} data-line-hold={projectId}>{hold.short}</span>}
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
