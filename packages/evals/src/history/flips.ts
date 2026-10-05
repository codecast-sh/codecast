import type { EvalFlip, FlipsResult } from '@codecast/shared/contracts/evalsApi';

import { codecastFreezeStore } from '../adapters/freezes';
import { repsSurface } from '../commands/line';
import { codecastVerdict, gradedSet, type RulerOf, type VerdictRun } from '../commands/verdict';
import { flipsBetween as flipsWith } from '../core/flips';
import { flipOf } from '../evalResult';
import { surfaceMeta } from '../registry';

// Which freezes flipped between two batches of one surface (core/flips.ts),
// on codecast's verdict, and the reply text behind each flip.

export { gradedSet };

/**
 * The flips from batch `a` to batch `b` among `rows` (one surface's reps).
 * Refuses when either batch graded nothing, or when any freeze both graded
 * ran on another model or ruler on one side.
 */
export const flipsBetween = <R extends VerdictRun>(rows: R[], a: string, b: string, ruler?: RulerOf<R>): FlipsResult => flipsWith(codecastVerdict, rows, a, b, ruler);

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
