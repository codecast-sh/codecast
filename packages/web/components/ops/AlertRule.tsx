// The watch's alert as one sentence under its chart: the side, the line,
// how many reads in a row and the warning level, each an inline field. An
// edit is a draft until Save (Enter saves, Escape drops it): the chart draws
// the drafted line, and the strip under the sentence replays the monitor
// over the chart's values with the draft, beside what the saved rule did.
import { useState } from "react";
import { monitorProblem, type MonitorDirection } from "@codecast/shared/contracts/metricMonitor";
import { useInboxStore } from "../../store/inboxStore";
import { backtest, type Backtest } from "./alertRule";
import { EVAL_READS, parseThreshold } from "./metricEditing";
import { durationShort, spanLabel, stampLabel, type Pt, type Win } from "./metricModel";
import type { OpsWatch } from "./opsTypes";
import "./alertRule.css";

export function AlertRule({ watch, history, win, within, now, onDraft }: {
  watch: OpsWatch;
  /** The values the chart shows, replayed by the strip. */
  history: readonly Pt[];
  win: Win;
  /** The window as a sentence names it: "in 30d". */
  within: string;
  now: number;
  onDraft: (line: number | undefined) => void;
}) {
  const update = useInboxStore((s) => s.updateOpsWatch);
  const [dir, setDir] = useState<MonitorDirection | null>(null);
  const [lineText, setLineText] = useState<string | null>(null);
  const [reads, setReads] = useState<number | null>(null);
  const [warnText, setWarnText] = useState<string | null>(null);

  const savedReads = watch.eval_reads ?? 1;
  const d = dir ?? watch.direction;
  const lineShown = lineText ?? (watch.threshold === undefined ? "" : String(watch.threshold));
  const line = parseThreshold(lineShown);
  const r = reads ?? savedReads;
  const warnShown = warnText ?? (watch.warn === undefined ? "" : String(watch.warn));
  const warn = parseThreshold(warnShown);

  const changed = {
    direction: d !== watch.direction,
    threshold: line !== null && (line ?? null) !== (watch.threshold ?? null),
    eval_reads: r !== savedReads,
    warn: warn !== null && (warn ?? null) !== (watch.warn ?? null),
  };
  const dirty = Object.values(changed).some(Boolean);
  const problem = line === null ? "The line is not a number"
    : warn === null ? "The warning level is not a number"
    : typeof line === "number" ? monitorProblem({ threshold: line, direction: d, eval_reads: r, warn: warn ?? undefined }) : null;

  const typeLine = (t: string) => {
    setLineText(t);
    const v = parseThreshold(t);
    onDraft(v === null ? undefined : v);
  };
  const discard = () => { setDir(null); setLineText(null); setReads(null); setWarnText(null); onDraft(undefined); };
  const save = () => {
    if (!dirty || problem) return;
    update(watch._id, {
      ...(changed.direction ? { direction: d } : {}),
      ...(changed.threshold ? { threshold: line ?? null } : {}),
      ...(changed.eval_reads ? { eval_reads: r } : {}),
      ...(changed.warn || (line === undefined && watch.warn !== undefined) ? { warn: line === undefined ? null : warn ?? null } : {}),
    });
    discard();
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    if (e.key === "Escape") discard();
  };

  const draft = typeof line === "number" ? backtest(history, { threshold: line, direction: d, eval_reads: r }, now) : null;
  const saved = dirty && watch.threshold !== undefined ? backtest(history, { threshold: watch.threshold, direction: watch.direction, eval_reads: savedReads }, now) : null;

  return (
    <section className="mxr" aria-label="Alert rule" data-alert-rule data-dirty={dirty ? "" : undefined}>
      <p className="mxr-say">
        Alert when it goes{" "}
        <select className="mxr-f" value={d} aria-label="Alerting side" onChange={(e) => setDir(e.target.value as MonitorDirection)} onKeyDown={keys} data-watch-direction>
          <option value="above">above</option>
          <option value="below">below</option>
        </select>{" "}
        <input
          id="mx-line"
          className="mxr-f mxr-num"
          inputMode="decimal"
          placeholder="a line"
          aria-label="Alert line"
          aria-invalid={line === null}
          value={lineShown}
          onChange={(e) => typeLine(e.target.value)}
          onKeyDown={keys}
          data-watch-threshold
        />
        {watch.unit && <span className="mxr-unit">{watch.unit}</span>}
        {typeof line === "number" && (
          <>
            {" "}for{" "}
            <select className="mxr-f" value={r} aria-label="Reads in a row" onChange={(e) => setReads(Number(e.target.value))} onKeyDown={keys} data-watch-eval>
              {EVAL_READS.map((n) => <option key={n} value={n}>{n === 1 ? "1 read" : `${n} reads in a row`}</option>)}
            </select>
            {r > 1 && <span className="mxr-dim"> ({spanLabel(r * watch.interval_ms)})</span>}
            , warn at{" "}
            <input
              className="mxr-f mxr-num"
              inputMode="decimal"
              placeholder="none"
              aria-label="Warning level"
              aria-invalid={warn === null}
              value={warnShown}
              onChange={(e) => setWarnText(e.target.value)}
              onKeyDown={keys}
              data-watch-warn
            />
          </>
        )}
      </p>

      {draft && <Replay test={draft} saved={saved} win={win} within={within} />}

      {dirty && (
        <div className="mxr-foot" data-watch-draft>
          {problem ? <span className="mxr-problem">{problem}</span> : line === undefined ? <span className="mxr-dim">No line: the watch keeps reading, and never alerts</span> : null}
          <span className="flex-1" />
          <button type="button" className="ops-btn" onClick={discard}>Discard</button>
          <button type="button" className="ops-btn" data-tone="primary" disabled={!!problem} onClick={save} data-watch-draft-save>Save</button>
        </div>
      )}
    </section>
  );
}

/** The replayed alerts as marks across the chart's window, their count and time past the line, and the saved rule's beside a draft's. */
function Replay({ test, saved, win, within }: { test: Backtest; saved: Backtest | null; win: Win; within: string }) {
  const span = Math.max(1, win.to - win.from);
  const n = test.alerts.length;
  return (
    <div className="mxr-test" data-backtest={n}>
      <div className="mxr-strip" role="img" aria-label={`${n} alerts ${within}`}>
        {test.alerts.filter((a) => a.to >= win.from && a.from <= win.to).map((a) => {
          const from = Math.max(a.from, win.from);
          return (
            <i
              key={a.from}
              data-open={a.open ? "" : undefined}
              style={{ left: `${((from - win.from) / span) * 100}%`, width: `${((Math.min(a.to, win.to) - from) / span) * 100}%` }}
              title={`${stampLabel(a.from)}, ${durationShort(a.to - a.from)}${a.open ? ", still running" : ""}`}
            />
          );
        })}
      </div>
      <span className="mxr-count">
        <b>{n || "No"}</b> {n === 1 ? "alert" : "alerts"} {within}
        {test.total > 0 && <>, <b>{durationShort(test.total)}</b> past the line</>}
        {saved && (saved.alerts.length !== n || saved.total !== test.total) && (
          <s className="mxr-was" data-backtest-saved={saved.alerts.length}>now {saved.alerts.length}{saved.total > 0 ? `, ${durationShort(saved.total)}` : ""}</s>
        )}
      </span>
    </div>
  );
}
