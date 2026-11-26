import { STRONG_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'automatic-review',
  title: "Codecast's automatic review of a pull request no run is behind: is the change a mechanism",
  route: 'call',
  // lib/automaticReview.ts AUTOMATIC_REVIEW_MODEL is STRONG_MODEL.
  model: STRONG_MODEL,
  sources: surfaceSources('automatic-review', 'packages/convex/convex/lib/automaticReview.ts', 'packages/convex/convex/lib/anthropic.ts'),
  reps: { check: 5 },
  // One strong call; the server's prompt cap (120,000 characters, about 35,000 tokens) bounds it near $0.08.
  maxUsdPerRep: 0.08,
  criteria: null,
};
