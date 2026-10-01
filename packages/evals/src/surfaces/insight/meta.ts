import { CALL_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'insight',
  title: 'Session insight: goal, blockers, next action',
  route: 'call',
  model: CALL_MODEL,
  maxTokens: 1200,
  prodTemperature: 'api-default',
  sources: surfaceSources('insight', 'packages/convex/convex/sessionInsights.ts', 'packages/convex/convex/lib/anthropic.ts'),
  reps: { check: 5 },
  maxUsdPerRep: 0.04,
  criteria: "the headline and each turn are supported by the transcript: every ask is the user's, every did item happened",
};
