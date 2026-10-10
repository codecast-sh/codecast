"use client";
// The line's problems as an error tracker lists issues (line-workspace.md LW1
// Timeline): a row each with how often it happened lately as a sparkline, when
// it was last seen, how many times in all, its fix attempts and where it
// stands; regressed first, then the newest activity. Filters by state and words.
import { memo, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { LineIssue } from "../../../../../lib/line/lineModel";
import { formatRelativeTime } from "../../../../../lib/conversationFormat";
import {
  attemptEndWords, attemptTone, bucketCounts, DAY, momentWords, PROBLEM_STATE_WORDS, PROBLEM_STATES, regressionAt,
  type ProblemState,
} from "../../../../../lib/line/timeline";

export type ProblemRow = { issue: LineIssue; state: ProblemState };

type Period = "24h" | "14d" | "90d";
const PERIODS: Record<Period, { span: number; bars: number }> = { "24h": { span: DAY, bars: 24 }, "14d": { span: 14 * DAY, bars: 14 }, "90d": { span: 90 * DAY, bars: 30 } };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ProblemList({ rows, now, open, href }: { rows: ProblemRow[]; now: number; open: (id: string) => void; href: (id: string) => string }) {
  const [state, setState] = useState<ProblemState | "all">("all");
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState<Period>("14d");
  const listRef = useRef<HTMLOListElement>(null);

  const counts = useMemo(() => {
    const c = new Map<ProblemState, number>();
    for (const r of rows) c.set(r.state, (c.get(r.state) ?? 0) + 1);
    return c;
  }, [rows]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => (state === "all" || r.state === state) && (!q || r.issue.title.toLowerCase().includes(q) || (r.issue.ref ?? "").toLowerCase().includes(q)));
  }, [rows, state, query]);

  // ↑ ↓ (and j k) walk the rows; Enter opens the focused one (it is a link).
  const onKey = (e: React.KeyboardEvent) => {
    const dir = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
    if (!dir || (e.target as HTMLElement).tagName === "INPUT") return;
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-line-issue]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const to = items[Math.max(0, Math.min(items.length - 1, i + dir))];
    if (to) { e.preventDefault(); to.focus(); }
  };

  const regressed = counts.get("regressed") ?? 0;
  const fixing = counts.get("fixing") ?? 0;

  return (
    <div className="lwt-list" onKeyDown={onKey}>
      <header className="lwt-list-head">
        <div>
          <h2 className="lwt-list-h">Problems</h2>
          <p className="lwt-list-sub">
            {plural(rows.length, "problem")}
            {regressed > 0 && <>, <b data-tone="bad">{regressed} regressed</b></>}
            {fixing > 0 && <>, {fixing} being fixed</>}
          </p>
        </div>
        <label className="lwt-search">
          <Search className="w-3.5 h-3.5" aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a problem" aria-label="Find a problem" />
        </label>
      </header>

      <div className="lw-filters lwt-filters" role="group" aria-label="Show">
        <button type="button" className="lw-filter" aria-pressed={state === "all"} onClick={() => setState("all")}>All<span>{rows.length}</span></button>
        {PROBLEM_STATES.filter((s) => counts.get(s)).map((s) => (
          <button key={s} type="button" className="lw-filter" data-state={s} aria-pressed={state === s} onClick={() => setState(state === s ? "all" : s)}>
            <i className="lwt-state-dot" data-state={s} />{PROBLEM_STATE_WORDS[s]}<span>{counts.get(s)}</span>
          </button>
        ))}
      </div>

      <div className="lwt-table" role="table" aria-label="Problems">
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
        {!shown.length ? (
          <p className="lwt-quiet lwt-list-none">{rows.length ? "No problem matches." : "Each problem this line works shows here with its history."}</p>
        ) : (
          <ol ref={listRef} className="lwt-rows">
            {shown.map((r) => <Row key={r.issue.id} row={r} now={now} period={period} open={open} href={href(r.issue.id)} />)}
          </ol>
        )}
      </div>
    </div>
  );
}

const Row = memo(function Row({ row: { issue, state }, now, period, open, href }: { row: ProblemRow; now: number; period: Period; open: (id: string) => void; href: string }) {
  const h = issue.history;
  const last = h.occurrences[h.occurrences.length - 1]?.at ?? null;
  const total = Math.max(issue.findings, h.occurrences.length);
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
          <span className="lwt-row-t">{issue.title}</span>
          <span className="lwt-row-m">
            {issue.ref && <span className="lwt-ref">{issue.ref}</span>}
            <span className="lwt-row-where">{issue.where.text}</span>
          </span>
        </span>
        <span role="cell"><Spark issue={issue} now={now} period={period} /></span>
        <span role="cell" className="lwt-row-when" title={last ? momentWords(last) : undefined}>{last ? formatRelativeTime(last, now) : "never"}</span>
        <span role="cell" className="lwt-num">{total}{h.capped ? "+" : ""}</span>
        <span role="cell" className="lwt-dots" aria-label={plural(h.attempts.length, "attempt")}>
          {h.attempts.slice(-6).map((a) => <i key={a.runId} data-tone={attemptTone(a)} data-live={a.live ? "" : undefined} title={`Attempt ${a.n}: ${attemptEndWords(a)}`} />)}
          {h.attempts.length > 6 && <small>+{h.attempts.length - 6}</small>}
          {!h.attempts.length && <small>none</small>}
        </span>
        <span role="cell"><span className="lwt-state" data-state={state}>{PROBLEM_STATE_WORDS[state]}</span></span>
      </a>
    </li>
  );
});

/** The occurrences over the period as bars; what came back after a fix in red, a fix going live as a green tick. */
const Spark = memo(function Spark({ issue, now, period }: { issue: LineIssue; now: number; period: Period }) {
  const h = issue.history;
  const { span, bars } = PERIODS[period];
  const t0 = now - span;
  const step = span / bars;
  const data = useMemo(() => {
    const all = bucketCounts(h.occurrences.map((o) => o.at), t0, now + 1, step);
    const back = bucketCounts(h.occurrences.filter((o) => regressionAt(o.at, h.regressions)).map((o) => o.at), t0, now + 1, step);
    return { all, back, max: Math.max(1, ...all) };
  }, [h, t0, now, step]);
  const W = 112;
  const H = 26;
  const bw = W / bars;
  const live = h.ships.filter((s) => s.liveAt >= t0).map((s) => ((s.liveAt - t0) / span) * W);
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
      {live.map((lx, i) => <line key={i} x1={lx} x2={lx} y1={1} y2={H - 1} className="lwt-spark-live" />)}
      {sum === 0 && <text x={W / 2} y={H / 2 + 3} className="lwt-spark-none">quiet</text>}
    </svg>
  );
});

