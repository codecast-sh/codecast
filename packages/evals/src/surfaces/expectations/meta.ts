import { AGENT_MODEL } from '../../models';
import { surfaceSources, type SurfaceMeta } from '../../surface';

/** The routine's prompt, as the line org template ships it (the-line-model.md LM5). */
export const PROMPT_REL = 'packages/cli/org-templates/line/org/prompts/expectations-daily.md';

export const meta: SurfaceMeta = {
  id: 'expectations',
  title: "A project's daily expectations pass",
  route: 'agent',
  model: AGENT_MODEL,
  sources: surfaceSources('expectations', PROMPT_REL, 'packages/shared/contracts/expectations.ts', 'packages/cli/src/expectationsCommand.ts', 'packages/evals/src/served.ts', 'packages/cli/scripts/prompt-dry-run-bin/cast'),
  reps: { check: 8, smoke: 3 },
  maxUsdPerRep: 2,
  criteria: 'the proposal holds only changes a person ruled in the window, each quoting their words',
  // A fixture is a world cut at its capture: a read it does not hold is
  // refused like any read past a capture, and only the document itself must
  // be served.
  frozenVerbs: ['expectations show'],
  cut: { follow: () => [], gitRoots: () => [] },
  // The pass submits its proposal and records its ledger line; the guard
  // refuses both here, and the proposal file is what the run is graded on.
  allowedRefusals: ['^expectations propose', '(^| )ledger( |$)'],
};
