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
/** The server has no conversations.markInteractive (an older deployment): nothing is asked again this daemon life. */
let unsupported = false;

// How Convex answers a call to a function the deployment does not have.
const MISSING_FUNCTION = /Could not find (?:public )?function/i;

/** Ask the server to mark `conversationId` interactive when the flags read from its head say a person runs it. */
export function healInteractiveMark(
  mark: (conversationId: string) => Promise<unknown>,
  conversationId: string,
  headFlags: string | null | undefined,
  log: (line: string) => void = () => {},
): void {
  if (unsupported || !headFlags?.split(/\s+/).includes("--interactive") || asked.has(conversationId)) return;
  asked.add(conversationId);
  mark(conversationId).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (MISSING_FUNCTION.test(message)) {
      // An older server: asking again on every pass for every session would only spend the shared write throttle.
      if (!unsupported) log(`The server cannot mark sessions interactive yet (${message}); not asking again until the daemon restarts`);
      unsupported = true;
      return;
    }
    // Any other failure is asked again on a later pass.
    asked.delete(conversationId);
    log(`Could not mark ${conversationId.slice(0, 12)} interactive: ${message}`);
  });
}

/** For tests: forget what was asked, and that the server lacked the function. */
export function resetInteractiveMarks(): void {
  asked.clear();
  unsupported = false;
}
