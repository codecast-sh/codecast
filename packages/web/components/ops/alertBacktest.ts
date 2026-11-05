// What an alert rule would have done over values already held: the
// monitor's own state machine (nextMonitorState, the one the poll runs)
// replayed read by read, so a line or a reads-in-a-row count being typed
// shows the alerts it would have raised before it is saved.
import { nextMonitorState, type MonitorDirection } from "@codecast/shared/contracts/metricMonitor";
import type { Pt } from "./metricModel";

export type AlertRuleDraft = { threshold: number; direction: MonitorDirection; eval_reads?: number };
/** One replayed alert: from the read that flipped it to the read that cleared it; `open` when it still runs at the last read. */
export type ReplayedAlert = { from: number; to: number; open: boolean };
export type Backtest = { alerts: ReplayedAlert[]; total: number };

export function backtest(points: readonly Pt[], rule: AlertRuleDraft, until: number): Backtest {
  const pts = [...points].sort((a, b) => a.at - b.at);
  const k = Math.max(1, rule.eval_reads ?? 1);
  const alerts: ReplayedAlert[] = [];
  let state: "ok" | "alert" = "ok";
  let from = 0;
  for (let i = 0; i < pts.length; i++) {
    const next = nextMonitorState(state, pts.slice(Math.max(0, i + 1 - k), i + 1).map((p) => p.value), rule);
    if (next === "alert" && state === "ok") from = pts[i].at;
    if (next === "ok" && state === "alert") alerts.push({ from, to: pts[i].at, open: false });
    state = next;
  }
  if (state === "alert") alerts.push({ from, to: Math.max(from, until), open: true });
  return { alerts, total: alerts.reduce((s, a) => s + (a.to - a.from), 0) };
}
