// The six stages a problem's run goes through, as a person names them
// (line-journeys.md LJ6.4): each a dot that is done, current, failed or not
// reached, read from the run's own visits. Pure, so the problem page, the run
// page and a test read one result.
import { PHASE_ORDER, guessPhase, type LinePhaseKey } from "@codecast/shared/contracts/linePhases";
import type { LineRunModel, LineVisit } from "./lineModel";

export const STAGE_WORDS: Record<LinePhaseKey, string> = { understand: "Investigate", prove: "Prove", build: "Build", check: "Verify", decide: "Present", ship: "Ship" };
/** A stage while a run is in it: "Building". */
export const STAGE_DOING: Record<LinePhaseKey, string> = { understand: "Investigating", prove: "Proving", build: "Building", check: "Verifying", decide: "Presenting", ship: "Shipping" };

export type StageMark = "done" | "current" | "failed" | "none";
export type Stage = { key: LinePhaseKey; label: string; mark: StageMark; /** The stage's last step in this run, for the link to it; null when the run never reached the stage. */ step: string | null };

type TrackRun = Pick<LineRunModel, "visits" | "live">;
export type StageOf = (node: string, label?: string) => LinePhaseKey | null;

/** Steps that carry a run in and out of the line and belong to no stage. */
const EDGE_STEPS = new Set(["start", "exit"]);

const stageOfVisit = (v: Pick<LineVisit, "node" | "label">, stageOf?: StageOf): LinePhaseKey | null =>
  EDGE_STEPS.has(v.node) ? null : stageOf?.(v.node, v.label) ?? guessPhase(v.node, v.label);

/** The step a failed run really stopped at: the first of the failures it ended on, past the end step that records it. A step that only received nothing
 *  from the one before it ("Prove gave no result" after Analyze died) is not where it failed. */
export function firstFailedVisit(run: Pick<LineRunModel, "visits"> | null | undefined): LineVisit | null {
  const vs = run?.visits ?? [];
  let at: LineVisit | null = null;
  const ending = (v: LineVisit) => EDGE_STEPS.has(v.node) || v.kind === "end";
  for (let i = vs.length - 1; i >= 0; i--) {
    if (vs[i].status === "failed") at = vs[i];
    // A graph's end step (failed_at_bind) only records where the run ended: the failure is the step before it.
    else if (ending(vs[i])) continue;
    // A script the graph routes a failure to on its way out (Unscored after Eval: it files a blocker and ends) records
    // the failure; the failure is the step before it. An agent's step after a failure is work, never skipped.
    else if (!at && vs[i].kind === "script" && vs[i - 1]?.status === "failed" && vs.slice(i + 1).every(ending)) continue;
    else break;
  }
  return at;
}

/**
 * The run's six stages. The stage of its newest step is current while the run is live or waits there, failed when
 * the run ended on a failure in it, done otherwise; stages before it that the run visited are done; stages after it
 * are not reached (a run sent back from Verify to Build has not verified). Ship is listed only once Present is done.
 * `waitingAt`: the run waits on a person at this stage (a decision asked), so the stage is current, not done.
 */
export function stageTrack(run: TrackRun | null | undefined, stageOf?: StageOf, opts: { waiting?: boolean; failed?: boolean; /** The run stands at this stage whatever ran after it: a fix asked and never answered stands at Present, even if steps past it ran. */ at?: LinePhaseKey | null } = {}): Stage[] {
  const last = new Map<LinePhaseKey, LineVisit>();
  let cur: LinePhaseKey | null = null;
  for (const v of run?.visits ?? []) {
    const st = stageOfVisit(v, stageOf);
    if (!st) continue;
    last.set(st, v);
    cur = st;
  }
  const failedAt = opts.failed === false ? null : firstFailedVisit(run);
  // A run that ended on a failure is read at the step it failed in, not the one that received nothing after it.
  const failStage = failedAt && !run?.live ? stageOfVisit(failedAt, stageOf) : null;
  if (failStage) cur = failStage;
  if (opts.at) cur = opts.at;
  const at = cur ? PHASE_ORDER.indexOf(cur) : -1;
  const out: Stage[] = [];
  for (const [i, key] of PHASE_ORDER.entries()) {
    const v = last.get(key) ?? null;
    let mark: StageMark = "none";
    if (v && i < at) mark = "done";
    else if (v && i === at) {
      if (failStage === key) mark = "failed";
      else if (run?.live || opts.waiting || opts.at || v.status === "live" || v.status === "waiting") mark = "current";
      else mark = "done";
    }
    out.push({ key, label: STAGE_WORDS[key], mark, step: i <= at ? v?.node ?? null : null });
  }
  const present = out.find((s) => s.key === "decide");
  return present?.mark === "done" ? out : out.filter((s) => s.key !== "ship");
}
