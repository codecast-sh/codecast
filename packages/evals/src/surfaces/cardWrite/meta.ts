import { PROD_DEFAULT_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'card-write',
  title: "The line's card words: six plain fields a person decides Ship, Revise or Drop from",
  route: 'call',
  // The station is an agent=claude hand with no model of its own, so it runs the launching person's Claude Code default.
  model: PROD_DEFAULT_MODEL,
  sources: surfaceSources(
    'card-write',
    'packages/cli/src/workflow/templates/line/card_write.md',
    'packages/cli/src/workflow/templates/line.cast',
    'packages/cli/src/workflow/runner.ts',
    'packages/cli/src/workflow/condition.ts',
    'packages/shared/contracts/unattended.ts',
    'packages/shared/contracts/changeCard.ts',
  ),
  reps: { check: 5 },
  // One strong call over a card of a few KB, plus the judge.
  maxUsdPerRep: 0.15,
  criteria: 'a person who never saw the work can judge Ship, Revise or Drop from the six fields alone, and every claim in them matches what the card records (its checks, proof, examples and diff), with no result stated stronger than the card shows',
};
