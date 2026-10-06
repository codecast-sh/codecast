import { PROD_DEFAULT_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'guidance',
  title: 'The codecast guidance an install writes into CLAUDE.md',
  route: 'agent',
  // People's sessions run on their Claude Code default, which is what reads this file.
  model: PROD_DEFAULT_MODEL,
  sources: surfaceSources('guidance', 'packages/shared/contracts/snippets.ts'),
  reps: { check: 8, smoke: 3 },
  maxUsdPerRep: 1.5,
  criteria: 'the agent reaches for the codecast tool the guidance names for this request',
  // The writes are the behavior under test: the guard refuses and records each, and the checks read them.
  allowedRefusals: ['.*'],
};
