"use client";
// The Line page (line-journeys.md LJ8.5). Job: see whether the line is working
// and where it is not. Table (the default) lists every step in the line's
// order, under its phase, with the work sitting at it; each count opens that
// step's page on the same rows (stepTable reads stepWork's counts). The bar
// says what waits on the viewer as For you's one count (opening it), then the
// columns' sums that are not the viewer's: with someone else, running, and
// step failures (failed visits of this line's steps, not Problems' Failed,
// which counts problems). Under the bar, one pointer
// to Problems' Not started: what the line has not taken. The finders sit
// under it, a row each opening the finder's page. Map draws the same steps as
// the graph, for its shape.
import { memo, useMemo, type ReactNode } from "react";
import { LINE_MODES, LINE_MODE_LABELS, type LineMode } from "../../../../lib/line/lineWorkspaceUrl";
import { stepTableFigures, type StepTableRow } from "../../../../lib/line/stepTable";
import { useStepTable } from "../step/useStepFacts";
import { STEP_SHOWS, showParam, type StepShow } from "../../../../lib/line/stepWork";
import { needCount, needsOfLine } from "../../../../lib/line/lineNeeds";
import { GraphView } from "./GraphView";
import { FindTable } from "./finder/FindTable";
import { ProblemPointers, useProblemCounts } from "./ProblemPointers";
import type { LineViewProps } from "./types";
import "./steps.css";

/** Table or Map: the page's one switch, in the same place in both modes. */
function ModeSwitch({ mode, select }: { mode: LineMode; select: LineViewProps["select"] }) {
  return (
    <div className="lw-seg" role="tablist" aria-label="Show the steps as">
      {LINE_MODES.map((m) => (
        <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => select({ mode: m }, undefined, { replace: true })} data-line-mode={m}>{LINE_MODE_LABELS[m]}</button>
      ))}
    </div>
  );
}

export function ProcessView(props: LineViewProps) {
  const { selection, select } = props;
  const mode = selection.mode;
  const toggle = <ModeSwitch mode={mode} select={select} />;
  if (mode === "map") return <GraphView {...props} lead={toggle} />;
  return <StepsPage {...props} toggle={toggle} />;
}

/** The Problems chips the summary row points at: the line's own queue, problems a new run must ask again and problems
 *  no run has taken. */
const NOT_TAKEN = ["newask", "notstarted"] as const;

const COLS: Array<{ show: StepShow; label: string }> = [
  { show: "waiting", label: "Waiting" },
  { show: "failed", label: "Failed" },
  { show: "passed", label: "Passed" },
];

const StepsPage = memo(function StepsPage({ model, workspace: ws, selection, select, href, toggle }: LineViewProps & { toggle: ReactNode }) {
  const rows = useStepTable(model, ws);
  const fig = useMemo(() => stepTableFigures(rows), [rows]);
  // Every figure above the table is this line's (its project's, when one is picked), as the table's are: what waits on
  // the viewer here opens For you narrowed to this line, Not started opens Problems' chip narrowed the same way.
  const line = model.graphKey;
  const counts = useProblemCounts({ model, workspace: ws, selection, process: line });
  const onYou = useMemo(() => needCount(needsOfLine(ws.needs, line, ws.project?._id ?? null)), [ws.needs, line, ws.project]);
  // One body per phase, in the line's order: the table reads as the line runs.
  const phases = useMemo(() => {
    const out: Array<{ key: string; label: string; rows: StepTableRow[] }> = [];
    for (const r of rows) {
      const key = r.stage ?? "other";
      const last = out[out.length - 1];
      if (last?.key === key) last.rows.push(r);
      else out.push({ key, label: r.phase || "Other", rows: [r] });
    }
    return out;
  }, [rows]);
  const open = (id: string, show: StepShow | null) => select({ step: id, show: show && showParam(model.steps[id]?.kind ?? "agent", show), tab: null });

  return (
    <div className="lst" data-line-steps={rows.length}>
      <header className="lst-bar">
        <h2 className="lst-h">Steps</h2>
        <span className="lst-facts">
          {/* What waits on the viewer in this line, whichever step (or none) holds it: it opens For you on exactly those. */}
          {onYou > 0 && <a className="lst-fact" data-tone="you" data-line-steps-onyou={onYou} href={href({ view: "foryou", process: line, step: null, show: null })}><b className="lw-num">{onYou}</b> waiting on you</a>}
          {fig.others > 0 && <span className="lst-fact" data-line-steps-others={fig.others}><b className="lw-num">{fig.others}</b> with someone else</span>}
          {fig.running > 0 && <span className="lst-fact" data-line-steps-running={fig.running}><i className="lw-dot" data-pulse="" style={{ color: "var(--lw-live)" }} aria-hidden /><b className="lw-num">{fig.running}</b> running</span>}
          {fig.failed > 0 && <span className="lst-fact" data-tone="bad" data-line-steps-failed={fig.failed}><b className="lw-num">{fig.failed}</b> step {fig.failed === 1 ? "failure" : "failures"}</span>}
        </span>
        <div className="lst-bar-r">{toggle}</div>
      </header>
      {/* The line's queue: they open Problems' chips, where each row's act and each project's start control live. */}
      <ProblemPointers keys={NOT_TAKEN} counts={counts} href={href} process={line} className="lst-pointers" label="The line's queue" />

      {rows.length ? (
        <table className="lst-table">
          <colgroup><col data-c="step" /><col data-c="wait" /><col /><col data-c="n" /></colgroup>
          <thead>
            <tr>
              <th scope="col">Step</th>
              {COLS.map((c) => <th key={c.show} scope="col" className="lst-n" data-col={c.show}>{c.label}</th>)}
            </tr>
          </thead>
          {phases.map((p) => (
            <tbody key={p.key} data-line-steps-phase={p.key}>
              <tr className="lst-phase-row"><th scope="rowgroup" colSpan={1 + COLS.length}>{p.label}</th></tr>
              {p.rows.map((r) => <StepRow key={r.id} r={r} href={href} open={open} />)}
            </tbody>
          ))}
        </table>
      ) : (
        <div className="lw-empty"><b>No steps yet</b></div>
      )}

      <FindTable workspace={ws} select={select} href={href} heading={<h2 className="lst-h lst-sub">Finders</h2>} />
    </div>
  );
});

/** What a Waiting cell says beside its number: whose move it is (to close, on you, someone else holding a decision, running), each
 *  part counted when there is more than one. The whole cell is one link: the step's Waiting rows, the first one open,
 *  answer there what For you would (a decision, a finished step's go-on). */
function waitWords(r: StepTableRow): ReactNode {
  // A fix main already carries waits on a close, not a go-on: said as what it asks.
  const parts = ([["close", r.toClose, "to close"], ["you", r.onYou - r.toClose, "on you"], ["others", r.others, "someone else"], ["running", r.running, "running"]] as const).filter(([, n]) => n > 0);
  const one = parts.length === 1;
  return (
    <span className="lst-cause">
      {parts.map(([k, n, w], i) => {
        const words = one ? w : <><b className="lw-num">{n}</b> {w}</>;
        return <span key={k}>{i > 0 && " · "}{words}</span>;
      })}
    </span>
  );
}

function StepRow({ r, href, open }: { r: StepTableRow; href: LineViewProps["href"]; open: (id: string, show: StepShow | null) => void }) {
  const link = (show: StepShow | null, children: ReactNode, className: string) => (
    <a className={className} href={href({ step: r.id, show: show && showParam(r.kind, show), tab: null })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); e.stopPropagation(); open(r.id, show); }}>{children}</a>
  );
  // A person's step has no failures: its unanswered decisions say so in the step page's own words, never in red.
  const person = r.kind === "person";
  return (
    <tr data-line-step-row={r.id} data-kind={r.kind} data-failing={r.counts.failed && !person ? "" : undefined} onClick={(e) => {
      // A press beside a link is the link's: a counted cell opens its rows, anywhere else the step.
      const t = e.target as Element;
      if (t.closest("a")) return;
      const col = t.closest<HTMLElement>("td[data-col]:not([data-zero])")?.dataset.col as StepShow | undefined;
      open(r.id, col ?? null);
    }}>
      <th scope="row">
        {link(null, <><i className="lst-mark" data-kind={r.kind} aria-hidden />{r.label}</>, "lst-name")}
      </th>
      {STEP_SHOWS.map((k) => {
        const n = r.counts[k];
        const side = k === "waiting" ? waitWords(r) : k === "failed" ? (person ? <span className="lst-cause">No answer</span> : r.topCause && <span className="lst-cause" data-thin={r.topThin ? "" : undefined} title={r.topCause}>{r.topCause}</span>) : null;
        return (
          <td key={k} className="lst-n" data-col={k} data-zero={n ? undefined : ""} data-tone={k === "waiting" ? (r.onYou ? "you" : r.others ? "none" : "live") : k === "failed" && person ? "none" : undefined}>
            {!n ? <span className="lst-none">–</span> : link(k, <><b className="lw-num">{n}</b>{side}</>, "lst-count")}
          </td>
        );
      })}
    </tr>
  );
}
