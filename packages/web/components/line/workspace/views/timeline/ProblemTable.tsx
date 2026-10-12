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
import type { Overlap } from "../../../../../lib/line/overlap";

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

export function ProblemTable({ rows, sort, onSort, selected, cursor, now, projectName, showProject, open, href, sourceWords, lineOff, overlaps, folded, unfolded, onFold }: {
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
  /** Where a problem came from as every list says it (the workspace's one source reading); undefined when nothing says. */
  sourceWords: (id: string) => string | undefined;
  /** Whether a project's line starts nothing on its own: an open problem there is queued, not being worked. */
  lineOff?: (projectId: string | null) => boolean;
  /** Each problem's duplicate set (lib/line/overlap): the oldest carries the count, a duplicate sits under it. */
  overlaps?: ReadonlyMap<string, Overlap>;
  /** Each defect's head row and the rows that are the same defect under it (overlap defectHeads). */
  folded?: ReadonlyMap<string, ProblemTableRow[]>;
  unfolded?: ReadonlySet<string>;
  onFold?: (id: string) => void;
}) {
  // The sparkline window moves once a bucket, never with the clock, so a tick redraws no row.
  const end = sparkEnd(now, SPAN / BARS);
  const underIds = useMemo(() => new Set([...(folded?.values() ?? [])].flat().map((k) => k.id)), [folded]);
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
          src={sourceWords(r.id) ?? r.sources[0]?.label}
          queued={r.status === "open" && !!lineOff?.(r.projectId)}
          overlap={overlaps?.get(r.id)}
          kids={folded?.get(r.id)}
          unfolded={!!unfolded?.has(r.id)}
          onFold={onFold}
          under={underIds.has(r.id)}
        />
      ))}
    </div>
  );
}

const Row = memo(function Row({ row: r, end, age, project, selected, cursor, open, href, src, queued, overlap, kids, unfolded, onFold, under }: {
  row: ProblemTableRow; end: number; age: string; project: string | null; selected: boolean; cursor: boolean; open: (id: string) => void; href: string; src: string | undefined; queued?: boolean; overlap?: Overlap;
  kids?: ProblemTableRow[]; unfolded?: boolean; onFold?: (id: string) => void; under?: boolean;
}) {
  const dupOf = overlap && overlap.set.length > 1 && overlap.primary !== r.id ? overlap.primaryRef : null;
  const h = r.issue.history;
  // A defect's head carries its siblings' runs and findings, so one bug attacked seven times reads as seven.
  const runsAll = h.attempts.length + (kids ?? []).reduce((n, k) => n + k.issue.history.attempts.length, 0);
  const findingsAll = r.findings + (kids ?? []).reduce((n, k) => n + k.findings, 0);
  const marks = h.attempts.slice(-MAX_MARKS);
  return (
    <a
      className="lwp-tr lwp-row"
      role="row"
      href={href}
      aria-selected={selected}
      data-cursor={cursor ? "" : undefined}
      data-status={r.status}
      data-line-issue={r.id}
      data-dup={dupOf || under ? "" : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        open(r.id);
      }}
    >
      <span className="lwp-c-ref lw-mono" role="gridcell">{r.issue.ref ?? ""}</span>
      <span className="lwp-c-title" role="gridcell" title={r.issue.title}>
        <i className="lwp-dot" data-status={r.status} aria-hidden />
        {under && <span className="lwp-dup" title={dupOf ? `Reads the same as ${dupOf}` : "Its findings cite the same rule"}>{dupOf ? `dup ${dupOf}` : "same defect"}</span>}
        <span className="lwp-title">{r.issue.title}</span>
        {!!kids?.length && (
          <button type="button" className="lwp-dup lwp-fold" data-primary="" aria-expanded={unfolded} data-line-defect={kids.length}
            title={`${kids.length + 1} problems, one defect: ${runsAll} runs, ${findingsAll} findings in all`}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onFold?.(r.id); }}>
            +{kids.length} same defect<span className="lw-num">{runsAll}×</span>
          </button>
        )}
      </span>
      <span className="lwp-c-src" role="gridcell" title={r.sources.map((s) => `${s.label} ${s.n}`).join(", ") || undefined}>
        {src ? <><span className="lwp-src">{src}</span>{r.sources.length > 1 && <small>+{r.sources.length - 1}</small>}</> : null}
      </span>
      {project != null && <span className="lwp-c-proj" role="gridcell" title={project}>{project}</span>}
      <span className="lwp-c-find" role="gridcell">
        <Spark issue={r.issue} end={end} />
        <span className="lw-num">{r.findings}{h.capped ? "+" : ""}</span>
      </span>
      <span className="lwp-c-att" role="gridcell">
        <span className="lwp-marks">
          {marks.map((a) => <i key={a.runId} data-tone={attemptTone(a, h)} data-live={a.live ? "" : undefined} title={attemptMarkWords(a, undefined, h)} />)}
        </span>
        <span className="lw-num">{h.attempts.length || ""}</span>
      </span>
      <span className="lwp-c-status" role="gridcell" data-status={r.status} data-queued={queued ? "" : undefined} title={queued ? "Auto-start is off for its project: nothing will start it" : waitingWhy(r.issue, r.status) ?? undefined}>{queued ? "Queued, off" : PROBLEM_STATUS_WORDS[r.status]}</span>
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
