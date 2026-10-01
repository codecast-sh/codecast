import { AGENT_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';
import { ROLE_WAKE_DIR, STANDING_READS } from '../roleWake/meta';

export const meta: SurfaceMeta = {
  id: 'anchor-brief',
  title: 'Anchor and role opening briefing',
  route: 'agent',
  // A freeze runs on the production session's model when its capture could read one (replay.ts).
  model: AGENT_MODEL,
  // Real freezes replay the opening prod sent; fixtures render bootstrapMessage
  // (and through it roleOpeningMessage) from the tree.
  sources: surfaceSources('anchor-brief', 'packages/convex/convex/anchors.ts', 'packages/shared/contracts/headOfPeoplePrompt.ts', ROLE_WAKE_DIR, 'packages/evals/src/served.ts', 'packages/cli/scripts/prompt-dry-run-bin/cast'),
  reps: { check: 8, smoke: 3 },
  maxUsdPerRep: 1.5,
  criteria: 'the opening turn orients the role to its scope and does no writes',
  ...STANDING_READS,
};
