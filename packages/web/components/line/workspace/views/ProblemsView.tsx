"use client";
// Problems (line-workspace.md LW1), the line's home: every problem on the
// process in view the way an error tracker opens its issue stream. What waits
// on you first (one strip into the Inbox), then one chart of every problem's
// findings over the window, then the table: status, source and came-back
// filters with counts, sortable columns, a sparkline per row on the chart's
// axis, and where each fix stands. A span brushed on the chart, or a
// problem's band clicked, narrows the list. j and k move, Enter opens. An open
// problem (`case` in the URL) leads with the fix waiting on you, then its
// timeline, beside the list when the pane is wide, in its place when it is
// not. The source filter is the shared `source` key, so a source picked in
// Sources narrows this list too.
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Check, ChevronDown, RotateCcw, Search, X } from "lucide-react";
import { findingConversation } from "@codecast/shared/contracts/judges";
import { useDecisionTask, useOpenFixDecisions } from "../../../../hooks/useFixDecision";
import { useTrialCards } from "../../../../hooks/useSyncTrial";
import { decisionRef } from "../../../../lib/line/fixDecision";
import {
  buildOverview, conversationsByProblem, countIn, fixStand, inFocus, overviewWindow,
  type FixStand, type OverviewFocus, type OverviewRange, type WaitingFix,
} from "../../../../lib/line/problemsOverview";
import { momentWords } from "../../../../lib/line/timeline";
import { LineDecision } from "../../widgets/LineDecision";
import { TrialCardPanel } from "./TrialCardPanel";
import { useLiveTrialDecisionStatus } from "./trialCards";
import { trialCardAnswerable, trialCardWaits } from "../../../../lib/line/lineInbox";
import { ProblemsOverview } from "./timeline/ProblemsOverview";
import { useEventListener } from "../../../../hooks/useEventListener";
import { useTabActive } from "../../../../hooks/usePagePresence";
import { hasOpenModal } from "../../../../shortcuts";
import { controlFocused, keyBelongsElsewhere } from "../../../../shortcuts/keyOwnership";
import { sourceLabel } from "../../../../lib/line/loopSteps";
import { humanize } from "../../../../lib/line/sourceNames";
import { sourceChipWords } from "../../../../lib/line/stepRuns";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import {
  buildProblemRows, DEFAULT_SORT, filterProblems, firstDesc, problemCounts, problemTableSig, sortProblemRows, PROBLEM_STATUSES, PROBLEM_STATUS_WORDS,
  type ProblemFilter, type ProblemSort, type ProblemSortKey, type ProblemTableRow, type StatusFilter,
} from "../../../../lib/line/problemTable";
import { usePopover } from "../usePopover";
import { setLineOn } from "../../map/useLineAdmission";
import { defectHeads, withDuplicatesUnderPrimary } from "../../../../lib/line/overlap";
import { ProblemTable } from "./timeline/ProblemTable";
import { TimelineView } from "./TimelineView";
import type { LineViewProps } from "./types";
import "./timeline/problems.css";
import "./timeline/overview.css";

/** What leads an open problem: a fix decision waiting on you (LineDecision), or a trial card no station posted as one, read as a proposal (TrialCardPanel). */
type LeadFix = WaitingFix & { kind: "decision" | "card" };

export function ProblemsView(props: LineViewProps) {
  const { model, workspace, selection, select, href, drawerOpen } = props;
  const [status, setStatus] = useState<StatusFilter>("active");
  const [back, setBack] = useState(false);
  const [lessons, setLessons] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProblemSort>(DEFAULT_SORT);
  const [cursor, setCursor] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // A fix put aside on an open problem (its X) stays aside until the problem changes or its Fix button asks for it again.
  // It only hides the fix that would lead by default: a decision the address names always shows, so Back onto it restores it.
  const [aside, setAside] = useState<string | null>(null);

  // A model rebuild makes every issue anew: a row whose signature held keeps its object, so the memoized rows redraw only the problems that moved.
  const kept = useRef(new Map<string, ProblemTableRow & { sig: string }>());
  const all = useMemo(() => {
    const next = new Map<string, ProblemTableRow & { sig: string }>();
    const out = buildProblemRows(model.issues, workspace.sources, workspace.rows.tasks, workspace.rows.signals as never).map((r) => {
      const sig = problemTableSig(r);
      const was = kept.current.get(r.id);
      const row = was?.sig === sig ? was : { ...r, sig };
      next.set(r.id, row);
      return row;
    });
    kept.current = next;
    return out;
  }, [model.issues, workspace.sources, workspace.rows.signals, workspace.rows.tasks]);

  const filter: ProblemFilter = { status, source: selection.source, back, query, hideLessons: !lessons };
  const counts = useMemo(() => problemCounts(all, filter), [all, status, selection.source, back, query, lessons]); // eslint-disable-line react-hooks/exhaustive-deps

  // The chart's window, shared by every row's sparkline; it moves once a bucket, never with the clock.
  const [range, setRange] = useState<OverviewRange>("7d");
  const [focus, setFocus] = useState<OverviewFocus | null>(null);
  const winNow = overviewWindow(range, workspace.now);
  const win = useMemo(() => winNow, [range, winNow.d1]); // eslint-disable-line react-hooks/exhaustive-deps
  const matching = useMemo(() => filterProblems(all, filter), [all, status, selection.source, back, query, lessons]); // eslint-disable-line react-hooks/exhaustive-deps
  const overview = useMemo(() => buildOverview(matching.map((r) => r.issue), win), [matching, win]);
  const inWindow = useMemo(() => new Map(all.map((r) => [r.id, countIn(r.issue, win.d0, win.d1)])), [all, win]);
  const conv = useMemo(() => conversationsByProblem(workspace.rows.signals as ReadonlyArray<{ _id: string; task_id: string; observed_at?: number; created_at?: number; fingerprint?: string; moment?: string }>, findingConversation, win.d0, win.d1), [workspace.rows.signals, win]);

  // What waits on you per problem: an open fix decision, else a trial card its station posted, else the newest run's card still pending.
  const decisions = useOpenFixDecisions();
  const trialCards = useTrialCards();
  const liveTrial = useLiveTrialDecisionStatus();
  // A trial card that cannot take an answer (no station posted it as a decision, or its step left the line) is a
  // proposal an open problem shows, never a fix waiting on you: its run has to be asked again first.
  const proposals = useMemo(() => {
    const out = new Map<string, LeadFix>();
    for (const c of trialCards) {
      const live = c.decision ? liveTrial.get(c.decision._id) : null;
      if (out.has(c.task_id) || !trialCardWaits(c, live) || trialCardAnswerable(c, live)) continue;
      out.set(c.task_id, c.decision ? { ref: c.decision.short_id ?? c.decision._id, trial: true, kind: "decision" } : { ref: c.short_id, trial: true, kind: "card" });
    }
    return out;
  }, [trialCards, liveTrial]);
  const waiting = useMemo(() => {
    const out = new Map<string, LeadFix>();
    for (const [task, d] of decisions) out.set(task, { ref: decisionRef(d), trial: false, kind: "decision" });
    // A trial card its station posted waits as the Inbox reads it (trialCardWaits) and opens as that decision.
    for (const c of trialCards) {
      if (!c.decision || out.has(c.task_id) || !trialCardAnswerable(c, liveTrial.get(c.decision._id))) continue;
      out.set(c.task_id, { ref: c.decision.short_id ?? c.decision._id, trial: true, kind: "decision" });
    }
    for (const r of all) {
      if (out.has(r.id)) continue;
      const card = r.issue.history.attempts[r.issue.history.attempts.length - 1]?.card;
      if (card?.ref && !card.answer && (card.status === "pending" || card.status === "waiting") && /^sd-/.test(card.ref)) out.set(r.id, { ref: card.ref, trial: false, kind: "decision" });
    }
    return out;
  }, [decisions, trialCards, liveTrial, all]);
  const fix = useMemo(() => new Map<string, FixStand>(all.map((r) => [r.id, fixStand(r.issue, waiting.get(r.id))])), [all, waiting]);

  // A duplicate (overlap) sits right under the oldest problem of its set, so the two read as one thing.
  // One defect under several ids folds under the first of it listed; "+N same defect" opens it.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  // Under Active, what waits on you leads, in the sort's order: the rest follow it.
  const filtered = useMemo(() => {
    const sorted = sortProblemRows(matching.filter((r) => inFocus(r.issue, focus)), sort, { findings: inWindow, conv, fix });
    return status === "active" ? [...sorted.filter((r) => r.status === "waiting"), ...sorted.filter((r) => r.status !== "waiting")] : sorted;
  }, [matching, focus, sort, inWindow, conv, fix, status]);
  const folded = useMemo(() => defectHeads(filtered, workspace.overlaps), [filtered, workspace.overlaps]);
  // The open problem's defect stays open, so a sibling opened from elsewhere is in the list.
  const openHead = useMemo(() => [...folded].find(([, kids]) => kids.some((k) => k.id === selection.case))?.[0] ?? null, [folded, selection.case]);
  const rows = useMemo(() => withDuplicatesUnderPrimary(filtered, workspace.overlaps, openHead ? new Set([...unfolded, openHead]) : unfolded), [filtered, workspace.overlaps, unfolded, openHead]);
  const toggleFold = useCallback((id: string) => setUnfolded((u) => { const n = new Set(u); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
  const lineOff = useCallback((p: string | null) => !!p && workspace.admissions.has(p) && !workspace.admissions.get(p)!.on, [workspace.admissions]);
  // Each project whose line is off, with how many of its open problems wait on the switch: one strip above the list.
  const offProjects = useMemo(() => {
    const by = new Map<string, number>();
    // A trial project's line is off on purpose (its runs are started by hand), as the Inbox's Not starting group reads it.
    for (const r of all) if (r.status === "open" && r.projectId && lineOff(r.projectId) && !workspace.trialProjects?.has(r.projectId)) by.set(r.projectId, (by.get(r.projectId) ?? 0) + 1);
    return [...by].sort((a, b) => b[1] - a[1]);
  }, [all, lineOff, workspace.trialProjects]);
  const order = useMemo(() => rows.map((r) => r.id), [rows]);

  const projectNames = useMemo(() => new Map(workspace.projects.map((p) => [p._id, p.title])), [workspace.projects]);
  const projectName = useCallback((id: string | null) => (id ? projectNames.get(id) ?? "" : ""), [projectNames]);
  const open = useCallback((id: string | null) => select({ case: id, run: null }), [select]);
  const caseHref = useCallback((id: string) => href({ case: id, run: null }), [href]);
  const sourceWords = useCallback((id: string) => { const src = workspace.sources.get(id); return src ? sourceChipWords(src) : undefined; }, [workspace.sources]);
  const openFix = useCallback((id: string, ref: string) => {
    setAside(null);
    select({ case: id, run: null, decision: waiting.get(id)?.kind === "decision" ? ref : null });
  }, [select, waiting]);
  const onSort = useCallback((key: ProblemSortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: firstDesc(key) })), []);
  const setSource = useCallback((source: string | null) => select({ source }), [select]);
  // The open problem's row, whatever opened it (the Inbox, a finding, a link by ref): highlighted and scrolled into view.
  const openId = useMemo(() => (selection.case ? all.find((r) => r.id === selection.case || r.issue.ref === selection.case)?.id ?? selection.case : null), [all, selection.case]);
  const openInList = !!openId && order.includes(openId);
  useWatchEffect(() => { if (openId && openInList) scrollToRow(openId, "center"); }, [openId, openInList]);

  // With no problem open: j and k move the cursor, Enter opens it, / finds. An open problem's own keys live in TimelineView.
  const active = useTabActive();
  const at = cursor ? order.indexOf(cursor) : -1;
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!active || selection.case || drawerOpen || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
    if (e.key === "j" || e.key === "ArrowDown") { const to = order[Math.min(order.length - 1, at + 1)]; if (to) { e.preventDefault(); setCursor(to); scrollToRow(to); } }
    else if (e.key === "k" || e.key === "ArrowUp") { const to = order[Math.max(0, at - 1)]; if (to) { e.preventDefault(); setCursor(to); scrollToRow(to); } }
    else if (e.key === "Enter" && cursor && at >= 0 && !controlFocused(e.target)) { e.preventDefault(); open(cursor); }
    else if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); }
  });

  // The fix leading an open problem: the one the address names, else the one waiting on it.
  const caseId = openId;
  // A decision the address names leads only the problem it is about: one the store files under another problem
  // (or a trial card of another problem) gives way to what waits on this one.
  const namedTask = useDecisionTask(selection.decision);
  const namedCard = selection.decision ? trialCards.find((c) => c.decision && (c.decision.short_id === selection.decision || c.decision._id === selection.decision)) : undefined;
  const namedFor = namedTask !== undefined ? namedTask : namedCard?.task_id;
  const named = !!selection.decision && !!caseId && (namedFor === undefined || namedFor === caseId);
  const lead: LeadFix | null = caseId
    ? (named ? { ref: selection.decision!, trial: false, kind: "decision" } : waiting.get(caseId) ?? proposals.get(caseId) ?? null)
    : null;
  useWatchEffect(() => { setAside(null); }, [caseId]);
  const leadCard = lead?.kind === "card" ? trialCards.find((c) => c.short_id === lead.ref) ?? null : null;
  const leadNode: ReactNode = !caseId || !lead || (aside === lead.ref && !named) ? null : lead.kind === "decision" ? (
    <div className="lwp-lead" data-line-problem-lead={lead.ref}>
      <LineDecision key={lead.ref} id={lead.ref} source={sourceWords(caseId) ?? null} onClose={() => { setAside(lead.ref); if (selection.decision) select({ decision: null }); }}
        onProblem={(taskId) => select({ case: taskId, run: null })}
        onRun={(runId, taskId) => select({ view: "runs", run: runId, decision: null }, taskId)} />
    </div>
  ) : leadCard ? (
    <div className="lwp-lead" data-line-problem-lead={leadCard.short_id}>
      <TrialCardPanel card={leadCard} now={workspace.now} source={sourceWords(leadCard.task_id) ?? null} onClose={() => setAside(leadCard.short_id)}
        onProblem={() => select({ case: leadCard.task_id, run: null })} onRun={() => select({ view: "runs", run: leadCard.run_id }, leadCard.task_id)} />
    </div>
  ) : null;

  // The fixes waiting on you in the process in view, as the Inbox lists them (its Fixes to decide group): the strip names the first few.
  const fixRows = useMemo(() => workspace.inbox.find((g) => g.kind === "decide")?.rows ?? [], [workspace.inbox]);
  const focusWords = !focus ? null : focus.kind === "problem"
    ? (() => { const r = all.find((x) => x.id === focus.id); return r ? `${r.issue.ref ?? ""} ${r.issue.title}`.trim() : "One problem"; })()
    : `${momentWords(focus.from)} to ${momentWords(focus.to)}`;

  if (!model.issues.length) return <div className="lw-empty" data-line-problems="empty"><b>No problems</b>Nothing has reached this process.</div>;

  return (
    <div className="lwp-host" data-line-problems={all.length}>
      <div className="lwp" data-open={selection.case ? "" : undefined} data-lead={leadNode ? "" : undefined}>
        <div className="lwp-list">
          {fixRows.length > 0 && !selection.case && (
            <div className="lwp-waiting" data-line-fixes-waiting={fixRows.length}>
              <span className="lw-num">{fixRows.length}</span>
              <span className="lwp-waiting-h">{fixRows.length === 1 ? "fix to decide" : "fixes to decide"}{workspace.forYou > fixRows.length && <span className="lwp-waiting-of"> of {workspace.forYou} for you</span>}</span>
              <span className="lwp-waiting-list">
                {fixRows.slice(0, 3).map((r) => (
                  <button key={r.key} type="button" className="lwp-waiting-fix" onClick={() => r.caseId && openFix(r.caseId, r.decisionRef ?? r.cardRef ?? "")} title={[`${r.ref ?? ""} ${r.title}`.trim(), r.ask].filter(Boolean).join("\n")} data-line-fix-open={r.decisionRef ?? r.cardRef ?? undefined}>
                    {r.ref && <b className="lwp-waiting-ref">{r.ref}</b>}{r.title}
                  </button>
                ))}
              </span>
              <a className="lwp-waiting-all" href={href({ view: "inbox" })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select({ view: "inbox" }); }}>
                {fixRows.length > 3 ? `All ${fixRows.length}` : "Inbox"}<ArrowRight aria-hidden />
              </a>
            </div>
          )}
          {!selection.case && offProjects.length > 0 && (
            <div className="lwp-off" data-line-off={offProjects.length}>
              <span className="lwp-off-h">Line off</span>
              {offProjects.map(([pid, n]) => {
                const a = workspace.admissions.get(pid);
                return (
                  <span key={pid} className="lwp-off-p" title={`${n} open ${n === 1 ? "problem waits" : "problems wait"} for ${projectName(pid) || "this project"}'s line to be turned on`} data-line-off-project={pid}>
                    <b>{projectName(pid) || "A project"}</b><span className="lw-num">{n}</span> waiting
                    {a?.role && <button type="button" className="lw-act" onClick={() => setLineOn(a.role!.id, true)} data-line-off-turn-on={pid}>Turn on</button>}
                  </span>
                );
              })}
            </div>
          )}
          {!selection.case && <ProblemsOverview overview={overview} range={range} onRange={setRange} focus={focus} onFocus={setFocus} focusWords={focusWords} />}
          <div className="lwp-bar">
            <div className="lw-seg lwp-status" role="tablist" aria-label="Status">
              <button type="button" role="tab" aria-selected={status === "active"} onClick={() => setStatus("active")} data-line-status="active" title="Every problem not closed">
                Active<span className="lw-num">{counts.status.get("active") ?? 0}</span>
              </button>
              {PROBLEM_STATUSES.filter((s) => s !== "closed").map((s) => (
                <button key={s} type="button" role="tab" aria-selected={status === s} onClick={() => setStatus(status === s ? "active" : s)} data-line-status={s} disabled={!counts.status.get(s) && status !== s}>
                  <i className="lwp-dot" data-status={s} aria-hidden />{PROBLEM_STATUS_WORDS[s]}<span className="lw-num">{counts.status.get(s) ?? 0}</span>
                </button>
              ))}
              <i className="lwp-seg-gap" aria-hidden />
              <button type="button" role="tab" aria-selected={status === "closed"} onClick={() => setStatus(status === "closed" ? "active" : "closed")} data-line-status="closed" disabled={!counts.status.get("closed") && status !== "closed"}>
                <i className="lwp-dot" data-status="closed" aria-hidden />Closed<span className="lw-num">{counts.status.get("closed") ?? 0}</span>
              </button>
              <button type="button" role="tab" aria-selected={status === "all"} onClick={() => setStatus("all")} data-line-status="all">
                All<span className="lw-num">{counts.status.get("all") ?? 0}</span>
              </button>
            </div>
            <StatusPicker value={status} counts={counts.status} onPick={setStatus} />
            <SourcePicker value={selection.source} sources={counts.sources} onPick={setSource} />
            <button type="button" className="lw-chip lwp-back-toggle" aria-pressed={back} onClick={() => setBack(!back)} disabled={!counts.back && !back} data-line-filter-back title="Only problems that came back after a close">
              <RotateCcw aria-hidden />Came back<span className="lw-num">{counts.back}</span>
            </button>
            {(counts.lessons > 0 || lessons) && (
              <button type="button" className="lw-chip" aria-pressed={lessons} onClick={() => setLessons(!lessons)} data-line-filter-lessons title="Problems only a lesson filed">
                Lessons<span className="lw-num">{counts.lessons}</span>
              </button>
            )}
            <label className="lwp-search">
              <Search aria-hidden />
              <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find" aria-label="Find a problem" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (query) setQuery(""); else e.currentTarget.blur(); } }} />
            </label>
          </div>
          {rows.length ? (
            <div className="lwp-scroll">
              <ProblemTable rows={rows} sort={sort} onSort={onSort} selected={openId} cursor={selection.case ? null : cursor} now={workspace.now} projectName={projectName} showProject={!workspace.project} open={open} href={caseHref} sourceWords={sourceWords} lineOff={lineOff} overlaps={workspace.overlaps} folded={folded} unfolded={unfolded} onFold={toggleFold}
                win={win} inWindow={inWindow} conv={conv} fix={fix} waiting={waiting} openFix={openFix} />
            </div>
          ) : (
            <div className="lw-empty lwp-none">
              <b>No match</b>
              <button type="button" className="lw-act" onClick={() => { setStatus("active"); setBack(false); setQuery(""); setSource(null); setFocus(null); }}>Clear filters</button>
            </div>
          )}
        </div>
        {selection.case && (
          <div className="lwp-detail">
            <TimelineView {...props} order={order} lead={leadNode} />
          </div>
        )}
      </div>
    </div>
  );
}

function scrollToRow(id: string, block: ScrollLogicalPosition = "nearest") {
  requestAnimationFrame(() => document.querySelector(`.lwp-row[data-line-issue="${id}"]`)?.scrollIntoView({ block }));
}

/** A source key as Sources writes it, in words: "AgentWatch", "AgentWatch / Quality". */
const sourceKeyWords = (key: string) => {
  const [src, judge] = key.split("/");
  return judge ? `${sourceLabel(src)} / ${humanize(judge)}` : sourceLabel(src);
};

/** The source filter: every source by default; a dropdown of the sources with problems in view, each with its count. */
function SourcePicker({ value, sources, onPick }: { value: string | null; sources: ReadonlyArray<{ key: string; label: string; n: number }>; onPick: (key: string | null) => void }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="lw-pop-host lwp-src-pick" ref={ref}>
      <button type="button" className="lw-chip" aria-haspopup="listbox" aria-expanded={open} data-on={value ? "" : undefined} onClick={() => setOpen(!open)} data-line-source-filter={value ?? "all"}>
        <span className="lw-chip-t">{value ? sourceKeyWords(value) : "All sources"}</span>
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

const STATUS_OPTIONS: ReadonlyArray<StatusFilter> = ["active", "waiting", "running", "open", "watching", "closed", "all"];
const statusWords = (s: StatusFilter) => (s === "active" ? "Active" : s === "all" ? "All" : PROBLEM_STATUS_WORDS[s]);

/** The status filter as one dropdown, for a pane too narrow for the segments (beside an open problem). */
function StatusPicker({ value, counts, onPick }: { value: StatusFilter; counts: ReadonlyMap<StatusFilter, number>; onPick: (s: StatusFilter) => void }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="lw-pop-host lwp-status-pick" ref={ref}>
      <button type="button" className="lw-chip" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} data-line-status-pick={value}>
        {value !== "active" && value !== "all" && <i className="lwp-dot" data-status={value} aria-hidden />}
        <span className="lw-chip-t">{statusWords(value)}</span>
        <span className="lw-num">{counts.get(value) ?? 0}</span>
        <ChevronDown className="w-3.5 h-3.5 opacity-60" aria-hidden />
      </button>
      {open && (
        <div className="lw-pop lw-filter-pop" role="listbox" aria-label="Status">
          {STATUS_OPTIONS.map((s) => (
            <button key={s} type="button" role="option" aria-selected={value === s} onClick={() => { onPick(s); setOpen(false); }}>
              <span className="lw-filter-check">{value === s ? <Check className="w-3.5 h-3.5" /> : s !== "active" && s !== "all" ? <i className="lwp-dot" data-status={s} aria-hidden /> : null}</span>
              <span className="lw-filter-name">{statusWords(s)}</span>
              <span className="lw-num">{counts.get(s) ?? 0}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
