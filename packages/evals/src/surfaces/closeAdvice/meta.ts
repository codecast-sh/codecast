import { CALL_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'close-advice',
  title: 'Close advice: does closing this quiet session lose anything',
  route: 'call',
  model: CALL_MODEL,
  // The replay runs prod's gather over the frozen docs, so the facts, the transcript shaper and the Close decision all shape the prompt.
  sources: surfaceSources(
    'close-advice',
    'packages/convex/convex/closeAdvice.ts',
    'packages/convex/convex/idleSummary.ts',
    'packages/convex/convex/lib/closeAside.ts',
    'packages/convex/convex/lib/anthropic.ts',
    'packages/convex/convex/titleGeneration.ts',
    'packages/shared/contracts/closeKind.ts',
    'packages/shared/contracts/armedTrigger.ts',
    'packages/shared/contracts/closedSession.ts',
    'packages/shared/contracts/inboxPlacement.ts',
    'packages/shared/contracts/machineMessages.ts',
  ),
  reps: { check: 5 },
  maxUsdPerRep: 0.01,
  criteria: null,
};
