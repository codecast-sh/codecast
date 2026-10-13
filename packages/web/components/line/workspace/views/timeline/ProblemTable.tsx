"use client";
// The Problems table (line-journeys.md LJ8.2): four columns. The problem (its
// whole title on up to two lines, its ref and project beneath), how often it
// happened in the window with an arrow against the window before, where it
// stands in one phrase, and when it was last seen. Rows sit under their status
// group; a failure cause and a project not started are headings that carry the
// group's one act. The whole row is the link to the problem.
import { memo, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronRight } from "lucide-react";
import { ageShort } from "../../../../../lib/lineFlow";
import { momentWords } from "../../../../../lib/line/timeline";
import { problemTitle, rowTrend, type ProblemRow, type ProblemSection, type ProblemSort, type ProblemSub } from "../../../../../lib/line/problemTable";
import type { StatusKey } from "../../../../../lib/line/problemStatus";
import type { OverviewRange } from "../../../../../lib/line/problemsOverview";

/** The column heads: Findings and Last sort the whole list flat; Status returns to the page's own grouped order. */
export function ProblemTableHead({ range, sort, onSort, grouped }: { range: OverviewRange; sort: ProblemSort; onSort: (s: ProblemSort) => void; /** One chip is on: the list is that group whatever the sort, so Status sorts nothing. */ grouped: boolean }) {
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
      {head("findings", `Findings ${range}`, "lwp-c-find")}
      {grouped ? <span className="lwp-c-status" role="columnheader">Status</span> : head(null, "Status", "lwp-c-status")}
      {head("last", "Last", "lwp-c-last")}
    </div>
  );
}

export function ProblemTable({ sections, now, range, showProject, projectName, href, open, onStatus, subAct }: {
  sections: ReadonlyArray<ProblemSection>;
  now: number;
  range: OverviewRange;
  showProject: boolean;
  projectName: (id: string | null) => string;
  href: (id: string) => string;
  open: (id: string) => void;
  /** A folded group's heading opens its chip. */
  onStatus: (status: StatusKey) => void;
  /** The act a sub-group's heading carries: starting a cause's problems again, a project's start control. */
  subAct?: (status: StatusKey, sub: ProblemSub) => ReactNode;
}) {
  const rows = (list: ReadonlyArray<ProblemRow>) => list.map((r) => (
    <Row key={r.id} row={r} range={range} age={r.seenAt ? ageShort(now - r.seenAt) : ""} project={showProject ? projectName(r.projectId) : ""} href={href(r.id)} open={open} />
  ));
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
            </div>
          ))}
          {!s.folded && (s.subs ? s.subs.map((sub) => (
            <div key={sub.key} className="lwp-sub" data-line-problem-sub={sub.key} data-count={sub.rows.length}>
              <div className="lwp-sub-h" role="row">
                <b>{sub.label}</b>
                {sub.ready != null
                  ? <span className="lwp-sub-n"><span className="lw-num" data-ready>{sub.ready}</span> ready<i aria-hidden>·</i><span className="lw-num" data-blocked>{sub.blocked}</span> blocked</span>
                  : <span className="lw-num lwp-sub-n">{sub.rows.length}</span>}
                <span className="lwp-sub-act">{subAct?.(s.status!, sub)}</span>
              </div>
              {rows(sub.rows)}
            </div>
          )) : rows(s.rows))}
        </div>
      ))}
    </div>
  );
}

const Row = memo(function Row({ row: r, range, age, project, href, open }: { row: ProblemRow; range: OverviewRange; age: string; project: string; href: string; open: (id: string) => void }) {
  const trend = rowTrend(r);
  const under = [r.issue.ref, project, r.dupOf ? `same as ${r.dupOf}` : null].filter(Boolean).join(" · ");
  return (
    <a
      className="lwp-tr lwp-row"
      role="row"
      href={href}
      data-status={r.stand.status}
      data-line-issue={r.id}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        open(r.id);
      }}
    >
      <span className="lwp-c-title" role="gridcell">
        <span className="lwp-title">{problemTitle(r.issue.title)}</span>
        {under && <span className="lwp-under">{under}</span>}
      </span>
      <span className="lwp-c-find" role="gridcell" data-trend={trend ?? undefined} title={r.before == null ? `${r.findings} in all` : `${r.before} in the ${range} before, ${r.findings} in all`}>
        <span className="lw-num">{r.inWindow || (trend ? 0 : "")}</span>
        {trend === "up" && <ArrowUp aria-label="more than the window before" />}
        {trend === "down" && <ArrowDown aria-label="fewer than the window before" />}
      </span>
      <span className="lwp-c-status" role="gridcell" data-ready={r.stand.status === "notstarted" && r.stand.ready ? "" : undefined}>{r.stand.phrase}</span>
      <span className="lwp-c-last lw-num" role="gridcell" title={r.seenAt ? `Newest finding ${momentWords(r.seenAt)}` : undefined}>{age}</span>
    </a>
  );
});
