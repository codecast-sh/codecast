"use client";
// The figures that open Problems (line-journeys.md LJ8.2): findings in the
// window against the window before, and the fixes in production with how many
// have been quiet since. Each figure that names problems is a link onto
// exactly those rows: "158% more" lists the problems found more, "3 fixes in
// production" and "2 of 3 quiet since" press their filters. A fact with
// nothing behind it to open (no fixes yet, fewer findings) is plain text or
// not drawn; the groups a chip already counts are not counted twice up here.
import type { MouseEvent, ReactNode } from "react";
import { changeWords, type OverviewRange, type ProblemFigures as Figures } from "../../../../../lib/line/problemsOverview";
import type { LineSelectionPatch } from "../../../../../lib/line/lineWorkspaceUrl";

const SHIPPED: LineSelectionPatch = { view: "problems", case: null, run: null, status: "shipped", quiet: null, found: null };
const QUIET: LineSelectionPatch = { ...SHIPPED, quiet: "1" };
const MORE: LineSelectionPatch = { view: "problems", case: null, run: null, found: "more" };
export type FigureKey = "shipped" | "quiet" | "more";

export function ProblemFigures({ figures: f, range, href, select, on }: {
  figures: Figures;
  range: OverviewRange;
  href: (patch: LineSelectionPatch) => string;
  select: (patch: LineSelectionPatch) => void;
  /** The narrowing a figure set, so it reads as pressed; pressing it again lifts it. */
  on?: FigureKey | null;
}) {
  const change = changeWords(f, range);
  const off = (patch: LineSelectionPatch): LineSelectionPatch => (patch.found ? { ...patch, found: null } : { ...patch, status: null, quiet: null });
  const link = (patch: LineSelectionPatch, key: FigureKey, cls: string, body: ReactNode, tone?: string) => (
    <a className={cls} data-tone={tone} href={href(on === key ? off(patch) : patch)} aria-current={on === key ? "true" : undefined} data-line-figure={key}
      onClick={(e: MouseEvent) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); select(on === key ? off(patch) : patch); }}>{body}</a>
  );
  // More findings than the window before: the words open the problems that grew. Fewer or the same opens nothing.
  const changeEl = change && (change.tone === "worse" && f.findings > 0
    ? link(MORE, "more", "lwf-more", change.words, change.tone)
    : <span className="lwf-more" data-tone={change.tone}>{change.words}</span>);
  return (
    <div className="lwf" data-line-figures="">
      {f.findings > 0 ? (
        <div className="lwf-fig" data-line-figure="findings" data-tone={change?.tone}>
          <b className="lw-num">{f.findings}</b>
          <span className="lwf-l">{f.findings === 1 ? "finding" : "findings"} in {range}</span>
          {changeEl}
        </div>
      ) : (
        <div className="lwf-fig lwf-none" data-line-figure="findings" data-none="">
          <span className="lwf-l">No findings in {range}</span>
          {changeEl}
        </div>
      )}
      {f.inProduction > 0 && (
        <div className="lwf-fig">
          {link(SHIPPED, "shipped", "lwf-main", <><b className="lw-num">{f.inProduction}</b><span className="lwf-l">{f.inProduction === 1 ? "fix" : "fixes"} in production</span></>)}
        </div>
      )}
      {f.inProduction > 0 && (
        <div className="lwf-fig">
          {link(QUIET, "quiet", "lwf-main", <><b className="lw-num">{f.quiet}<small> of {f.inProduction}</small></b><span className="lwf-l">quiet since the fix</span></>)}
        </div>
      )}
    </div>
  );
}
