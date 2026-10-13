// What a run's detail (line-workspace.md LW1) reads that no other view does,
// pure and tested: how a run ended, in a word, what a step
// could have decided, and where a run's visit is for a step. The trace itself
// is runTrace.ts; everything else is lineModel's.
import type { LineModel, LineRunModel, LineStep, LineVisit } from "./lineModel";
import { closeOutcome } from "./scriptReport";

// ── how a run ended ──────────────────────────────────────────────────────────

/** A run's end as every surface says it (Runs, the run's detail, the Graph's run bar and picker):
 *  "shipped", "dissolved", "failed", "stuck", "waiting", ... A normal stop at a step that ends the run reads "stopped". */
export function runEndWords(run: Pick<LineRunModel, "live" | "outcome" | "superseded"> & { status?: string; verdict?: LineRunModel["verdict"] }): string {
  const { tone, end } = run.outcome;
  if (run.superseded) return "superseded";
  // A run that built a fix reads by its fix (lineModel verdict), as its problem's history says it.
  if (run.verdict && !run.live) return run.verdict.word;
  if (tone === "waiting") return "waiting";
  if (run.live || tone === "live") return "running";
  if (tone === "failed" && end === "shipped") return "reopened";
  if (tone === "failed") return "failed";
  if (tone === "stuck") return "stuck";
  if (end) return end;
  // A finished run that named no end of its own ran through: "done", never "queued".
  if (run.status === "completed") return "done";
  return tone === "calm" ? "queued" : "closed";
}

export type RunEndTone = "ok" | "bad" | "warn" | "live" | "person" | "none";

/** The one color a run's end carries: shipped is good, red is only a failure, stuck is amber, running and waiting have their own; a close or a normal stop is neutral. */
export function runEndTone(word: string): RunEndTone {
  if (word === "shipped" || word === "deployed" || word === "merged") return "ok";
  if (word.endsWith(", not deployed") || word === "not shipped") return "warn";
  if (word === "failed" || word === "reopened") return "bad";
  if (word === "stuck") return "warn";
  if (word === "running") return "live";
  if (word === "waiting" || word === "parked") return "person";
  return "none";
}

/** Why a parked run waits, in a few words, from its outcome sentence: "Build finished", "Build looped three times". */
export function parkedWhy(text: string): string | null {
  const m = /^Stopped(?: at [^:]+)?:\s*([^;.]+)/.exec(text.trim());
  return m ? m[1].trim().slice(0, 40) : null;
}

/** A run is a re-run after a close when the attempt before it on the problem closed it without a change: the line paid twice. */
export const reranAfterClose = (prev: (Pick<LineRunModel, "live" | "outcome" | "superseded" | "visits"> & { verdict?: LineRunModel["verdict"] }) | undefined): boolean => !!prev && !prev.live && (runEndWords(prev) === "dissolved" || !!closeOutcome(prev.visits));

/** The groups a list of runs splits into, in reading order, each with its heading. */
export const RUN_END_GROUPS: ReadonlyArray<[string, string]> = [
  ["running", "Running"], ["waiting", "Waiting on you"], ["deployed", "Deployed"], ["merged", "Merged"], ["merged, not deployed", "Merged, not deployed"], ["shipped, not deployed", "Shipped, not deployed"], ["shipped", "Shipped"], ["reopened", "Shipped, came back"], ["not shipped", "Not shipped: no answer"], ["parked", "Parked"],
  ["failed", "Failed"], ["stuck", "Stuck"], ["stopped", "Stopped"], ["done", "Done"], ["closed", "Closed without a change"], ["dissolved", "Dissolved"], ["dropped", "Dropped"], ["superseded", "Superseded"], ["queued", "Queued"],
];

/** The step a run is at or stopped at, as the Runs list's At step says it: always a step, never an end (its status says how it ended). */
export function runStopStep(model: Pick<LineModel, "steps">, r: Pick<LineRunModel, "at_node" | "visits">): string | null {
  return runStop(model, r).label;
}

/** The step a run is at or stopped at (runStopStep) and its newest recorded visit there, whose output the Runs list shows beside it. */
export function runStop(model: Pick<LineModel, "steps">, r: Pick<LineRunModel, "at_node" | "visits">): { label: string | null; visit: LineVisit | null } {
  const isStep = (id: string | null | undefined) => !!id && !!model.steps[id] && model.steps[id].kind !== "end";
  const node = isStep(r.at_node) ? r.at_node! : [...r.visits].reverse().find((v) => isStep(v.node))?.node ?? null;
  if (!node) return { label: null, visit: null };
  return { label: model.steps[node].label, visit: [...r.visits].reverse().find((v) => v.node === node && !v.inferred) ?? null };
}

// ── a step's decisions ───────────────────────────────────────────────────────

const GENERIC_OUTCOMES = new Set(["success", "failure"]);

/** What a step could have decided: the outcomes its branches test for, then
 *  any its decisions reported that no branch names, most used first. */
export function stepOutcomes(model: Pick<LineModel, "graph">, step: Pick<LineStep, "id" | "decisions">): string[] {
  const seen = new Map<string, number>();
  for (const e of model.graph.edges) {
    if (e.from !== step.id || !e.condition) continue;
    for (const m of e.condition.matchAll(/\boutcome\s*={1,2}\s*["']?([\w-]+)/g)) if (!GENERIC_OUTCOMES.has(m[1]) && !seen.has(m[1])) seen.set(m[1], 0);
  }
  for (const d of step.decisions) {
    const o = d.decided.outcome;
    if (o && !GENERIC_OUTCOMES.has(o)) seen.set(o, (seen.get(o) ?? 0) + 1);
  }
  const branchOrder = [...seen.keys()];
  return branchOrder.sort((a, b) => (seen.get(b)! - seen.get(a)!) || branchOrder.indexOf(a) - branchOrder.indexOf(b));
}

/** The note a "wrong" label carries: what it should have said, then why. */
export function wrongNote(should: string | null, why: string): string {
  const w = why.trim();
  if (!should) return w;
  return w ? `Should be ${should.replace(/_/g, " ")}. ${w}` : `Should be ${should.replace(/_/g, " ")}.`;
}

// ── a run's visits ───────────────────────────────────────────────────────────

/** Where a click on a step lands in a run: its next visit after the playhead,
 *  else its last before; -1 when the run never reached it. */
export function visitOf(visits: ReadonlyArray<Pick<LineVisit, "node">>, stepId: string, from: number): number {
  for (let i = from + 1; i < visits.length; i++) if (visits[i].node === stepId) return i;
  for (let i = Math.min(from, visits.length - 1); i >= 0; i--) if (visits[i].node === stepId) return i;
  return -1;
}
