"use client";
// The Line page (line-journeys.md LJ8.5). Job: see whether the line is working
// and where it is not. Table (the default) lists every step in the line's
// order, under its phase, with the work sitting at it; each count opens that
// step's page on the same rows (stepTable reads stepWork's counts). The bar's
// figures are the columns' sums: on you, running, failed. The finders sit
// under it, a row each opening the finder's page. Map draws the same steps as
// the graph, for its shape.
import { memo, useMemo, type ReactNode } from "react";
import { LINE_MODES, LINE_MODE_LABELS, type LineMode } from "../../../../lib/line/lineWorkspaceUrl";
import { runFactsByStep, stepTable, stepTableFigures, type StepTableRow } from "../../../../lib/line/stepTable";
import { STEP_SHOWS, showParam, type StepShow } from "../../../../lib/line/stepWork";
import { GraphView } from "./GraphView";
import { FindTable } from "./finder/FindTable";
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

const COLS: Array<{ show: StepShow; label: string }> = [
  { show: "waiting", label: "Waiting" },
  { show: "failed", label: "Failed" },
  { show: "passed", label: "Passed" },
];

const StepsPage = memo(function StepsPage({ model, workspace: ws, select, href, toggle }: LineViewProps & { toggle: ReactNode }) {
  const facts = useMemo(() => runFactsByStep(ws.rows.runs as unknown as Parameters<typeof runFactsByStep>[0]), [ws.rows.runs]);
  const rows = useMemo(() => stepTable(model, facts), [model, facts]);
  const fig = useMemo(() => stepTableFigures(rows), [rows]);
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
          {fig.onYou > 0 && <span className="lst-fact" data-tone="you" data-line-steps-onyou={fig.onYou}><b className="lw-num">{fig.onYou}</b> waiting on you</span>}
          {fig.running > 0 && <span className="lst-fact" data-line-steps-running={fig.running}><i className="lw-dot" data-pulse="" style={{ color: "var(--lw-live)" }} aria-hidden /><b className="lw-num">{fig.running}</b> running</span>}
          {fig.failed > 0 && <span className="lst-fact" data-tone="bad" data-line-steps-failed={fig.failed}><b className="lw-num">{fig.failed}</b> failed</span>}
        </span>
        <div className="lst-bar-r">{toggle}</div>
      </header>

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

/** What a Waiting cell says beside its number: whose move it is. */
function waitWords(r: StepTableRow): ReactNode {
  if (r.onYou && r.running) return <span className="lst-cause"><b className="lw-num">{r.onYou}</b> on you · <b className="lw-num">{r.running}</b> running</span>;
  return <span className="lst-cause">{r.onYou ? "on you" : "running"}</span>;
}

function StepRow({ r, href, open }: { r: StepTableRow; href: LineViewProps["href"]; open: (id: string, show: StepShow | null) => void }) {
  const link = (show: StepShow | null, children: ReactNode, className: string) => (
    <a className={className} href={href({ step: r.id, show: show && showParam(r.kind, show), tab: null })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); e.stopPropagation(); open(r.id, show); }}>{children}</a>
  );
  // A person's step has no failures: its unanswered decisions say so in the step page's own words, never in red.
  const person = r.kind === "person";
  return (
    <tr data-line-step-row={r.id} data-kind={r.kind} data-failing={r.counts.failed && !person ? "" : undefined} onClick={(e) => { if (!(e.target as Element).closest("a")) open(r.id, null); }}>
      <th scope="row">
        {link(null, <><i className="lst-mark" data-kind={r.kind} aria-hidden />{r.label}</>, "lst-name")}
      </th>
      {STEP_SHOWS.map((k) => {
        const n = r.counts[k];
        const side = k === "waiting" ? waitWords(r) : k === "failed" ? (person ? <span className="lst-cause">No answer</span> : r.topCause && <span className="lst-cause" title={r.topCause}>{r.topCause}</span>) : null;
        return (
          <td key={k} className="lst-n" data-col={k} data-zero={n ? undefined : ""} data-tone={k === "waiting" ? (r.onYou ? "you" : "live") : k === "failed" && person ? "none" : undefined}>
            {n ? link(k, <><b className="lw-num">{n}</b>{side}</>, "lst-count") : <span className="lst-none">–</span>}
          </td>
        );
      })}
    </tr>
  );
}
