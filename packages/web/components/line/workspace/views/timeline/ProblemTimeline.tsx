"use client";
// One problem's page (line-workspace.md LW1 Problems): what it is and where it
// came from, its life on one time axis, every run on it (each one click from
// its run detail), and every finding with its source. State is marks, chips
// and numbers; the only reading is what the sources and the agents said.
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, ChevronLeft, ChevronRight, GitMerge, Play, Rocket, RotateCcw } from "lucide-react";
import { historyBrief, unshippedGuard, type CauseHistory, type HistoryAttempt } from "../../../../../lib/line/causeHistory";
import type { LineIssue, LineModel } from "../../../../../lib/line/lineModel";
import type { LineSignal } from "../../../../../lib/lineFlow";
import type { LineSelectionPatch } from "../../../../../lib/line/lineWorkspaceUrl";
import { formatRelativeTime } from "../../../../../lib/conversationFormat";
import {
  attemptEndWords, attemptTone, cameBackCount, closeStepLabel, comebackAt, defaultRange, momentWords, problemState, rangeDomain, spanWords,
  TIME_RANGES, type Domain, type TimeRange,
} from "../../../../../lib/line/timeline";
import { problemStatus, waitingWhy, PROBLEM_STATUS_WORDS } from "../../../../../lib/line/problemTable";
import { FoundWords, RunPath, useLineNav } from "../../../widgets";
import { findingJudgeLabel, findingTitle, sourceLabel } from "../../../../../lib/line/loopSteps";
import { UNAPPROVED_WORDS } from "../../../../../lib/line/runReport";
import { causeDoubt } from "../../../../../lib/line/lineTrace";
import { useInboxStore } from "../../../../../store/inboxStore";
import { AskAgain } from "../../../AskAgain";
import { DoubtChip } from "../../../DoubtChip";
import { requestReplayAt } from "../../stepDrafts";
import { TimelineChart, type TimelinePick } from "./TimelineChart";
import "./problems.css";

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
};

export function ProblemTimeline({ issue, model, now, projectTitle = null, signals, prev, next, open, select }: ProblemTimelineProps) {
  const h = issue.history;
  const state = problemState(h, issue.status);
  const status = problemStatus(issue, state);
  const [range, setRange] = useState<TimeRange>(() => defaultRange(h, now));
  const [zoom, setZoom] = useState<Domain | null>(null);
  const domain = useMemo(() => zoom ?? rangeDomain(range, h, now), [zoom, range, h, now]);
  const latestBack = h.regressed ? h.regressions[h.regressions.length - 1] : h.cameBack ? h.recurrences[h.recurrences.length - 1] : null;
  const [pick, setPick] = useState<TimelinePick | null>(() => (latestBack ? { kind: "comeback", runId: latestBack.afterRunId } : null));
  const labelOf = useCallback((id: string) => model.steps[id]?.label, [model.steps]);
  const backCount = cameBackCount(h);
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

  // This problem's findings, newest first, and where they came from.
  const own = useMemo(() => signals.filter((s) => s.task_id === issue.id), [signals, issue.id]);
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
  const doubt = causeRow ? causeDoubt(causeRow) : null;
  // The last run built a fix and went past a card nobody answered: the card has to be asked again.
  const askAgain = issue.where.text === UNAPPROVED_WORDS && !h.regressed && issue.status !== "done" && issue.status !== "dropped";
  const last = h.occurrences[h.occurrences.length - 1]?.at ?? null;
  const quote = issue.quotes[0];

  return (
    <div className="lwt-page" data-line-problem={issue.id} data-state={state} data-status={status}>
      <div className="lwt-crumbs">
        <button type="button" className="lw-link lwt-back" onClick={() => open(null)} title="Back to problems (Esc)"><ArrowLeft className="w-3.5 h-3.5" />Problems</button>
        {issue.ref && <span className="lwt-ref">{issue.ref}</span>}
        <span className="lw-spacer" />
        <button type="button" className="lw-iconbtn" disabled={!prev} onClick={() => prev && open(prev.id)} aria-label="Previous problem" title="Previous problem (k)"><ChevronLeft className="w-4 h-4" /></button>
        <button type="button" className="lw-iconbtn" disabled={!next} onClick={() => next && open(next.id)} aria-label="Next problem" title="Next problem (j)"><ChevronRight className="w-4 h-4" /></button>
      </div>

      <header className="lwt-hero">
        <div className="lwt-hero-top">
          <span className="lwp-pill" data-status={status} title={state !== status ? stateTitle(state) : undefined}>{PROBLEM_STATUS_WORDS[status]}</span>
          {waitingWhy(issue, status) && <span className="lwt-why" data-line-waiting-why>{waitingWhy(issue, status)}</span>}
          {backCount > 0 && <span className="lwp-back" data-line-came-back={backCount} title={`Came back ${backCount}x after a close`}><RotateCcw aria-hidden />{backCount}</span>}
          {projectTitle && <span className="lwt-hero-proj">{projectTitle}</span>}
        </div>
        <h2 className="lwt-h">{issue.title}</h2>
        {(doubt || askAgain) && (
          <div className="lwt-hero-acts">
            {doubt && <DoubtChip doubt={doubt} />}
            {askAgain && <AskAgain taskId={issue.id} projectId={causeRow?.project_id ?? null} />}
          </div>
        )}
      </header>

      <dl className="lwt-stats">
        <div className="lwt-stat-src">
          <dt>Source</dt>
          <dd>
            {sources.length ? sources.slice(0, 3).map(([s, n]) => (
              <button key={s} type="button" className="lwt-src" onClick={() => openSource(s)} title={`${sourceLabel(s)}: ${n} finding${n === 1 ? "" : "s"} here. Open in Sources`} data-line-problem-source={s}>
                {sourceLabel(s)}<span className="lw-num">{n}</span>
              </button>
            )) : <span className="lwt-none">none</span>}
            {sources.length > 3 && <small>+{sources.length - 3}</small>}
          </dd>
        </div>
        <div><dt>Findings</dt><dd className="lw-num">{total}{h.capped ? "+" : ""}</dd></div>
        <div><dt>First</dt><dd title={h.firstAt ? momentWords(h.firstAt) : undefined}>{h.firstAt ? formatRelativeTime(h.firstAt, now) : "never"}</dd></div>
        <div><dt>Last</dt><dd title={last ? momentWords(last) : undefined}>{last ? formatRelativeTime(last, now) : "never"}</dd></div>
        <div><dt>Runs</dt><dd className="lw-num">{h.attempts.length}</dd></div>
        <div data-bad={backCount ? "" : undefined}><dt>Came back</dt><dd className="lw-num">{backCount}</dd></div>
      </dl>

      {quote && (
        <blockquote className="lwt-quote" data-line-problem-quote>
          {quote.text}
          <cite>{sourceLabel(quote.source)}{quote.ref ? <span className="lwt-ref"> {quote.ref}</span> : null}</cite>
        </blockquote>
      )}

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
          <span className="lwt-coverage" data-state={h.coverage.state} title={h.coverage.words}>Deploys {COVERAGE_WORDS[h.coverage.state]}</span>
        </div>
        <TimelineChart history={h} labelOf={labelOf} domain={domain} now={now} selectedRun={openRun} pick={pick} onPick={onPick} onZoom={onZoom} onReset={onReset} />
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

function Legend({ h }: { h: CauseHistory }) {
  return (
    <div className="lwt-legend" aria-label="Legend">
      <span><i className="lwt-k-occ" />finding</span>
      {(h.regressions.length > 0 || h.recurrences.length > 0) && <span><i className="lwt-k-back" />came back</span>}
      <span><i className="lwt-k-att" />run</span>
      {h.closes.some((c) => c.kind !== "shipped") && <span><i className="lwt-k-close" />closed</span>}
      {h.ships.length > 0 && <span><i className="lwt-k-merge" />merged</span>}
      {h.deploys.length > 0 && <span><i className="lwt-k-deploy" />deploy</span>}
      {h.watches.length > 0 && <span><i className="lwt-k-watch" />watch</span>}
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
                  <span><b>#{c.n}</b> {c.kind === "shipped" ? "fix live" : c.kind}{at ? ` at ${at}` : ""}</span>
                  <time>{momentWords(c.at)}</time>
                  <span className="lwt-occ-close-back" data-tone={after.tone} title={after.title}>{after.text}</span>
                </li>
              );
            }
            const o = it.o;
            const s = byAt.get(o.at);
            const back = comebackAt(o.at, h);
            const judge = s ? findingJudgeLabel(s) : null;
            return (
              <li key={o.at} data-back={back ? "" : undefined}>
                <time dateTime={new Date(o.at).toISOString()}>{momentWords(o.at)}</time>
                <div className="lwt-occ-body">
                  <span className="lwt-occ-t" title={s?.detail_md || s?.short_id || undefined}>{s ? findingTitle(s) : <span className="lwt-none">older than what is read</span>}</span>
                  <span className="lwt-occ-m">
                    {s?.source && (
                      <button type="button" className="lwt-src" onClick={() => openSource(s.source, s._id)} title="Open this finding in Sources">{sourceLabel(s.source)}</button>
                    )}
                    {judge && judge !== sourceLabel(s!.source) && <span>{judge}</span>}
                    {typeof s?.severity === "number" && <span className="lwt-sev" data-sev={Math.min(5, Math.round(s.severity))}>sev {s.severity}</span>}
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

const AttemptRow = memo(function AttemptRow({ a, h, now, model, issue, labelOf, open, onToggle, onShowBack }: {
  a: HistoryAttempt; h: CauseHistory; now: number; model: LineModel; issue: LineIssue; labelOf: (id: string) => string | undefined;
  open: boolean; onToggle: () => void; onShowBack: (runId: string) => void;
}) {
  const nav = useLineNav();
  const ship = h.ships.find((s) => s.runId === a.runId);
  const close = h.closes.find((c) => c.runId === a.runId);
  const back = close?.back ?? null;
  // The head leads with what the run argued, so closes that repeat one argument read as repeats without opening them.
  const lead = a.card?.headline ?? a.found ?? a.outcome.text;
  const unshipped = unshippedGuard(a.ended, a.found);
  const watch = h.watches.find((w) => w.runId === a.runId);
  const run = model.runs.find((r) => r.id === a.runId) ?? null;
  const tone = attemptTone(a);
  const end = a.end ?? now;
  const endAt = a.ended && a.ended !== "shipped" ? closeStepLabel(a.endStep, labelOf) : null;
  const card = a.card;
  return (
    <li className="lwt-att-row" data-attempt={a.runId} data-open={open ? "" : undefined} data-tone={tone} data-superseded={a.superseded ? "" : undefined}>
      <div className="lwt-att-line">
        <button type="button" className="lwt-att-head" onClick={onToggle} aria-expanded={open}>
          <span className="lwt-att-n" data-tone={tone}>#{a.n}</span>
          <span className="lwt-att-what">
            <b title={lead}>{lead === a.found ? <FoundWords text={lead} unshipped={unshipped} /> : lead}</b>
            <small>
              <time title={momentWords(a.start)}>{momentWords(a.start)}</time>
              <span>{spanWords(end - a.start)}</span>
              {endAt && <span>at {endAt}</span>}
              {card?.ref && <span className="lwt-ref">{card.ref}</span>}
            </small>
          </span>
          {back && <span className="lwp-back" title={back.words}><RotateCcw aria-hidden />{back.count}</span>}
          <span className="lw-oc" data-tone={tone === "none" ? "none" : tone}>{attemptEndWords(a)}</span>
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
          {((a.found && lead !== a.found) || a.proposed || a.built) && (
            <dl className="lwt-said">
              {a.found && lead !== a.found && <><dt>Found</dt><dd><FoundWords text={a.found} unshipped={unshipped} /></dd></>}
              {a.proposed && <><dt>Proposed</dt><dd>{a.proposed}</dd></>}
              {a.built && <><dt>Built</dt><dd>{a.built}</dd></>}
            </dl>
          )}

          {card && (
            <dl className="lwt-said lwt-card">
              <dt>Card</dt>
              <dd className="lwt-card-head">
                {card.ref && <span className="lwt-ref">{card.ref}</span>}
                {card.answer
                  ? <span className="lwt-tag" data-tone="ok">{card.answer}</span>
                  : <span className="lwt-tag" data-tone={card.status === "pending" || card.status === "waiting" ? "ask" : undefined}>{card.status === "pending" || card.status === "waiting" ? "waiting on you" : card.status}</span>}
                {card.answeredAt && <time>{momentWords(card.answeredAt)}</time>}
              </dd>
              {card.wrong && <><dt>Wrong</dt><dd>{card.wrong}</dd></>}
              {card.change && card.change !== a.proposed && <><dt>Change</dt><dd>{card.change}</dd></>}
              {card.recommend && <><dt>Advised</dt><dd><b>{card.recommend.verdict}</b>{card.recommend.why ? ` ${card.recommend.why}` : ""}</dd></>}
              {card.note && <><dt>Note</dt><dd><q>{card.note}</q></dd></>}
            </dl>
          )}

          {(a.diff || a.merge || ship || watch) && (
            <div className="lwt-ship">
              {a.diff && (
                <span className="lwt-chip">
                  {a.diff.files} files <span className="lw-stat-add">+{a.diff.added}</span> <span className="lw-stat-del">−{a.diff.removed}</span>
                  {a.diff.pr && <a href={a.diff.pr} target="_blank" rel="noreferrer">PR <ArrowUpRight className="w-3 h-3" /></a>}
                </span>
              )}
              {a.merge && (
                <span className="lwt-chip" title={momentWords(a.merge.at)}><GitMerge className="w-3.5 h-3.5" /><code>{a.merge.sha.slice(0, 7)}</code> → {a.merge.into}{a.merge.prUrl && a.merge.prUrl !== a.diff?.pr ? <a href={a.merge.prUrl} target="_blank" rel="noreferrer">PR <ArrowUpRight className="w-3 h-3" /></a> : null}</span>
              )}
              {ship?.deploys.map((d) => (
                <span key={d.id} className="lwt-chip" data-tone="ok" title={`${d.title} (${d.how})`}>
                  <Rocket className="w-3.5 h-3.5" />{d.target ?? d.source} {momentWords(d.at)}
                  {d.url && <a href={d.url} target="_blank" rel="noreferrer" aria-label="The deploy"><ArrowUpRight className="w-3 h-3" /></a>}
                </span>
              ))}
              {ship && !ship.deploys.length && <span className="lwt-chip" data-tone="warn" title={ship.words}>no deploy recorded</span>}
              {watch && <span className="lwt-chip" data-tone={watch.state === "reopened" ? "bad" : watch.state === "quiet" ? "ok" : undefined} title={watch.end ? `Until ${momentWords(watch.end)}` : undefined}>{watchWords(watch)}</span>}
            </div>
          )}

          {run ? (
            <div className="lwt-path">
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
