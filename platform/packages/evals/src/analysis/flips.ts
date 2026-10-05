import type { Footing, FlipsResult } from '../contract';

import { footingChange, gradedSet, type RulerOf, type VerdictKit, type VerdictRun } from './verdict';

// Which freezes flipped between two batches of one surface: each freeze's
// majority verdict over one rep per seed (verdict.ts majority, onePerSeed),
// on the freezes both batches graded. A flip across a model or a judge ruler
// would read the model or the ruler as a prompt change, so the comparison
// refuses then and says which moved.

/**
 * The flips from batch `a` to batch `b` among `rows` (one surface's reps).
 * Refuses when either batch graded nothing, or when any freeze both graded
 * ran on another model or ruler on one side.
 */
export function flipsBetween<P extends VerdictRun, R extends P>(v: VerdictKit<P>, rows: R[], a: string, b: string, ruler: RulerOf<R> = v.policy.ruler): FlipsResult {
  const before = gradedSet(rows, a);
  const after = gradedSet(rows, b);
  const none: Footing = { model: null, ruler: null };
  const empty = !before.length ? a : !after.length ? b : null;
  if (empty) return { ok: false, reason: `${empty} graded nothing (every rep was dry, crashed or unscored)`, a: before[0] ? v.footingOf(before[0], ruler) : none, b: after[0] ? v.footingOf(after[0], ruler) : none };
  for (const r of after) {
    const other = before.find((x) => x.freezeId === r.freezeId);
    if (!other) continue;
    const [fa, fb] = [v.footingOf(other, ruler), v.footingOf(r, ruler)];
    const moved = footingChange(fa, fb);
    if (moved) return { ok: false, reason: moved === 'model' ? `another model: ${fa.model ?? '?'} in ${a}, ${fb.model ?? '?'} in ${b}` : `another judge ruler: ${fa.ruler ?? 'none'} in ${a}, ${fb.ruler ?? 'none'} in ${b}`, a: fa, b: fb };
  }
  return { ok: true, flips: v.verdictFlips(after, before) };
}
