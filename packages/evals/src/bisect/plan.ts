import type { Attribution, BisectPlan, RunRow } from '@codecast/shared/contracts/evalsApi';
import { NO_LEGACY, planFrom as planWith, renderPlan as renderPlanWith, type LegacyMap, type PlanArgs, type PlanDeps, type RenderHook, type Tier1 } from '@platform/evals/analysis';

import { codecastVerdict } from '../commands/verdict';
import { attribute, codecastAttributionMeta, type AttributionGit } from '../history/attribution';
import type { PromptReader } from '../history/epochs';
import type { HeadsFile } from '../provenance';
import { surfaceMeta } from '../registry';
import { gitHead, perRepUsd, readState, type EvalsState } from '../state';
import type { ProbeEnv } from './probe';

// A bisect's plan (@platform/evals/analysis bisect.ts) on codecast's records:
// Tier 0's answer from attribute, the cost per rep from EVALS_HOME's spend
// state, and Tier 1's render batches keyed by this checkout's head.

export { argsOf, CONFIRM_REPS, costBound, costLine, legacyMap, NO_LEGACY, planSearchable, searchable } from '@platform/evals/analysis';
export type { LegacyMap, PlanArgs, Tier1 } from '@platform/evals/analysis';

/** What the plan reads beyond its args; every field has a real default. */
export interface PlanWorld {
  rows: RunRow[];
  git?: AttributionGit;
  heads?: HeadsFile | null;
  reader?: PromptReader;
  state?: EvalsState;
}

/** What the plan asks of codecast: its verdict and surfaces, the spend state, and this checkout's head. */
const planDeps: PlanDeps<PlanWorld> = {
  verdict: codecastVerdict,
  meta: codecastAttributionMeta,
  perRepUsd: (surface, model, world) => perRepUsd(surfaceMeta(surface)!, world.state ?? readState(), model),
  toolHead: () => gitHead(),
};

/**
 * The plan from the records alone (Tier 0) and, once Tier 1 has run, its
 * classes. With no attribution given, it is attributed here from the world.
 */
export function planFrom(args: PlanArgs, world: PlanWorld, attribution?: Attribution, tier1: Tier1 | null = null): BisectPlan {
  const tier0 = () => attribute({ surface: args.surface, rows: world.rows, good: args.good, bad: args.bad, freezes: args.freezes, allCommits: args.allCommits, git: world.git, heads: world.heads, reader: world.reader });
  return planWith(args, world, planDeps, attribution ?? tier0, tier1);
}

/** Tier 1 over a plan (@platform/evals/analysis bisect.ts renderPlan). */
export const renderPlan = (plan: BisectPlan, args: PlanArgs, world: PlanWorld, env: ProbeEnv, o: { toolHead?: string; onRender?: RenderHook } = {}): Promise<{ plan: BisectPlan; legacy: LegacyMap }> => renderPlanWith(plan, args, world, env, planDeps, o);

/** The plan, with Tier 1's classes when an env is given (`bisect plan` without --no-render). */
export async function buildPlan(args: PlanArgs, world: PlanWorld, o: { env?: ProbeEnv; toolHead?: string; onRender?: RenderHook } = {}): Promise<{ plan: BisectPlan; legacy: LegacyMap }> {
  const plan = planFrom(args, world);
  return o.env ? renderPlan(plan, args, world, o.env, o) : { plan, legacy: NO_LEGACY };
}
