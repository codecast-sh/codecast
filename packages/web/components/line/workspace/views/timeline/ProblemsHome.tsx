"use client";
// Problems (line-journeys.md LJ8.2): what is wrong with the product and
// whether it is getting better. Three figures say it, the trend shows it, and
// the table lists every problem under its one status. A figure, a chip or a
// legend row narrows the table; a row opens the problem. Under Failed each
// cause is a heading that starts its problems again; under Not started each
// project is a heading with its line's start control, the control's one home.
// The filter, sort, window and search are the URL's, so Back returns to them.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import { useEventListener } from "../../../../../hooks/useEventListener";
import { useTabActive } from "../../../../../hooks/usePagePresence";
import { useInboxStore } from "../../../../../store/inboxStore";
import { isRefusedDispatchError } from "../../../../../store/mutativeMiddleware";
import { hasOpenModal } from "../../../../../shortcuts";
import { keyBelongsElsewhere } from "../../../../../shortcuts/keyOwnership";
import { OVERVIEW_RANGES, DEFAULT_RANGE } from "../../../../../lib/line/problemsOverview";
import { STATUS_LABELS, STATUS_ORDER, type StatusKey } from "../../../../../lib/line/problemStatus";
import type { ProblemSort, ProblemSub } from "../../../../../lib/line/problemTable";
import { aboutWords, useRunDuration } from "../../../../../lib/line/runDuration";
import { SwitchReview } from "../../../../consequential/ConsequentialSwitch";
import { startTheseAgainLedger } from "../../../../consequential/ledgers";
import { LineStartControl } from "../../../../consequential/lineStart";
import { useRunCost } from "../../../../consequential/useRunCost";
import { useLineAdmission } from "../../../map/useLineAdmission";
import type { LineViewProps } from "../types";
import { ProblemFigures } from "./ProblemFigures";
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
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const setStatus = useCallback((status: StatusKey | null) => select({ status, quiet: null }), [select]);
  const setSort = useCallback((s: ProblemSort) => select({ sort: s }), [select]);
  const open = useCallback((id: string) => select({ case: id, run: null }), [select]);
  const caseHref = useCallback((id: string) => href({ case: id, run: null }), [href]);

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
    const saved = Number(sessionStorage.getItem(key) ?? 0);
    if (saved > 0) el.scrollTop = saved;
    return () => { try { sessionStorage.setItem(key, String(Math.round(el.scrollTop))); } catch { /* storage full or off: the list opens at its top */ } };
  }, [filter.status, filter.quiet, filter.q, sort, range]);

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
  const [again, setAgain] = useState<ProblemSub | null>(null);
  const [refused, setRefused] = useState<{ key: string; words: string } | null>(null);
  const againProject = again?.rows[0]?.projectId ?? null;
  const cost = useRunCost(againProject);
  const duration = useRunDuration(againProject);
  const startThese = useCallback(() => {
    if (!again) return;
    const key = again.key;
    setAgain(null);
    setRefused(null);
    for (const r of again.rows) {
      useInboxStore.getState().startLineCause(r.id).catch((e: unknown) => {
        if (isRefusedDispatchError(e)) setRefused({ key, words: (e instanceof Error ? e.message : String(e ?? "")).replace(/^.*ConvexError:\s*/, "").split("\n")[0] || "The server refused it" });
      });
    }
  }, [again]);

  const subAct = useCallback((status: StatusKey, sub: ProblemSub) => {
    if (status === "failed") return (
      <>
        {refused?.key === sub.key && <span className="lwp-sub-err" role="alert">{refused.words}</span>}
        <button type="button" className="lw-act" aria-haspopup="dialog" onClick={() => setAgain(sub)} data-line-start-again={sub.key}>{sub.rows.length === 1 ? "Start again…" : "Start these again…"}</button>
      </>
    );
    if (status === "notstarted") return <ProjectStart sub={sub} workspace={workspace} />;
    return null;
  }, [refused, workspace]);

  const figureOn = filter.status === "merged" ? "merged" : filter.status === "shipped" ? (filter.quiet ? "quiet" : "shipped") : null;
  const narrowed = !!filter.status || !!filter.q;
  const chips = useMemo(() => STATUS_ORDER.filter((s) => counts.by[s] > 0 || filter.status === s), [counts, filter.status]);

  return (
    <div className="lwp-list" ref={scrollRef} data-line-problems-home="">
      <div className="lwp-top">
        <ProblemFigures figures={figures} range={range} href={href} select={select} on={figureOn} />
        <div className="lw-seg lwp-win" role="group" aria-label="Window">
          {OVERVIEW_RANGES.map((r) => <button key={r} type="button" aria-pressed={range === r} onClick={() => select({ win: r === DEFAULT_RANGE ? null : r })} data-line-overview-range={r}>{r}</button>)}
        </div>
      </div>
      <ProblemsTrend overview={overview} picked={filter.q || null} onPick={(ref) => setQuery(ref ?? "")} />
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
          </div>
          <label className="lwp-search">
            <Search aria-hidden />
            <input ref={searchRef} value={typed} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search problems" data-line-problem-search=""
              onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (typed) setQuery(""); else e.currentTarget.blur(); } }} />
            {typed && <button type="button" className="lwp-clear" aria-label="Clear the search" onClick={() => { setQuery(""); searchRef.current?.focus(); }}><X aria-hidden /></button>}
          </label>
        </div>
        <ProblemTableHead range={range} sort={sort} onSort={setSort} grouped={!!filter.status} />
      </div>
      {sections.length ? (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- the rows are the controls; this only moves focus between them
        <div className="lwp-rows" onKeyDown={moveRow}>
          <ProblemTable sections={sections} now={workspace.now} range={range} showProject={!workspace.project} projectName={list.projectName} href={caseHref} open={open} onStatus={setStatus} subAct={subAct} />
        </div>
      ) : (
        <div className="lw-empty lwp-none" data-line-problems-none="">
          <b>{narrowed ? "No problem matches" : "No problems"}</b>
          {narrowed && <button type="button" className="lw-act" onClick={() => { setTyped(""); select({ status: null, quiet: null, q: null }); }}>Show all {list.all.length}</button>}
        </div>
      )}
      {again && (
        <SwitchReview
          ledger={startTheseAgainLedger({ cause: again.label, count: again.rows.length, projects: [...new Set(again.rows.map((r) => list.projectName(r.projectId)).filter(Boolean))], cost, about: duration ? aboutWords(duration) : null })}
          onClose={() => setAgain(null)} onConfirm={startThese} />
      )}
    </div>
  );
}

/** A project's heading under Not started: its line's start control, the one place a line is turned on. A project
 *  with nobody in charge says so and links to where a lead is set; a trial project's runs start on their own. */
function ProjectStart({ sub, workspace }: { sub: ProblemSub; workspace: LineViewProps["workspace"] }) {
  const projectId = sub.projectId ?? null;
  const admit = useLineAdmission(projectId);
  const rollup = useMemo(() => workspace.allRollups.find((r) => r.key === projectId) ?? null, [workspace.allRollups, projectId]);
  if (!projectId) return <span className="lwp-sub-note">In no project: nothing starts these</span>;
  if (workspace.trialProjects.has(projectId)) return <a className="lw-link" href="/trial">Trial: runs start on their own</a>;
  if (!admit.admission) return null;
  if (!admit.admission.role) return <a className="lw-link" href={`/projects/${projectId}`} data-line-no-lead={projectId}>No lead: set one on the project</a>;
  // The review states what the sweep would start: the project's whole queue (lineFlow lineRollup), which may hold
  // more than the rows under this heading (a problem whose run failed is listed under Failed and is still startable).
  return (
    <LineStartControl projectId={projectId} project={sub.label} admit={admit} waiting={rollup?.causes ?? sub.rows.length} ready={rollup?.ready ?? sub.ready ?? null} notReady={rollup?.notReady}
      className="lw-act" label="Review start" triggerProps={{ "data-line-start": projectId }} />
  );
}
