"use client";
// Problems (line-workspace.md LW1): every problem on the process in view as a
// table, the way an error tracker lists issues. Status, source and came-back
// filters with counts, sortable columns, j and k to move, Enter to open. An
// open problem (`case` in the URL) shows its timeline beside the list when
// the pane is wide, in its place when it is not. The source filter is the
// shared `source` key, so a source picked in Sources narrows this list too.
import { useCallback, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, RotateCcw, Search, X } from "lucide-react";
import { useEventListener } from "../../../../hooks/useEventListener";
import { useTabActive } from "../../../../hooks/usePagePresence";
import { hasOpenModal } from "../../../../shortcuts";
import { keyBelongsElsewhere } from "../../../../shortcuts/keyOwnership";
import { sourceLabel } from "../../../../lib/line/loopSteps";
import {
  buildProblemRows, DEFAULT_SORT, filterProblems, firstDesc, problemCounts, problemTableSig, sortProblemRows, PROBLEM_STATUSES, PROBLEM_STATUS_WORDS,
  type ProblemFilter, type ProblemSort, type ProblemSortKey, type ProblemStatus, type ProblemTableRow,
} from "../../../../lib/line/problemTable";
import { usePopover } from "../usePopover";
import { ProblemTable } from "./timeline/ProblemTable";
import { TimelineView } from "./TimelineView";
import type { LineViewProps } from "./types";
import "./timeline/problems.css";

export function ProblemsView(props: LineViewProps) {
  const { model, workspace, selection, select, href, drawerOpen } = props;
  const [status, setStatus] = useState<ProblemStatus | "all">("all");
  const [back, setBack] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProblemSort>(DEFAULT_SORT);
  const [cursor, setCursor] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // A model rebuild makes every issue anew: a row whose signature held keeps its object, so the memoized rows redraw only the problems that moved.
  const kept = useRef(new Map<string, ProblemTableRow & { sig: string }>());
  const all = useMemo(() => {
    const next = new Map<string, ProblemTableRow & { sig: string }>();
    const out = buildProblemRows(model.issues, workspace.rows.signals, workspace.rows.tasks).map((r) => {
      const sig = problemTableSig(r);
      const was = kept.current.get(r.id);
      const row = was?.sig === sig ? was : { ...r, sig };
      next.set(r.id, row);
      return row;
    });
    kept.current = next;
    return out;
  }, [model.issues, workspace.rows.signals, workspace.rows.tasks]);

  const filter: ProblemFilter = { status, source: selection.source, back, query };
  const counts = useMemo(() => problemCounts(all, filter), [all, status, selection.source, back, query]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => sortProblemRows(filterProblems(all, filter), sort), [all, status, selection.source, back, query, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const order = useMemo(() => rows.map((r) => r.id), [rows]);

  const projectNames = useMemo(() => new Map(workspace.projects.map((p) => [p._id, p.title])), [workspace.projects]);
  const projectName = useCallback((id: string | null) => (id ? projectNames.get(id) ?? "" : ""), [projectNames]);
  const open = useCallback((id: string | null) => select({ case: id, run: null }), [select]);
  const caseHref = useCallback((id: string) => href({ case: id, run: null }), [href]);
  const onSort = useCallback((key: ProblemSortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: firstDesc(key) })), []);
  const setSource = useCallback((source: string | null) => select({ source }), [select]);

  // With no problem open: j and k move the cursor, Enter opens it, / finds. An open problem's own keys live in TimelineView.
  const active = useTabActive();
  const at = cursor ? order.indexOf(cursor) : -1;
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!active || selection.case || drawerOpen || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
    if (e.key === "j" || e.key === "ArrowDown") { const to = order[Math.min(order.length - 1, at + 1)]; if (to) { e.preventDefault(); setCursor(to); scrollToRow(to); } }
    else if (e.key === "k" || e.key === "ArrowUp") { const to = order[Math.max(0, at - 1)]; if (to) { e.preventDefault(); setCursor(to); scrollToRow(to); } }
    else if (e.key === "Enter" && cursor && at >= 0) { e.preventDefault(); open(cursor); }
    else if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); }
  });

  if (!model.issues.length) return <div className="lw-empty" data-line-problems="empty"><b>No problems</b>Nothing has reached this process.</div>;

  const filtered = status !== "all" || !!selection.source || back || !!query.trim();
  return (
    <div className="lwp-host" data-line-problems={all.length}>
      <div className="lwp" data-open={selection.case ? "" : undefined}>
        <div className="lwp-list">
          <div className="lwp-bar">
            <div className="lw-seg lwp-status" role="tablist" aria-label="Status">
              <button type="button" role="tab" aria-selected={status === "all"} onClick={() => setStatus("all")} data-line-status="all">
                All<span className="lw-num">{counts.status.get("all") ?? 0}</span>
              </button>
              {PROBLEM_STATUSES.map((s) => (
                <button key={s} type="button" role="tab" aria-selected={status === s} onClick={() => setStatus(status === s ? "all" : s)} data-line-status={s} disabled={!counts.status.get(s) && status !== s}>
                  <i className="lwp-dot" data-status={s} aria-hidden />{PROBLEM_STATUS_WORDS[s]}<span className="lw-num">{counts.status.get(s) ?? 0}</span>
                </button>
              ))}
            </div>
            <SourcePicker value={selection.source} sources={counts.sources} onPick={setSource} />
            <button type="button" className="lw-chip lwp-back-toggle" aria-pressed={back} onClick={() => setBack(!back)} disabled={!counts.back && !back} data-line-filter-back title="Only problems that came back after a close">
              <RotateCcw aria-hidden />Came back<span className="lw-num">{counts.back}</span>
            </button>
            <label className="lwp-search">
              <Search aria-hidden />
              <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find" aria-label="Find a problem" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (query) setQuery(""); else e.currentTarget.blur(); } }} />
            </label>
            <span className="lwp-count lw-num" data-line-problems-shown={rows.length}>{filtered ? `${rows.length} of ${all.length}` : all.length}</span>
          </div>
          {rows.length ? (
            <div className="lwp-scroll">
              <ProblemTable rows={rows} sort={sort} onSort={onSort} selected={selection.case} cursor={selection.case ? null : cursor} now={workspace.now} projectName={projectName} showProject={!workspace.project} open={open} href={caseHref} />
            </div>
          ) : (
            <div className="lw-empty lwp-none">
              <b>No match</b>
              <button type="button" className="lw-act" onClick={() => { setStatus("all"); setBack(false); setQuery(""); setSource(null); }}>Clear filters</button>
            </div>
          )}
        </div>
        {selection.case && (
          <div className="lwp-detail">
            <TimelineView {...props} order={order} />
          </div>
        )}
      </div>
    </div>
  );
}

function scrollToRow(id: string) {
  requestAnimationFrame(() => document.querySelector(`.lwp-row[data-line-issue="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" }));
}

/** The source filter: every source by default; a dropdown of the sources with problems in view, each with its count. */
function SourcePicker({ value, sources, onPick }: { value: string | null; sources: ReadonlyArray<{ key: string; label: string; n: number }>; onPick: (key: string | null) => void }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="lw-pop-host lwp-src-pick" ref={ref}>
      <button type="button" className="lw-chip" aria-haspopup="listbox" aria-expanded={open} data-on={value ? "" : undefined} onClick={() => setOpen(!open)} data-line-source-filter={value ?? "all"}>
        <span className="lw-chip-t">{value ? sourceLabel(value) : "All sources"}</span>
        {value
          ? <span role="button" tabIndex={-1} className="lwp-clear" aria-label="All sources" onClick={(e) => { e.stopPropagation(); onPick(null); }}><X aria-hidden /></span>
          : <ChevronDown className="w-3.5 h-3.5 opacity-60" aria-hidden />}
      </button>
      {open && (
        <div className="lw-pop lw-filter-pop" role="listbox" aria-label="Source">
          <button type="button" role="option" aria-selected={!value} onClick={() => { onPick(null); setOpen(false); }}>
            <span className="lw-filter-check">{!value && <Check className="w-3.5 h-3.5" />}</span>
            <span className="lw-filter-name">All sources</span>
          </button>
          {sources.map((s) => (
            <button key={s.key} type="button" role="option" aria-selected={value === s.key} onClick={() => { onPick(s.key); setOpen(false); }} data-line-source-option={s.key}>
              <span className="lw-filter-check">{value === s.key && <Check className="w-3.5 h-3.5" />}</span>
              <span className="lw-filter-name">{s.label}</span>
              <span className="lw-num">{s.n}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
