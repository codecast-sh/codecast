"use client";
// Problems (line-journeys.md LJ8.2 and LJ8.3): the list of what is wrong with
// the product (ProblemsHome), or the one problem the address names (`case`),
// which takes the page. The list's filter, sort and window stay in the
// address while a problem is open, so its prev and next walk the list the
// person came from and Back returns to it.
import { ProblemsHome } from "./timeline/ProblemsHome";
import { useProblemList } from "./timeline/useProblemList";
import { ProblemPage } from "./problem/ProblemPage";
import type { LineViewProps } from "./types";
import "./timeline/problems.css";
import "./timeline/overview.css";

export function ProblemsView(props: LineViewProps) {
  const { model, workspace, selection, select, href, drawerOpen } = props;
  const list = useProblemList(model, workspace, selection);

  if (!workspace.problems.length) return <div className="lw-empty" data-line-problems="empty"><b>No problems</b></div>;

  return (
    <div className="lwp-host" data-line-problems={list.all.length}>
      <div className="lwp" data-open={selection.case ? "" : undefined}>
        {selection.case ? (
          <div className="lwp-detail">
            <ProblemPage {...props} order={list.order} />
          </div>
        ) : (
          <ProblemsHome list={list} workspace={workspace} selection={selection} select={select} href={href} drawerOpen={drawerOpen} />
        )}
      </div>
    </div>
  );
}
