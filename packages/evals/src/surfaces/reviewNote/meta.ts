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
    'when the verdict is approve, the reply is the Ship card a person answers, and that person runs this product but never opened the session that made the change: its question is short and plain, and the card says in plain words what the change does for the people it reaches, what the review saw for itself and what rests on someone else\'s word or went unchecked, with no term, name, path, id or rubric code that only the code or the session explains, and no list of code findings or checked ids on it; when the verdict is changes, the reply is the note the implementer gets, and it says plainly what must change before the branch can ship',
};
