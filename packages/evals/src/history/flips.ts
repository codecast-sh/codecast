import type { EvalFlip, Footing, FlipsResult } from '@codecast/shared/contracts/evalsApi';

import { codecastFreezeStore } from '../adapters/freezes';
import { repsSurface } from '../commands/line';
import { defaultRuler, gradedSet, footingChange, footingOf, verdictFlips, type RulerOf, type VerdictRun } from '../commands/verdict';
import { flipOf } from '../evalResult';
import { surfaceMeta } from '../registry';

// Which freezes flipped between two batches of one surface: each freeze's
// majority verdict over one rep per seed (verdict.ts majority, onePerSeed),
// on the freezes both batches graded. A flip across a model or a judge ruler
// would read the model or the ruler as a prompt change, so the comparison
// refuses then and says which moved.

export { gradedSet };

/**
 * The flips from batch `a` to batch `b` among `rows` (one surface's reps).
 * Refuses when either batch graded nothing, or when any freeze both graded
 * ran on another model or ruler on one side.
 */
export function flipsBetween<R extends VerdictRun>(rows: R[], a: string, b: string, ruler: RulerOf<R> = defaultRuler): FlipsResult {
  const before = gradedSet(rows, a);
  const after = gradedSet(rows, b);
  const none: Footing = { model: null, ruler: null };
  const empty = !before.length ? a : !after.length ? b : null;
  if (empty) return { ok: false, reason: `${empty} graded nothing (every rep was dry, crashed or unscored)`, a: before[0] ? footingOf(before[0], ruler) : none, b: after[0] ? footingOf(after[0], ruler) : none };
  for (const r of after) {
    const other = before.find((x) => x.freezeId === r.freezeId);
    if (!other) continue;
    const [fa, fb] = [footingOf(other, ruler), footingOf(r, ruler)];
    const moved = footingChange(fa, fb);
    if (moved) return { ok: false, reason: moved === 'model' ? `another model: ${fa.model ?? '?'} in ${a}, ${fb.model ?? '?'} in ${b}` : `another judge ruler: ${fa.ruler ?? 'none'} in ${a}, ${fb.ruler ?? 'none'} in ${b}`, a: fa, b: fb };
  }
  return { ok: true, flips: verdictFlips(after, before) };
}

/**
 * The reply text behind flips, for the before and after cards: each freeze's
 * moment, one rep from each batch that matches its side's verdict, and the
 * judge's note, built the way `line` builds them (repsSurface, flipOf).
 */
export async function flipExamples(surface: string, freezeIds: string[], a: string, b: string): Promise<EvalFlip[]> {
  const meta = surfaceMeta(surface);
  if (!meta || !freezeIds.length) return [];
  const freezes = (await codecastFreezeStore().list()).filter((f) => freezeIds.includes(f.id));
  const reps = await repsSurface(meta, freezes, [], { base: a, branch: b }, { base: a, head: b });
  return reps.freezes.map(flipOf).filter((x): x is EvalFlip => !!x);
}
