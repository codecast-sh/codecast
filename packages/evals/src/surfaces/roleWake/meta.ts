import { AGENT_MODEL } from '../../models';
import { OWN_BRIEF_EDIT, surfaceSources, type SurfaceMeta } from '../../surface';

// What a role reads from its standing session, captured by `./evals snapshot`
// and served back to the replay. The role's own `cast brief` is captured as
// `brief @{role}` (a bare read from the role's session moves its brief clock)
// and served under the argv the role types; `org review` likewise without
// --team, since a role's session defaults to its own workspace. anchor-brief
// shares the list: an opening turn reads the same world.
export const STANDING_READS: Pick<SurfaceMeta, 'frozenReads' | 'frozenVerbs' | 'servedAliases'> = {
  frozenReads: [
    ['brief', '@{role}'],
    ['brief', '@{role}', '--json'],
    ['org', 'inputs', '--team', '{team}', '--json'],
    ['org', 'health', '--team', '{team}', '--json'],
    ['org', 'ls', '--team', '{team}', '--json'],
    ['org', 'ls', '--team', '{team}'],
    // A bare `cast org` prints the CLI's usage; captured so the frozen verb answers it.
    ['org'],
    ['sessions'],
    ['sessions', '--json'],
    ['org', 'review', '--team', '{team}'],
  ],
  frozenVerbs: ['brief', 'org', 'sessions'],
  servedAliases: [
    { serve: ['brief'], from: ['brief', '@{role}'] },
    { serve: ['brief', '--json'], from: ['brief', '@{role}', '--json'] },
    { serve: ['org', 'review'], from: ['org', 'review', '--team', '{team}'] },
    { serve: ['org', 'ls'], from: ['org', 'ls', '--team', '{team}'] },
  ],
};

/** Where the shared standing-session code lives, so anchor-brief declares it as a source too. */
export const ROLE_WAKE_DIR = 'packages/evals/src/surfaces/roleWake';

export const meta: SurfaceMeta = {
  id: 'role-wake',
  title: 'Role wake frame',
  route: 'agent',
  // A freeze runs on the production session's model when its capture could read one (replay.ts).
  model: AGENT_MODEL,
  // A role's trigger runs inline in its standing session, so its frame is the
  // server's inject frame (agentTasks.triggerFrameFor over formatScheduledTask),
  // never buildTriggerFrame, which frames a spawned run. Real freezes replay
  // the frame prod built; fixtures render it from the tree.
  sources: surfaceSources('role-wake', 'packages/shared/contracts/machineMessages.ts', 'packages/convex/convex/lib/orgRoutine.ts', 'packages/shared/contracts/briefStanding.ts', 'packages/shared/contracts/rolePlaybook.ts', 'packages/cli/src/briefLines.ts', 'packages/evals/src/served.ts', 'packages/cli/scripts/prompt-dry-run-bin/cast'),
  reps: { check: 8, smoke: 3 },
  maxUsdPerRep: 1.5,
  criteria: 'asks a person only what needs them; each line names evidence',
  ...STANDING_READS,
  // A stashed session's frame tells the role to declare its state, and every check ends by saving its brief; those writes are the frame's, not the role's choice.
  // Its own check is the role's to tune (org-staffing.md S38); whether a tune was right is the fixture's wake-tune gate.
  allowedRefusals: ['^state ', OWN_BRIEF_EDIT, '^role tune( |$)'],
};
