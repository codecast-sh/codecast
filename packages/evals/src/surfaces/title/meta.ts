import { CALL_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'title',
  title: 'Session title and short title',
  route: 'call',
  model: CALL_MODEL,
  // Sources are every module that shapes the prompt or a gate, imported ones
  // included: fence.ts fences the transcript, machineMessages.ts strips
  // harness frames, idleSummary.ts holds the no-refusal gate's isRefusalProse.
  sources: surfaceSources('title', 'packages/convex/convex/titleGeneration.ts', 'packages/convex/convex/lib/anthropic.ts', 'packages/shared/contracts/fence.ts', 'platform/packages/fence/src/index.ts', 'packages/shared/contracts/machineMessages.ts', 'packages/convex/convex/idleSummary.ts'),
  reps: { check: 5 },
  maxUsdPerRep: 0.03,
  criteria: 'names what the session is actually doing at this point, specific enough to find it later',
};
