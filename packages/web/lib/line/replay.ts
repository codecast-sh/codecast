// What a run's detail (line-workspace.md LW1) reads that no other view does,
// pure and tested: how a run ended, in a word and as a filter, what a step
// could have decided, and where a run's visit is for a step. The trace itself
// is runTrace.ts; everything else is lineModel's.
import type { LineModel, LineRunModel, LineStep, LineVisit } from "./lineModel";

// ── how a run ended, as the case list filters it ─────────────────────────────

export type RunEndKind = "shipped" | "closed" | "stopped" | "running";
export const RUN_END_FILTERS: ReadonlyArray<{ key: RunEndKind; label: string }> = [
  { key: "shipped", label: "Shipped" },
  { key: "closed", label: "Closed" },
  { key: "stopped", label: "Stopped" },
  { key: "running", label: "Running" },
];

/** Which filter a run falls under: shipped, closed without a change, stopped, or still going. */
export function runEndKind(run: Pick<LineRunModel, "live" | "outcome">): RunEndKind {
  const { tone, end } = run.outcome;
  if (run.live || tone === "live" || tone === "waiting") return "running";
  if (tone === "shipped") return "shipped";
  if (tone === "failed" || tone === "stuck") return "stopped";
  if (end === "shipped") return "shipped";
  return "closed";
}

/** A run's end as its tag says it: "shipped", "dissolved", "stopped", "waiting". */
export function runEndWords(run: Pick<LineRunModel, "live" | "outcome">): string {
  const { tone, end } = run.outcome;
  if (tone === "waiting") return "waiting";
  if (run.live || tone === "live") return "running";
  if (tone === "failed" && end === "shipped") return "reopened";
  if (tone === "failed" || tone === "stuck") return "stopped";
  if (end) return end;
  return tone === "calm" ? "queued" : "closed";
}

/** The one color a run's end carries: shipped is good, stopped is bad, running and waiting have their own; a close is neutral. */
export function runEndTone(word: string): "ok" | "bad" | "live" | "person" | "none" {
  if (word === "shipped") return "ok";
  if (word === "stopped" || word === "reopened") return "bad";
  if (word === "running") return "live";
  if (word === "waiting") return "person";
  return "none";
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
