// The window an embedded standing conversation shows (AnchorConversation):
// the messages from a cut on, and where that cut falls. Pure, so the rules
// test without React.

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

/** The provisioning prompt opens "You are **<name>**, the standing agent for"
 *  or "..., the **team** anchor" (convex anchors.ts bootstrapMessage); it is
 *  an ordinary message from the host, so its own first line is the mark. */
export function isBootstrapMessage(m: { role?: string; content?: unknown } | undefined): boolean {
  if (!m || (m.role && m.role !== "user")) return false;
  const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join("") : "";
  return /^\s*You are \*\*[^*]+\*\*, the (standing agent for|\*\*(team|personal)\*\* anchor)/.test(text);
}

/** Where to cut when the loaded window starts on the provisioning prompt:
 *  the first message after it. Undefined when the window starts elsewhere
 *  (an older page not loaded yet, or a session that never had one) or when
 *  the prompt is all there is, so nothing else is ever hidden. */
export function bootstrapCut(conversation: WindowedConversation | null | undefined): number | undefined {
  const messages = conversation?.messages ?? [];
  if ((conversation?.loaded_start_index ?? 0) !== 0 || !isBootstrapMessage(messages[0])) return undefined;
  return messages[1]?.timestamp;
}
