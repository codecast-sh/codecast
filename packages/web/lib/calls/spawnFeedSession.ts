// A session spawned for a call (a huddle feed, Scribe), shared by web and the
// phone: neither the media room nor any web-only module is reached from here.
import { SessionCreatePendingError, defaultNewSessionPath, useInboxStore } from "../../store/inboxStore";

// Local-first "new session seeded with a message": stub + optimistic bubble +
// side panel now, durable create + send resolve behind it. Same lifecycle as
// ContextChatInput. Returns a promise of the real conversation id.
//
// `body` may be written for the stub (a huddle briefing names the character
// the session will wear, decided from the stub id), and `onReady` runs with
// the real id before the message is sent, so a write the briefing promises
// (that character) lands before the agent reads it.

// The store gives up on a create after its own window (a 30 s race and a 15 s
// poll) with SessionCreatePendingError, but the durable outbox still owns the
// create and the session lands later. A feed spawned for a room must wait for
// that landing, or the session that lands holds a briefing promising words
// and hears nothing: keep asking while the create is merely parked and the
// stub still stands, up to five minutes.
const SPAWN_WAIT_MS = 5 * 60_000;
async function awaitSpawn(stubId: string): Promise<string> {
  const store = useInboxStore.getState() as any;
  const deadline = Date.now() + SPAWN_WAIT_MS;
  for (;;) {
    try {
      return await store.awaitConvexId(stubId);
    } catch (e) {
      const parked = e instanceof SessionCreatePendingError && (store.sessions[stubId] || store.conversations[stubId]);
      if (!parked || Date.now() >= deadline) throw e;
    }
  }
}

export function spawnSessionWithMessage(
  body: string | ((stubId: string) => string),
  onReady?: (convexId: string) => void,
  teamId?: string | null,
  // false: the session works out of sight (Scribe keeps the board, not a thread).
  openPanel = true,
): Promise<string> {
  const store = useInboxStore.getState() as any;
  const projectPath = defaultNewSessionPath(store, teamId);
  const gitRoot = projectPath;
  const { stubId } = store.beginOptimisticSession({
    agentType: "claude_code",
    projectPath,
    gitRoot,
    create: (sid: string) =>
      store.createSession({
        agent_type: "claude_code",
        project_path: projectPath,
        git_root: gitRoot,
        session_id: sid,
      }),
  });
  const text = typeof body === "function" ? body(stubId) : body;
  const clientId = store.addOptimisticMessage(stubId, text);
  if (openPanel) store.openSidePanel(stubId);
  return awaitSpawn(stubId).then((convexId: string) => {
    onReady?.(convexId);
    store.sendMessage(convexId, text, undefined, clientId);
    return convexId;
  });
}
