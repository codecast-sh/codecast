// The daemon heals sessions recorded before it marked interactive launches.
// A line typed at a session's terminal reads as typed only when the session
// carries `--interactive` (convex lib/messageProvenance), and the daemon sets
// that mark when it creates a conversation from the transcript head (parser
// detectCliFlags, codexSessionMeta codexLaunchFlags). A conversation created
// before then has neither mark, so each sync pass that reads such a head as
// interactive asks the server to add it (conversations.markInteractive), which
// adds only that mark and only to a session with neither mark. A head that is
// missing or unreadable yields no mark, so nothing is asked.

/** The conversations this process already asked about, so each is asked once per daemon life. */
const asked = new Set<string>();

/** Ask the server to mark `conversationId` interactive when the flags read from its head say a person runs it. */
export function healInteractiveMark(
  mark: (conversationId: string) => Promise<unknown>,
  conversationId: string,
  headFlags: string | null | undefined,
  log: (line: string) => void = () => {},
): void {
  if (!headFlags?.split(/\s+/).includes("--interactive") || asked.has(conversationId)) return;
  asked.add(conversationId);
  mark(conversationId).catch((err) => {
    // A failed ask is asked again on a later pass.
    asked.delete(conversationId);
    log(`Could not mark ${conversationId.slice(0, 12)} interactive: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/** For tests: forget what was asked. */
export function resetInteractiveMarks(): void {
  asked.clear();
}
