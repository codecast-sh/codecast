import { PROSE_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'changes-story',
  title: 'Changes page: one story from its commits and gated sessions',
  route: 'call',
  model: PROSE_MODEL,
  // changesProse.ts builds and parses the request; shared/changes holds the
  // length limits, clip and the skip rule's subject parsing; changesCommon.ts
  // holds the leak and em dash gates.
  sources: surfaceSources('changes-story', 'packages/convex/convex/changesProse.ts', 'packages/convex/convex/lib/anthropic.ts', 'packages/shared/changes', 'packages/evals/src/surfaces/changesCommon.ts'),
  reps: { check: 5 },
  maxUsdPerRep: 0.03,
  criteria: 'says what changed for the people who use or build the product in plain words, every claim is supported by the inputs, and a reason is given only where an input states one',
};
