// The model pins. Call surfaces run on the model prod calls with, imported
// from its one home, so a prod model change moves the evals with it.
export { CHEAP_MODEL as CALL_MODEL } from '../../convex/convex/lib/anthropic';

/** Grades a reply against a freeze's criteria. Never changes with --model. */
export const JUDGE_MODEL = 'claude-sonnet-5-5';
/** Runs the agent surfaces when the production session's model is unknown: fixtures, and freezes whose capture read none. */
export const AGENT_MODEL = 'claude-sonnet-5-5';
/**
 * What a session prod launches with no --model runs on: the launching
 * person's Claude Code default (`"model": "opus"` in the founder's
 * ~/.claude/settings.json). `cast org review` spawns the analyzer that way
 * (orgInitRun.ts), so org-review replays on it. Move it when that default moves.
 */
export const PROD_DEFAULT_MODEL = 'claude-opus-5-5';
