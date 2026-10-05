import type { RunRow } from '@codecast/shared/contracts/evalsApi';

import { codecastVerdict } from '../commands/verdict';
import { failedControls as failedControlsWith, readProbe as readProbeWith, type Reading } from '../core/bisect';

// How a set of reps reads against the ends of a range (evals-ui.md section 5),
// on codecast's verdict: the rule a bisect probe is classified by, and the
// one attribution reads recorded batches by (core/bisect.ts).

export { crashedFocus, unsureSide } from '../core/bisect';
export type { Reading } from '../core/bisect';

/** How a probe's reps read: flip mode by majority, score mode by separation from the good control. */
export const readProbe = (set: RunRow[], focus: string[], mode: 'flip' | 'score', goodControl: RunRow[]): Reading => readProbeWith(codecastVerdict, set, focus, mode, goodControl);

/** The control freezes a set fails by majority, a tie failing nothing. */
export const failedControls = (set: RunRow[], controls: string[]): string[] => failedControlsWith(codecastVerdict, set, controls);
