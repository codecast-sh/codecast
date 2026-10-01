import { CALL_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'handoff',
  title: 'Handoff brief',
  route: 'call',
  model: CALL_MODEL,
  sources: surfaceSources(
    'handoff',
    'packages/convex/convex/handoff.ts',
    'packages/convex/convex/idleSummary.ts',
    'packages/convex/convex/titleGeneration.ts',
    'packages/shared/contracts/handoffPrompt.ts',
    'packages/convex/convex/lib/anthropic.ts',
  ),
  reps: { check: 5 },
  maxUsdPerRep: 0.06,
  criteria: 'a cold reader can continue: decisions, state, next steps',
};
