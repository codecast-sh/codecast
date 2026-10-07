import { HEAD_OF_PEOPLE_HANDLE } from '@codecast/shared/contracts/orgLead';

import { PROD_DEFAULT_MODEL } from '../../models';
import { OWN_BRIEF_EDIT, OWN_BRIEF_READ, surfaceSources, type SurfaceMeta } from '../../surface';
import { orgCut } from './cut';

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
    'packages/cli/scripts/prompt-dry-run-bin/git',
  ),
  reps: { check: 8, smoke: 3 },
  // The opus pin's measured mean (32 reps, 2026-10-02: $2.65 to $12.70); state.ts keeps each model's own history once a run records one.
  maxUsdPerRep: 7,
  criteria: null,
  // The Head of People's own brief is captured by handle from the capturing shell (a bare read from its own session would move its brief clock), and served as the bare read its review types.
  frozenReads: [['org', 'inputs', '--team', '{team}', '--json'], ['org', 'health', '--team', '{team}', '--json'], ['org', 'ls', '--team', '{team}', '--json'], ['brief', `@${HEAD_OF_PEOPLE_HANDLE}`, '--team', '{team}'], ['brief', `@${HEAD_OF_PEOPLE_HANDLE}`, '--team', '{team}', '--json']],
  servedAliases: [
    { serve: ['brief'], from: ['brief', `@${HEAD_OF_PEOPLE_HANDLE}`, '--team', '{team}'] },
    { serve: ['brief', '--json'], from: ['brief', `@${HEAD_OF_PEOPLE_HANDLE}`, '--team', '{team}', '--json'] },
  ],
  // `brief` too: the analyzer ends a review by writing its brief, and a read of it must never reach the live workspace.
  frozenVerbs: ['org', 'brief'],
  // The prompt ends every review by writing the analyzer's read into its own brief; that write is the prompt's, not the analyzer's choice.
  allowedRefusals: [OWN_BRIEF_EDIT],
  // The prompt also has the review start from its brief; a snapshot from before the role existed holds none, and the refused read is no zero.
  allowedUnserved: [OWN_BRIEF_READ],
  // A snapshot is the workspace at its capture: the records the analyzer drills into are captured, any other read is refused, and git history stops there.
  cut: orgCut,
};
