// WHAT THE VIEWER HAS SEEN OF A ROOM'S THREAD, shared by every surface that
// counts or sounds it: the stage's thread button, the header's door to the
// call, and the arrival chime (useRoomThreadAlerts).
//
// Per room, two facts. `seenAt` is the newest row's own time when the viewer
// last had the thread in front of them; the badge counts lines after it. The
// row's time, not the clock, so skew between this machine and the server
// cannot hide or invent a line. `watching` says the thread is open in a window
// that has focus right now: a line landing there is read as it lands, so it
// neither counts nor knocks.
//
// Both live in localStorage as well as in memory, because the desktop call
// window draws the thread while the main window draws the header and plays
// the sound: a line read in one must stop counting in the other. The storage
// event carries a write in one window to the rest.
import { useSyncExternalStore } from "react";
import type { ThreadRow } from "../../components/calls/roomThreadModel";

type Seen = { seenAt?: number; watching?: boolean };

const PREFIX = "codecast:room-thread:";
const memory = new Map<string, Seen>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const cb of listeners) cb();
}

function read(roomKey: string): Seen {
  const cached = memory.get(roomKey);
  if (cached) return cached;
  let seen: Seen = {};
  try {
    seen = JSON.parse(localStorage.getItem(PREFIX + roomKey) || "{}") ?? {};
  } catch {}
  memory.set(roomKey, seen);
  return seen;
}

function write(roomKey: string, patch: Seen): void {
  const prev = read(roomKey);
  const next = { ...prev, ...patch };
  if (next.seenAt === prev.seenAt && next.watching === prev.watching) return;
  memory.set(roomKey, next);
  try {
    localStorage.setItem(PREFIX + roomKey, JSON.stringify(next));
  } catch {}
  emit();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (!e.key?.startsWith(PREFIX)) return;
    memory.delete(e.key.slice(PREFIX.length));
    emit();
  });
}

export function subscribeRoomThreadSeen(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getRoomThreadSeen(roomKey: string): Seen {
  return read(roomKey);
}

/** The rows are on screen: everything up to the newest is seen. A room seen
 *  for the first time starts from what is already there, so the backlog of a
 *  room you walk into is never "new". */
export function markRoomThreadSeen(roomKey: string, rows: ThreadRow[], open: boolean): void {
  if (!open && read(roomKey).seenAt !== undefined) return;
  write(roomKey, { seenAt: rows[rows.length - 1]?.at ?? 0 });
}

export function setRoomThreadWatching(roomKey: string, watching: boolean): void {
  write(roomKey, { watching });
}

/** A line that deserves the viewer's attention: someone else typed it, or an
 *  agent in the room answered. Never the viewer's own line, never an event. */
export function isArrival(row: ThreadRow): boolean {
  return !row.mine && !row.event;
}

export function countUnread(rows: ThreadRow[] | null | undefined, seen: Seen): number {
  if (!rows || seen.seenAt === undefined || seen.watching) return 0;
  const after = seen.seenAt;
  return rows.filter((r) => r.at > after && isArrival(r)).length;
}

export function useRoomThreadSeen(roomKey: string | null | undefined): Seen {
  return useSyncExternalStore(
    subscribeRoomThreadSeen,
    () => (roomKey ? read(roomKey) : EMPTY),
    () => EMPTY,
  );
}

const EMPTY: Seen = {};
