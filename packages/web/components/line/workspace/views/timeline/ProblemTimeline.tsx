"use client";
// One problem's page in the Timeline view (line-workspace.md LW1 Timeline):
// what it is and where it stands, its life on one time axis, every attempt to
// fix it with its card, diff and path, the occurrences themselves (what came
// back after a fix one click away), and what the next attempt must not repeat.
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, ChevronLeft, ChevronRight, GitMerge, Rocket } from "lucide-react";
import type { CauseHistory, HistoryAttempt } from "../../../../../lib/line/causeHistory";
import type { LineIssue, LineModel } from "../../../../../lib/line/lineModel";
import type { LineSignal } from "../../../../../lib/lineFlow";
import { formatRelativeTime } from "../../../../../lib/conversationFormat";
import {
  attemptEndWords, attemptTone, cameBackCount, comebackAt, defaultRange, momentWords, problemLine, problemState, rangeDomain, spanWords,
  PROBLEM_STATE_WORDS, TIME_RANGES, type Domain, type TimeRange,
} from "../../../../../lib/line/timeline";
import { useWorkspaceCollection } from "../../../../../hooks/useWorkspaceCollection";
import { useProjectWorkspace } from "../../../useLineFloor";
import { AlreadyTried, RunPath, useLineNav } from "../../../widgets";
import { findingTitle, quotesCustomerText, sourceLabel } from "../../../../../lib/line/loopSteps";
import { UNAPPROVED_WORDS } from "../../../../../lib/line/runReport";
import { causeDoubt } from "../../../../../lib/line/lineTrace";
import { useInboxStore } from "../../../../../store/inboxStore";
import { AskAgain } from "../../../AskAgain";
import { DoubtChip } from "../../../DoubtChip";
import { TimelineChart, type TimelinePick } from "./TimelineChart";

const RANGE_WORDS: Record<TimeRange, string> = { "24h": "24h", "7d": "7d", "30d": "30d", all: "All" };
const signalSig = (s: LineSignal) => `${s.task_id}|${s.observed_at ?? s.created_at}|${s.title}|${s.reopened ? 1 : 0}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const EXAMPLES = 8;

export type ProblemTimelineProps = {
  issue: LineIssue;
  model: LineModel;
  now: number;
  workspaceRow: { workspace?: string | null; team_id?: string | null } | null;
  /** The problems either side, for the header's arrows (j and k). */
  prev: LineIssue | null;
  next: LineIssue | null;
  open: (id: string | null) => void;
};

export function ProblemTimeline({ issue, model, now, workspaceRow, prev, next, open }: ProblemTimelineProps) {
  const h = issue.history;
  const state = problemState(h, issue.status);
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

  const total = Math.max(issue.findings, h.occurrences.length);
  // The cause's own row: a doubt the record raised about it, and the project it is filed under.
  const causeRow = useInboxStore((st) => (st.tasks as unknown as Record<string, Parameters<typeof causeDoubt>[0] & { project_id?: string }>)[issue.id] ?? null);
  const doubt = causeRow ? causeDoubt(causeRow) : null;
  // The last run built a fix and went past a card nobody answered: the card has to be asked again.
  const askAgain = issue.where.text === UNAPPROVED_WORDS && !h.regressed && issue.status !== "done" && issue.status !== "dropped";
  const last = h.occurrences[h.occurrences.length - 1]?.at ?? null;
  // A product's findings can quote its customers; those quotes stay out of the page (loopSteps quotesCustomerText).
  const quotes = useMemo(() => issue.quotes.filter((q) => !quotesCustomerText(q.source)), [issue.quotes]);

  return (
    <div className="lwt-page" data-line-problem={issue.id} data-state={state}>
      <div className="lwt-crumbs">
        <button type="button" className="lw-link lwt-back" onClick={() => open(null)}><ArrowLeft className="w-3.5 h-3.5" />All problems</button>
        <span className="lw-spacer" />
        <button type="button" className="lw-iconbtn" disabled={!prev} onClick={() => prev && open(prev.id)} aria-label="Previous problem" title="Previous problem (k)"><ChevronLeft className="w-4 h-4" /></button>
        <button type="button" className="lw-iconbtn" disabled={!next} onClick={() => next && open(next.id)} aria-label="Next problem" title="Next problem (j)"><ChevronRight className="w-4 h-4" /></button>
      </div>

      <header className="lwt-hero">
        <div className="lwt-hero-top">
          <span className="lwt-state" data-state={state}>{PROBLEM_STATE_WORDS[state]}</span>
          {issue.ref && <span className="lwt-ref">{issue.ref}</span>}
        </div>
        <h2 className="lwt-h">{issue.title}</h2>
        <p className="lwt-where">{problemLine(issue, labelOf, now)}</p>
        {(doubt || askAgain) && (
          <div className="lwt-hero-acts">
            {doubt && <DoubtChip doubt={doubt} />}
            {askAgain && <AskAgain taskId={issue.id} projectId={causeRow?.project_id ?? null} />}
          </div>
        )}
        {quotes[0] && <blockquote className="lwt-quote">{quotes[0].text}<cite>{sourceLabel(quotes[0].source)}</cite></blockquote>}
      </header>

      <dl className="lwt-stats">
        <div><dt>Occurrences</dt><dd>{total}{h.capped ? "+" : ""}</dd></div>
        <div><dt>First seen</dt><dd>{h.firstAt ? formatRelativeTime(h.firstAt, now) : "never"}</dd></div>
        <div><dt>Last seen</dt><dd>{last ? formatRelativeTime(last, now) : "never"}</dd></div>
        <div><dt>Fix attempts</dt><dd>{h.attempts.length}</dd></div>
        <div data-bad={backCount ? "" : undefined}><dt>Came back</dt><dd>{backCount ? plural(backCount, "time") : "never"}</dd></div>
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
              <button type="button" className="lw-act" onClick={onReset}>Reset zoom</button>
            </span>
          )}
          <span className="lw-spacer" />
          <Legend h={h} />
        </div>
        <TimelineChart history={h} labelOf={labelOf} domain={domain} now={now} selectedRun={openRun} pick={pick} onPick={onPick} onZoom={onZoom} onReset={onReset} />
        <div className="lwt-coverage" data-state={h.coverage.state}>{h.coverage.words}</div>
      </section>

      <div className="lwt-cols">
        <div className="lwt-main">
          <div ref={occRef}>
            <Occurrences h={h} issue={issue} pick={pick} setPick={setPick} workspaceRow={workspaceRow} />
          </div>
          <div ref={attemptsRef}>
            <Attempts h={h} now={now} model={model} issue={issue} openRun={openRun} setOpenRun={setOpenRun} onShowBack={(runId) => onPick({ kind: "comeback", runId })} />
          </div>
        </div>
        <aside className="lwt-side">
          <AlreadyTried h={h} brief />
          <Facts h={h} issue={issue} />
        </aside>
      </div>
    </div>
  );
}

function Legend({ h }: { h: CauseHistory }) {
  return (
    <div className="lwt-legend" aria-label="Legend">
      <span><i className="lwt-k-occ" />occurrence</span>
      {(h.regressions.length > 0 || h.recurrences.length > 0) && <span><i className="lwt-k-back" />came back</span>}
      <span><i className="lwt-k-att" />attempt</span>
      {h.closes.some((c) => c.kind !== "shipped") && <span><i className="lwt-k-close" />closed</span>}
      {h.ships.length > 0 && <span><i className="lwt-k-merge" />merged</span>}
      {h.deploys.length > 0 && <span><i className="lwt-k-deploy" />deploy</span>}
      {h.watches.length > 0 && <span><i className="lwt-k-watch" />watch</span>}
    </div>
  );
}

// ── the occurrences: what a pick on the chart holds ──────────────────────────

function Occurrences({ h, issue, pick, setPick, workspaceRow }: { h: CauseHistory; issue: LineIssue; pick: TimelinePick | null; setPick: (p: TimelinePick | null) => void; workspaceRow: ProblemTimelineProps["workspaceRow"] }) {
  const workspace = useProjectWorkspace(workspaceRow);
  const all = useWorkspaceCollection<LineSignal>("signals", signalSig, workspace);
  const byAt = useMemo(() => {
    const m = new Map<number, LineSignal>();
    for (const s of all) if (s.task_id === issue.id) m.set(s.observed_at ?? s.created_at, s);
    return m;
  }, [all, issue.id]);
  const [more, setMore] = useState(false);

  const { title, list } = useMemo(() => {
    if (pick?.kind === "comeback") {
      const a = h.attempts.find((x) => x.runId === pick.runId);
      const list = h.occurrences.filter((o) => comebackAt(o.at, h)?.afterRunId === pick.runId);
      const close = h.closes.find((c) => c.runId === pick.runId);
      if (list.length) return { title: close && close.kind !== "shipped" ? `After attempt ${a?.n ?? "?"} ${close.kind} it` : `After attempt ${a?.n ?? "?"}'s fix went live`, list };
    }
    if (pick?.kind === "bucket") {
      return { title: `${momentWords(pick.from)} to ${momentWords(pick.to)}`, list: h.occurrences.filter((o) => o.at >= pick.from && o.at < pick.to) };
    }
    return { title: "Latest", list: h.occurrences };
  }, [pick, h]);
  const rows = useMemo(() => [...list].reverse(), [list]);
  const shown = more ? rows : rows.slice(0, EXAMPLES);

  return (
    <section className="lwt-sec" data-line-occurrences>
      <h3 className="lwt-sec-h">
        Occurrences
        <span className="lwt-sec-scope" data-bad={pick?.kind === "comeback" ? "" : undefined}>{title} · {list.length}</span>
        {pick && <button type="button" className="lw-link" onClick={() => setPick(null)}>Show latest</button>}
      </h3>
      {!rows.length ? (
        <p className="lwt-quiet">{h.occurrences.length ? "None in this span." : "No occurrence of this problem is recorded."}</p>
      ) : (
        <ol className="lwt-occ">
          {shown.map((o) => {
            const s = byAt.get(o.at);
            const back = comebackAt(o.at, h);
            const a = back ? h.attempts.find((x) => x.runId === back.afterRunId) : null;
            const closedBy = back && "kind" in back ? back.kind : null;
            return (
              <li key={o.at} data-back={back ? "" : undefined}>
                <time dateTime={new Date(o.at).toISOString()}>{momentWords(o.at)}</time>
                <div className="lwt-occ-body">
                  <span className="lwt-occ-t" title={s?.short_id ?? undefined}>{s ? findingTitle(s) : "A report past the two weeks this page holds"}</span>
                  <span className="lwt-occ-m">
                    {s?.source && <span>{sourceLabel(s.source)}</span>}
                    {o.reopened && <span className="lwt-tag" data-tone="bad">reopened it</span>}
                    {back && <span className="lwt-tag" data-tone="bad">{closedBy ? `after attempt ${a?.n ?? "?"} ${closedBy} it` : `after attempt ${a?.n ?? "?"}'s fix`}</span>}
                  </span>
                </div>
                {s?.evidence_url && (
                  <a className="lw-iconbtn" href={s.evidence_url} target="_blank" rel="noreferrer" aria-label="Where the source saw it" title="Where the source saw it"><ArrowUpRight className="w-3.5 h-3.5" /></a>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {rows.length > EXAMPLES && (
        <button type="button" className="lw-link lwt-more" onClick={() => setMore(!more)}>{more ? "Show fewer" : `Show all ${rows.length}`}</button>
      )}
    </section>
  );
}

// ── the attempts ─────────────────────────────────────────────────────────────

function Attempts({ h, now, model, issue, openRun, setOpenRun, onShowBack }: { h: CauseHistory; now: number; model: LineModel; issue: LineIssue; openRun: string | null; setOpenRun: (id: string | null) => void; onShowBack: (runId: string) => void }) {
  if (!h.attempts.length) {
    return (
      <section className="lwt-sec">
        <h3 className="lwt-sec-h">Fix attempts</h3>
        <p className="lwt-quiet">No run has taken this problem yet.</p>
      </section>
    );
  }
  return (
    <section className="lwt-sec">
      <h3 className="lwt-sec-h">Fix attempts<span className="lwt-sec-scope">{h.attempts.length}</span></h3>
      <ol className="lwt-atts">
        {[...h.attempts].reverse().map((a) => (
          <AttemptRow key={a.runId} a={a} h={h} now={now} model={model} issue={issue} open={openRun === a.runId} onToggle={() => setOpenRun(openRun === a.runId ? null : a.runId)} onShowBack={onShowBack} />
        ))}
      </ol>
    </section>
  );
}

const AttemptRow = memo(function AttemptRow({ a, h, now, model, issue, open, onToggle, onShowBack }: { a: HistoryAttempt; h: CauseHistory; now: number; model: LineModel; issue: LineIssue; open: boolean; onToggle: () => void; onShowBack: (runId: string) => void }) {
  const nav = useLineNav();
  const ship = h.ships.find((s) => s.runId === a.runId);
  // What came back after this close until a later fix went live: a dissolve repeated later still did not hold.
  const close = h.closes.find((c) => c.runId === a.runId);
  const back = close?.back ?? null;
  // The header leads with what the attempt argued, so closes that repeat one argument read as repeats without opening them.
  const lead = a.card?.headline ?? a.found ?? a.outcome.text;
  const unshipped = unshippedGuard(a.ended, a.found);
  const watch = h.watches.find((w) => w.runId === a.runId);
  const run = model.runs.find((r) => r.id === a.runId) ?? null;
  const tone = attemptTone(a);
  const end = a.end ?? now;
  return (
    <li className="lwt-att-row" data-attempt={a.runId} data-open={open ? "" : undefined} data-tone={tone} data-superseded={a.superseded ? "" : undefined}>
      <button type="button" className="lwt-att-head" onClick={onToggle} aria-expanded={open}>
        <span className="lwt-att-n" data-tone={tone}>#{a.n}</span>
        <span className="lwt-att-what">
          <b title={lead !== a.outcome.text ? lead : undefined}>{lead === a.found ? <FoundWords text={lead} unshipped={unshipped} /> : lead}</b>
          <small>{lead !== a.outcome.text ? `${a.outcome.text.replace(/\.$/, "")} · ` : ""}{momentWords(a.start)}{a.live ? ", running" : ""} · {spanWords(end - a.start)}{a.card?.ref ? ` · ${a.card.ref}` : ""}</small>
        </span>
        {back && <span className="lwt-tag" data-tone="bad">came back</span>}
        <span className="lw-oc" data-tone={tone === "none" ? "none" : tone}>{attemptEndWords(a)}</span>
        <span className="lw-chev" aria-hidden />
      </button>
      {open && (
        <div className="lwt-att-body">
          {back && (
            <div className="lwt-callout" data-tone="bad">
              <span>{back.words}. {close?.kind === "shipped" ? "This fix did not hold." : "Closing it did not hold."}</span>
              <button type="button" className="lw-act" onClick={() => onShowBack(a.runId)}>Show them</button>
            </div>
          )}
          <dl className="lwt-said">
            {a.found && <><dt>Found</dt><dd><FoundWords text={a.found} unshipped={unshipped} /></dd></>}
            {a.proposed && <><dt>Proposed</dt><dd>{a.proposed}</dd></>}
            {a.built && <><dt>Built</dt><dd>{a.built}</dd></>}
          </dl>

          {a.card && (
            <div className="lwt-card">
              <div className="lw-lbl">The card{a.card.ref ? ` ${a.card.ref}` : ""}</div>
              {a.card.wrong && <p><b>What was wrong.</b> {a.card.wrong}</p>}
              {a.card.change && a.card.change !== a.proposed && <p><b>The change.</b> {a.card.change}</p>}
              {a.card.recommend && <p><b>Recommended {a.card.recommend.verdict}.</b> {a.card.recommend.why ?? ""}</p>}
              <p className="lwt-card-answer">
                {a.card.answer
                  ? <>Answered <b>{a.card.answer}</b>{a.card.answeredAt ? ` ${momentWords(a.card.answeredAt)}` : ""}{a.card.note ? <>: <q>{a.card.note}</q></> : null}</>
                  : a.card.status === "pending" || a.card.status === "waiting" ? "Waiting for an answer." : `Not answered (${a.card.status}).`}
              </p>
            </div>
          )}

          {(a.diff || a.merge || ship) && (
            <div className="lwt-ship">
              {a.diff && (
                <span className="lwt-chip">
                  {plural(a.diff.files, "file")} <span className="lw-stat-add">+{a.diff.added}</span> <span className="lw-stat-del">−{a.diff.removed}</span>
                  {a.diff.pr && <a href={a.diff.pr} target="_blank" rel="noreferrer">PR <ArrowUpRight className="w-3 h-3" /></a>}
                </span>
              )}
              {a.merge && (
                <span className="lwt-chip"><GitMerge className="w-3.5 h-3.5" /><code>{a.merge.sha.slice(0, 7)}</code> into {a.merge.into}{a.merge.prUrl && a.merge.prUrl !== a.diff?.pr ? <a href={a.merge.prUrl} target="_blank" rel="noreferrer">PR <ArrowUpRight className="w-3 h-3" /></a> : null}</span>
              )}
              {ship?.deploys.map((d) => (
                <span key={d.id} className="lwt-chip" data-tone="ok" title={`${d.title} (${d.how})`}>
                  <Rocket className="w-3.5 h-3.5" />{d.target ?? d.source} {momentWords(d.at)}
                  {d.url && <a href={d.url} target="_blank" rel="noreferrer" aria-label="The deploy"><ArrowUpRight className="w-3 h-3" /></a>}
                </span>
              ))}
              {ship && <span className="lwt-ship-words">{ship.words}.</span>}
              {watch && <span className="lwt-ship-words">{watch.state === "quiet" ? "The watch after it ended quiet." : watch.state === "watching" ? `Watching${watch.end ? ` until ${momentWords(watch.end)}` : ""}.` : watch.state === "reopened" ? `Reopened ${momentWords(watch.reopenedAt ?? watch.start)}.` : null}</span>}
            </div>
          )}

          {run ? (
            <div className="lwt-path">
              <div className="lw-lbl">Its path through the line</div>
              <RunPath run={run} />
              <button type="button" className="lw-act" onClick={() => nav.openRun(run.id, issue.id)}>Replay it</button>
            </div>
          ) : (
            <p className="lwt-quiet">This attempt ran on another graph; switch the graph in the header to read its path.</p>
          )}
        </div>
      )}
    </li>
  );
});

function Facts({ h, quotes }: { h: CauseHistory; quotes: LineIssue["quotes"] }) {
  return (
    <section className="lwt-side-box">
      <h3 className="lwt-sec-h">About it</h3>
      <dl className="lwt-facts">
        <dt>First seen</dt><dd>{h.firstAt ? momentWords(h.firstAt) : "not recorded"}</dd>
        <dt>Last activity</dt><dd>{momentWords(h.lastActivity)}</dd>
        {/* Only when the count above leaves something out: reports older than what was read, or only the recent two weeks. */}
        {h.occurrencesFrom !== "history" ? <><dt>Reports read</dt><dd>The last two weeks only</dd></>
          : h.capped && h.since ? <><dt>Reports read</dt><dd>From {momentWords(h.since)}; older ones not read</dd></> : null}
        <dt>Shipped</dt><dd>{h.ships.length ? plural(h.ships.length, "fix", "fixes") : "nothing yet"}</dd>
        <dt>Deploys</dt><dd>{h.deploys.length ? `${plural(h.deploys.length, "deploy")} carried a fix` : h.coverage.state === "unread" ? "reading" : "none recorded"}</dd>
        {quotes.length > 1 && <><dt>Reports say</dt><dd>{quotes.slice(1).map((q, i) => <q key={i} className="lwt-fact-q">{q.text}</q>)}</dd></>}
      </dl>
    </section>
  );
}
