"use client";
// The Flows stage's activity rail (FlowsStage): what the live flows' runs just
// did, newest first. A run reads as where it stands (at a station, waiting on
// a person there, stalled there, failed, finished) with its problem and how
// long ago it moved. The filters narrow to what needs a look (on a person,
// stalled, failed) and show only when any run is in that state; the counts
// live on the flow list, read from the flow map. A row opens the run.
import { useMemo, useState } from "react";
import Link from "next/link";
import { STALLED_MS } from "@codecast/shared/contracts/flowMap";
import type { FlowRun } from "../../../../../hooks/useFlowLibrary";
import { ageShort } from "../../../../../lib/lineFlow";
import type { LineViewProps } from "../types";

/** The rows the rail draws before "Show more". */
const SHOWN = 40;

export type RunState = "live" | "you" | "stalled" | "failed" | "done";
const FILTERS: Array<{ key: ActivityFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "you", label: "On a person" },
  { key: "stalled", label: "Stalled" },
  { key: "failed", label: "Failed" },
];

/** Where a run stands now: a paused run waits on a person, a running one unchanged for STALLED_MS is stalled. */
function runState(r: FlowRun, now: number): RunState {
  if (r.status === "paused") return "you";
  if (r.status === "failed") return "failed";
  if (r.status === "completed") return "done";
  return now - r.updated_at >= STALLED_MS ? "stalled" : "live";
}

function runWords(r: FlowRun, st: RunState): string {
  const at = r.current_node_label ?? r.current_node_id ?? null;
  switch (st) {
    case "you": return at ? `Waits at ${at}` : "Waits on a person";
    case "stalled": return at ? `Stalled at ${at}` : "Stalled";
    case "failed": return at ? `Failed at ${at}` : "Failed";
    // A run that reached an end node reads as finished; one that stopped mid-flow names where.
    case "done": return at && !/^(exit|end|done|finish(ed)?)$/i.test(at) ? `Ended at ${at}` : "Finished";
    default: return r.status === "pending" ? "Starting" : at ? `At ${at}` : "Running";
  }
}

export type ActivityFilter = RunState | "all";

/** `filter`/`onFilter`: which runs it lists, held by the stage so the head's stalled count can narrow it. */
export function FlowActivity({ runs, flowLabel, now, href, filter, onFilter: setFilter }: { runs: FlowRun[]; flowLabel: (r: FlowRun) => string | null; now: number; href: LineViewProps["href"]; filter: ActivityFilter; onFilter: (f: ActivityFilter) => void }) {
  const [more, setMore] = useState(false);
  const rows = useMemo(() => runs.map((r) => ({ r, st: runState(r, now) })).sort((a, b) => b.r.updated_at - a.r.updated_at), [runs, now]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const x of rows) c[x.st] = (c[x.st] ?? 0) + 1;
    return c;
  }, [rows]);
  const shownFilters = FILTERS.filter((f) => f.key === "all" || counts[f.key]);
  const picked = filter !== "all" && !counts[filter] ? "all" : filter;
  const list = picked === "all" ? rows : rows.filter((x) => x.st === picked);
  const shown = more ? list : list.slice(0, SHOWN);
  return (
    <aside className="fs-rail" aria-label="Activity" data-flow-activity={rows.length}>
      <h2 className="fs-col-h">Activity</h2>
      {shownFilters.length > 1 ? (
        <div className="fs-rail-f" role="tablist" aria-label="Show">
          {shownFilters.map((f) => (
            <button key={f.key} type="button" role="tab" aria-selected={picked === f.key} data-tone={f.key} onClick={() => setFilter(f.key)} data-flow-activity-filter={f.key}>
              {f.label}
            </button>
          ))}
        </div>
      ) : null}
      {list.length === 0 ? <p className="fs-none">No runs yet</p> : (
        <ol className="fs-acts">
          {shown.map(({ r, st }) => {
            const flow = flowLabel(r);
            return (
              <li key={r._id}>
                <Link className="fs-act" href={href({ view: "problems", run: r._id, case: r.task_short_id ?? r.task_id ?? null })} data-state={st} data-flow-activity-run={r._id}>
                  <i className="fs-act-dot" data-state={st} aria-hidden />
                  <span className="fs-act-what">{runWords(r, st)}</span>
                  <span className="fs-act-age lw-num">{ageShort(Math.max(0, now - r.updated_at))}</span>
                  <span className="fs-act-task">
                    {r.task_short_id ? <span className="fs-act-ref">{r.task_short_id}</span> : null}
                    {r.task_title ?? (r.task_short_id ? "" : "no task")}
                  </span>
                  {flow ? <span className="fs-act-flow">{flow}</span> : null}
                </Link>
              </li>
            );
          })}
        </ol>
      )}
      {list.length > SHOWN ? <button type="button" className="fs-more" onClick={() => setMore(!more)}>{more ? "Show fewer" : `Show all ${list.length}`}</button> : null}
    </aside>
  );
}
