// Cross-window bridge for the compose popup.
//
// The floating "New Session" palette is a SEPARATE Electron window with its own
// store, so a first message sent from it can't paint an optimistic bubble in the
// MAIN window directly. For "send & open" (Cmd+Enter) the popup broadcasts the
// {conversationId, content, clientId} of the send it ALREADY dispatched; the main
// window seeds an optimistic bubble with that SAME clientId, so the message shows
// instantly and still dedupes against the server echo (whose client_id matches).
//
// There is NO second send here — delivery stays on the popup's single durable
// outbox path, so a missed broadcast (e.g. the main window was closed) degrades to
// the server pending_messages rail, never to a lost message. Same-origin only
// (palette + main share an origin); BroadcastChannel never crosses it.

export type ComposeOptimistic = { conversationId: string; content: string; clientId: string };

const CHANNEL = "codecast-compose-optimistic";

function open(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  try { return new BroadcastChannel(CHANNEL); } catch { return null; }
}

export function broadcastComposeOptimistic(info: ComposeOptimistic): void {
  const ch = open();
  if (!ch) return;
  try { ch.postMessage(info); } finally { ch.close(); }
}

export function subscribeComposeOptimistic(cb: (info: ComposeOptimistic) => void): () => void {
  const ch = open();
  if (!ch) return () => {};
  const handler = (e: MessageEvent) => { if (e.data?.conversationId) cb(e.data as ComposeOptimistic); };
  ch.addEventListener("message", handler);
  return () => { ch.removeEventListener("message", handler); ch.close(); };
}
