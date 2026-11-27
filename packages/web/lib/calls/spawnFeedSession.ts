// A session spawned for a call (a huddle feed, Scribe), shared by web and the
// phone: neither the media room nor any web-only module is reached from here.
import { AVATAR_KEYS } from "@codecast/shared/contracts/orgAvatars";
import { characterNameFor, defaultCharacterFor, type Character } from "@codecast/shared/contracts/sessionCharacter";
import { SessionCreatePendingError, defaultNewSessionPath, useInboxStore } from "../../store/inboxStore";
import { findSessionRow } from "./findSessionRow";
import { characterFor } from "../sessionIdentity";

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
  // A session the team never sees, from its first write (a person's own huddle).
  privately = false,
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
        ...(privately ? { private: true } : {}),
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

/** The character a session spawned FOR a huddle wears (session-characters.md
 *  S1): the hash default for `seed`, unless an agent already in the room
 *  wears that face or that name, in which case the next free face and its
 *  name. Two agents called Ember in one room would answer each other's asks.
 *  Written as a CHOSEN character (the seed is the stub, not the row's final
 *  id), so the room's name for it holds on every surface. */
export function characterForRoom(seed: string, taken: Character[]): Character {
  const clash = (c: { avatar: string; name: string }) =>
    taken.some((t) => t.avatar === c.avatar || t.name.toLowerCase() === c.name.toLowerCase());
  const own = defaultCharacterFor(seed);
  if (!clash(own)) return { ...own, chosen: true };
  const start = AVATAR_KEYS.indexOf(own.avatar);
  for (let i = 1; i < AVATAR_KEYS.length; i++) {
    const avatar = AVATAR_KEYS[(start + i) % AVATAR_KEYS.length];
    const c = { avatar, name: characterNameFor(seed, avatar) };
    if (!clash(c)) return { ...c, chosen: true };
  }
  return { ...own, chosen: true };
}

/** The characters of the agents a live transcript already feeds, read from
 *  the store, so a newcomer can avoid their faces and names. */
export function charactersInRoom(routes: Array<{ kind: string; target: string }>): Character[] {
  const st = useInboxStore.getState() as any;
  return routes
    .filter((r) => r.kind === "session")
    .map((r) => findSessionRow(st, r.target))
    .filter(Boolean)
    .map((row) => characterFor(row));
}
