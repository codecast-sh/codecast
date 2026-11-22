// Who wrote a user-role message: a person at a signed-in composer, a person
// at the session's own terminal, or a program. An allowlist that fails
// closed: only the two typed kinds have positive evidence, and anything the
// record cannot vouch for reads as a program.
//
// - typed_composer: the echo's queue row was written by a composer send on a
//   session login (pending_messages.channel, server-set).
// - typed_local: no queue row at all, in a session no program launched, so
//   the only way in was its terminal.
// - program: every other path (API-token sends, forks, spawns, triggers,
//   flow briefs, decision frames, comment briefs, a launched session's
//   opening prompt) and every message whose origin is unclear.
//
// Composer rows written before the channel existed read as program.
import type { Doc } from "../_generated/dataModel";
import { isHostedAgentType, parseDecisionAnswer } from "@codecast/shared/contracts";
import { stickyPromptContent } from "../../../web/lib/stickyPrompt";
import { cleanUserMessage, isBareNudge } from "../../../web/components/sessionMessage";
import { isPressedMessage, isProgramLaunched, isUserMessageNoise } from "./userSend";

export type MessageProvenance = "typed_composer" | "typed_local" | "program";

type ConversationLinks = Pick<
  Doc<"conversations">,
  | "parent_conversation_id"
  | "is_subagent"
  | "spawned_by_conversation_id"
  | "workflow_run_id"
  | "agent_task_id"
  | "cli_flags"
  | "project_path"
  | "forked_from"
  | "agent_type"
>;

/** A program started this session (isProgramLaunched, or a fork's branch). */
export function launchedByProgram(conversation: ConversationLinks): boolean {
  return isProgramLaunched(conversation as Doc<"conversations">) || !!conversation.forked_from;
}

/**
 * `pending` is the queue row the echo adopted (found by the message's
 * client id), or null when there is none.
 */
export function messageProvenance(
  message: { _id: string; client_id?: string; from_user_id?: string },
  pending: { channel?: "composer"; echo_message_id?: string } | null,
  conversation: ConversationLinks,
): MessageProvenance {
  if (pending) {
    // A row that settled onto another message is not this message's row.
    if (pending.echo_message_id && String(pending.echo_message_id) !== String(message._id)) return "program";
    return pending.channel === "composer" ? "typed_composer" : "program";
  }
  // Only a queue row's adoption stamps these, so the message came through a
  // queue whose row is gone or unreadable.
  if (message.client_id || message.from_user_id) return "program";
  // A hosted conversation has no terminal; a launched one's terminal is the launcher's.
  if (isHostedAgentType(conversation.agent_type) || launchedByProgram(conversation)) return "program";
  return "typed_local";
}

/**
 * Whether a user-role message's text could be a person's own words: not
 * machinery (session messages, triggers, task notifications, slash commands
 * and their output, compaction, spawned briefings, interruption notices) and
 * not the product's words for a button press. Bare nudges ("yes", "do it")
 * and decision answers stay: they are how a person says yes.
 */
export function mayBeTyped(content: string | undefined): boolean {
  if (!content?.trim() || isUserMessageNoise(content) || isPressedMessage(content)) return false;
  if (parseDecisionAnswer(content)) return true;
  return stickyPromptContent(content) !== null || isBareNudge(cleanUserMessage(content));
}
