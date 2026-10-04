// A verdict as the Evals pages read it: the glyph state of a run or a set,
// the words for a baseline and how its p was reached, and a flip's links.
// Pure, so the views and their tests share it without a component module.

import type { BatchStats, BatchVerdict, RunRow, VerdictFlip } from "@codecast/shared/contracts/evalsApi";
import { evalsHref } from "./evalsPaths";
import { batchLabel } from "./format";

export type VerdictState = "pass" | "fail" | "crash" | "mixed" | "dry" | "unscored";

/** A run's glyph state. */
export const verdictOfRow = (row: Pick<RunRow, "status">): VerdictState => (row.status === "pass" ? "pass" : row.status === "fail" ? "fail" : row.status === "crash" ? "crash" : row.status === "dry" ? "dry" : "unscored");

/** A set's glyph state from its pass count. */
export function verdictOfSet(passed: number, reps: number): VerdictState {
  if (!reps) return "unscored";
  if (passed === reps) return "pass";
  if (passed === 0) return "fail";
  return "mixed";
}

// ── A verdict's baseline ────────────────────────────────────────────────────

/** A verdict's baseline in words: short for a row ("vs pooled 3"), long for a title or a header ("3 pooled nightly batches: Oct 1, ...; ..."). */
export function baselineWords(base: BatchVerdict["baseline"]): { short: string; long: string } | null {
  if (!base) return null;
  const n = base.batches.length;
  if (!base.reps) return { short: `${base.kind} baseline building`, long: `the ${base.kind} baseline has no graded reps yet` };
  const what = base.kind === "pooled" ? `${n} pooled ${base.cadence ? `${base.cadence} ` : ""}${n === 1 ? "batch" : "batches"}` : base.kind === "against" ? "one named batch" : n === 1 ? "the previous batch" : `each freeze's previous batch (${n} batches)`;
  return { short: `vs ${base.kind}${n > 1 ? ` ${n}` : ""}`, long: `${what}: ${base.batches.map((b) => batchLabel(b)).join("; ")}` };
}

/**
 * How a verdict's p was reached, for a title, as verdict.ts weighs it: a
 * cadence baseline (`pooled`) night by night per freeze (separateNights over
 * nightStrata), any other by a one-sided Mann-Whitney of per-rep scores.
 * Without a p (too few, or no baseline) it is the baseline's words alone.
 */
export function separationTitle(v: Pick<BatchVerdict, "baseline" | "separation">): string | undefined {
  const words = baselineWords(v.baseline);
  if (!words || !("p" in v.separation)) return words?.long;
  return v.baseline?.kind === "pooled"
    ? `Night by night per freeze: the latest batch's mean on each freeze ranked among that freeze's means on ${words.long}`
    : `One-sided Mann-Whitney of the latest batch's per-rep scores against ${words.long}`;
}

/** The newest batch of a verdict's baseline, by when each began (`stats` carries the times); null with no baseline. */
export function newestBaseline(v: BatchVerdict, stats: readonly BatchStats[]): string | null {
  const base = v.baseline?.batches ?? [];
  if (!base.length) return null;
  const at = new Map(stats.map((b) => [b.batch, Date.parse(b.batchAt)]));
  return [...base].sort((a, b) => (at.get(b) ?? (Date.parse(b) || -Infinity)) - (at.get(a) ?? (Date.parse(a) || -Infinity)))[0]!;
}

// ── A flip's links ──────────────────────────────────────────────────────────

export type FlipRuns = Pick<VerdictFlip, "freezeId" | "before" | "after">;

/** The freeze a flip names, opened on the two reps the flip compares rather than the freeze page's own default pair. */
export const flipFreezeHref = (f: FlipRuns) => evalsHref.freeze(f.freezeId, { a: f.before[0] ?? null, b: f.after[0] ?? null });
