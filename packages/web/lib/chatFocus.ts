// What the reader is looking at in chat, right now.
//
// The toast decision needs this (a message in the channel on your screen must
// not toast — chatToastTier's first rule), but nothing RENDERS from it, so it
// stays out of the store: a store field would wake every subscriber on a channel
// switch to serve a value only an event handler reads.
//
// Several surfaces can be reading at once — the Threads page keeps every card
// whose tail is on screen registered — so this is a registry of holds, not a
// single slot: each surface releases exactly the hold it took, and one card
// leaving can never erase another's.

export type ChatFocus = {
  channelId?: string;
  threadRootId?: string;
};

const holds = new Set<ChatFocus>();

/** Register what a surface is showing. Call the returned release on unmount —
 *  it removes exactly this hold and nothing else. */
export function holdChatFocus(f: ChatFocus): () => void {
  holds.add(f);
  return () => {
    holds.delete(f);
  };
}

// The chat page's single slot: one surface at a time, replaced on navigation.
let releasePageHold: (() => void) | null = null;

export function setChatFocus(next: ChatFocus): void {
  releasePageHold?.();
  releasePageHold = holdChatFocus(next);
}

export function clearChatFocus(): void {
  releasePageHold?.();
  releasePageHold = null;
}

/** Is this channel, in this thread context, on the reader's screen right now?
 *  The thread compare is exact — a room on screen does not cover its threads,
 *  nor a thread its room — mirroring chatToastTier's "already on screen"
 *  rule, which this predicate feeds. */
export function isChatContextOnScreen(channelId: string, threadRootId?: string): boolean {
  for (const h of holds) {
    if (h.channelId === channelId && (h.threadRootId ?? undefined) === (threadRootId ?? undefined)) return true;
  }
  return false;
}
