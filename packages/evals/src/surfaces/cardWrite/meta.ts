import { PROD_DEFAULT_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'card-write',
  title: "The line's presenter: the one decision a run puts to a person, its page and its report",
  route: 'agent',
  // The station is an agent=claude hand with no model of its own, so it runs the launching person's Claude Code default.
  model: PROD_DEFAULT_MODEL,
  sources: surfaceSources(
    'card-write',
    'packages/cli/src/workflow/templates/line/card_write.md',
    'packages/cli/src/workflow/presenter.md',
    'packages/cli/src/workflow/templates/line.cast',
    'packages/cli/src/workflow/runner.ts',
    'packages/shared/contracts/unattended.ts',
    'packages/shared/contracts/changeCard.ts',
    'packages/cli/src/decisionKit.ts',
    'packages/cli/scripts/lib/linePresent.ts',
    'packages/cli/scripts/line-present-replay-bin/cast',
    'packages/cli/scripts/prompt-dry-run-bin/cast',
  ),
  reps: { check: 8, smoke: 3 },
  // An agent turn that reads the problem, the findings and the diff, then writes a page and posts: about $0.60 on Opus.
  maxUsdPerRep: 1.5,
  criteria:
    'a person who never saw the work can choose from the decision alone: the question is the choice about the people the problem reached, the answers are the courses really open with the lean first, and every case, count and claim on the card and the page comes from the record (the problem, its findings, what the run measured) or from running the change\'s code, which the code shown must bear out, with no result stated stronger than either shows and anything left unverified said plainly',
  // A fixture is the world the station read: every read answers from it, and the decision and the report are recorded, not sent.
  // The problem's own reads are the fixture's to hold (cardWrite.test.ts); the worktree's path is the one read the replay itself must serve. Any other read the record lacks is noted, not zeroed.
  frozenVerbs: ['ws path'],
  cut: { follow: () => [], gitRoots: () => [] },
  allowedRefusals: ['^decide( |$)', '^state( |$)'],
};
