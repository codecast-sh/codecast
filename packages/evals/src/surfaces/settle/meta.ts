import { CALL_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'settle',
  title: 'Settle: is the session done, waiting or working',
  route: 'call',
  model: CALL_MODEL,
  maxTokens: 200,
  prodTemperature: 0,
  sources: surfaceSources('settle', 'packages/convex/convex/idleSummary.ts', 'packages/convex/convex/lib/anthropic.ts'),
  reps: { check: 5 },
  maxUsdPerRep: 0.03,
  criteria: null,
};
