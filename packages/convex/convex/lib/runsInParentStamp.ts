// Where conversations.runs_in_parent is written on a session's own row: at
// create (the daemon's word, else the legacy rule an older daemon leaves to the
// server) and when the daemon rebinds a promoted subagent to a UUID of its own
// (subagentPromotion.ts). Every process gate reads it through the shared
// runsInParentProcess. Kept out of conversations.ts for its line cap.
import { launchedHeadless, legacyRunsInParent, runsInParentProcess } from "@codecast/shared/contracts/runsInParent";

/** The value a new conversation is born with. A fork carries its parent
 *  message and is never a subagent, whatever its id. */
export function runsInParentAtCreate(args: { runs_in_parent?: boolean; parent_message_uuid?: string; agent_type: string; session_id: string; cli_flags?: string }, parentConversationId: unknown): boolean {
  return args.runs_in_parent ?? (!args.parent_message_uuid &&
    legacyRunsInParent({ agent_type: args.agent_type, session_id: args.session_id, parent_conversation_id: parentConversationId, cli_flags: args.cli_flags }));
}

/** A Claude Code subagent moved off its `agent-` id onto one of its own (the
 *  daemon resumed it as its own process): it no longer runs in its parent's. */
export function rebindRunsInParentPatch(conv: { agent_type?: string; session_id?: string }, sessionId: string): { runs_in_parent?: false } {
  const subagentId = (id: string) => conv.agent_type === "claude_code" && legacyRunsInParent({ agent_type: conv.agent_type, session_id: id });
  return subagentId(conv.session_id ?? "") && !subagentId(sessionId) ? { runs_in_parent: false } : {};
}

/** The process facts every inbox row carries (a listed row and a subagent
 *  child row alike): launched as a program, the server's verdict on cli_flags
 *  --print, which it never sends (what a close of its lead reads, shared
 *  goesDownWithLead); runs inside its parent's process, legacy rows resolved
 *  (every process gate); and when a person took it over from its parent, on or
 *  off the owners model (who hears it, shared answersToParent). */
export function processRowFields(conv: Parameters<typeof runsInParentProcess>[0] & { parent_released_at?: number | null }) {
  return { headless_launch: launchedHeadless(conv), runs_in_parent: runsInParentProcess(conv), parent_released_at: conv.parent_released_at ?? null };
}
