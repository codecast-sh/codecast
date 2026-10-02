import { CALL_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'changes-edition',
  title: "Changes page: a team day's edition from its stories",
  route: 'call',
  // The pin for an ordinary day. prod's editionModel moves a day of more than
  // 40 stories to the strong model, and the replay sends whatever it picks.
  model: CALL_MODEL,
  sources: surfaceSources('changes-edition', 'packages/convex/convex/changesProse.ts', 'packages/convex/convex/lib/anthropic.ts', 'packages/shared/changes', 'packages/evals/src/surfaces/changesCommon.ts'),
  reps: { check: 5 },
  maxUsdPerRep: 0.1,
  criteria: 'the headline and standfirst say what the day was about for the team, the lead is the story a teammate most needs today, and nothing is claimed that the stories do not say',
};
