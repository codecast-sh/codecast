// A verdict as the Evals pages read it: the glyph state of a run or a set,
// the words for a baseline and how its p was reached, and a flip's links.
// Pure, so the views and their tests share it without a component module.

import { isFlapping, type BatchStats, type BatchVerdict, type RunRow, type VerdictFlip } from "@codecast/shared/contracts/evalsApi";
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

/** What a baseline holds, and its batches as every page names them. */
function baselineParts(base: NonNullable<BatchVerdict["baseline"]>): { what: string; list: string } {
  const n = base.batches.length;
  const batches = n === 1 ? "batch" : "batches";
  const what = base.kind === "pooled" ? `${n} ${base.cadence ? `${base.cadence} ` : ""}${batches}` : base.kind === "against" ? "one named batch" : n === 1 ? "the previous batch" : `each freeze's previous batch (${n} batches)`;
  return { what, list: base.batches.map((b) => batchLabel(b)).join("; ") };
}

/**
 * A verdict's baseline in words: short for a row ("vs 3 nights"), long for a
 * title or a header ("3 nightly batches, night by night per freeze: Oct 1,
 * ..."). A cadence baseline is weighed night by night, never as one pool of
 * reps, so its words never say "pooled".
 */
export function baselineWords(base: BatchVerdict["baseline"]): { short: string; long: string } | null {
  if (!base) return null;
  const n = base.batches.length;
  const kindWord = base.kind === "pooled" ? "nightly" : base.kind;
  if (!base.reps) return { short: `${kindWord} baseline building`, long: `the ${kindWord} baseline has no graded reps yet` };
  const { what, list } = baselineParts(base);
  if (base.kind === "pooled") return { short: `vs ${n} ${n === 1 ? "night" : "nights"}`, long: `${what}, night by night per freeze: ${list}` };
  return { short: `vs ${base.kind}${n > 1 ? ` ${n}` : ""}`, long: `${what}: ${list}` };
}

/**
 * How a verdict's p was reached, for a title, as verdict.ts weighs it: a
 * cadence baseline (`pooled`) night by night per freeze (separateNights over
 * nightStrata), any other by a one-sided Mann-Whitney of per-rep scores.
 * Without a p (too few, or no baseline) it is the baseline's words alone.
 */
export function separationTitle(v: Pick<BatchVerdict, "baseline" | "separation">): string | undefined {
  const words = baselineWords(v.baseline);
  if (!words || !v.baseline || !("p" in v.separation)) return words?.long;
  const { what, list } = baselineParts(v.baseline);
  return v.baseline.kind === "pooled"
    ? `Night by night per freeze: the latest batch's mean on each freeze ranked among that freeze's means on ${what}: ${list}`
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

/** Why a flip says nothing, without its name: "flaps: 9 of 22 batches, same prompt on both sides". */
export function noiseReasons(f: Pick<VerdictFlip, "history" | "samePrompt">): string {
  const parts: string[] = [];
  if (f.history && isFlapping(f.history)) parts.push(`flaps: ${f.history.flips} of ${f.history.batches} batches`);
  if (f.samePrompt) parts.push("same prompt on both sides");
  return parts.join(", ");
}

/** Why a flip is not counted, in one line: "jx7btyt:100 broke, flaps: 9 of 22 batches, same prompt on both sides". */
export const noiseFlipWords = (f: VerdictFlip): string => `${f.name} ${f.direction}, ${noiseReasons(f)}`;

/**
 * The noise flips on one line of a verdict: one flip names its reasons in
 * full ("1 flip on noise: flaps 9 of 22, same prompt"), several give a count.
 */
export const noiseFlipsShort = (noise: readonly VerdictFlip[]): string =>
  noise.length === 1 ? `1 flip on noise: ${noiseReasons(noise[0]!).replace("flaps: ", "flaps ").replace(" batches", "").replace(" on both sides", "")}` : `${noise.length} flips on noise`;
