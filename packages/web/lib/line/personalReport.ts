// A personal Ship's run as a report (runReport.ts): its run reads through its round's view (personalRound.ts), as the
// journey, the diagram and a station's panel read it, so its steps, its landing and its ends say what they say there.
// A run is a personal Ship's only when the graph the caller has says so (ownRound.ts), never by its name. Pure.
import { isLineRun } from "@codecast/shared/contracts/changeCard";
import { flowNodeAttrOf } from "@codecast/shared/contracts/flowPool";
import type { RunNodeRow } from "../workflowRun";
import { leftWords, stationResult } from "../ship/stationResult";
import { stopWhy } from "../ship/journeyWords";
import { jsonOf, personalRound, shortWhy, type RoundState, type RoundStation } from "../ship/personalRound";
import { roundsOnOwnResults } from "../ship/ownRound";
import type { ReportRun, ReportStep, StepState } from "./runReport";

/** A graph a report reads a run by. */
export type RunGraph = { own_results?: boolean; source?: string | null; nodes?: ReadonlyArray<{ id: string; label?: string; type?: string; fold?: boolean; stop?: string; backend?: string }>; edges?: ReadonlyArray<{ from: string; to: string; label?: string; condition?: string }> };
type OwnGraph = { nodes: NonNullable<RunGraph["nodes"]>; edges: NonNullable<RunGraph["edges"]> };

/** The graph of a personal Ship's run (ownRound.ts: it says so in its graph), from the graph the caller has: the run's
 *  stored row, whose source says it, or its flow. Null for every other run, and for a caller with no graph: a run's
 *  name alone never makes it personal (a team's own flow may be slugged `personal`). */
export function ownGraphOf(graph?: RunGraph | null): OwnGraph | null {
  return graph?.nodes && graph.edges && roundsOnOwnResults(graph) ? (withSourceAttrs(graph) as OwnGraph) : null;
}

/** Whether a run's page draws its steps as its path (runPath): a line run, and a personal Ship's, whose steps read
 *  through its round's view as the phone and every other surface read them. Every other run reads as its sessions. */
export const readsAsPath = (run: Parameters<typeof isLineRun>[0], graph?: RunGraph | null): boolean => isLineRun(run) || !!ownGraphOf(graph);

/** The commit a run put on main, as its page names it: a personal Ship's latest landing ("Landed", the sha its journey
 *  shows, though the run row keeps its first merge), else the run's merge. */
export function landingOf(run: ReportRun & { merge?: { sha: string } | null }, graph?: RunGraph | null): { word: "Landed" | "Merged"; sha: string } | null {
  const own = ownGraphOf(graph);
  const sha = own ? personalRound(own as any, run as any)?.landed ?? run.merge?.sha : run.merge?.sha;
  return sha ? { word: own ? "Landed" : "Merged", sha } : null;
}

/** A stored workflows row (useRunWorkflow) keeps no fold, stop, backend or machine on its nodes (workflowNodeValidator):
 *  they read from its source, as pushedFlow reads them, so a report drawn from the row reads the graph the journey does. */
function withSourceAttrs(g: RunGraph): RunGraph {
  if (!g.source || g.nodes!.some((n) => n.fold || n.stop)) return g;
  const attrs = (["fold", "stop", "backend", "machine"] as const).map((k) => [k, flowNodeAttrOf(g.source, k)] as const);
  return { ...g, nodes: g.nodes!.map((n) => {
    const add: Record<string, unknown> = {};
    for (const [k, of] of attrs) if (of[n.id] && (k === "stop" || k === "backend" || of[n.id] === "true")) add[k] = k === "stop" || k === "backend" ? of[n.id] : true;
    return { ...n, ...add };
  }) };
}

/** A personal run's step as its round's view says (personalRound.ts): running, done, found work, nothing to do, or a
 *  step of an earlier round. A step left for the person opens the task it was posted to. */
const PERSONAL_STEP: Record<RoundState, StepState> = { running: "live", done: "done", nothing: "nothing", back: "failed", stopped: "failed", failed: "failed", idle: "noted", unknown: "unknown" };
function personalStepOf(step: ReportStep, { state, endSays }: RoundStation, ofRound: boolean, row: RunNodeRow, run: ReportRun): ReportStep {
  // A step of another round says its state only, never that round's words or links.
  if (!ofRound) {
    const { note: _n, href: _h, hrefTitle: _t, ...bare } = step;
    return state === "running" ? { ...bare, state: "live", result: "Running" }
      : state === "done" ? { ...bare, state: "done", result: "Landed earlier" }
      : { ...bare, state: "noted", result: "An earlier round" };
  }
  const left = row.result_preview?.startsWith(leftWords("")) && run.task_short_id ? { href: `/tasks/${run.task_short_id}`, hrefTitle: "Open the task the step was posted to" } : {};
  // Its result JSON (stationResult.ts): Skipped when it found nothing to do, its note as its words, and a step it left to
  // the person beside them. A station that reported live on a run that ended short of Live says what the end says.
  const ran = row.status === "completed" ? stationResult(row.result_preview) : null;
  const skipped = state === "nothing";
  const words = endSays?.why ?? (skipped ? "Skipped" : ran?.note ?? step.result);
  const note = skipped && ran?.note ? { note: ran.note } : ran?.leftForYou ? { note: leftWords(ran.leftForYou) } : {};
  return { ...step, ...left, ...note, result: words, state: PERSONAL_STEP[state] };
}

/** A personal Ship's run as its path reads it (runPath), or null for every other run: the steps it shows (a branch its
 *  round runs unreported, since a script reports only when it ends, is a step of the run now) and each one's words. */
export function personalPath(graph: RunGraph | null | undefined, run: ReportRun) {
  const own = ownGraphOf(graph);
  const round = own ? personalRound(own, run) : null;
  return round && {
    shows: (row: RunNodeRow) => round.station(row.id).state === "running",
    step: (step: ReportStep, row: RunNodeRow) => personalStepOf(step, round.station(row.id), round.ofRound(row.id), row, run),
  };
}

/** A personal Ship's stop, its reason whole: a result's note, a rejection's findings, never its raw JSON. */
export function personalStopText(run: ReportRun, own: OwnGraph): string {
  const stop = own.nodes.find((n) => n.id === run.current_node_id && n.type === "exit");
  return `${stop?.label ?? "Stopped"}: ${(stopWhy(run.fail_reason) ?? "").replace(/\.$/, "")}.`;
}

/** A finished personal Ship at one of its own ends, by its name, saying how far the change got (with why when short of
 *  Live) and a step left for the person. Null for a run at no end of its own. */
export function personalEndText(run: ReportRun, own: OwnGraph): string | null {
  const end = own.nodes.find((n) => n.id === run.current_node_id && n.type === "exit" && !n.stop);
  if (!end) return null;
  const left = [...(run.node_statuses ?? [])].reverse().map((n) => stationResult(n.result_preview)?.leftForYou).find(Boolean);
  const round = personalRound(own, run);
  // The station that decided the end: the newest one with a way into it whose output is a result.
  const decided = (run.node_statuses ?? []).filter((n) => own.edges.some((e) => e.to === end.id && (e.from === n.node_id || own.edges.some((x) => x.to === e.from && x.from === n.node_id))) && !!jsonOf(n.result_preview)?.outcome)
    .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))[0];
  // Short of Live (as the journey reads it: an end not named Live), it says why.
  const why = end.label !== "Live" && round?.landed && decided ? shortWhy(decided.result_preview, round.landed) : null;
  return `${end.label ?? end.id}${why ? `: ${why.replace(/\.$/, "")}` : ""}.${left ? ` ${leftWords(left).replace(/\.?$/, ".")}` : ""}`;
}
