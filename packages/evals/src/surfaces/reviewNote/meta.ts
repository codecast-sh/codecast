import { PROD_DEFAULT_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'review-note',
  title: "The reviewer's verdict note, which the change flow's Ship card shows its person as the card's document",
  route: 'call',
  // The review station is an agent=claude hand with no model of its own, so it runs the launching person's Claude Code default.
  model: PROD_DEFAULT_MODEL,
  sources: surfaceSources('review-note', 'packages/cli/src/workflow/templates/line/review.md', 'packages/cli/src/workflow/templates/decide.cast'),
  reps: { check: 5 },
  // One Opus call over up to ~45k tokens of review session, plus two Sonnet graders.
  maxUsdPerRep: 1.2,
  // Reruns when its prompt changes, not nightly.
  standingRuns: false,
  criteria:
    'a person who runs this product but never opened the session that made the change can answer the Ship card from the card alone: it opens by saying in plain words what the change does for the people it reaches and what the review found, before any review detail, with no term, name, path or id that only the code or the session explains; and the review itself (the verdict, every finding line and what was checked) is still there below for whoever needs it',
};
