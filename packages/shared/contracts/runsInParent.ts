// Whether a session runs inside its parent's process: one stored fact,
// conversations.runs_in_parent, read by every process gate (revive selection,
// limit recovery, hibernation, the close cascade) on the server and the web.
// Kept out of the contracts barrel, beside closeCascade, which reads it.
import { isClaudeSubagentSessionId } from "./claudeSubagentSession";

export type RunsInParentFacts = {
  runs_in_parent?: boolean | null;
  session_id?: string | null;
  agent_type?: string | null;
  parent_conversation_id?: unknown;
  spawned_by_conversation_id?: unknown;
  cli_flags?: string | null;
  headless_launch?: boolean | null;
};

/** This session has no process of its own: it runs inside its parent's. */
export function runsInParentProcess(row: RunsInParentFacts): boolean {
  return row.runs_in_parent ?? legacyRunsInParent(row);
}

/** The answer for a row written before runs_in_parent existed: a Claude Code
 *  subagent transcript (an agent-<hex> session id), or a codex child the
 *  daemon linked from its lead's own transcript, stamped --print (a
 *  thread_spawn thread inside the lead's process, or a `codex exec` the lead
 *  ran). A codex child started through /cli/spawn carries no --print and runs
 *  its own process. runsInParentBackfill writes this onto every legacy row. */
export function legacyRunsInParent(row: RunsInParentFacts): boolean {
  if (row.session_id && isClaudeSubagentSessionId(row.session_id)) return true;
  return row.agent_type === "codex" && !!row.parent_conversation_id && !row.spawned_by_conversation_id && launchedHeadless(row);
}

/** The session was launched as a program (its cli_flags carry --print). Only
 *  the server holds cli_flags: every row it sends a client carries this
 *  verdict instead, as headless_launch (convex conversations.ts row builders,
 *  syncLog buildCargo), so both sides answer from the one rule. */
export function launchedHeadless(row: { cli_flags?: string | null; headless_launch?: boolean | null }): boolean {
  if (typeof row.headless_launch === "boolean") return row.headless_launch;
  return /(^|\s)--print(\s|$)/.test(row.cli_flags ?? "");
}
