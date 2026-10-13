"use client";
// The three figures that open Problems (line-journeys.md LJ8.2) and fill For
// you's reader when nothing waits: findings in the window against the window
// before, fixes in production, and how many of those have been quiet since.
// Each count is a link onto exactly the rows it counts. A window with no
// findings says so in one line, and fixes show only when there are some: a
// row of zeros and "100% fewer" over nothing reads as noise.
import type { MouseEvent, ReactNode } from "react";
import { changeWords, type OverviewRange, type ProblemFigures as Figures } from "../../../../../lib/line/problemsOverview";
import type { LineSelectionPatch } from "../../../../../lib/line/lineWorkspaceUrl";

const SHIPPED: LineSelectionPatch = { view: "problems", case: null, run: null, status: "shipped", quiet: null };
const QUIET: LineSelectionPatch = { ...SHIPPED, quiet: "1" };
const MERGED: LineSelectionPatch = { view: "problems", case: null, run: null, status: "merged", quiet: null };

export function ProblemFigures({ figures: f, range, href, select, on }: {
  figures: Figures;
  range: OverviewRange;
  href: (patch: LineSelectionPatch) => string;
  select: (patch: LineSelectionPatch) => void;
  /** The filter a figure set, so it reads as pressed: "shipped", "quiet" or "merged". */
  on?: "shipped" | "quiet" | "merged" | null;
}) {
  const change = changeWords(f, range);
  const link = (n: number, patch: LineSelectionPatch, key: "shipped" | "quiet" | "merged", cls: string, body: ReactNode) => n > 0 ? (
    <a className={cls} href={href(patch)} aria-current={on === key ? "true" : undefined} data-line-figure={key}
      onClick={(e: MouseEvent) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); select(on === key ? { ...patch, status: null, quiet: null } : patch); }}>{body}</a>
  ) : <span className={cls} data-line-figure={key}>{body}</span>;
  const merged = f.merged > 0 && link(f.merged, MERGED, "merged", "lwf-more", <><span className="lw-num">{f.merged}</span> {f.merged === 1 ? "fix" : "fixes"} not in production</>);
  return (
    <div className="lwf" data-line-figures="">
      {f.findings > 0 ? (
        <div className="lwf-fig" data-line-figure="findings">
          <b className="lw-num">{f.findings}</b>
          <span className="lwf-l">{f.findings === 1 ? "finding" : "findings"} in {range}</span>
          {change && <span className="lwf-more" data-tone={change.tone}>{change.words}</span>}
        </div>
      ) : (
        <div className="lwf-fig lwf-none" data-line-figure="findings" data-none="">
          <span className="lwf-l">No findings in {range}</span>
          {change && <span className="lwf-more">{change.words}</span>}
        </div>
      )}
      {(f.inProduction > 0 || f.merged > 0) && (
        <div className="lwf-fig">
          {link(f.inProduction, SHIPPED, "shipped", "lwf-main", <><b className="lw-num">{f.inProduction}</b><span className="lwf-l">{f.inProduction === 1 ? "fix" : "fixes"} in production</span></>)}
          {f.inProduction === 0 && merged}
        </div>
      )}
      {f.inProduction > 0 && (
        <div className="lwf-fig">
          {link(f.quiet, QUIET, "quiet", "lwf-main", <><b className="lw-num">{f.quiet}<small> of {f.inProduction}</small></b><span className="lwf-l">quiet since the fix</span></>)}
          {merged}
        </div>
      )}
    </div>
  );
}
