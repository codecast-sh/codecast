// The numbers `cast plan eval` sets side by side to compare plans run under
// different messaging policies (convex/planLog.ts `telemetry`). Run the same
// work as two plans, one per policy, then `cast plan eval <a> --compare <b>`.

import { formatCount } from "@codecast/shared/contracts/weeklyCard";

export type PlanTelemetry = {
  plan: string;
  policy: string;
  tasks: number;
  done: number;
  blocked: number;
  retries: number;
  finished: boolean;
  wall_minutes: number | null;
  task_minutes: number;
  entries: Record<string, number>;
  sessions: number;
  uncounted: number;
  tokens: number;
  list_usd: number;
};

const COLUMNS: Array<[string, (t: PlanTelemetry) => string]> = [
  ["plan", (t) => t.plan],
  ["policy", (t) => t.policy],
  ["done", (t) => `${t.done}/${t.tasks}`],
  // "+": tasks are still open, so the clock is still running.
  ["wall", (t) => (t.wall_minutes == null ? "-" : `${t.wall_minutes}m${t.finished ? "" : "+"}`)],
  ["task time", (t) => `${t.task_minutes}m`],
  ["tokens", (t) => formatCount(t.tokens)],
  ["list $", (t) => t.list_usd.toFixed(2)],
  ["sessions", (t) => `${t.sessions}${t.uncounted ? ` +${t.uncounted} uncounted` : ""}`],
  ["retries", (t) => String(t.retries)],
  ["blocked", (t) => String(t.blocked)],
  ["fact/fail/iface", (t) => ["fact", "fail", "interface"].map((k) => t.entries[k] ?? 0).join("/")],
];

/** One row per plan, columns padded to line up. */
export function formatTelemetryTable(rows: PlanTelemetry[]): string {
  const cells = [COLUMNS.map(([head]) => head), ...rows.map((r) => COLUMNS.map(([, cell]) => cell(r)))];
  const widths = COLUMNS.map((_, i) => Math.max(...cells.map((row) => row[i].length)));
  return cells.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}
