import { PROD_DEFAULT_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'org-review',
  title: 'Org analyzer review',
  route: 'agent',
  // Prod spawns the analyzer with no --model, so it runs on the default model (models.ts).
  model: PROD_DEFAULT_MODEL,
  // orgInitRun.ts only wraps headOfPeoplePrompt.ts, which holds the analyzer's text; orgProposal.ts is the spec spec-parses grades against.
  sources: surfaceSources(
    'org-review',
    'packages/shared/contracts/headOfPeoplePrompt.ts',
    'packages/shared/contracts/orgProposal.ts',
    'packages/cli/src/orgInitRun.ts',
    'packages/cli/src/orgInit.ts',
    'packages/cli/scripts/prompt-dry-run-bin/cast',
  ),
  reps: { check: 8, smoke: 3 },
  maxUsdPerRep: 2.5,
  criteria: null,
  frozenReads: [['org', 'inputs', '--team', '{team}', '--json'], ['org', 'health', '--team', '{team}', '--json'], ['org', 'ls', '--team', '{team}', '--json']],
  // `brief` too: the analyzer ends a review by writing its brief, and a read of it must never reach the live workspace.
  frozenVerbs: ['org', 'brief'],
};
