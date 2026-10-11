"use client";
// The Problems table (line-workspace.md LW1 Problems): a row per problem with
// fixed columns, the way an error tracker lists issues. Where it came from,
// its findings over two weeks, its attempts as marks, where it stands and
// whether it came back. A header sorts; a row opens the problem's timeline.
import { memo, useMemo } from "react";
import { ArrowDown, ArrowUp, RotateCcw } from "lucide-react";
import { ageShort } from "../../../../../lib/lineFlow";
import { attemptMarkWords, attemptTone, bucketCounts, comebackTimes, DAY, momentWords, sparkEnd } from "../../../../../lib/line/timeline";
import { PROBLEM_STATUS_WORDS, waitingWhy, type ProblemSort, type ProblemSortKey, type ProblemTableRow } from "../../../../../lib/line/problemTable";
import type { LineIssue } from "../../../../../lib/line/lineModel";

const SPAN = 14 * DAY;
const BARS = 14;
const MAX_MARKS = 5;

type Col = { key: ProblemSortKey | null; label: string; cls: string; title?: string };
const COLS: Col[] = [
  { key: "title", label: "Problem", cls: "lwp-c-title" },
  { key: "source", label: "Source", cls: "lwp-c-src" },
  { key: null, label: "Project", cls: "lwp-c-proj" },
  { key: "findings", label: "Findings 14d", cls: "lwp-c-find", title: "Findings over the last 14 days, and in all" },
  { key: "attempts", label: "Runs", cls: "lwp-c-att", title: "Runs on the problem, newest last" },
  { key: "status", label: "Status", cls: "lwp-c-status" },
  { key: "back", label: "Back", cls: "lwp-c-back", title: "Times it came back after a close" },
  { key: "last", label: "Last", cls: "lwp-c-last", title: "Last activity" },
];

export function ProblemTable({ rows, sort, onSort, selected, cursor, now, projectName, showProject, open, href }: {
  rows: ProblemTableRow[];
  sort: ProblemSort;
  onSort: (key: ProblemSortKey) => void;
  selected: string | null;
  /** The row j and k point at while no problem is open. */
  cursor: string | null;
  now: number;
  projectName: (id: string | null) => string;
  showProject: boolean;
  open: (id: string) => void;
  href: (id: string) => string;
}) {
  // The sparkline window moves once a bucket, never with the clock, so a tick redraws no row.
  const end = sparkEnd(now, SPAN / BARS);
  // Ages are coarse words: a row redraws only when its own word changes.
  return (
    <div className="lwp-table" role="grid" aria-label="Problems" aria-rowcount={rows.length} data-project-col={showProject ? "" : undefined}>
      <div className="lwp-tr lwp-th" role="row">
        <span className="lwp-c-ref" role="columnheader">Ref</span>
        {COLS.filter((c) => showProject || c.cls !== "lwp-c-proj").map((c) => (
          <span key={c.label} role="columnheader" className={c.cls} aria-sort={c.key && sort.key === c.key ? (sort.desc ? "descending" : "ascending") : undefined}>
            {c.key ? (
              <button type="button" onClick={() => onSort(c.key!)} title={c.title} data-on={sort.key === c.key ? "" : undefined}>
                {c.label}
                {sort.key === c.key && (sort.desc ? <ArrowDown className="lwp-sort" aria-hidden /> : <ArrowUp className="lwp-sort" aria-hidden />)}
              </button>
            ) : c.label}
          </span>
        ))}
      </div>
      {rows.map((r) => (
        <Row
          key={r.id}
          row={r}
          end={end}
          age={r.lastAt ? ageShort(now - r.lastAt) : ""}
          project={showProject ? projectName(r.projectId) : null}
          selected={selected === r.id}
          cursor={cursor === r.id}
          open={open}
          href={href(r.id)}
        />
      ))}
    </div>
  );
}

const Row = memo(function Row({ row: r, end, age, project, selected, cursor, open, href }: {
  row: ProblemTableRow; end: number; age: string; project: string | null; selected: boolean; cursor: boolean; open: (id: string) => void; href: string;
}) {
  const h = r.issue.history;
  const marks = h.attempts.slice(-MAX_MARKS);
  const src = r.sources[0];
  return (
    <a
      className="lwp-tr lwp-row"
      role="row"
      href={href}
      aria-selected={selected}
      data-cursor={cursor ? "" : undefined}
      data-status={r.status}
      data-line-issue={r.id}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        open(r.id);
      }}
    >
      <span className="lwp-c-ref lw-mono" role="gridcell">{r.issue.ref ?? ""}</span>
      <span className="lwp-c-title" role="gridcell" title={r.issue.title}>
        <i className="lwp-dot" data-status={r.status} aria-hidden />
        <span className="lwp-title">{r.issue.title}</span>
      </span>
      <span className="lwp-c-src" role="gridcell" title={r.sources.map((s) => `${s.label} ${s.n}`).join(", ") || undefined}>
        {src ? <><span className="lwp-src">{src.label}</span>{r.sources.length > 1 && <small>+{r.sources.length - 1}</small>}</> : <span className="lwp-src-none">none</span>}
      </span>
      {project != null && <span className="lwp-c-proj" role="gridcell" title={project}>{project}</span>}
      <span className="lwp-c-find" role="gridcell">
        <Spark issue={r.issue} end={end} />
        <span className="lw-num">{r.findings}{h.capped ? "+" : ""}</span>
      </span>
      <span className="lwp-c-att" role="gridcell">
        <span className="lwp-marks">
          {marks.map((a) => <i key={a.runId} data-tone={attemptTone(a)} data-live={a.live ? "" : undefined} title={attemptMarkWords(a)} />)}
        </span>
        <span className="lw-num">{h.attempts.length || ""}</span>
      </span>
      <span className="lwp-c-status" role="gridcell" data-status={r.status} title={waitingWhy(r.issue, r.status) ?? undefined}>{PROBLEM_STATUS_WORDS[r.status]}</span>
      <span className="lwp-c-back" role="gridcell">
        {r.back > 0 && <span className="lwp-back" title={`Came back ${r.back}x after a close`}><RotateCcw aria-hidden />{r.back}</span>}
      </span>
      <span className="lwp-c-last lw-num" role="gridcell" title={r.lastAt ? momentWords(r.lastAt) : undefined}>{age}</span>
    </a>
  );
});

/** Findings per day over two weeks; what came back after a close in red, a close as a tick. */
const Spark = memo(function Spark({ issue, end }: { issue: LineIssue; end: number }) {
  const h = issue.history;
  const t0 = end - SPAN;
  const step = SPAN / BARS;
  const data = useMemo(() => {
    const all = bucketCounts(h.occurrences.map((o) => o.at), t0, end, step);
    const back = bucketCounts(comebackTimes(h), t0, end, step);
    return { all, back, max: Math.max(1, ...all), sum: all.reduce((n, c) => n + c, 0) };
  }, [h, t0, end, step]);
  const W = 70;
  const H = 16;
  const bw = W / BARS;
  const closes = h.closes.filter((c) => c.at >= t0);
  return (
    <svg className="lwp-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-label={`${data.sum} in 14 days`}>
      <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="lwp-spark-base" />
      {data.all.map((n, i) => n > 0 && (
        <g key={i}>
          <rect x={i * bw + 0.5} width={bw - 1.5} y={H - 1 - Math.max(2, (n / data.max) * (H - 2))} height={Math.max(2, (n / data.max) * (H - 2))} rx={0.5} className="lwp-spark-bar" />
          {data.back[i] > 0 && <rect x={i * bw + 0.5} width={bw - 1.5} y={H - 1 - Math.max(2, (data.back[i] / data.max) * (H - 2))} height={Math.max(2, (data.back[i] / data.max) * (H - 2))} rx={0.5} className="lwp-spark-bar" data-back="" />}
        </g>
      ))}
      {closes.map((c, i) => { const x = ((c.at - t0) / SPAN) * W; return <line key={i} x1={x} x2={x} y1={0} y2={H - 1} className="lwp-spark-close" data-kind={c.kind} />; })}
    </svg>
  );
});
