// THE LIVENESS HOLD — when the device cannot know its liveness facts are
// current, placement reads them at the last moment they were (store
// livenessHeldAt) until a fresh read lands.
//
// A running session's heartbeat window reaches only a minute or two ahead, and
// the inbox evaluates it against the clock. A launch from cache, a suspension
// (a phone in the background, a laptop asleep) or a dropped socket leaves the
// facts as they were while the clock moves on, so every running row slid into
// Needs You until the subscription caught up (phone 8, web 4, 2026-10-26).
// The hold keeps each row where it last was, the sync indicator shows, and one
// round-trip read (`_probe`: never the subscription's possibly pre-sleep
// cache) started after the latest hold releases it.

/** A coarse tick later than this after the previous one means the process was suspended. */
export const LIVENESS_SUSPEND_GAP_MS = 40_000;
/** The same for a hidden page: Chrome runs a hidden tab's timers about once a
 *  minute, later under load, so a shorter gap there is throttling, not sleep. */
export const LIVENESS_HIDDEN_SUSPEND_GAP_MS = 150_000;

/** The latest heartbeat the cached facts carry: about when they were last refreshed. */
export function cachedFactsAsOf(sessions: Record<string, { last_heartbeat?: number | null } | undefined>, now: number): number | null {
  let at: number | null = null;
  for (const id in sessions) {
    const beat = sessions[id]?.last_heartbeat;
    if (typeof beat === "number" && beat <= now && (at === null || beat > at)) at = beat;
  }
  return at;
}

export type LivenessHoldIO = {
  /** What outlives a remount of the controller (the window's store); defaults to this IO. */
  store?: object;
  now: () => number;
  /** Store reads and the two transitions. */
  hydrated: () => boolean;
  sessions: () => Record<string, { last_heartbeat?: number | null } | undefined>;
  heldAt: () => number | null;
  holdSeq: () => number;
  hold: (at: number) => void;
  release: (seq: number) => void;
  /** One fresh read of the liveness overlay, applied; resolves false when nothing was applied. */
  probe: (signal: AbortSignal) => Promise<boolean>;
  connected: () => boolean;
  /** Whether the page is hidden (its timers throttled); absent where timers are never throttled. */
  hidden?: () => boolean;
  /** Subscriptions; each returns its unsubscribe. */
  onTick: (fn: () => void) => () => void;
  onConnection: (fn: () => void) => () => void;
  onWake: (fn: () => void) => () => void;
  onStore: (fn: () => void) => () => void;
};

// When a controller on a store last stopped with its facts current (socket up,
// nothing held), keyed by LivenessHoldIO.store. The store outlives its
// feeders: the join flow's SetupScreen mounts them and "Open team" remounts
// them under the dashboard shell, so the next controller starts on facts the
// live subscription kept current a moment ago, not a launch from cache
// (ct-101309: "Syncing" on every page for 18s after joining a team).
const currentAsOf = new WeakMap<object, number>();

export function startLivenessHold(io: LivenessHoldIO): () => void {
  const store = io.store ?? io;
  const handedOff = currentAsOf.get(store) ?? null;
  currentAsOf.delete(store);
  const sinceHandoff = handedOff == null ? -1 : io.now() - handedOff;
  const remount = sinceHandoff >= 0 && sinceHandoff <= LIVENESS_SUSPEND_GAP_MS;
  let lastAlive = remount ? handedOff! : io.now();
  let aliveHidden = io.hidden?.() ?? false;
  // A remount inherits the stopped controller's facts; only a real launch boots from cache.
  let booted = remount;
  let probing: AbortController | null = null;

  const probe = () => {
    if (probing || io.heldAt() == null || !io.connected()) return;
    const seq = io.holdSeq();
    const controller = new AbortController();
    probing = controller;
    io.probe(controller.signal).then(
      (applied) => {
        if (probing === controller) probing = null;
        if (applied && !controller.signal.aborted) io.release(seq);
        // A hold placed while this read was in flight wants a read of its own.
        if (io.heldAt() != null && io.holdSeq() !== seq) probe();
      },
      () => {
        if (probing === controller) probing = null;
      },
    );
  };
  const hold = (at: number) => {
    io.hold(at);
    probe();
  };

  // Launch from cache: the facts are as old as their latest heartbeat.
  const boot = () => {
    if (booted || !io.hydrated()) return;
    booted = true;
    const at = cachedFactsAsOf(io.sessions(), io.now());
    if (at !== null) hold(at);
  };

  // Facts are current up to the last moment the process ran with a socket.
  const check = () => {
    const now = io.now();
    const gap = aliveHidden ? LIVENESS_HIDDEN_SUSPEND_GAP_MS : LIVENESS_SUSPEND_GAP_MS;
    if (now - lastAlive > gap) hold(lastAlive);
    else if (!io.connected() && io.heldAt() == null) hold(lastAlive);
    if (io.connected()) {
      lastAlive = now;
      aliveHidden = io.hidden?.() ?? false;
    }
    probe();
  };

  const offStore = io.onStore(() => {
    boot();
    if (booted) offStore();
  });
  boot();
  if (booted) offStore();
  const offs = [io.onTick(check), io.onConnection(check), io.onWake(check)];
  // Stopping ends the only reader that can release a hold, so the hold goes
  // with it. A window boots as sync host and holds from its cache, then the
  // election demotes it and stops this; a hold left behind froze that
  // follower's placement clock and every session that ran since read as
  // Working until a reload.
  return () => {
    // Only a controller that read the cache (booted) can vouch for the facts.
    if (booted && io.connected() && io.heldAt() == null) currentAsOf.set(store, io.now());
    offStore();
    for (const off of offs) off();
    probing?.abort();
    probing = null;
    if (io.heldAt() != null) io.release(io.holdSeq());
  };
}
