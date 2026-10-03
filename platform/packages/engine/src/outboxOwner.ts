// Which window owns a durable outbox row.
//
// The outbox is one table per origin, shared by every window, and every
// window drains it (at boot, on reconnect, on becoming visible, on an
// interval). A window's own guards (in flight, already acknowledged) are in
// memory, so without an owner a drain in window B re-sends rows that window A
// enqueued and already delivered but has not yet deleted. Under a slow
// IndexedDB that gap is tens of seconds, and the re-send lands after A's later
// writes: a write followed by its reversal (undo, a toggle back, a second
// rename) is reverted on the server by a sibling window's drain.
//
// Each middleware instance stamps its rows with an owner id and holds a Web
// Lock named for it for as long as the page lives. A drain skips rows whose
// owner is another window that still holds its lock: those are that window's
// to deliver. A closed, reloaded or crashed window releases its lock, so its
// rows are replayed by whoever drains next, exactly as before. Where Web Locks
// are unavailable (React Native, tests, old browsers) nothing changes: every
// row is drainable by every window.

export const OUTBOX_OWNER_LOCK_PREFIX = "platform-outbox-owner:";

type LockInfoLike = { name?: string };
export type LockManagerLike = {
  request(name: string, options: { mode: "exclusive" }, callback: () => Promise<unknown>): Promise<unknown>;
  query(): Promise<{ held?: LockInfoLike[] }>;
};

export function defaultLockManager(): LockManagerLike | null {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  return locks && typeof locks.request === "function" && typeof locks.query === "function" ? locks : null;
}

export function newOutboxOwnerId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Hold this window's owner lock until the page goes away. */
export function claimOutboxOwner(owner: string, locks: LockManagerLike | null): void {
  if (!locks) return;
  locks
    .request(`${OUTBOX_OWNER_LOCK_PREFIX}${owner}`, { mode: "exclusive" }, () => new Promise<never>(() => {}))
    .catch(() => {});
}

/** The owners whose windows are alive, or null when that cannot be known. */
export async function liveOutboxOwners(locks: LockManagerLike | null): Promise<Set<string> | null> {
  if (!locks) return null;
  try {
    const { held = [] } = await locks.query();
    const live = new Set<string>();
    for (const lock of held) {
      if (lock.name?.startsWith(OUTBOX_OWNER_LOCK_PREFIX)) live.add(lock.name.slice(OUTBOX_OWNER_LOCK_PREFIX.length));
    }
    return live;
  } catch {
    return null;
  }
}

/** A row another live window owns: that window delivers it, nobody else. */
export function ownedByAnotherLiveWindow(
  entry: { owner?: string },
  self: string,
  live: Set<string> | null,
): boolean {
  return !!entry.owner && entry.owner !== self && !!live?.has(entry.owner);
}
