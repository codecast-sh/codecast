import { flipReading, type ProbeReading, type RunRow } from '@codecast/shared/contracts/evalsApi';

import { repPassed } from '../adapters/replay';
import { scoreOrZero } from '../commands/verdict';
import { median, separate } from '../stats';

// How a set of reps reads against the ends of a range (evals-ui.md section 5):
// the rule a bisect probe is classified by, and the one attribution reads
// recorded batches by. A leaf, so attribution can import it without the
// probe runner's worktree and check machinery.

/** A probe's reading before the unsure rule: `split` asks for 2 more reps per freeze. */
export type Reading = ProbeReading;

/** The focus freezes a set has no scored rep on: every rep there crashed, so the set says nothing about them. */
export const crashedFocus = (set: RunRow[], focus: string[]): string[] => focus.filter((f) => !set.some((r) => r.freezeId === f && r.status !== 'crash'));

/**
 * How a probe's reps read. In flip mode, the contract's flipReading over the
 * graded reps (crashes vote nowhere). In score mode, the focus scores against
 * the good control's: separated worse is bad, too few to separate is a split,
 * otherwise good.
 */
export function readProbe(set: RunRow[], focus: string[], mode: 'flip' | 'score', goodControl: RunRow[]): Reading {
  const ran = set.filter((r) => focus.includes(r.freezeId) && r.status !== 'crash');
  if (mode === 'score') {
    const s = separate(ran.map(scoreOrZero), goodControl.filter((r) => focus.includes(r.freezeId)).map(scoreOrZero));
    return s.kind === 'worse' ? 'bad' : s.kind === 'too-few' ? 'split' : 'good';
  }
  return flipReading(ran.map((r) => ({ freezeId: r.freezeId, passed: repPassed(r) })), focus);
}

/**
 * The control freezes a set fails by majority, a tie failing nothing (the
 * contract's flipReading over that freeze alone). A control passed on both
 * ends in the records, so failing now says the tool, the judge or the tree
 * under test moved, never the source between the ends.
 */
export function failedControls(set: RunRow[], controls: string[]): string[] {
  const ran = set.filter((r) => r.status !== 'crash').map((r) => ({ freezeId: r.freezeId, passed: repPassed(r) }));
  return controls.filter((f) => flipReading(ran, [f]) === 'bad');
}

/**
 * The unsure rule: a probe still split after its extra reps sides with the
 * control its focus median sits nearer, the bad one on a tie, and is marked
 * unsure so the answer's confidence drops.
 */
export function unsureSide(set: RunRow[], focus: string[], good: RunRow[], bad: RunRow[]): 'good' | 'bad' {
  const med = (s: RunRow[]) => median(s.filter((r) => focus.includes(r.freezeId)).map(scoreOrZero));
  const [p, g, b] = [med(set), med(good), med(bad)];
  if (!Number.isFinite(p) || !Number.isFinite(g) || !Number.isFinite(b)) return 'bad';
  return Math.abs(p - g) < Math.abs(p - b) - 1e-9 ? 'good' : 'bad';
}
