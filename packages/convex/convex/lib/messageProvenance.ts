// Who wrote a user-role message: a person at a signed-in composer, a person
// at the session's own terminal, or a program. An allowlist that fails
// closed: only the two typed kinds have positive evidence, and anything the
// record cannot vouch for reads as a program.
//
// - typed_composer: the echo's queue row was written by a composer send on a
//   session login (pending_messages.channel, server-set) that handed over the
//   words the person typed (pending_messages.typed_text).
// - typed_local: no queue row at all, no queue row anywhere in the session
//   with the same words, in a session no program launched or handed over, so
//   the only way in was its terminal.
// - program: every other path (API-token sends, forks, spawns, handoffs,
//   triggers, flow briefs, decision frames, comment briefs, joint sends, a
//   launched session's opening prompt) and every message whose origin is
//   unclear.
//
// Only a message's typed part (typedPart) is a person's: quotes, mention
// context and attachments the composer folded in, and blocks pasted at the
// terminal, are not.
import type { Doc } from "../_generated/dataModel";
import { canonicalSlashCommand, isHostedAgentType, parseDecisionAnswer, stripMentionContext, stripPastedContent } from "@codecast/shared/contracts";
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
  | "handed_off_from_conversation_id"
  | "agent_type"
>;

/** A program started this session (isProgramLaunched, a fork's branch, or a session another one handed its work to). */
export function launchedByProgram(conversation: ConversationLinks): boolean {
  return isProgramLaunched(conversation as Doc<"conversations">) || !!conversation.forked_from || !!conversation.handed_off_from_conversation_id;
}

/**
 * `pending` is the queue row the echo adopted (found by the message's client
 * id), or null when there is none. `queuedSame`: some queue row of the
 * session, in any status, holds the same words (queuedTwin), so an echo the
 * queue never matched to its row still reads as that row's.
 */
export function messageProvenance(
  message: { _id: string; client_id?: string; from_user_id?: string },
  pending: { channel?: "composer"; typed_text?: string; echo_message_id?: string } | null,
  conversation: ConversationLinks,
  queuedSame = false,
): MessageProvenance {
  if (pending) {
    // A row that settled onto another message is not this message's row.
    if (pending.echo_message_id && String(pending.echo_message_id) !== String(message._id)) return "program";
    return pending.channel === "composer" && pending.typed_text?.trim() ? "typed_composer" : "program";
  }
  // Only a queue row's adoption stamps these, so the message came through a
  // queue whose row is gone or unreadable.
  if (message.client_id || message.from_user_id) return "program";
  if (queuedSame) return "program";
  // A hosted conversation has no terminal; a launched one's terminal is the launcher's.
  if (isHostedAgentType(conversation.agent_type) || launchedByProgram(conversation)) return "program";
  return "typed_local";
}

// A pasted block, closed. One left open cannot be told from what follows it.
const PASTED_BLOCK_RE = /<pasted_content(?=[\s>])[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g;

/** A slash command as Claude Code records it, or as the queue carried it: "/name args". */
function slashInvocation(content: string): string | null {
  const t = content.trim();
  return /^<command-(?:name|message)>/.test(t) || t.startsWith("/") ? canonicalSlashCommand(t) : null;
}

/**
 * The words of a typed message that are its person's own, or null when none
 * are or they cannot be told apart. A composer send's are the words it handed
 * over with the send (pending_messages.typed_text), never the quotes, mention
 * context or attachments it folded around them. A terminal line's are its text
 * with each pasted block and mention context taken out; a paste left open
 * makes the whole line unreadable. A slash command reads as "/name args", its
 * expansion never.
 */
export function typedPart(content: string, provenance: MessageProvenance, pending: { typed_text?: string } | null): string | null {
  if (provenance === "program") return null;
  if (provenance === "typed_composer") return pending?.typed_text?.trim() || null;
  const command = slashInvocation(content);
  if (command) return command;
  const unpasted = content.replace(PASTED_BLOCK_RE, "");
  if (unpasted.includes("<pasted_content")) return null;
  return stripMentionContext(unpasted).trim() || null;
}

/** Words as two sends of them compare: paste markers and whitespace folded, a slash command in one shape. */
export function sameWordsKey(text: string): string {
  return (slashInvocation(text) ?? stripPastedContent(text)).replace(/\s+/g, " ").trim();
}

/**
 * Whether a session's queue rows hold the words of `content`: the same words,
 * or a row of 20 characters or more inside it. Fails toward program: a person
 * who typed what a program had queued reads as that program.
 */
export function queuedTwin(content: string, queuedKeys: ReadonlySet<string>): boolean {
  const key = sameWordsKey(content);
  if (!key) return false;
  if (queuedKeys.has(key)) return true;
  for (const q of queuedKeys) if (q.length >= 20 && key.includes(q)) return true;
  return false;
}

/**
 * Whether a user-role message's text could be a person's own words: not
 * machinery (session messages, triggers, task notifications, command output,
 * compaction, spawned briefings, interruption notices) and not the product's
 * words for a button press. A slash command a person typed stays ("/drive
 * ..." is how a person asks for the work to ship); its expansion never. Bare
 * nudges ("yes", "do it") and decision answers stay: they are how a person
 * says yes.
 */
export function mayBeTyped(content: string | undefined): boolean {
  if (!content?.trim()) return false;
  if (slashInvocation(content)) return true;
  if (isUserMessageNoise(content) || isPressedMessage(content)) return false;
  if (parseDecisionAnswer(content)) return true;
  return stickyPromptContent(content) !== null || isBareNudge(cleanUserMessage(content));
}
