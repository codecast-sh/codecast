import { useSyncExternalStore } from "react";

// Which conversations have a decision docked above their composer, and how to
// open it whole. The docked card (SessionDecisionCard) registers itself while
// it is mounted; a neighbour that names the same ask (the pinned state's `You`
// line, which says "answer the card…") opens it through here instead of
// leaving the person to find the card. Ephemeral UI wiring, never stored.

const openers = new Map<string, () => void>();
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

/** Registers the card's opener for a conversation; returns the unregister. */
export function registerDecisionOpener(conversationId: string, open: () => void): () => void {
  openers.set(conversationId, open);
  emit();
  return () => {
    if (openers.get(conversationId) !== open) return;
    openers.delete(conversationId);
    emit();
  };
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The opener of the conversation's docked decision, or null when none is docked. */
export function useDecisionOpener(conversationId: string | undefined): (() => void) | null {
  return useSyncExternalStore(subscribe, () => (conversationId ? openers.get(conversationId) ?? null : null), () => null);
}
