import { AGENT_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'org-review',
  title: 'Org analyzer review',
  route: 'agent',
  // The role and anchor surfaces pin the production session's model when the resolver can read it.
  model: AGENT_MODEL,
  // orgInitRun.ts only wraps chiefOfStaffPrompt.ts, which holds the analyzer's text; orgProposal.ts is the spec spec-parses grades against.
  sources: surfaceSources(
    'org-review',
    'packages/shared/contracts/chiefOfStaffPrompt.ts',
    'packages/shared/contracts/orgProposal.ts',
    'packages/cli/src/orgInitRun.ts',
    'packages/cli/src/orgInit.ts',
    'packages/cli/scripts/prompt-dry-run-bin/cast',
  ),
  reps: { check: 8, smoke: 3 },
  maxUsdPerRep: 2.5,
  criteria: null,
  frozenReads: [['org', 'inputs', '--team', '{team}', '--json'], ['org', 'health', '--team', '{team}', '--json'], ['org', 'ls', '--team', '{team}', '--json']],
  frozenVerbs: ['org'],
};
