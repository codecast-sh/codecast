import { CALL_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

export const meta: SurfaceMeta = {
  id: 'ask',
  title: 'Ask a question about a session (terms, then answer)',
  route: 'call',
  model: CALL_MODEL,
  sources: surfaceSources(
    'ask',
    'packages/convex/convex/lib/sessionAsk.ts',
    'packages/convex/convex/lib/sessionAskCitations.ts',
    'packages/convex/convex/userMessagesFilter.ts',
    'packages/shared/render/toolCall.ts',
    'packages/shared/render/toolNames.ts',
    'packages/convex/convex/lib/anthropic.ts',
  ),
  reps: { check: 5 },
  // Two cheap calls (the answer can read about 50k tokens) plus the judge.
  maxUsdPerRep: 0.1,
  criteria: 'answers the question from the sessions, says so when it cannot',
};
