/**
 * The Run group: one rep in full (verdict, moment, and the host's own tabs),
 * its gates and judged checks or, before a score, the rubric it will be held
 * to; the run's problems in its header; the cost track the surface page draws
 * under its chart; and the Timeline a host shows a run's story in.
 * `runPages` names the pages EvalsApp routes to.
 */
import type { EvalsPages } from '../host';
import { RunPage } from './RunPage';

export { RunView, type RunViewProps } from './RunView';
export { GateList, RubricGates, AnchorLink, type AnchorProps } from './GateList';
export { JudgeChecks, RubricChecks, RubricCard, MissedFloors, ScoreHistory, JudgeCall } from './JudgeChecks';
export { CostTrack } from './CostTrack';
export { Timeline, type TimelineItem, type TimelineProps, type TimelineTone } from './Timeline';
export { RunPage } from './RunPage';

export const runPages: EvalsPages = { run: RunPage };
