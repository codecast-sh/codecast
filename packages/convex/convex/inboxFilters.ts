import type { Doc } from "./_generated/dataModel";

export type ConversationDoc = Doc<"conversations">;

export const NOISE_TITLE_PREFIXES = ["[Using:", "[Request", "[SUGGESTION MODE:"] as const;

export function isNoiseTitle(title: string | undefined): boolean {
  const t = title?.trim() || "";
  if (!t) return false;
  if (t.toLowerCase() === "warmup") return true;
  return NOISE_TITLE_PREFIXES.some((p) => t.startsWith(p));
}

export function isOrphanOrSubagent(conv: ConversationDoc): boolean {
  if (conv.is_subagent === true) return true;
  if (conv.is_workflow_sub === true) return true;
  if (conv.parent_conversation_id && !conv.parent_message_uuid) return true;
  return false;
}

// `inbox_dismissed_at` is an absolute flag: a truthy value means dismissed until
// a user action clears it. Never compare it against `updated_at`. See
// schema.ts for the list of mutations allowed to clear it.
//
// Dismissed conversations are still part of the inbox — clients categorize them
// into a separate bucket via the `inbox_dismissed_at` field on each result.
export function shouldShowInInbox(conv: ConversationDoc): boolean {
  if (isOrphanOrSubagent(conv)) return false;
  if (conv.status === "completed" && conv.message_count === 0) return false;
  if (isNoiseTitle(conv.title)) return false;
  if (conv.inbox_killed_at) return false;
  return true;
}
