import { CALL_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'call-summary',
  title: 'Call summary and action items',
  route: 'call',
  model: CALL_MODEL,
  sources: surfaceSources('call-summary', 'packages/convex/convex/transcripts.ts', 'packages/convex/convex/lib/anthropic.ts'),
  reps: { check: 5 },
  maxUsdPerRep: 0.04,
  criteria: 'action items are real commitments from the transcript, with owners where stated',
};
