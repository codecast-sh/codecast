"use client";
// The Line page (line-journeys.md LJ8.5). Job: see whether the line is working
// and where it is not. Table (the default) lists every step with the work
// sitting at it, the step that fails most first; each count opens that step's
// page on the same rows (stepTable reads stepWork's counts). The finders sit
// under it, a row each opening the finder's page. Map draws the same steps as
// the graph, for its shape.
import { memo, useMemo, type ReactNode } from "react";
import { LINE_MODES, LINE_MODE_LABELS, type LineMode } from "../../../../lib/line/lineWorkspaceUrl";
import { runFactsByStep, stepTable, type StepTableRow } from "../../../../lib/line/stepTable";
import { STEP_SHOWS, type StepShow } from "../../../../lib/line/stepWork";
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
  const running = useMemo(() => model.runs.filter((r) => r.live && !r.superseded).length, [model.runs]);
  const open = (id: string, show: StepShow | null) => select({ step: id, show, tab: null });

  return (
    <div className="lst" data-line-steps={rows.length}>
      <header className="lst-bar">
        <h2 className="lst-h">Steps</h2>
        {running > 0 && <span className="lst-fact" data-line-steps-running={running}><i className="lw-dot" data-pulse="" style={{ color: "var(--lw-live)" }} aria-hidden /><b className="lw-num">{running}</b> running</span>}
        <div className="lst-bar-r">{toggle}</div>
      </header>

      {rows.length ? (
        <table className="lst-table">
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">Phase</th>
              {COLS.map((c) => <th key={c.show} scope="col" className="lst-n" data-col={c.show}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => <StepRow key={r.id} r={r} href={href} open={open} />)}
          </tbody>
        </table>
      ) : (
        <div className="lw-empty"><b>No steps yet</b></div>
      )}

      <FindTable workspace={ws} select={select} href={href} heading={<h2 className="lst-h lst-sub">Finders</h2>} />
    </div>
  );
});

function StepRow({ r, href, open }: { r: StepTableRow; href: LineViewProps["href"]; open: (id: string, show: StepShow | null) => void }) {
  const link = (show: StepShow | null, children: ReactNode, className: string) => (
    <a className={className} href={href({ step: r.id, show, tab: null })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); e.stopPropagation(); open(r.id, show); }}>{children}</a>
  );
  return (
    <tr data-line-step-row={r.id} data-kind={r.kind} data-failing={r.counts.failed ? "" : undefined} onClick={(e) => { if (!(e.target as Element).closest("a")) open(r.id, null); }}>
      <th scope="row">
        {link(null, <><i className="lst-mark" data-kind={r.kind} aria-hidden />{r.label}</>, "lst-name")}
      </th>
      <td className="lst-phase">{r.phase}</td>
      {STEP_SHOWS.map((k) => {
        const n = r.counts[k];
        return (
          <td key={k} className="lst-n" data-col={k} data-zero={n ? undefined : ""}>
            {n ? link(k, <><b className="lw-num">{n}</b>{k === "failed" && r.topCause && <span className="lst-cause">{r.topCause}</span>}</>, "lst-count") : <span className="lst-none">–</span>}
          </td>
        );
      })}
    </tr>
  );
}
