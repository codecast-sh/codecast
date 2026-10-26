// What the phone does the moment it comes back from the background, so the
// conversation on screen shows what the server already has without waiting on
// the socket.
//
// iOS suspends the app's JS and usually kills its socket while it is away, so a
// return starts with a reconnect and a re-subscription of every live query
// before any new row can arrive. Two things shorten that:
//
// - The socket. Convex reconnects on its own retry timer (up to 16 s) and only
//   notices a socket that died silently after 60 s without a server message.
//   A return reconnects a down or stalled socket at once, and replaces a socket
//   that claims to be up but cannot answer a fresh query within a few seconds.
// - The rows. The conversation on screen (or the one a tapped push names) reads
//   its new rows over plain HTTPS, beside the socket rather than behind it, and
//   merges them into the store; the live subscription takes over once the
//   socket is back.
import { AppState, type AppStateStatus } from 'react-native';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@codecast/convex/convex/_generated/api';
import { socketStats } from '@/lib/socketStats';
import { readForward } from '@codecast/web/hooks/inboxWarm';
import { isConvexId, useInboxStore } from '@codecast/web/store/inboxStore';
import { convex, CONVEX_URL } from '@/lib/convex';

// A live socket answers the return's probe query well inside this.
const PROOF_WINDOW_MS = 5_000;
// A connect attempt older than this when the app comes back is restarted.
const STALLED_CONNECT_MS = 3_000;

let route = '';
let token: string | null = null;
let started = false;
const inFlight = new Set<string>();

/** The last HTTPS catch-up that landed: when, for which conversation, how many
 *  rows. Read by the foreground trace. */
export const lastCatchUp = { at: 0, convId: '', rows: 0 };

export function setForegroundRoute(path: string) {
  route = path;
}

export function currentRoute(): string {
  return route;
}

/** The signed-in user's access token, for the HTTPS reads. */
export function setCatchUpToken(next: string | null) {
  token = next;
}

export function sessionIdFromRoute(path: string): string | null {
  const m = /^\/session\/([^/?#]+)/.exec(path);
  return m && isConvexId(m[1]) ? m[1] : null;
}

/** Newest row timestamp the store holds for a conversation (0 when none). */
export function newestLocalTimestamp(convId: string): number {
  const rows = useInboxStore.getState().messages[convId] as { timestamp?: number }[] | undefined;
  return rows?.length ? (rows[rows.length - 1]?.timestamp ?? 0) : 0;
}

/**
 * Reads a conversation's rows newer than the store's newest over HTTPS and
 * merges them. A conversation with nothing loaded yet is left to the screen's
 * own cold open, which fetches the full first page.
 */
export async function catchUpConversation(convId: string): Promise<void> {
  if (!token || !isConvexId(convId) || inFlight.has(convId)) return;
  const after = newestLocalTimestamp(convId);
  if (!after) return;
  inFlight.add(convId);
  const started = Date.now();
  try {
    const http = new ConvexHttpClient(CONVEX_URL);
    http.setAuth(token);
    const rows = await readForward(http, convId, after);
    Object.assign(lastCatchUp, { at: Date.now(), convId, rows: rows ?? 0 });
    if (__DEV__) console.log(`[foreground-resume] https rows=${rows} in ${Date.now() - started}ms`);
  } catch (err) {
    // The socket's own subscription still delivers the same rows.
    if (__DEV__) console.log(`[foreground-resume] https failed after ${Date.now() - started}ms`, String(err));
  } finally {
    inFlight.delete(convId);
  }
}

// Convex's socket manager. Internal API, so every call is guarded: a client
// that renames it simply keeps its own reconnect timing.
function socketManager(): any {
  return (convex as any)?.sync?.webSocketManager ?? null;
}

/** The socket manager's state ("ready", "connecting", "disconnected", ...). */
export function socketState(): string {
  const state = socketManager()?.socket?.state;
  return typeof state === 'string' ? state : 'unknown';
}

// Replace the socket now. Convex's own close schedules the new socket on its
// retry backoff (up to 16 s after a run of failures), so the scheduled retry is
// cancelled and the connect starts immediately.
function reconnectNow() {
  const manager = socketManager();
  if (!manager) return;
  if (manager.socket?.state !== 'disconnected') manager.closeAndReconnect?.('InactiveServer');
  manager.tryReconnectImmediately?.();
}

// Any conversation id the store knows, for the probe's arguments.
function anyConversationId(): string | null {
  const s = useInboxStore.getState();
  const onScreen = sessionIdFromRoute(route);
  if (onScreen) return onScreen;
  for (const id of Object.keys(s.messages)) if (isConvexId(id)) return id;
  return null;
}

// A socket that says "ready" after a return proves nothing: the OS hands the
// app the messages it buffered before suspension, so even the last message
// time looks fresh on a socket that died minutes ago, and Convex only notices
// after 60 s without a server message. A query with arguments no one has
// asked before cannot be answered from the client's cache, so the server has
// to answer it over this socket; no answer inside the window means the socket
// is dead.
function proveSocket() {
  const convId = anyConversationId();
  if (!convId) return;
  let answered = false;
  convex
    .query(api.conversations.listMessagesTail, { conversation_id: convId, after_timestamp: Date.now() })
    .then(() => { answered = true; }, () => { answered = true; });
  setTimeout(() => {
    if (!answered && socketState() === 'ready') reconnectNow();
  }, PROOF_WINDOW_MS);
}

function nudgeSocket() {
  const state = socketState();
  if (state === 'disconnected') {
    reconnectNow();
    return;
  }
  // A connect attempt made while the network was gone can sit in its TCP
  // handshake well past the network's return.
  if (state === 'connecting') {
    if (Date.now() - socketStats.lastConnectAt > STALLED_CONNECT_MS) reconnectNow();
    return;
  }
  if (state === 'ready') proveSocket();
}

/** Starts watching AppState. Idempotent. */
export function startForegroundResume() {
  if (started) return;
  started = true;
  let wasBackground = false;
  AppState.addEventListener('change', (next: AppStateStatus) => {
    if (next === 'background') {
      wasBackground = true;
      return;
    }
    if (next !== 'active' || !wasBackground) return;
    wasBackground = false;
    nudgeSocket();
    const convId = sessionIdFromRoute(route);
    if (convId) void catchUpConversation(convId);
  });
}
