"use client";
// One problem's page (line-workspace.md LW1 Problems): what it is and where it
// came from, its life on one time axis, every run on it (each one click from
// its run detail), and every finding with its source. State is marks, chips
// and numbers; the only reading is what the sources and the agents said.
import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, ChevronLeft, ChevronRight, GitMerge, Play, Rocket, RotateCcw } from "lucide-react";
import { historyBrief, unshippedGuard, type CauseHistory, type HistoryAttempt } from "../../../../../lib/line/causeHistory";
import type { LineIssue, LineModel } from "../../../../../lib/line/lineModel";
import type { LineSignal } from "../../../../../lib/lineFlow";
import type { LineSelectionPatch } from "../../../../../lib/line/lineWorkspaceUrl";
import { formatRelativeTime } from "../../../../../lib/conversationFormat";
import {
  attemptEndWords, attemptTone, cameBackCount, shownWatches, closeStepLabel, comebackAt, defaultRange, momentWords, problemState, rangeDomain, spanWords,
  TIME_RANGES, type Domain, type TimeRange,
} from "../../../../../lib/line/timeline";
import { problemNow, problemStatus, statusWords, waitingWhy } from "../../../../../lib/line/problemTable";
import { homeExpectation, offTopicComebacks, withoutOffTopic, type TopicSignal } from "../../../../../lib/line/timeline";
import { useCollectionRows } from "../../../../../hooks/useCollectionRows";
import { FoundWords, RunPath, StepKindLegend, useLineNav } from "../../../widgets";
import { findingGist, findingTitle, sourceLabel } from "../../../../../lib/line/loopSteps";
import { UNAPPROVED_WORDS, shortDay } from "../../../../../lib/line/runReport";
import { causeDoubt } from "../../../../../lib/line/lineTrace";
import { useInboxStore } from "../../../../../store/inboxStore";
import { AskAgain } from "../../../AskAgain";
import { DoubtChip } from "../../../DoubtChip";
import { requestReplayAt } from "../../stepDrafts";
import { askLine, waitsForFindings } from "../../../../../lib/line/lineInbox";
import { TimelineChart, type TimelinePick } from "./TimelineChart";
import { CameFrom, ProblemAsk, reporterOf, useReporterNames } from "./ProblemHead";
import { useWaitingTrialCards } from "../trialCards";
import type { Overlap } from "../../../../../lib/line/overlap";
import { scriptSaid } from "../../../../../lib/line/visitOutput";
import "./problems.css";

const topicSig = (x: { _id: string; observed_at?: number; subject?: string | null }) => `${x._id}|${x.observed_at ?? 0}|${x.subject ?? ""}`;
const RANGE_WORDS: Record<TimeRange, string> = { "24h": "24h", "7d": "7d", "30d": "30d", all: "All" };
const EXAMPLES = 12;
/** A list this short shows whole. */
const ALL_UP_TO = 24;
const COVERAGE_WORDS = { unread: "reading", none: "none recorded", known: "recorded" } as const;

export type ProblemTimelineProps = {
  issue: LineIssue;
  model: LineModel;
  now: number;
  /** The project's name when the line shows every project; null when filtered to one. */
  projectTitle?: string | null;
  /** The findings in view; this problem's are the ones filed on it. */
  signals: ReadonlyArray<LineSignal>;
  /** The problems either side in the list, for the arrows (j and k). */
  prev: LineIssue | null;
  next: LineIssue | null;
  open: (id: string | null) => void;
  select: (patch: LineSelectionPatch) => void;
  /** The address asked for the question's answer box (`ask=1`). */
  askFocus?: boolean;
  /** Its duplicate set (lib/line/overlap): the problems that read the same, filed under the oldest. */
  overlap?: Overlap | null;
  refOf?: (id: string) => string | null;
  /** The fix waiting on you about this problem (its decision), drawn first under the crumbs. */
  lead?: ReactNode;
};

export function ProblemTimeline({ issue, model, now, projectTitle = null, signals, prev, next, open, select, askFocus = false, overlap = null, refOf, lead = null }: ProblemTimelineProps) {
  // Every finding on the problem (its own feed brings the older ones): what tells a comeback from a cluster that drifted.
  const caseWhere = useMemo(() => (x: TopicSignal & { task_id?: string; retired?: unknown }) => x.task_id === issue.id && !x.retired, [issue.id]);
  const caseSignals = useCollectionRows<TopicSignal & { _id: string; task_id: string }>("signals", { where: caseWhere, sig: topicSig });
  const offTopic = useMemo(() => offTopicComebacks(issue.history, caseSignals), [issue.history, caseSignals]);
  const home = useMemo(() => homeExpectation(issue.history, caseSignals), [issue.history, caseSignals]);
  // The page reads the history with the drift taken out, so its header, chart, runs and close marks say one count.
  const read = useMemo(() => withoutOffTopic(issue.history, offTopic), [issue.history, offTopic]);
  // A run parked at a trial card waits on you from the moment it asked: its bar ends there in the decision's color,
  // and every surface of the page says "waiting on you", never "running" for the hours it sits.
  const waits = useWaitingTrialCards();
  const lastRun = read.attempts[read.attempts.length - 1]?.runId ?? null;
  const lastWait = lastRun ? waits.get(lastRun) ?? null : null;
  const h = useMemo(() => {
    const last = read.attempts[read.attempts.length - 1];
    if (!lastWait || !last?.live) return read;
    const parked = { ...last, live: false, end: Math.max(last.start, lastWait.created_at), outcome: { ...last.outcome, tone: "waiting" as const, text: `Waiting on your answer to ${lastWait.decision?.short_id ?? lastWait.short_id}` } };
    return { ...read, attempts: [...read.attempts.slice(0, -1), parked] };
  }, [read, lastWait]);
  const state = problemState(h, issue.status);
  const status = problemStatus(issue, state);
  const [range, setRange] = useState<TimeRange>(() => defaultRange(h, now));
  const [zoom, setZoom] = useState<Domain | null>(null);
  const domain = useMemo(() => zoom ?? rangeDomain(range, h, now), [zoom, range, h, now]);
  const latestBack = h.regressed ? h.regressions[h.regressions.length - 1] : h.cameBack ? h.recurrences[h.recurrences.length - 1] : null;
  const [pick, setPick] = useState<TimelinePick | null>(() => (latestBack ? { kind: "comeback", runId: latestBack.afterRunId } : null));
  const labelOf = useCallback((id: string) => model.steps[id]?.label, [model.steps]);
  const backCount = cameBackCount(h, offTopic);
  const [openRun, setOpenRun] = useState<string | null>(() => h.attempts[h.attempts.length - 1]?.runId ?? null);
  const attemptsRef = useRef<HTMLDivElement>(null);
  const occRef = useRef<HTMLDivElement>(null);

  const onPick = useCallback((p: TimelinePick) => {
    if (p.kind === "attempt") {
      setOpenRun(p.runId);
      requestAnimationFrame(() => attemptsRef.current?.querySelector(`[data-attempt="${p.runId}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
      return;
    }
    setPick(p);
    requestAnimationFrame(() => occRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }, []);
  const onZoom = useCallback((d: Domain) => setZoom(d), []);
  const onReset = useCallback(() => setZoom(null), []);

  // This problem's findings and where they came from: the problem's own feed when it holds more than the rows in view.
  const own = useMemo(() => {
    const inView = signals.filter((s) => s.task_id === issue.id);
    return caseSignals.length > inView.length ? (caseSignals as unknown as LineSignal[]) : inView;
  }, [signals, issue.id, caseSignals]);
  const sources = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of own) m.set(s.source, (m.get(s.source) ?? 0) + 1);
    if (!m.size) for (const q of issue.quotes) m.set(q.source, (m.get(q.source) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [own, issue.quotes]);
  const openSource = useCallback((source: string, finding?: string) => select({ view: "sources", source, finding: finding ?? null }), [select]);

  const total = Math.max(issue.findings, h.occurrences.length);
  // The cause's own row: a doubt the record raised about it.
  const causeRow = useInboxStore((st) => (st.tasks as unknown as Record<string, Parameters<typeof causeDoubt>[0] & { project_id?: string }>)[issue.id] ?? null);
  const doubtRead = causeRow ? causeDoubt(causeRow) : null;
  // The question itself is pinned below, so the chip that only says one was asked stays off.
  const doubt = doubtRead && !(issue.ask && causeRow?.readiness === "needs_context" && doubtRead.why === issue.ask) ? doubtRead : null;
  // The last run built a fix and went past a card nobody answered: the card has to be asked again.
  const askAgain = issue.where.text === UNAPPROVED_WORDS && !h.regressed && issue.status !== "done" && issue.status !== "dropped";
  const unanswered = askAgain ? h.attempts[h.attempts.length - 1] ?? null : null;
  const last = h.occurrences[h.occurrences.length - 1]?.at ?? null;
  // A run parked at a trial card waits on you, in the Runs list's words, not "running".
  const now_ = useMemo(() => {
    const w = problemNow(issue);
    return lastWait ? w.map((x) => (x === "running" ? `waiting on you · ${lastWait.short_id}` : x)) : w;
  }, [issue, lastWait]);

  return (
    <div className="lwt-page" data-line-problem={issue.id} data-state={state} data-status={status}>
      <div className="lwt-crumbs">
        <button type="button" className="lw-link lwt-back" onClick={() => open(null)} title="Back to problems (Esc)"><ArrowLeft className="w-3.5 h-3.5" />Problems</button>
        {issue.ref && <span className="lwt-ref">{issue.ref}</span>}
        <span className="lw-spacer" />
        <button type="button" className="lw-iconbtn" disabled={!prev} onClick={() => prev && open(prev.id)} aria-label="Previous problem" title="Previous problem (k)"><ChevronLeft className="w-4 h-4" /></button>
        <button type="button" className="lw-iconbtn" disabled={!next} onClick={() => next && open(next.id)} aria-label="Next problem" title="Next problem (j)"><ChevronRight className="w-4 h-4" /></button>
      </div>
      {lead}

      <header className="lwt-hero">
        <div className="lwt-hero-top">
          {/* A fix that went past an unanswered card: the pill says the state, the line under it what happened, the button what it does. */}
          <span className="lwp-pill" data-status={status} title={state !== status ? stateTitle(state) : undefined}>{askAgain ? "Not shipped" : statusWords(issue, status)}</span>
          {issue.dissolvedFixedAt != null && <span className="lwt-now" data-line-dissolved-fixed title="A finding observed after this reopens the problem"><span className="lwt-now-f">fixed since {shortDay(issue.dissolvedFixedAt)}</span></span>}
          {issue.dissolvedWhy && <span className="lwt-now" data-line-dissolved-why title={issue.dissolvedWhy}><span className="lwt-now-f">{issue.dissolvedWhy}</span></span>}
          {askAgain && unanswered ? (
            <span className="lwt-now" data-line-problem-unanswered><span className="lwt-now-f" data-tone="warn">Run #{unanswered.n} proposed a fix on {shortDay(unanswered.end ?? unanswered.start)}; nobody answered, so it did not ship</span></span>
          ) : now_.length > 0 && (
            <span className="lwt-now" data-line-problem-now title={waitingWhy(issue, status) ?? undefined}>
              {now_.map((w, i) => <span key={i} className="lwt-now-f" data-tone={/^waiting on you/.test(w) ? "ask" : /not deployed|unanswered|withdrawn|expired|came back|stopped|failed/.test(w) ? "warn" : undefined}>{i === 0 ? `Run ${w}` : w}</span>)}
            </span>
          )}
          {askAgain && <AskAgain taskId={issue.id} projectId={causeRow?.project_id ?? null} />}
          {backCount > 0 && <span className="lwp-back" data-line-came-back={backCount} title={`Came back ${backCount}x after a close`}><RotateCcw aria-hidden />{backCount}</span>}
          {projectTitle && <span className="lwt-hero-proj">{projectTitle}</span>}
        </div>
        {overlap && overlap.set.length > 1 && <Overlaps overlap={overlap} self={issue} refOf={refOf} open={open} />}
        <h2 className="lwt-h">{issue.title}</h2>
        {doubt && (
          <div className="lwt-hero-acts">
            <DoubtChip doubt={doubt} />
          </div>
        )}
      </header>

      {issue.ask && !waitsForFindings(issue.ask) && <ProblemAsk question={askLine(issue.ask)} why={issue.ask} taskRef={issue.ref} focus={askFocus} asks={issue.forYou ? issue.forYou === "question" : issue.findings > 1} />}
      <CameFrom own={own} expected={total} now={now} openSource={openSource} sources={sources} home={home} />

      <dl className="lwt-stats">
        <div><dt>First</dt><dd title={h.firstAt ? momentWords(h.firstAt) : undefined}>{h.firstAt ? formatRelativeTime(h.firstAt, now) : "never"}</dd></div>
        <div><dt>Last</dt><dd title={last ? momentWords(last) : undefined}>{last ? formatRelativeTime(last, now) : "never"}</dd></div>
        <div><dt>Runs</dt><dd className="lw-num">{h.attempts.length}</dd></div>
        <div data-bad={backCount ? "" : undefined}><dt>Came back</dt><dd className="lw-num">{backCount}</dd></div>
        {offTopic.size > 0 && <div data-off="" title="Findings after a close that cite another expectation: the cluster drifted, the problem did not come back"><dt>Off topic</dt><dd className="lw-num">{offTopic.size}</dd></div>}
      </dl>

      <section className="lw-obj lwt-panel" data-flat="">
        <div className="lw-obj-head lwt-toolbar">
          <div className="lw-seg" role="tablist" aria-label="Time range">
            {TIME_RANGES.map((r) => (
              <button key={r} type="button" role="tab" aria-selected={!zoom && range === r} onClick={() => { setRange(r); setZoom(null); }} data-line-range={r}>{RANGE_WORDS[r]}</button>
            ))}
          </div>
          {zoom && (
            <span className="lwt-zoomed">
              {momentWords(zoom[0])} to {momentWords(zoom[1])}
              <button type="button" className="lw-act" onClick={onReset}>Reset</button>
            </span>
          )}
          <span className="lw-spacer" />
          <Legend h={h} />
          {h.ships.length > 0 && <span className="lwt-coverage" data-state={h.coverage.state} title={h.coverage.words}>Deploys {COVERAGE_WORDS[h.coverage.state]}</span>}
        </div>
        <TimelineChart history={h} offTopic={offTopic} labelOf={labelOf} domain={domain} now={now} selectedRun={openRun} pick={pick} onPick={onPick} onZoom={onZoom} onReset={onReset} />
      </section>

      <div ref={attemptsRef}>
        <Attempts h={h} now={now} model={model} issue={issue} labelOf={labelOf} openRun={openRun} setOpenRun={setOpenRun} onShowBack={(runId) => onPick({ kind: "comeback", runId })} />
      </div>
      <div ref={occRef}>
        <Occurrences h={h} own={own} pick={pick} setPick={setPick} labelOf={labelOf} openSource={openSource} />
      </div>
    </div>
  );
}

/** The fine state a five-way status folds, for its tooltip. */
const stateTitle = (s: ReturnType<typeof problemState>) => ({
  regressed: "Regressed after a fix", cameback: "Came back after a close", fixing: "A run is on it", unapproved: "Shipped past an unanswered card",
  watching: "Shipped, under watch", held: "Shipped and held", folded: "Folded into another problem", open: "Open", closed: "Closed",
})[s];

/** A key for each kind of mark the chart draws, and only those. */
function Legend({ h }: { h: CauseHistory }) {
  return (
    <div className="lwt-legend" aria-label="Legend">
      {h.occurrences.length > 0 && <span><i className="lwt-k-occ" />finding</span>}
      {(h.regressions.length > 0 || h.recurrences.length > 0) && <span><i className="lwt-k-back" />came back</span>}
      {h.attempts.length > 0 && <span><i className="lwt-k-att" />run on it</span>}
      {h.closes.some((c) => c.kind !== "shipped") && <span><i className="lwt-k-close" />closed without a change</span>}
      {h.ships.some((s) => s.merge) && <span><i className="lwt-k-merge" />fix merged</span>}
      {h.deploys.length > 0 && <span><i className="lwt-k-deploy" />deploy</span>}
      {shownWatches(h).length > 0 && <span><i className="lwt-k-watch" />watch</span>}
    </div>
  );
}

// ── the findings: what a pick on the chart narrows ───────────────────────────

function Occurrences({ h, own, pick, setPick, labelOf, openSource }: {
  h: CauseHistory; own: ReadonlyArray<LineSignal>; pick: TimelinePick | null; setPick: (p: TimelinePick | null) => void;
  labelOf: (id: string) => string | undefined; openSource: (source: string, finding?: string) => void;
}) {
  const byAt = useMemo(() => {
    const m = new Map<number, LineSignal>();
    for (const s of own) m.set(s.observed_at ?? s.created_at, s);
    return m;
  }, [own]);
  const [more, setMore] = useState(false);

  // Every finding, newest first; a pick of a span on the chart narrows it to that span.
  const bucket = pick?.kind === "bucket" ? pick : null;
  const list = useMemo(() => (bucket ? h.occurrences.filter((o) => o.at >= bucket.from && o.at < bucket.to) : h.occurrences), [bucket, h.occurrences]);
  const rows = useMemo(() => [...list].reverse(), [list]);
  const shown = more || rows.length <= ALL_UP_TO ? rows : rows.slice(0, EXAMPLES);
  // Each close sits where it happened, as a divider: what came after one that did not hold is tinted under it.
  const items = useMemo(() => {
    const closes = [...h.closes].sort((a, b) => b.at - a.at);
    const out: Array<{ kind: "occ"; o: (typeof shown)[number] } | { kind: "close"; c: (typeof closes)[number] }> = [];
    let i = 0;
    for (const o of shown) {
      while (i < closes.length && closes[i].at > o.at) out.push({ kind: "close", c: closes[i++] });
      out.push({ kind: "occ", o });
    }
    return out;
  }, [shown, h.closes]);
  const pickedClose = pick?.kind === "comeback" ? pick.runId : null;
  const names = useReporterNames();
  // Findings of one problem often share a title (an expectation's words): each row then leads with what its finder says.
  const sameTitle = useMemo(() => new Set(own.map((s) => findingTitle(s))).size < own.length, [own]);

  return (
    <section className="lwt-sec" data-line-occurrences>
      <h3 className="lwt-sec-h">
        Findings
        <span className="lwt-sec-scope">{bucket ? `${momentWords(bucket.from)} to ${momentWords(bucket.to)}` : "All"} · {list.length}</span>
        {h.occurrencesFrom !== "history" && <span className="lwt-tag" title="Only the last two weeks of findings are read">14d</span>}
        {bucket && <button type="button" className="lw-link" onClick={() => setPick(null)}>Show all</button>}
      </h3>
      {!rows.length ? (
        <p className="lwt-quiet">{h.occurrences.length ? "None in this span." : "None recorded."}</p>
      ) : (
        <ol className="lwt-occ">
          {items.map((it) => {
            if (it.kind === "close") {
              const c = it.c;
              const after = closeAfter(c, h);
              const at = c.kind === "shipped" ? null : closeStepLabel(c.step, labelOf);
              return (
                <li key={`close:${c.runId}`} className="lwt-occ-close" data-tone={c.back ? "bad" : c.kind === "shipped" ? "ok" : undefined} data-picked={pickedClose === c.runId ? "" : undefined} data-line-occ-close={c.runId}>
                  <span><b>#{c.n}</b> {c.kind === "shipped" ? (h.ships.find((x) => x.runId === c.runId)?.deploys.length ? "deployed" : "merged") : c.kind}{at ? ` at ${at}` : ""}</span>
                  <time>{momentWords(c.at)}</time>
                  <span className="lwt-occ-close-back" data-tone={after.tone} title={after.title}>{after.text}</span>
                </li>
              );
            }
            const o = it.o;
            const s = byAt.get(o.at);
            const back = comebackAt(o.at, h);
            const who = s ? reporterOf(s, names) : null;
            const gist = s ? findingGist(s) : null;
            const lead = s ? (sameTitle ? gist?.says ?? gist?.quote ?? findingTitle(s) : findingTitle(s)) : null;
            return (
              <li key={o.at} data-back={back ? "" : undefined}>
                <time dateTime={new Date(o.at).toISOString()}>{momentWords(o.at)}</time>
                <div className="lwt-occ-body">
                  <span className="lwt-occ-t" title={s?.detail_md || s?.short_id || undefined}>{lead ?? <span className="lwt-none">Not loaded</span>}</span>
                  <span className="lwt-occ-m">
                    {s?.source && (
                      <button type="button" className="lwt-src" onClick={() => openSource(s.source, s._id)} title="Open this finding in Sources">{sourceLabel(s.source)}</button>
                    )}
                    {who && <span className="lwt-who">{who}</span>}
                    {gist?.quote && lead !== gist.quote && <q className="lwt-occ-q">{gist.quote}</q>}
                    {typeof s?.severity === "number" && <span className="lwt-sev" data-sev={Math.min(5, Math.round(s.severity / 2))} title="Severity, 1 to 10">sev {s.severity}</span>}
                    {o.reopened && <span className="lwt-tag" data-tone="bad">reopened</span>}
                    {back && <span className="lwt-tag" data-tone="bad"><RotateCcw className="w-3 h-3" />back</span>}
                  </span>
                </div>
                {s?.evidence_url && (
                  <a className="lw-iconbtn" href={s.evidence_url} target="_blank" rel="noreferrer" aria-label="Evidence" title="Where the source saw it"><ArrowUpRight className="w-3.5 h-3.5" /></a>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {rows.length > ALL_UP_TO && (
        <button type="button" className="lw-link lwt-more" onClick={() => setMore(!more)}>{more ? "Show fewer" : `Show all ${rows.length}`}</button>
      )}
    </section>
  );
}

/** What followed a close until the next one, as a mark: came back n times, folded, closed again, or quiet. */
export function closeAfter(c: CauseHistory["closes"][number], h: CauseHistory): { text: string; tone?: "bad" | "ok"; title?: string } {
  const span = [...h.regressions, ...h.recurrences].find((r) => r.afterRunId === c.runId);
  if (span?.count) return { text: `back ${span.count}x`, tone: "bad", title: `Came back ${span.count}x after it` };
  if (c.fold && c.fold.liveAt == null) return { text: "folded", title: c.fold.words };
  if (h.closes.some((x) => x.at > c.at)) return { text: "closed again" };
  return { text: "quiet", tone: "ok", title: "Nothing came back after it" };
}

// ── the runs ─────────────────────────────────────────────────────────────────

function Attempts({ h, now, model, issue, labelOf, openRun, setOpenRun, onShowBack }: {
  h: CauseHistory; now: number; model: LineModel; issue: LineIssue; labelOf: (id: string) => string | undefined;
  openRun: string | null; setOpenRun: (id: string | null) => void; onShowBack: (runId: string) => void;
}) {
  const brief = useMemo(() => (h.attempts.length ? historyBrief(h) : ""), [h]);
  return (
    <section className="lwt-sec" data-line-attempts={h.attempts.length}>
      <h3 className="lwt-sec-h">Runs<span className="lwt-sec-scope">{h.attempts.length}</span></h3>
      {!h.attempts.length ? <p className="lwt-quiet">No run yet.</p> : (
        <ol className="lwt-atts">
          {[...h.attempts].reverse().map((a) => (
            <AttemptRow key={a.runId} a={a} h={h} now={now} model={model} issue={issue} labelOf={labelOf} open={openRun === a.runId} onToggle={() => setOpenRun(openRun === a.runId ? null : a.runId)} onShowBack={onShowBack} />
          ))}
        </ol>
      )}
      {brief && (
        <details className="lwt-brief">
          <summary>Brief for the next run</summary>
          <pre>{brief}</pre>
        </details>
      )}
    </section>
  );
}

/** The problems that read the same as this one: each opens, and a duplicate merges into the oldest (marked its duplicate and dropped). */
function Overlaps({ overlap, self, refOf, open }: { overlap: Overlap; self: LineIssue; refOf?: (id: string) => string | null; open: (id: string | null) => void }) {
  const others = overlap.set.filter((id) => id !== self.id);
  const primary = overlap.primary === self.id;
  const merge = (dupRef: string | null) => { if (dupRef && overlap.primaryRef) void useInboxStore.getState().updateTask(dupRef, { duplicate_of: overlap.primaryRef, status: "dropped" }); };
  return (
    <div className="lwt-overlap" data-line-overlap={overlap.set.length}>
      <span className="lwt-tag" data-tone="warn">{overlap.set.length} open, same problem</span>
      {others.map((id) => {
        const ref = refOf?.(id) ?? null;
        return (
          <span key={id} className="lwt-overlap-item">
            <button type="button" className="lw-link lw-mono" onClick={() => open(id)}>{ref ?? "problem"}</button>
            {primary && <button type="button" className="lw-act" onClick={() => merge(ref)} data-line-merge={ref ?? id} title={`Mark ${ref} a duplicate of ${overlap.primaryRef} and drop it`}>Merge here</button>}
          </span>
        );
      })}
      {!primary && <button type="button" className="lw-act" data-primary="" onClick={() => merge(self.ref)} data-line-merge={self.ref ?? self.id} title={`Mark ${self.ref} a duplicate of ${overlap.primaryRef} and drop it`}>Merge into {overlap.primaryRef}</button>}
    </div>
  );
}

/** Why a failed run died, in a few words: the failing check its last step named ("test passed on base"). */
function failWhy(run: LineModel["runs"][number] | null): string | null {
  const v = run?.visits[run.visits.length - 1];
  // A check runner's report names its red checks; anything else says why in its own first line.
  const t = (v?.decided.result ? scriptSaid(v.decided.result)?.text : null) ?? v?.decided.words?.trim();
  if (!t || /^(failed|done|running)$/i.test(t)) return null;
  return t.length > 80 ? `${t.slice(0, 79).trimEnd()}…` : t;
}

const AttemptRow = memo(function AttemptRow({ a, h, now, model, issue, labelOf, open, onToggle, onShowBack }: {
  a: HistoryAttempt; h: CauseHistory; now: number; model: LineModel; issue: LineIssue; labelOf: (id: string) => string | undefined;
  open: boolean; onToggle: () => void; onShowBack: (runId: string) => void;
}) {
  const nav = useLineNav();
  const ship = h.ships.find((s) => s.runId === a.runId);
  const close = h.closes.find((c) => c.runId === a.runId);
  // What came back between this close and the next one: the badge sits on the run the comebacks followed, never on every earlier close too.
  const back = [...h.regressions, ...h.recurrences].find((r) => r.afterRunId === a.runId) ?? null;
  // The head leads with what the run argued, so closes that repeat one argument read as repeats without opening them.
  const lead = a.card?.headline ?? a.found ?? a.outcome.text;
  const unshipped = unshippedGuard(a.ended, a.found);
  const watch = shownWatches(h).find((w) => w.runId === a.runId);
  const run = model.runs.find((r) => r.id === a.runId) ?? null;
  const tone = attemptTone(a, h);
  const end = a.end ?? now;
  const endAt = a.ended && a.ended !== "shipped" ? closeStepLabel(a.endStep, labelOf) : null;
  // A run that stopped or failed without closing says where: its last step.
  const verdict = attemptEndWords(a, h);
  const stopAt = !a.ended && (verdict === "stopped" || verdict === "failed") ? run?.visits[run.visits.length - 1]?.label ?? null : null;
  const card = a.card;
  const wait = useWaitingTrialCards().get(a.runId) ?? null;
  // A failed run reads by where and why it died; what it found is its second line.
  const failedTitle = verdict === "failed" && stopAt ? `Failed at ${stopAt}${failWhy(run) ? `: ${failWhy(run)}` : ""}` : null;
  // "Built the change" says only that it built: the diff says what.
  const built = a.built && !/^built the change\.?$/i.test(a.built.trim()) ? a.built : null;
  return (
    <li className="lwt-att-row" data-attempt={a.runId} data-open={open ? "" : undefined} data-tone={tone} data-superseded={a.superseded ? "" : undefined}>
      <div className="lwt-att-line">
        <button type="button" className="lwt-att-head" onClick={onToggle} aria-expanded={open}>
          <span className="lwt-att-n" data-tone={tone}>#{a.n}</span>
          <span className="lwt-att-what">
            <b title={failedTitle ?? lead} data-tone={failedTitle ? "bad" : undefined}>{failedTitle ?? (lead === a.found ? <FoundWords text={lead} unshipped={unshipped} /> : lead)}</b>
            {failedTitle && <small className="lwt-att-sub" title={lead}>{lead}</small>}
            <small>
              <time title={momentWords(a.start)}>{momentWords(a.start)}</time>
              <span>{spanWords(end - a.start)}</span>
              {endAt && <span>at {endAt}</span>}
              {card?.ref && <span className="lwt-ref">{card.ref}</span>}
            </small>
          </span>
          {back && <span className="lwp-back" title={back.words}><RotateCcw aria-hidden />{back.count}</span>}
          {wait ? <span className="lw-oc" data-tone="person" title={wait.card?.headline || wait.question} data-line-attempt-wait={wait.short_id}>Waiting on you · {wait.short_id}</span>
            : <span className="lw-oc" data-tone={tone === "none" ? "none" : tone} title={a.outcome.text}>{failedTitle ? "failed" : stopAt ? `${attemptEndWords(a, h)} at ${stopAt}` : attemptEndWords(a, h)}</span>}
          <span className="lw-chev" aria-hidden />
        </button>
        {run && (
          <button type="button" className="lw-iconbtn lwt-att-go" onClick={() => nav.openRun(run.id, issue.id)} aria-label={`Open run #${a.n}`} title="Open the run, step by step" data-line-open-run={run.id}>
            <Play className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {open && (
        <div className="lwt-att-body">
          {(back || (close?.fold && close.fold.liveAt == null)) && (
            <div className="lwt-flags">
              {back && <><span className="lwt-tag" data-tone="bad"><RotateCcw className="w-3 h-3" />back {back.count}x after it</span><button type="button" className="lw-link" onClick={() => onShowBack(a.runId)}>Show</button></>}
              {close?.fold && close.fold.liveAt == null && !back && <span className="lwt-tag" title={close.fold.words}>folded into {close.fold.into}</span>}
            </div>
          )}
          {((a.found && lead !== a.found) || a.proposed || built || a.diff) && (
            <dl className="lwt-said">
              {a.found && lead !== a.found && <><dt>Found</dt><dd><FoundWords text={a.found} unshipped={unshipped} /></dd></>}
              {a.proposed && <><dt>Proposed</dt><dd>{a.proposed}</dd></>}
              {(built || a.diff) && (
                <><dt>Built</dt><dd>
                  {a.diff && (
                    <span className="lwt-chip lwt-diff">
                      {a.diff.files} files <span className="lw-stat-add">+{a.diff.added}</span> <span className="lw-stat-del">−{a.diff.removed}</span>
                      {a.diff.pr && <a href={a.diff.pr} target="_blank" rel="noreferrer">PR <ArrowUpRight className="w-3 h-3" /></a>}
                    </span>
                  )}
                  {built}
                </dd></>
              )}
            </dl>
          )}

          {card && (
            <dl className="lwt-said lwt-card">
              <dt>Card</dt>
              <dd className="lwt-card-head">
                {card.ref && <span className="lwt-ref">{card.ref}</span>}
                {card.answer
                  ? <span className="lwt-tag" data-tone="ok">{card.answer}</span>
                  : a.unapproved ? <span className="lwt-tag" data-tone="warn" title={`Card ${card.status}`}>card unanswered</span>
                  : <span className="lwt-tag" data-tone={card.status === "pending" || card.status === "waiting" ? "ask" : undefined}>{card.status === "pending" || card.status === "waiting" ? "waiting on you" : card.status}</span>}
                {card.answeredAt && <time>{momentWords(card.answeredAt)}</time>}
              </dd>
              {card.wrong && <><dt>Wrong</dt><dd>{card.wrong}</dd></>}
              {card.change && card.change !== a.proposed && <><dt>Change</dt><dd>{card.change}</dd></>}
              {card.recommend && <><dt>Advised</dt><dd><b>{card.recommend.verdict}</b>{card.recommend.why ? ` ${card.recommend.why}` : ""}</dd></>}
              {card.note && <><dt>Note</dt><dd><q>{card.note}</q></dd></>}
            </dl>
          )}

          {(a.merge || ship || watch) && (
            <div className="lwt-ship">
              {a.merge && (
                <span className="lwt-chip" title={momentWords(a.merge.at)}><GitMerge className="w-3.5 h-3.5" /><code>{a.merge.sha.slice(0, 7)}</code> → {a.merge.into}{a.merge.prUrl && a.merge.prUrl !== a.diff?.pr ? <a href={a.merge.prUrl} target="_blank" rel="noreferrer">PR <ArrowUpRight className="w-3 h-3" /></a> : null}</span>
              )}
              {ship?.deploys.map((d) => (
                <span key={d.id} className="lwt-chip" data-tone="ok" title={`${d.title} (${d.how})`}>
                  <Rocket className="w-3.5 h-3.5" />{d.target ?? d.source} {momentWords(d.at)}
                  {d.url && <a href={d.url} target="_blank" rel="noreferrer" aria-label="The deploy"><ArrowUpRight className="w-3 h-3" /></a>}
                </span>
              ))}
              {watch && <span className="lwt-chip" data-tone={watch.state === "reopened" ? "bad" : watch.state === "quiet" ? "ok" : undefined} title={watch.end ? `Until ${momentWords(watch.end)}` : undefined}>{watchWords(watch)}</span>}
            </div>
          )}

          {run ? (
            <div className="lwt-path">
              <StepKindLegend className="lwt-path-legend" itemClassName="lwt-path-lg" show={(k) => run.visits.some((v) => v.kind === k)} mark={(k) => <span className="lw-visit" data-kind={k}><span className="lw-visit-n" /></span>} />
              <RunPath run={run} onVisit={(step) => { requestReplayAt(run.id, step, false); nav.openRun(run.id, issue.id); }} />
              <button type="button" className="lw-act" onClick={() => nav.openRun(run.id, issue.id)}>Open run</button>
            </div>
          ) : (
            <span className="lwt-tag" title="This run is on another process; pick it in the header">other process</span>
          )}
        </div>
      )}
    </li>
  );
});

const watchWords = (w: CauseHistory["watches"][number]) =>
  w.state === "quiet" ? "watch ended quiet" : w.state === "watching" ? `watching${w.end ? ` to ${momentWords(w.end)}` : ""}` : w.state === "reopened" ? `reopened ${momentWords(w.reopenedAt ?? w.start)}` : "watch";
