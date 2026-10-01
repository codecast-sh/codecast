import { CALL_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'title',
  title: 'Session title and short title',
  route: 'call',
  model: CALL_MODEL,
  maxTokens: 400,
  prodTemperature: 0,
  sources: surfaceSources('title', 'packages/convex/convex/titleGeneration.ts', 'packages/convex/convex/lib/anthropic.ts'),
  reps: { check: 5 },
  maxUsdPerRep: 0.03,
  criteria: 'names what the session is actually doing at this point, specific enough to find it later',
};
