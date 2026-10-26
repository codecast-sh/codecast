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
// - The push. On binaries with the notification service extension
//   (targets/notification-service), a push about a conversation has already
//   read its new rows before the phone showed it; they are merged first.
import { AppState, type AppStateStatus } from 'react-native';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@codecast/convex/convex/_generated/api';
import { socketStats } from '@/lib/socketStats';
import { readForward } from '@codecast/web/hooks/inboxWarm';
import { ensureHydrated, isConvexId, useInboxStore } from '@codecast/web/store/inboxStore';
import { convex, CONVEX_URL } from '@/lib/convex';
import { pushPrefetchNative } from '@/modules/codecast-push-prefetch';

// A live socket answers the return's probe query well inside this.
const PROOF_WINDOW_MS = 5_000;
// A connect attempt older than this when the app comes back is restarted.
const STALLED_CONNECT_MS = 3_000;
// Conversations whose newest row the extension may read from, newest first.
const WATERMARK_LIMIT = 300;
// How long saved rows wait for the disk cache on a cold launch; past it they
// stay on disk for the next return.
const CACHE_WAIT_MS = 30_000;

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

/** The last merge of the extension's saved rows, read by the foreground trace. */
export const lastPrefetch = { at: 0, rows: 0 };

/** The signed-in user's access token, for the HTTPS reads and the extension. */
export function setCatchUpToken(next: string | null) {
  const signedIn = !token && !!next;
  token = next;
  try {
    pushPrefetchNative?.setToken(next);
  } catch {}
  // A cold launch from a push: the rows the extension read wait for sign-in.
  if (signedIn) void mergePrefetched();
}

// What the extension needs to read a pushed conversation: the backend and the
// newest row this phone holds for each conversation it has loaded.
function writePrefetchState() {
  if (!pushPrefetchNative) return;
  const marks: [string, number][] = [];
  for (const [id, rows] of Object.entries(useInboxStore.getState().messages)) {
    const ts = rows?.length ? (rows[rows.length - 1] as { timestamp?: number })?.timestamp : 0;
    if (ts && isConvexId(id)) marks.push([id, ts]);
  }
  marks.sort((a, b) => b[1] - a[1]);
  try {
    pushPrefetchNative.writeState(JSON.stringify({ url: CONVEX_URL, watermarks: Object.fromEntries(marks.slice(0, WATERMARK_LIMIT)) }));
  } catch {}
}

// A cold launch signs in before the disk cache is loaded, and a conversation
// read before then looks empty. The saved rows wait for the cache.
function cacheLoaded(): Promise<boolean> {
  if (useInboxStore.getState().clientStateInitialized) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, CACHE_WAIT_MS);
    const unsubscribe = useInboxStore.subscribe((state) => {
      if (!state.clientStateInitialized) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}

/** Merges the rows the extension read for pushed conversations. */
export async function mergePrefetched(): Promise<void> {
  if (!pushPrefetchNative || !(await cacheLoaded())) return;
  let saved: string[] = [];
  try {
    saved = pushPrefetchNative.takeAll();
  } catch {
    return;
  }
  let merged = 0;
  for (const text of saved) {
    try {
      const entry = JSON.parse(text) as { conversation_id?: string; after_timestamp?: number; messages?: any[] };
      const convId = entry.conversation_id;
      if (!convId || !isConvexId(convId) || !entry.messages?.length) continue;
      const hydrated = await ensureHydrated(convId);
      const local = newestLocalTimestamp(convId);
      // Rows that start past the window this phone holds would leave a gap;
      // the screen's own open reads those.
      if (local < (entry.after_timestamp ?? Infinity)) {
        if (__DEV__) console.log(`[foreground-resume] prefetch skipped ${convId}: hydrated=${hydrated} local=${local} after=${entry.after_timestamp}`);
        continue;
      }
      useInboxStore.getState().mergeMessages(convId, entry.messages, 'append', { initialized: true });
      merged += entry.messages.length;
      if (__DEV__) console.log(`[foreground-resume] prefetch merged ${entry.messages.length} rows into ${convId}; newest now ${newestLocalTimestamp(convId)}`);
    } catch {}
  }
  if (saved.length) Object.assign(lastPrefetch, { at: Date.now(), rows: merged });
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
      writePrefetchState();
      return;
    }
    if (next !== 'active' || !wasBackground) return;
    wasBackground = false;
    nudgeSocket();
    const convId = sessionIdFromRoute(route);
    // The extension's rows first: the HTTPS read then asks only for what is
    // newer than them.
    void mergePrefetched().then(() => (convId ? catchUpConversation(convId) : undefined));
  });
}
