// Open state for the per-conversation terminal split, keyed by conversation.
// Lives at module level (not in inboxStore) so switching conversations and back
// preserves the split and its xterm buffer — same reasoning as termSessions.ts.
// Kept out of components/terminal/ConversationTerminal.tsx so that module
// exports only components and stays a React Fast Refresh boundary.

// The split opens at 40% of the window height; dragging resizes it from there.
export function conversationTerminalDefaultHeight(): number {
  return Math.round(window.innerHeight * 0.4);
}

export interface SplitState {
  termId: string | null;
  target: string;
  height: number;
}

export const conversationTerminalSplits = new Map<string, SplitState>();
let version = 0;
const listeners = new Set<() => void>();

export function bumpConversationTerminals(): void {
  version++;
  for (const l of listeners) l();
}

export function subscribeConversationTerminals(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getConversationTerminalsVersion(): number {
  return version;
}

export function isConversationTerminalOpen(convKey: string): boolean {
  return conversationTerminalSplits.has(convKey);
}

export function toggleConversationTerminal(convKey: string, target: string): void {
  const existing = conversationTerminalSplits.get(convKey);
  if (existing) {
    if (existing.termId) {
      const termId = existing.termId;
      void import("./termSessions").then(({ closeTab }) => closeTab(termId));
    }
    conversationTerminalSplits.delete(convKey);
  } else {
    conversationTerminalSplits.set(convKey, { termId: null, target, height: conversationTerminalDefaultHeight() });
  }
  bumpConversationTerminals();
}
