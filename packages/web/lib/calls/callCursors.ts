// Multiplayer cursors over a shared screen.
//
// Tandem's users chased each other's cursors around a screen share; the
// cursor is the cheapest "I am looking at this" there is. On a call, each
// person's pointer over a screen share tile is sent to the room on the
// LiveKit data channel (lossy, about thirty a second, nothing stored), and
// every other participant draws it over their copy of that share with the
// person's name. The presenter sees the others' cursors over their own share,
// which is the whole point: "this button, here".
//
// Points are normalized to the share's own pixels (0..1 of the video frame),
// so two viewers with different tile sizes agree on where "here" is; the
// receiver maps them back through the same object contain rule the ghost
// cursor uses (browserWatch mapFromFrame). A cursor that stops moving fades
// on the same idle window as the agent's ghost. A pointer that leaves the
// tile sends one "gone" so the others do not wait for the fade.

import type { Room, RemoteParticipant } from "livekit-client";
import { RoomEvent } from "livekit-client";
import { GHOST_IDLE_MS } from "../browserGhost";

export const CURSOR_TOPIC = "cursor";
/** Sends are paced like the browser control surface: about thirty a second. */
export const CURSOR_SEND_MIN_GAP_MS = 33;
export const CURSOR_IDLE_MS = GHOST_IDLE_MS;

export type CursorMessage =
  | { t: "cursor"; sid: string; nx: number; ny: number; at: number }
  | { t: "cursor"; sid: string; gone: true; at: number };

export type CallCursor = {
  /** The LiveKit identity, which is the user id. */
  identity: string;
  name: string;
  /** The screen share track this cursor hovers. */
  sid: string;
  nx: number;
  ny: number;
  at: number;
};

export type CursorState = ReadonlyMap<string, CallCursor>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeCursorMessage(msg: CursorMessage): Uint8Array<ArrayBuffer> {
  const bytes = encoder.encode(JSON.stringify(msg));
  // A fresh ArrayBuffer, never a shared one: the LiveKit publish signature asks for it.
  const out = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  out.set(bytes);
  return out;
}

/** One message as the wire delivered it, or null if malformed. */
export function decodeCursorMessage(payload: Uint8Array): CursorMessage | null {
  let raw: any;
  try {
    raw = JSON.parse(decoder.decode(payload));
  } catch {
    return null;
  }
  if (!raw || raw.t !== "cursor" || typeof raw.sid !== "string" || !raw.sid) return null;
  const at = typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : 0;
  if (raw.gone === true) return { t: "cursor", sid: raw.sid, gone: true, at };
  if (typeof raw.nx !== "number" || typeof raw.ny !== "number" || !Number.isFinite(raw.nx) || !Number.isFinite(raw.ny)) return null;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return { t: "cursor", sid: raw.sid, nx: clamp(raw.nx), ny: clamp(raw.ny), at };
}

/**
 * Fold one message from `identity` into the cursor map. A stale message (older
 * than what is already held) is dropped, as the lossy channel can reorder.
 * Returns the same map when nothing changed.
 */
export function applyCursorMessage(
  state: CursorState,
  identity: string,
  name: string,
  msg: CursorMessage,
  receivedAt: number,
): CursorState {
  const prev = state.get(identity);
  if (prev && msg.at && prev.at > msg.at) return state;
  const next = new Map(state);
  if ("gone" in msg) {
    if (!prev) return state;
    next.delete(identity);
    return next;
  }
  next.set(identity, { identity, name, sid: msg.sid, nx: msg.nx, ny: msg.ny, at: msg.at || receivedAt });
  return next;
}

/** Drop cursors that have not moved inside the idle window. Same map when none. */
export function expireCursors(state: CursorState, now: number): CursorState {
  let next: Map<string, CallCursor> | null = null;
  for (const [id, c] of state) {
    if (now - c.at >= CURSOR_IDLE_MS) {
      if (!next) next = new Map(state);
      next.delete(id);
    }
  }
  return next ?? state;
}

/** When the next cursor in the map will expire, or null. */
export function nextCursorExpiryAt(state: CursorState): number | null {
  let at: number | null = null;
  for (const c of state.values()) {
    const t = c.at + CURSOR_IDLE_MS;
    if (at === null || t < at) at = t;
  }
  return at;
}

type Listener = () => void;

// One store for the page: the room is a module level singleton too.
let state: CursorState = new Map();
const listeners = new Set<Listener>();
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  for (const l of listeners) l();
}

function setState(next: CursorState) {
  if (next === state) return;
  state = next;
  emit();
  armExpiry();
}

function armExpiry() {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  const at = nextCursorExpiryAt(state);
  if (at === null) return;
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    setState(expireCursors(state, Date.now()));
  }, Math.max(0, at - Date.now()) + 16);
}

export function subscribeCallCursors(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getCallCursors(): CursorState {
  return state;
}

export function resetCallCursors() {
  setState(new Map());
}

/** Receive the room's cursor messages. Called once per Room, where the other
 *  room handlers are attached; the handlers die with the room. */
export function bindCallCursors(room: Room): void {
  room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
    if (topic !== CURSOR_TOPIC || !participant) return;
    const msg = decodeCursorMessage(payload);
    if (!msg) return;
    setState(applyCursorMessage(state, participant.identity, participant.name || participant.identity, msg, Date.now()));
  });
  room.on(RoomEvent.Disconnected, () => resetCallCursors());
}

let lastSentAt = 0;
let lastSentSid: string | null = null;

/** Whether a move at `now` should go out, given the last send. Pure, for tests. */
export function shouldSendCursor(now: number, lastAt: number): boolean {
  return now - lastAt >= CURSOR_SEND_MIN_GAP_MS;
}

async function publish(room: Room, msg: CursorMessage) {
  try {
    await room.localParticipant.publishData(encodeCursorMessage(msg), { reliable: false, topic: CURSOR_TOPIC });
  } catch {
    // A room mid teardown drops the packet; the next move sends again.
  }
}

/** My pointer over the share `sid`, normalized to its frame. Paced. */
export function sendCursor(room: Room | null, sid: string, nx: number, ny: number, now = Date.now()): boolean {
  if (!room) return false;
  if (!shouldSendCursor(now, lastSentAt)) return false;
  lastSentAt = now;
  lastSentSid = sid;
  void publish(room, { t: "cursor", sid, nx, ny, at: now });
  return true;
}

/** My pointer left the share: tell the others now rather than on the fade. */
export function sendCursorGone(room: Room | null, sid?: string): void {
  const target = sid ?? lastSentSid;
  if (!room || !target) return;
  lastSentAt = 0;
  lastSentSid = null;
  void publish(room, { t: "cursor", sid: target, gone: true, at: Date.now() });
}

// Dev console seam (like window.__setCallTiles): push a teammate's cursor over
// a share so the overlay can be designed without a second participant.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as any).__callCursors = {
    apply: (identity: string, name: string, msg: CursorMessage) =>
      setState(applyCursorMessage(state, identity, name, msg, Date.now())),
    reset: resetCallCursors,
    get: () => state,
  };
}
