import { CALL_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'suggest',
  title: 'Composer suggestions (anthropic branch)',
  route: 'call',
  model: CALL_MODEL,
  maxTokens: 1200,
  prodTemperature: 0.3,
  sources: surfaceSources('suggest', 'packages/convex/convex/composerSuggestions.ts', 'packages/convex/convex/lib/anthropic.ts'),
  reps: { check: 5 },
  maxUsdPerRep: 0.06,
  criteria: null,
};
