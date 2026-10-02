import { CALL_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'settle',
  title: 'Settle: is the session done, waiting or working',
  route: 'call',
  model: CALL_MODEL,
  // titleGeneration.ts holds isLowSignalPrompt, which decides which rows reach the prompt, and it reads machineMessages.ts.
  sources: surfaceSources('settle', 'packages/convex/convex/idleSummary.ts', 'packages/convex/convex/lib/anthropic.ts', 'packages/convex/convex/titleGeneration.ts', 'packages/shared/contracts/machineMessages.ts'),
  reps: { check: 5 },
  maxUsdPerRep: 0.03,
  criteria: null,
};
