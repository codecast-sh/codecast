"use client";
// The Problems table (line-journeys.md LJ8.2): four columns. The problem (its
// whole title on up to two lines, its ref and project beneath), how often it
// happened in the window with an arrow against the window before, where it
// stands in one phrase, and when it was last seen. Rows sit under their status
// group; a failure cause and a project not started are headings that carry the
// group's one act. The whole row is the link to the problem.
import { memo, useMemo, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronRight } from "lucide-react";
import { ageShort } from "../../../../../lib/lineFlow";
import { momentWords } from "../../../../../lib/line/timeline";
import { countIn, rowStrip, stripWords, type OverviewWindow } from "../../../../../lib/line/problemsOverview";
import { problemListName, rowTrend, type ProblemRow, type ProblemSection, type ProblemSort, type ProblemSub } from "../../../../../lib/line/problemTable";
import type { StatusKey } from "../../../../../lib/line/problemStatus";
import type { OverviewRange } from "../../../../../lib/line/problemsOverview";
import { RowStrip } from "./RowStrip";

/** The column heads: Findings and Last sort the whole list flat; Status returns to the page's own grouped order. */
export function ProblemTableHead({ range, sort, onSort, grouped, day }: { range: OverviewRange; sort: ProblemSort; onSort: (s: ProblemSort) => void; /** One chip is on: the list is that group whatever the sort, so Status sorts nothing. */ grouped: boolean; /** A picked bar: the column counts that day ("Oct 9"). */ day?: string | null }) {
  const head = (key: ProblemSort, label: string, cls: string) => {
    const on = sort === key;
    return (
      <span role="columnheader" className={cls} aria-sort={on ? (key ? "descending" : "other") : undefined}>
        <button type="button" onClick={() => onSort(key)} data-on={on ? "" : undefined} data-line-sort={key ?? "status"}>
          {label}{on && key && <ArrowDown className="lwp-sort" aria-hidden />}
        </button>
      </span>
    );
  };
  return (
    <div className="lwp-tr lwp-th" role="row">
      <span className="lwp-c-title" role="columnheader">Problem</span>
      {head("findings", `Findings ${day ?? range}`, "lwp-c-find")}
      {grouped ? <span className="lwp-c-status" role="columnheader">Status</span> : head(null, "Status", "lwp-c-status")}
      {/* When the problem was last seen, never when a run last wrote or it started waiting (For you's clock). */}
      {head("last", "Last finding", "lwp-c-last")}
    </div>
  );
}

export function ProblemTable({ sections, now, range, win, day, showProject, projectName, processOf, href, open, onStatus, subAct, rowAct, sectionAct }: {
  sections: ReadonlyArray<ProblemSection>;
  now: number;
  range: OverviewRange;
  /** The page's window: each row's strip spans it. */
  win: OverviewWindow;
  /** A picked bar: each row's Findings cell is its count that day, the number the list is sorted by. */
  day?: { from: number; to: number } | null;
  showProject: boolean;
  projectName: (id: string | null) => string;
  /** The process a row is in, named under it while the list spans more than one. */
  processOf?: (r: ProblemRow) => string;
  href: (id: string) => string;
  open: (id: string) => void;
  /** A folded group's heading opens its chip. */
  onStatus: (status: StatusKey) => void;
  /** The act a sub-group's heading carries: starting a cause's problems again, a project's start control. */
  subAct?: (status: StatusKey, sub: ProblemSub) => ReactNode;
  /** A row's own act, under its status (Needs a new ask: Ask again, Reopen). */
  rowAct?: (r: ProblemRow) => ReactNode;
  /** The act an open group's heading carries (Needs a new ask: ask again for all of them). */
  sectionAct?: (status: StatusKey, rows: ReadonlyArray<ProblemRow>) => ReactNode;
}) {
  const one = (r: ProblemRow) => {
    const row = <Row key={r.id} row={r} range={range} win={win} dayN={day ? countIn(r.issue, day.from, day.to) : null} age={r.seenAt ? ageShort(now - r.seenAt) : ""} project={showProject ? projectName(r.projectId) : ""} process={processOf?.(r) ?? ""} href={href(r.id)} open={open} />;
    const act = rowAct?.(r);
    // The act sits under the row's status, outside its link: a press acts, never opens the problem.
    return act ? <div key={r.id} className="lwp-rowbox">{row}<div className="lwp-tr lwp-row-act" data-line-row-act={r.id}><span className="lwp-row-act-c">{act}</span></div></div> : row;
  };
  // A row's folded twins are not rows of their own (the chip counts the problem once): each is one line under it, its
  // ref opening it and its merge beside it.
  const twin = (t: ProblemRow) => (
    <div key={t.id} className="lwp-tr lwp-row-act lwp-twin" data-line-twin={t.issue.ref ?? t.id}>
      <span className="lwp-row-act-c">
        <a className="lw-link" href={href(t.id)} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); open(t.id); }}>{t.issue.ref ?? "Twin"}</a>
        <span className="lwp-twin-n">same problem · <span className="lw-num">{t.findings}</span> {t.findings === 1 ? "finding" : "findings"}</span>
        {rowAct?.(t)}
      </span>
    </div>
  );
  const rows = (list: ReadonlyArray<ProblemRow>) => list.map((r) => r.twins?.length
    ? <div key={r.id} className="lwp-twinbox">{one(r)}<div className="lwp-twins" data-line-twins={r.twins.length}>{r.twins.map(twin)}</div></div>
    : one(r));
  return (
    <div className="lwp-table" role="grid" aria-label="Problems">
      {sections.map((s) => (
        <div key={s.status ?? "flat"} role="rowgroup" className="lwp-group" data-line-problem-group={s.status ?? "flat"} data-count={s.n}>
          {s.status && (s.folded ? (
            <button type="button" className="lwp-section" data-folded="" data-status={s.status} onClick={() => onStatus(s.status!)} data-line-problem-section={s.status}>
              <span>{s.label}</span><span className="lw-num">{s.n}</span><ChevronRight aria-hidden />
            </button>
          ) : (
            <div className="lwp-section" role="row" data-status={s.status} data-line-problem-section={s.status}>
              <span role="gridcell">{s.label}</span><span className="lw-num">{s.n}</span>
              {sectionAct && <span className="lwp-section-act">{sectionAct(s.status!, s.rows)}</span>}
            </div>
          ))}
          {!s.folded && (s.subs ? s.subs.map((sub) => (
            <div key={sub.key} className="lwp-sub" data-line-problem-sub={sub.key} data-count={sub.rows.length}>
              <div className="lwp-sub-h" role="row">
                <b>{sub.label}</b>
                {sub.ready != null
                  ? <span className="lwp-sub-n"><span className="lw-num" data-ready>{sub.ready}</span> ready<i aria-hidden>·</i><span className="lw-num" data-blocked>{sub.blocked}</span> blocked</span>
                  : s.status === "failed"
                    // Problems, not runs: a step's page counts every run that failed there, this counts each problem once.
                    ? <span className="lwp-sub-n" title="Problems whose newest run stopped this way"><span className="lw-num">{sub.rows.length}</span>{sub.rows.length === 1 ? "problem" : "problems"}</span>
                    : <span className="lw-num lwp-sub-n">{sub.rows.length}</span>}
                <span className="lwp-sub-act">{subAct?.(s.status!, sub)}</span>
                {/* The open problem with the line that these runs failed on: its name and where it stands. */}
                {sub.heldBy?.map((h) => (
                  <a key={h.id} className="lwp-sub-held" href={href(h.id)} data-line-held-by={h.issue.ref ?? h.id}
                    onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); open(h.id); }}>
                    <span className="lwp-sub-held-k">Same cause</span>
                    <span className="lwp-sub-held-ref">{h.issue.ref}</span>
                    <span className="lwp-sub-held-name">{problemListName(h.issue)}</span>
                    <span className="lwp-sub-held-st" data-status={h.stand.status}>{h.stand.phrase}</span>
                  </a>
                ))}
              </div>
              {rows(sub.rows)}
            </div>
          )) : rows(s.rows))}
        </div>
      ))}
    </div>
  );
}

const Row = memo(function Row({ row: r, range, win, dayN, age, project, process, href, open }: { row: ProblemRow; range: OverviewRange; win: OverviewWindow; dayN: number | null; age: string; project: string; process: string; href: string; open: (id: string) => void }) {
  // Under a picked bar the cell is that day's count, with no arrow: the comparison is the window's, not the day's.
  const trend = dayN == null ? rowTrend(r) : null;
  const h = r.issue.history;
  const strip = useMemo(() => rowStrip(h, win), [h, win]);
  const under = [r.issue.ref, process, project, r.dupOf && !r.foldedInto ? `same as ${r.dupOf}` : null, r.twins?.length ? `also ${r.twins.map((t) => t.issue.ref).filter(Boolean).join(", ")}` : null].filter(Boolean).join(" · ");
  return (
    <a
      className="lwp-tr lwp-row"
      role="row"
      href={href}
      data-status={r.stand.status}
      data-line-issue={r.id}
      data-twin={r.foldedInto ? "" : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        open(r.id);
      }}
    >
      <span className="lwp-c-title" role="gridcell">
        <span className="lwp-title">{problemListName(r.issue)}</span>
        {under && <span className="lwp-under">{under}</span>}
      </span>
      <span className="lwp-c-find" role="gridcell" data-trend={trend ?? undefined} title={r.before == null ? `${r.findings} in all` : `${r.before} in the ${range} before, ${r.findings} in all`}>
        <RowStrip strip={strip} words={stripWords(strip, h, range)} />
        <span className="lw-num">{dayN ?? r.inWindow}</span>
        {trend === "up" && <ArrowUp aria-label="more than the window before" />}
        {trend === "down" && <ArrowDown aria-label="fewer than the window before" />}
      </span>
      <span className="lwp-c-status" role="gridcell" data-ready={r.stand.status === "notstarted" && r.stand.ready ? "" : undefined}>{r.stand.phrase}</span>
      <span className="lwp-c-last lw-num" role="gridcell" title={r.seenAt ? `Newest finding ${momentWords(r.seenAt)}` : undefined}>{age}</span>
    </a>
  );
});
