"use client";
// The line's problems as an error tracker lists issues (line-workspace.md LW1
// Timeline): a row each with how often it happened lately as a sparkline, when
// it was last seen, how many times in all, its fix attempts and where it
// stands; regressed first, then the newest activity. Filters by state and words.
import { memo, useMemo, useRef, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";
import type { LineIssue } from "../../../../../lib/line/lineModel";
import { formatRelativeTime } from "../../../../../lib/conversationFormat";
import {
  attemptMarkWords, attemptTone, MARK_TONE_WORDS, bucketCounts, cameBackClose, closeWords, comebackTimes, DAY, momentWords, problemLine, problemWasRun, PROBLEM_STATE_WORDS, PROBLEM_STATES, sparkEnd,
  type ProblemState,
} from "../../../../../lib/line/timeline";

export type ProblemRow = { issue: LineIssue; state: ProblemState };

type Period = "24h" | "14d" | "90d";
const PERIODS: Record<Period, { span: number; bars: number }> = { "24h": { span: DAY, bars: 24 }, "14d": { span: 14 * DAY, bars: 14 }, "90d": { span: 90 * DAY, bars: 30 } };

import { shortDay } from "@codecast/shared/contracts/causeHistory";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The filter a chip sets: a state among the problems the graph worked, the problems no run has taken, or the ones not ready to start. */
type Show = ProblemState | "all" | "unrun" | "notready";

/** The project's queue, the "N waiting" the header counts, split by the fix line each waiting problem last ran on. */
export type ProblemQueue = { total: number; routes: ReadonlyArray<{ title: string; waiting: number | null }>; neverRun: number };

/** Which part of the queue each fix line holds: "Of the 64 waiting, 11 are on Fixes in Union, 5 on Fixes here and 48 have not run yet." */
export function queueWords(q: ProblemQueue): string | null {
  if (!q.total) return null;
  const parts = [
    ...q.routes.filter((r) => r.waiting).map((r, i) => `${r.waiting} ${i === 0 ? (r.waiting === 1 ? "is on " : "are on ") : "on "}${r.title}`),
    ...(q.neverRun ? [`${q.neverRun} ${q.neverRun === 1 ? "has" : "have"} not run on any line yet`] : []),
  ];
  if (!parts.length) return null;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Of the ${q.total} waiting, ${list}.`;
}

/** `?show=notready` opens the list on the problems not ready to start (the start switch links here), `?show=unapproved` on a state (what waits for you links there). */
const showOf = (v: string | null): Show | null => (v === "notready" ? "notready" : v && (PROBLEM_STATES as ReadonlyArray<string>).includes(v) ? (v as ProblemState) : null);

/** The decision a problem came back after, when Replay can open it: its run on the drawn graph and the step that closed it. */
type BackDecision = { runId: string; step: string; markable: boolean };

export function ProblemList({ rows, now, open, href, labelOf, graphTitle, hasRun, markable, openDecision, queue, notReady, otherGraphs = [], judgesOf }: {
  rows: ProblemRow[];
  now: number;
  open: (id: string) => void;
  href: (id: string) => string;
  /** A step's label by id, for where a close happened. */
  labelOf: (id: string) => string | undefined;
  /** The drawn graph, as its tab names it ("Fixes in Union"). */
  graphTitle: string;
  /** Whether a run is on the drawn graph, so Replay can open it. */
  hasRun: (runId: string) => boolean;
  /** Whether a step's decision can be marked right or wrong (an agent's or a person's; a script's cannot). */
  markable: (stepId: string) => boolean;
  /** Open a run's decision at a step in Replay, ready to mark wrong. */
  openDecision: (issueId: string, d: BackDecision) => void;
  /** The project's whole queue, so the list says which part of it this fix line holds. */
  queue?: ProblemQueue;
  /** The problems the line will not start (lineFlow startableCause), by id. */
  notReady?: ReadonlySet<string>;
  /** The project's other fix lines: a not-ready problem only they worked is listed there. */
  otherGraphs?: ReadonlyArray<{ title: string; open: () => void }>;
  /** The judges that found a problem (loopSteps problemJudges), which tell apart two problems with one title. */
  judgesOf?: ReadonlyMap<string, string[]>;
}) {
  const asked = showOf(useSearchParams()?.get("show") ?? null);
  const [show, setShow] = useState<Show>(asked ?? "all");
  // A link to the list while it is open (the header's "wait for you") moves the filter too.
  useWatchEffect(() => { if (asked) setShow(asked); }, [asked]);
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState<Period>("14d");
  const [unrunOpen, setUnrunOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // The graph's own problems, and the project's problems no run of it has taken yet.
  // A problem closed without ever running (merged, dissolved) waits for nothing: "waiting" counts the open ones, the noun the header and the start switch use.
  const { worked, unrun } = useMemo(() => ({
    worked: rows.filter((r) => problemWasRun(r.issue)),
    unrun: rows.filter((r) => !problemWasRun(r.issue) && r.issue.status !== "done" && r.issue.status !== "dropped"),
  }), [rows]);
  const counts = useMemo(() => {
    const c = new Map<ProblemState, number>();
    for (const r of worked) c.set(r.state, (c.get(r.state) ?? 0) + 1);
    return c;
  }, [worked]);
  const match = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (r: ProblemRow) => !q || r.issue.title.toLowerCase().includes(q) || (r.issue.ref ?? "").toLowerCase().includes(q);
  }, [query]);
  const shown = useMemo(
    () => (show === "unrun" ? [] : worked.filter((r) => (show === "all" || r.state === show || (show === "notready" && !!notReady?.has(r.issue.id))) && match(r))),
    [worked, show, match, notReady],
  );
  const waiting = useMemo(() => (show === "all" || show === "unrun" ? unrun.filter(match) : show === "notready" ? unrun.filter((r) => notReady?.has(r.issue.id) && match(r)) : []), [unrun, show, match, notReady]);
  // The chip counts every waiting problem not ready to start, the number the start switch says; the ones only another fix line worked are named below the list.
  const notReadyCount = notReady?.size ?? 0;
  const notReadyElsewhere = useMemo(() => (notReady ? notReady.size - rows.filter((r) => notReady.has(r.issue.id)).length : 0), [rows, notReady]);
  const waitingOpen = show === "unrun" || show === "notready" || unrunOpen || (!!query.trim() && waiting.length > 0);
  const ofQueue = queue ? queueWords(queue) : null;

  // ↑ ↓ (and j k) walk the rows; Enter opens the focused one (it is a link).
  const onKey = (e: React.KeyboardEvent) => {
    const dir = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
    if (!dir || (e.target as HTMLElement).tagName === "INPUT") return;
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-line-issue]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const to = items[Math.max(0, Math.min(items.length - 1, i + dir))];
    if (to) { e.preventDefault(); to.focus(); }
  };

  // Rows take words and a bucket-aligned end, never the clock itself, so a tick redraws only the rows whose words moved.
  const end = sparkEnd(now, PERIODS[period].span / PERIODS[period].bars);
  const regressed = counts.get("regressed") ?? 0;
  const cameBack = counts.get("cameback") ?? 0;
  const fixing = counts.get("fixing") ?? 0;
  const backOf = (issue: LineIssue): BackDecision | null => {
    const c = cameBackClose(issue);
    return c?.step && hasRun(c.runId) ? { runId: c.runId, step: c.step, markable: markable(c.step) } : null;
  };
  // Titles that read the same where a row cuts them: each row keeps one line, and its subline says the words that tell it apart.
  const collide = useMemo(() => {
    const groups = new Map<string, ProblemRow[]>();
    const key = (r: ProblemRow) => r.issue.title.slice(0, TITLE_SEEN).toLowerCase();
    for (const r of [...shown, ...waiting]) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
    const out = new Map<string, string>();
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const words = g.map((r) => r.issue.title.split(/\s+/));
      let same = 0;
      while (words.every((w) => w[same] !== undefined && w[same].toLowerCase() === words[0][same].toLowerCase())) same++;
      // The same title word for word (two product issues breaking one expectation): what tells them apart is the judge that found each, its size and age, never a quote (customer text stays out, loopSteps quotesCustomerText).
      // Found by different judges: the judge says which is which (its size is in the Total column).
      const judges = g.map((r) => judgesOf?.get(r.issue.id)?.join(", ") ?? "");
      const byJudge = judges.every(Boolean) && new Set(judges).size === g.length;
      for (const [i, r] of g.entries()) out.set(r.issue.id, words[i].slice(same).join(" ") || (byJudge ? judges[i] : sizeWords(r.issue)));
    }
    return out;
  }, [shown, waiting, judgesOf]);
  // The attempt marks' colors in the rows on screen, said once above them.
  const tones = useMemo(() => {
    const seen = new Set(shown.flatMap((r) => r.issue.history.attempts.slice(-6).map(attemptTone)));
    return MARK_TONE_WORDS.filter(([t]) => seen.has(t));
  }, [shown]);
  const row = (r: ProblemRow) => <Row key={r.issue.id} row={r} seen={lastSeen(r.issue, now)} end={end} period={period} open={open} href={href(r.issue.id)} labelOf={labelOf} back={backOf(r.issue)} openDecision={openDecision} apart={collide.get(r.issue.id) ?? null} />;

  return (
    <div className="lwt-list" onKeyDown={onKey}>
      <header className="lwt-list-head">
        <div>
          <h2 className="lwt-list-h">Problems</h2>
          <p className="lwt-list-sub">
            {graphTitle}: {plural(worked.length, "problem")} worked
            {regressed > 0 && <>, <b data-tone="bad">{regressed} regressed</b></>}
            {cameBack > 0 && <>, <b data-tone="bad">{cameBack} came back</b></>}
            {fixing > 0 && <>, {fixing} being fixed</>}
            {!ofQueue && unrun.length > 0 && <>. {unrun.length} more waiting, not run on any line yet</>}
            {ofQueue && <>. {ofQueue}</>}
          </p>
        </div>
        <label className="lwt-search">
          <Search className="w-3.5 h-3.5" aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a problem" aria-label="Find a problem" />
        </label>
      </header>

      <div className="lw-filters lwt-filters" role="group" aria-label="Show">
        <button type="button" className="lw-filter" aria-pressed={show === "all"} onClick={() => setShow("all")} title={`The problems ${graphTitle} has run on`}>Worked<span>{worked.length}</span></button>
        {PROBLEM_STATES.filter((s) => counts.get(s)).map((s) => (
          <button key={s} type="button" className="lw-filter" data-state={s} aria-pressed={show === s} onClick={() => setShow(show === s ? "all" : s)}>
            <i className="lwt-state-dot" data-state={s} />{PROBLEM_STATE_WORDS[s]}<span>{counts.get(s)}</span>
          </button>
        ))}
        {unrun.length > 0 && (
          <button type="button" className="lw-filter lwt-filter-unrun" aria-pressed={show === "unrun"} onClick={() => setShow(show === "unrun" ? "all" : "unrun")}>
            Not run on any line<span>{unrun.length}</span>
          </button>
        )}
        {notReadyCount > 0 && (
          <button type="button" className="lw-filter" aria-pressed={show === "notready"} onClick={() => setShow(show === "notready" ? "all" : "notready")} title="Problems the line will not start yet: in review, waiting on a person's answer, held by an earlier run, or not grounded" data-line-filter-notready>
            Waiting on you or another run<span>{notReadyCount}</span>
          </button>
        )}
        {tones.length > 0 && (
          <span className="lwt-tone-legend" aria-label="What the attempt marks' colors mean">
            {tones.map(([t, w]) => <span key={t}><span className="lwt-dots"><i data-tone={t} /></span>{w}</span>)}
          </span>
        )}
      </div>

      <div className="lwt-table" role="table" aria-label="Problems" ref={listRef}>
        <div className="lwt-tr lwt-th" role="row">
          <span role="columnheader">Problem</span>
          <span role="columnheader" className="lwt-th-trend">
            <span className="lw-seg lwt-period" role="tablist" aria-label="Trend over">
              {(Object.keys(PERIODS) as Period[]).map((p) => (
                <button key={p} type="button" role="tab" aria-selected={period === p} onClick={() => setPeriod(p)}>{p}</button>
              ))}
            </span>
          </span>
          <span role="columnheader">Last seen</span>
          <span role="columnheader" className="lwt-num">Total</span>
          <span role="columnheader">Attempts</span>
          <span role="columnheader">State</span>
        </div>
        {show !== "unrun" && (show === "notready" && !shown.length ? null : !shown.length ? (
          <p className="lwt-quiet lwt-list-none">{worked.length ? "No problem matches." : `${graphTitle} has not taken a problem yet.`}</p>
        ) : (
          <ol className="lwt-rows">{shown.map(row)}</ol>
        ))}
        {waiting.length > 0 && (
          <section className="lwt-unrun" data-open={waitingOpen ? "" : undefined}>
            {show === "unrun" || show === "notready" ? null : (
              <button type="button" className="lwt-unrun-h" aria-expanded={waitingOpen} onClick={() => setUnrunOpen(!unrunOpen)}>
                <ChevronRight className="w-3.5 h-3.5" aria-hidden />
                Not run on any line yet<span>{waiting.length}</span>
              </button>
            )}
            {waitingOpen && <ol className="lwt-rows">{waiting.map(row)}</ol>}
          </section>
        )}
        {show === "notready" && notReadyElsewhere > 0 && (
          <p className="lwt-quiet lwt-list-none" data-line-notready-elsewhere={notReadyElsewhere}>
            {notReadyElsewhere} more {notReadyElsewhere === 1 ? "is" : "are"} on{" "}
            {otherGraphs.length === 1
              ? <button type="button" className="text-sol-blue hover:underline" onClick={otherGraphs[0].open}>{otherGraphs[0].title}</button>
              : "the project's other fix lines"}
            .
          </p>
        )}
      </div>
    </div>
  );
}

/** A problem by its size and age, for rows whose titles are the same: "28 reports since Oct 3". */
const sizeWords = (issue: LineIssue) => {
  const n = Math.max(issue.findings, issue.history.occurrences.length);
  return `${plural(n, "report")}${issue.history.firstAt ? ` since ${shortDay(issue.history.firstAt)}` : ""}`;
};

/** About how many characters of a title a row shows before it cuts: two titles alike that far read as the same. */
const TITLE_SEEN = 64;

/** When a problem was last seen, in words, and as a moment for the title. */
const lastAt = (issue: LineIssue) => issue.history.occurrences[issue.history.occurrences.length - 1]?.at ?? null;
const lastSeen = (issue: LineIssue, now: number) => {
  const last = lastAt(issue);
  return last ? formatRelativeTime(last, now) : "never";
};

const Row = memo(function Row({ row: { issue, state }, seen, end, period, open, href, labelOf, back, openDecision, apart }: { row: ProblemRow; seen: string; end: number; period: Period; open: (id: string) => void; href: string; labelOf: (id: string) => string | undefined; back: BackDecision | null; openDecision: (issueId: string, d: BackDecision) => void; apart: string | null }) {
  const h = issue.history;
  const line = problemLine(issue, labelOf, end);
  // A close that did not hold names the step's decision: "Dissolved at Investigate Oct 7" opens it in Replay, ready to mark wrong (learning-loop.md LL4).
  const lead = back ? closeWords(h.closes[h.closes.length - 1], labelOf) : null;
  const goBack = (e: React.SyntheticEvent) => { e.preventDefault(); e.stopPropagation(); if (back) openDecision(issue.id, back); };
  const last = lastAt(issue);
  const total = Math.max(issue.findings, h.occurrences.length);
  // Shipped past a card nobody answered: the card is still the person's to read and answer.
  const router = useRouter();
  const card = state === "unapproved" ? [...h.attempts].reverse().find((a) => a.unapproved)?.card?.ref ?? null : null;
  const review = (e: React.SyntheticEvent) => { e.preventDefault(); e.stopPropagation(); if (card) router.push(`/decisions/${card}`); };
  return (
    <li role="row">
      <a
        className="lwt-tr lwt-row"
        href={href}
        data-line-issue={issue.id}
        data-state={state}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          open(issue.id);
        }}
      >
        <span className="lwt-row-what" role="cell">
          <span className="lwt-row-t" title={apart != null ? issue.title : undefined}>{issue.title}</span>
          <span className="lwt-row-m">
            {issue.ref && <span className="lwt-ref">{issue.ref}</span>}
            {apart && <span className="lwt-row-apart" title={issue.title}>{issue.title.endsWith(apart) ? "…" : ""}{apart}</span>}
            <span className="lwt-row-where">
              {lead && line.startsWith(lead) ? (
                <>
                  <span
                    role="link"
                    tabIndex={0}
                    className="lwt-row-close"
                    title={back!.markable ? "Open this decision in Replay to mark it wrong" : "Open this run in Replay at the step that closed it"}
                    onClick={goBack}
                    onKeyDown={(e) => { if (e.key === "Enter") goBack(e); }}
                    data-line-came-back={back!.runId}
                  >
                    {lead}
                  </span>
                  {line.slice(lead.length)}
                </>
              ) : line}
            </span>
            {card && (
              <span role="link" tabIndex={0} className="lwt-row-act" title="Nobody answered this card, yet the run went on. Open it to see what changed and answer it now." onClick={review} onKeyDown={(e) => { if (e.key === "Enter") review(e); }} data-line-review-unapproved={card}>
                Review what shipped
              </span>
            )}
          </span>
        </span>
        <span role="cell"><Spark issue={issue} end={end} period={period} /></span>
        <span role="cell" className="lwt-row-when" title={last ? momentWords(last) : undefined}>{seen}</span>
        <span role="cell" className="lwt-num">{total}{h.capped ? "+" : ""}</span>
        <span role="cell" className="lwt-dots" aria-label={plural(h.attempts.length, "attempt")}>
          {h.attempts.slice(-6).map((a) => <i key={a.runId} data-tone={attemptTone(a)} data-live={a.live ? "" : undefined} title={attemptMarkWords(a, labelOf)} />)}
          {h.attempts.length > 6 && <small>+{h.attempts.length - 6}</small>}
          {!h.attempts.length && <small>none</small>}
        </span>
        <span role="cell"><span className="lwt-state" data-state={state}>{PROBLEM_STATE_WORDS[state]}</span></span>
      </a>
    </li>
  );
});

/** The occurrences over the period as bars; what came back after a fix in red, a fix going live as a green tick. */
const Spark = memo(function Spark({ issue, end, period }: { issue: LineIssue; end: number; period: Period }) {
  const h = issue.history;
  const { span, bars } = PERIODS[period];
  const t0 = end - span;
  const step = span / bars;
  const data = useMemo(() => {
    const all = bucketCounts(h.occurrences.map((o) => o.at), t0, end, step);
    const back = bucketCounts(comebackTimes(h), t0, end, step);
    return { all, back, max: Math.max(1, ...all) };
  }, [h, t0, end, step]);
  const W = 112;
  const H = 26;
  const bw = W / bars;
  // Every close, a fix going live or a close without a change, as a tick.
  const closes = h.closes.filter((c) => c.at >= t0).map((c) => ({ x: ((c.at - t0) / span) * W, kind: c.kind }));
  const sum = data.all.reduce((n, c) => n + c, 0);
  return (
    <svg className="lwt-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-label={`${plural(sum, "occurrence")} in ${period}`}>
      <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="lwt-spark-base" />
      {data.all.map((n, i) => n > 0 && (
        <g key={i}>
          <rect x={i * bw + 0.5} width={Math.max(1, bw - 1.5)} y={H - 1 - (n / data.max) * (H - 4)} height={(n / data.max) * (H - 4)} rx={1} className="lwt-spark-bar" />
          {data.back[i] > 0 && <rect x={i * bw + 0.5} width={Math.max(1, bw - 1.5)} y={H - 1 - (data.back[i] / data.max) * (H - 4)} height={(data.back[i] / data.max) * (H - 4)} rx={1} className="lwt-spark-bar" data-back="" />}
        </g>
      ))}
      {closes.map((c, i) => <line key={i} x1={c.x} x2={c.x} y1={1} y2={H - 1} className="lwt-spark-live" data-kind={c.kind} />)}
      {sum === 0 && <text x={W / 2} y={H / 2 + 3} className="lwt-spark-none">quiet</text>}
    </svg>
  );
});

