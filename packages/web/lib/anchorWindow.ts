// The window an embedded standing conversation shows (AnchorConversation):
// the messages from a cut on, and where that cut falls. Pure, so the rules
// test without React.

import { isBootstrapPrompt } from "@codecast/shared/contracts";

export type WindowedConversation = { messages?: Array<{ timestamp: number; role?: string; content?: unknown }>; loaded_start_index?: number } & Record<string, unknown>;

/** The conversation from `since` on. `reachedStart` is true once a loaded
 *  message is older than the cut: everything the window can hold is here, so
 *  the view stops asking for older pages. The same object back when nothing
 *  is cut, so the view's memo holds. */
export function windowConversationSince<T extends WindowedConversation>(conversation: T | null | undefined, since: number | undefined): { conversation: T; reachedStart: boolean } | null {
  if (!conversation) return null;
  const messages = conversation.messages ?? [];
  const cut = since === undefined ? 0 : messages.findIndex((m) => m.timestamp >= since);
  const dropped = cut === -1 ? messages.length : cut;
  if (dropped === 0) return { conversation, reachedStart: false };
  return { conversation: { ...conversation, messages: messages.slice(dropped), loaded_start_index: (conversation.loaded_start_index ?? 0) + dropped }, reachedStart: true };
}

/** The provisioning prompt, known by its own first line: the ONE shared
 *  recogniser (isBootstrapPrompt, @codecast/shared machineMessages), which the
 *  inbox card's preview and the sticky prompt header also consult, applied to
 *  a message object here. */
export function isBootstrapMessage(m: { role?: string; content?: unknown } | undefined): boolean {
  if (!m || (m.role && m.role !== "user")) return false;
  const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join("") : "";
  return isBootstrapPrompt(text);
}

/** Where to cut: just after the last provisioning prompt in the loaded
 *  window. A seat seated on an existing agent (org-staffing.md S16) carries
 *  the prompt mid-history, and the thread as this role starts there; a fresh
 *  seat carries it first. A prompt with nothing after it cuts itself, so the
 *  page opens on the lead alone. Undefined when the window holds no prompt
 *  (older pages not loaded yet, or a session that never had one). */
export function bootstrapCut(conversation: WindowedConversation | null | undefined): number | undefined {
  const messages = conversation?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isBootstrapMessage(messages[i])) continue;
    return messages[i + 1]?.timestamp ?? messages[i].timestamp + 1;
  }
  return undefined;
}
