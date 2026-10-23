import { PROD_DEFAULT_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'decide',
  title: 'A decision an agent puts to its person with cast decide, read cold',
  route: 'call',
  // The asking session runs on the person's Claude Code default.
  model: PROD_DEFAULT_MODEL,
  sources: surfaceSources('decide', 'packages/shared/contracts/snippets.ts', 'packages/cli/src/decideCommand.ts'),
  reps: { check: 5 },
  // One Opus call over up to ~45k tokens of session, plus two Sonnet graders.
  maxUsdPerRep: 1.2,
  criteria:
    'a person who runs this product but never saw the session can tell from the card alone, reading it once, what is being decided and why it matters to the people it affects, what each answer would do, and which answer the agent favours and why; it says so directly in plain words, with no term, name, id or reference that only the session explains',
};
