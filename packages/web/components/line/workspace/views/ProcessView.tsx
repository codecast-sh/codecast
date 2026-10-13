"use client";
// The Line page (line-journeys.md LJ8.5). Job: see whether the line is working
// and where it is not. Table (the default) lists every step in the line's
// order, under its phase, with the work sitting at it; each count opens that
// step's page on the same rows (stepTable reads stepWork's counts). The bar's
// figures are the columns' sums: on you (out of For you's whole count, and
// opening it), with someone else, running, failed. Under the bar, one pointer
// to Problems' Not started: what the line has not taken. The finders sit
// under it, a row each opening the finder's page. Map draws the same steps as
// the graph, for its shape.
import { memo, useMemo, type ReactNode } from "react";
import { LINE_MODES, LINE_MODE_LABELS, type LineMode } from "../../../../lib/line/lineWorkspaceUrl";
import { needSteps, stepTableFigures, type StepTableRow } from "../../../../lib/line/stepTable";
import { useStepTable } from "../step/useStepFacts";
import { STEP_SHOWS, showParam, type StepShow } from "../../../../lib/line/stepWork";
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

/** The Problems chip the summary row points at: problems no run has taken. */
const NOT_TAKEN = ["notstarted"] as const;

const COLS: Array<{ show: StepShow; label: string }> = [
  { show: "waiting", label: "Waiting" },
  { show: "failed", label: "Failed" },
  { show: "passed", label: "Passed" },
];

const StepsPage = memo(function StepsPage({ model, workspace: ws, selection, select, href, toggle }: LineViewProps & { toggle: ReactNode }) {
  const rows = useStepTable(model, ws);
  const fig = useMemo(() => stepTableFigures(rows), [rows]);
  const counts = useProblemCounts({ model, workspace: ws, selection });
  // For you's items no step of this line holds: asked before any run (a question, is this real, assigned), or on
  // another line. Named beside the steps' own, so the figures add up to For you's count.
  const away = useMemo(() => {
    const { elsewhere } = needSteps(ws.needs, model.runs);
    const lines = new Map<string, number>();
    let before = 0;
    for (const n of elsewhere) {
      if (n.process && n.process !== model.graphKey) lines.set(n.process, (lines.get(n.process) ?? 0) + 1);
      else before++;
    }
    return { before, lines: [...lines].map(([key, n]) => ({ key, n, title: ws.processes.find((p) => p.key === key)?.title ?? key })) };
  }, [ws.needs, ws.processes, model.runs, model.graphKey]);
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
          {/* For you's whole count, split by where each item waits: at a step here, before any run, on another line. */}
          {fig.onYou > 0 && <a className="lst-fact" data-tone="you" data-line-steps-onyou={fig.onYou} href={href({ view: "foryou", step: null, show: null })}><b className="lw-num">{fig.onYou}</b> waiting on you</a>}
          {away.before > 0 && <a className="lst-fact" data-tone="you" data-line-steps-before={away.before} href={href({ view: "foryou", step: null, show: null })}><b className="lw-num">{away.before}</b> asked before a run</a>}
          {away.lines.map((l) => <a key={l.key} className="lst-fact" data-tone="you" data-line-steps-away={l.key} href={href({ graph: l.key, step: null, show: null })}><b className="lw-num">{l.n}</b> on {l.title}</a>)}
          {fig.others > 0 && <span className="lst-fact" data-line-steps-others={fig.others}><b className="lw-num">{fig.others}</b> with someone else</span>}
          {fig.running > 0 && <span className="lst-fact" data-line-steps-running={fig.running}><i className="lw-dot" data-pulse="" style={{ color: "var(--lw-live)" }} aria-hidden /><b className="lw-num">{fig.running}</b> running</span>}
          {fig.failed > 0 && <span className="lst-fact" data-tone="bad" data-line-steps-failed={fig.failed}><b className="lw-num">{fig.failed}</b> failed</span>}
        </span>
        <div className="lst-bar-r">{toggle}</div>
      </header>
      {/* The problems the line has not taken: they open Problems' Not started, where each project's start control lives. */}
      <ProblemPointers keys={NOT_TAKEN} counts={counts} href={href} className="lst-pointers" label="Not on the line" />

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

/** What a Waiting cell says beside its number: whose move it is (on you, someone else holding a decision, running), each
 *  part counted when there is more than one. The whole cell is one link: the step's Waiting rows, the first one open,
 *  answer there what For you would (a decision, a finished step's go-on). */
function waitWords(r: StepTableRow): ReactNode {
  const parts = ([["you", r.onYou, "on you"], ["others", r.others, "someone else"], ["running", r.running, "running"]] as const).filter(([, n]) => n > 0);
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
