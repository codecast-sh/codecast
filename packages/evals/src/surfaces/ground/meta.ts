import { STRONG_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'ground',
  title: "The line's ground step: the goal a cause threatens, its kind of work, risk and readiness",
  route: 'call',
  model: STRONG_MODEL,
  // ground.md carries goalsBrief.ts's three blocks verbatim (groundPrompt.test.ts), so a change to the node's text is a change to this surface's definition.
  sources: surfaceSources('ground', 'packages/shared/contracts/goalsBrief.ts', 'packages/shared/contracts/initiative.ts', 'packages/convex/convex/lineGround.ts', 'packages/convex/convex/lib/anthropic.ts', 'packages/cli/src/workflow/templates/line/ground.md'),
  reps: { check: 5 },
  // One strong call over a cause and a brief of a few projects; it thinks before it answers.
  maxUsdPerRep: 0.05,
  criteria: null,
};
