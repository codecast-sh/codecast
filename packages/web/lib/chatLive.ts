// Has the channel rail been answered by the SERVER yet, in this page load?
//
// The rail is persisted (store/clientSyncRegistry: chatRail is a meta blob) and
// hydrates from IndexedDB at boot, long before the Convex websocket answers
// chat.listChannels. Anything that reads "the rail changed" as "a message just
// arrived" therefore has to know which rail it is looking at: the cached one
// says only what was true when the app was last closed, and treating it as an
// arrival is how a reload toasts everything that happened overnight.
//
// One boolean, one direction, one page load. It is deliberately NOT in the store
// — it is provenance of a subscription, not state anyone syncs or persists.

let live = false;
const subscribers = new Set<() => void>();

/** Called by useChatChannelsSync the first time a server payload lands. */
export function markChatRailLive(): void {
  if (live) return;
  live = true;
  for (const fn of subscribers) fn();
}

export function isChatRailLive(): boolean {
  return live;
}

export function subscribeChatRailLive(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Test seam: module state outlives a test file's cases. */
export function _resetChatRailLive(): void {
  live = false;
  subscribers.clear();
}
