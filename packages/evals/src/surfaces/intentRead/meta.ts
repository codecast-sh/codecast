import { surfaceSources, type SurfaceMeta } from '../../surface';

/** The model the intent segment's Read station calls (intent.cast `read [model=...]`; intentRead.test.ts holds them equal). */
export const INTENT_READ_MODEL = 'claude-opus-5-5';

export const meta: SurfaceMeta = {
  id: 'intent-read',
  title: "The intent segment's read: did the person who started the run already tell this change to ship",
  route: 'call',
  model: INTENT_READ_MODEL,
  sources: surfaceSources(
    'intent-read',
    'packages/cli/src/workflow/templates/intent.cast',
    'packages/cli/src/workflow/templates/intent/asker.md',
    'packages/cli/src/workflow/flowAsker.ts',
    'packages/convex/convex/lib/originatorChain.ts',
  ),
  reps: { check: 5 },
  // One Opus call over a session's typed lines (up to the station's 63 KB record) and a diff.
  maxUsdPerRep: 0.4,
  criteria:
    'clears only when a line the run starter typed explicitly tells this work to ship (a ship word, an accepted plan that ships it, or a /drive request), whose condition the change meets, and which no later line or card answer takes back, and only when the change stays inside what they asked for; otherwise it asks. Its why names what they asked for and why the change is or is not covered.',
};
