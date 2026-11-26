// The run a person's screen draws, rebuilt from the real runner's progress reports (personalReports.json, recorded by
// scripts/record-personal-reports.ts from the cli's personal flow end-to-end suite) through the server's merge of a
// report into the run row (convex workflow_runs.ts updateProgress): one entry per node, its latest visit; entering a
// node starts its clock and clears its words; a report while it runs keeps both; a report that ends it stamps
// completed_at; a run that ends closes the stations still running. Tests of the personal journey, diagram and report
// read runs built here, never hand-made node states: a fan-out's script branch, for one, is reported only when it ends.
import reports from "./personalReports.json";

/** A progress report, as much of it as the server merges into the run. */
type Report = Record<string, any>;
export type ReplayedRun = {
  _id: string; status: string; current_node_id?: string; fail_reason?: string; workflow_name: string; task_short_id: string;
  spawner_conversation_id: string; merge?: { sha: string }; waiting_on_session?: any;
  node_statuses: Array<{ node_id: string; status: string; outcome?: string; result_preview?: string; visits?: number; started_at: number; completed_at?: number; session_id?: string }>;
};
/** The run after one report, and that report. */
export type Moment = { run: ReplayedRun; report: Record<string, any> };

const LANDED = /^\{.*"outcome"\s*:\s*"landed".*"sha"\s*:\s*"([0-9a-f]{7,40})"/;

/** Every moment of a recorded scenario, by its test's name (or a unique part of it). */
export function replay(scenario: string): Moment[] {
  const all = reports as Record<string, Report[]>;
  const names = Object.keys(all).filter((k) => k === scenario || k.includes(scenario));
  if (names.length !== 1) throw new Error(`replay: ${names.length} recorded scenarios match "${scenario}"`);
  let t = 1_000;
  let run: ReplayedRun = { _id: "run_replay", status: "running", workflow_name: "personal", task_short_id: "ct-9", spawner_conversation_id: "conv_replay", node_statuses: [] };
  const moments: Moment[] = [];
  for (const a of all[names[0]]) {
    t += 1_000;
    const ns = [...run.node_statuses];
    const i = a.node_id && a.node_status ? ns.findIndex((n) => n.node_id === a.node_id) : -1;
    const prev = i >= 0 ? ns[i] : undefined;
    const entering = a.node_status === "running" && (prev?.status !== "running" || (a.visits !== undefined && a.visits !== prev?.visits));
    if (a.node_id && a.node_status) {
      const entry = {
        node_id: a.node_id, status: a.node_status, outcome: a.outcome, session_id: a.session_id ?? prev?.session_id,
        result_preview: a.result_preview ?? (entering ? undefined : prev?.result_preview),
        ...(a.visits !== undefined || prev?.visits !== undefined ? { visits: a.visits ?? prev?.visits } : {}),
        started_at: entering ? t : (prev?.started_at ?? t),
        completed_at: a.node_status !== "running" ? t : undefined,
      };
      if (i >= 0) ns[i] = entry; else ns.push(entry);
    }
    const ending = a.run_status === "completed" || a.run_status === "failed" ? a.run_status : null;
    run = {
      ...run,
      current_node_id: a.current_node_id,
      // convex lib/runEnd.ts closeRunningStations.
      node_statuses: ending ? ns.map((n) => (n.status === "running" ? { ...n, status: ending, outcome: n.outcome ?? "stopped", completed_at: t } : n)) : ns,
      ...(a.run_status ? { status: a.run_status } : {}),
      fail_reason: a.fail_reason,
      ...(a.waiting_on_session !== undefined || ending ? { waiting_on_session: ending ? undefined : (a.waiting_on_session ?? undefined) } : {}),
    };
    // Land's script records its landing on the run (`cast flow landed`), in a process the suite's fake server never hears.
    // The server keeps a run's first merge (convex orgLineMerge.ts recordMergeCore: `kept`).
    const landed = a.node_status === "completed" && /^(land|landed)$/.test(a.node_id ?? "") ? String(a.result_preview ?? "").match(LANDED)?.[1] : undefined;
    if (landed && !run.merge) run = { ...run, merge: { sha: landed } };
    moments.push({ run, report: a });
  }
  return moments;
}

/** The run at the first report a test names: a node entering, a node ending, or the run ending. `after` skips that many
 *  matches first (the second round's). */
export function at(moments: Moment[], match: { node?: string; status?: string; run?: string }, after = 0): ReplayedRun {
  const hits = moments.filter(({ report: r }) => (!match.node || r.node_id === match.node) && (!match.status || r.node_status === match.status) && (!match.run || r.run_status === match.run));
  const hit = hits[after];
  if (!hit) throw new Error(`replay: no report ${JSON.stringify(match)} (#${after})`);
  return hit.run;
}

/** The run as a person's Stop leaves it at a moment (convex workflow_runs cancel: "Cancelled by user", then
 *  lib/runEnd.ts closeRunningStations). */
export const stoppedAt = (run: ReplayedRun): ReplayedRun => ({
  ...run, status: "failed", fail_reason: "Cancelled by user",
  node_statuses: run.node_statuses.map((n) => (n.status === "running" ? { ...n, status: "failed", outcome: n.outcome ?? "stopped" } : n)),
});

/** The run as it ended. */
export const end = (moments: Moment[]): ReplayedRun => moments[moments.length - 1].run;

/** The recorded scenarios' names. */
export const scenarios = () => Object.keys(reports as Record<string, unknown>);
