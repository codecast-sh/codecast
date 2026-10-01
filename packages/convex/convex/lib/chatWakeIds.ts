// The client_id a chat wake's pending_messages row carries, so a retried
// send never queues the same wake twice. chat.ts writes them; the multiplayer
// sim's invariants read them back, so both go through here.
//
//   chat-mention:<message>:<target>  a line's mention woke a role or a session
//   chat-relay:<message>             a thread reply relayed into the session it answers

const MENTION = "chat-mention:";
const RELAY = "chat-relay:";

export const chatMentionClientId = (messageId: string, targetId: string) => `${MENTION}${messageId}:${targetId}`;
export const chatRelayClientId = (messageId: string) => `${RELAY}${messageId}`;

/** The line and the woken role or session a mention wake names; null for any other client_id. */
export function parseChatMentionClientId(clientId: unknown): { message: string; target: string } | null {
  if (typeof clientId !== "string" || !clientId.startsWith(MENTION)) return null;
  const [message = "", target = ""] = clientId.slice(MENTION.length).split(":");
  return { message, target };
}

/** The line a relay wake carries; null for any other client_id. */
export function parseChatRelayClientId(clientId: unknown): string | null {
  return typeof clientId === "string" && clientId.startsWith(RELAY) ? clientId.slice(RELAY.length) : null;
}
