// The model pins. Call surfaces run on the model prod calls with, imported
// from its one home, so a prod model change moves the evals with it.
export { CHEAP_MODEL as CALL_MODEL } from '../../convex/convex/lib/anthropic';

/** Grades a reply against a freeze's criteria. Never changes with --model. */
export const JUDGE_MODEL = 'claude-sonnet-5-5';
/** Runs the agent surfaces when the production session's model is unknown. */
export const AGENT_MODEL = 'claude-sonnet-5-5';
