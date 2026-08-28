// THE DOOR: whether a teammate's burst may play out loud on this client.
//
// It lived inside hooks/useWalkieSync as one boolean expression and a
// `document.visibilityState` read. It is here now because both halves grew a
// question React cannot answer on its own: "is a person at this machine" is a
// fact about the MACHINE rather than about this window, and "may this window be
// the one that plays it" is a fact about the OTHER windows.
//
// A hot microphone hangs off the answer. Auto-listen is unmuted, so this is not
// only "may their voice reach me", it is also "may my microphone open without
// my touching anything". That is why the policy is a named pure function with
// one copy of every clause, and why the machine's own signals are gathered here
// rather than sampled at three call sites.
//
// WHAT CHANGED, AND WHY IT HAD TO. The old gate was this window being visible.
// A person working in another app therefore heard nothing at all, which is
// exactly the case the walkie exists for: the founder's word for it is that the
// burst should reach you wherever you are. The gate is now RECENT INPUT ON THIS
// MACHINE, from any window of this app, which opens the door behind another app
// and still shuts it on a machine nobody is sitting at.
//
// Widening the gate makes a second question load bearing. Every window runs its
// own copy of the walkie's ear (hooks/useWalkieSync is mounted by the dashboard
// and by the people window), and the visibility gate used to be what kept all
// but one of them out of the room. With "at the machine" they would ALL pass,
// every one of them would take a seat in the burst's room, and one teammate
// talking would arrive as several voices over each other. So the door also asks
// whether this window is the one that speaks for the app, below.
import {
  getIdleMs,
  getLastDesktopActivityAt,
  installDesktopInputTracker,
  isElectron,
  isNotificationLeader,
  subscribeWindowRole,
} from "../desktop";

/**
 * How recently somebody must have touched this machine for a voice to play out
 * loud on it. Three minutes is the same bar the presence reporter uses for "a
 * human is here": long enough to survive reading a page or a phone call, short
 * enough that a machine left running overnight is not a room somebody's voice
 * fills at 3am.
 */
export const AT_MACHINE_MS = 3 * 60_000;

/** A person touched this machine recently enough for a burst to play. */
export function atTheMachine(idleMs: number): boolean {
  return idleMs < AT_MACHINE_MS;
}

/**
 * THE DOOR, as one rule.
 *
 * The pref is open by default: a teammate's voice reaching you is the point of
 * the feature, and "off" is the deliberate act. The snooze is the same door
 * shut for an hour, pressed to stop the voice playing right now rather than to
 * change what the product is. Neither touches DELIVERY: a burst behind a closed
 * door still lands in the DM with its unread and its push, so nobody can be
 * silenced by somebody else's setting.
 *
 * `leader` is the newest clause and the least obvious. It is not a preference
 * and it is not about the person at all: it decides which of this app's open
 * windows takes the seat, so that one teammate talking is one voice and one
 * strip rather than one of each per window.
 */
export function walkieDoorOpen(input: {
  callsOn: boolean;
  /** Somebody has touched this machine inside AT_MACHINE_MS, in any window. */
  atMachine: boolean;
  /** This window is the one that speaks for the app: the one that sounds. */
  leader: boolean;
  snoozed: boolean;
  pref?: string | null;
  status?: string | null;
}): boolean {
  if (!input.callsOn || !input.atMachine || !input.leader || input.snoozed) return false;
  if (input.pref === "off") return false;
  return input.status !== "busy";
}

// ── the machine, across its windows ─────────────────────────────────────────
//
// One record per window in localStorage, under a key of that window's own. A
// map under one key would be a read, a change and a write from several windows
// at once, which loses stamps; a key each is a write nobody else touches, and
// reading is a scan of a handful of small rows.

const WINDOW_KEY = "cc.walkie.window.";
/** A record older than this belongs to a window that closed without saying so
 *  (a crash, a killed tab). Three ticks of the poll below. */
const STALE_MS = 60_000;
/** How often a window restamps itself, and how often the idle answer is
 *  re-read. Coarse on purpose: the question is a three minute one. */
const TICK_MS = 20_000;

export type DoorWindow = {
  id: string;
  /** The last committed gesture seen by that window. */
  inputAt: number;
  /** When that window last took focus. Zero for one that never has. */
  focusedAt: number;
  /** When that window last said it was still open. */
  aliveAt: number;
};

/** The windows that still exist, newest stamp of any kind deciding. */
function alive(windows: DoorWindow[], now: number): DoorWindow[] {
  return windows.filter((w) => now - w.aliveAt < STALE_MS);
}

/**
 * When somebody last touched this machine, as far as this app can see.
 *
 * The maximum across windows, which is the whole point of writing the stamps
 * down: a browser tab sees input on its own page and nowhere else, so a person
 * typing in the other window of the same app is invisible to this one. Taking
 * the maximum lifts every window to the most recent gesture any of them saw.
 */
export function machineInputAt(windows: DoorWindow[], now: number): number {
  let best = 0;
  for (const w of alive(windows, now)) best = Math.max(best, w.inputAt);
  return best;
}

/**
 * WHICH WINDOW SPEAKS FOR THE APP, in a browser.
 *
 * The most recently focused window that still exists, which is the frontmost
 * one whenever the app is frontmost at all, and the last one the person used
 * when it is not. Ties go to the lowest id so that two windows opened in the
 * same millisecond still agree, and so the answer never depends on the order a
 * scan happened to return.
 *
 * The desktop does not use this: its shell elects a leader across real OS
 * windows (electron/notificationRouter chooseLeader, which prefers the people
 * window, then the focused one, then main) and that election is already what
 * decides which window SOUNDS. Reusing it is what keeps the strip and the sound
 * in the same window by construction rather than by coincidence.
 */
export function chooseDoorWindow(windows: DoorWindow[], now: number): string | null {
  let best: DoorWindow | null = null;
  for (const w of alive(windows, now)) {
    if (!best || w.focusedAt > best.focusedAt || (w.focusedAt === best.focusedAt && w.id < best.id)) {
      best = w;
    }
  }
  return best?.id ?? null;
}

export type MachineDoor = {
  /** Somebody is at this machine, by any window's reckoning. */
  atMachine: boolean;
  /** This window is the one that may take the seat and draw the strip. */
  leader: boolean;
};

const CLOSED: MachineDoor = Object.freeze({ atMachine: false, leader: false });

let selfId = "";
let snapshot: MachineDoor = CLOSED;
let installed = false;
let focusedAt = 0;
/** What the operating system says, on the desktop, where the answer is machine
 *  wide and stays true while the app sits behind another app. Null everywhere
 *  else, and everywhere else the in-page gestures are the only witness. */
let osIdleMs: number | null = null;
let lastWrite = 0;
const watchers = new Set<() => void>();

function readWindows(): DoorWindow[] {
  const out: DoorWindow[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(WINDOW_KEY)) continue;
      const row = JSON.parse(localStorage.getItem(key) || "null");
      if (row && typeof row.aliveAt === "number") {
        out.push({
          id: key.slice(WINDOW_KEY.length),
          inputAt: Number(row.inputAt) || 0,
          focusedAt: Number(row.focusedAt) || 0,
          aliveAt: row.aliveAt,
        });
      }
    }
  } catch {
    // No storage (private mode, a test environment). One window is then all
    // this app can see, which is the answer it had before any of this existed.
  }
  return out;
}

function writeSelf(now: number): void {
  lastWrite = now;
  try {
    localStorage.setItem(
      `${WINDOW_KEY}${selfId}`,
      JSON.stringify({ inputAt: getLastDesktopActivityAt(), focusedAt, aliveAt: now }),
    );
  } catch {
    /* see readWindows */
  }
}

/**
 * The two answers, recomputed.
 *
 * Both halves take the MOST GENEROUS true reading rather than this window's
 * own: the machine is idle only when every window agrees it is, and the
 * operating system overrules them all where it can be asked. What is left is
 * honest about its own blindness: a browser tab behind another app sees no
 * gestures at all, so its door closes three minutes after the person walked
 * away from THIS app, which is the best a page can know.
 */
function compute(now: number): MachineDoor {
  const local = Math.max(getLastDesktopActivityAt(), focusedAt);
  const shared = Math.max(local, machineInputAt(readWindows(), now));
  const inPageIdle = shared > 0 ? now - shared : Number.MAX_SAFE_INTEGER;
  const idleMs = Math.min(inPageIdle, osIdleMs ?? Number.MAX_SAFE_INTEGER);
  const leader = isElectron() ? isNotificationLeader() : ownsTheBrowser(now);
  return { atMachine: atTheMachine(idleMs), leader };
}

function ownsTheBrowser(now: number): boolean {
  const windows = readWindows();
  // A window that cannot write its own record cannot be outvoted by one that
  // can: with no storage every window believes it is alone, which is what the
  // walkie did before the election existed.
  if (!windows.length) return true;
  return chooseDoorWindow(windows, now) === selfId;
}

function refresh(): void {
  const now = Date.now();
  if (now - lastWrite >= TICK_MS / 4) writeSelf(now);
  const next = compute(now);
  if (next.atMachine === snapshot.atMachine && next.leader === snapshot.leader) return;
  snapshot = Object.freeze(next);
  for (const cb of watchers) cb();
}

function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  selfId = Math.random().toString(36).slice(2, 10);
  // The same tracker the presence reporter installs, and idempotent, so the
  // two consumers of "a person is here" read one set of listeners.
  installDesktopInputTracker();
  focusedAt = document.hasFocus() ? Date.now() : 0;

  const onFocus = () => {
    // Focusing the app is a gesture the in-page tracker cannot see: the click
    // that raised this window landed on the dock or on another screen.
    focusedAt = Date.now();
    writeSelf(focusedAt);
    refresh();
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onFocus();
    else refresh();
  });
  // A gesture in this window opens the door in the same tick rather than at the
  // next poll: coming back to the machine and hearing the next word is the
  // whole promise.
  for (const ev of ["pointerdown", "keydown"]) {
    window.addEventListener(ev, () => refresh(), { capture: true, passive: true });
  }
  // A sibling window writing its record. This is how one window's keystroke
  // holds another window's door open.
  window.addEventListener("storage", (e) => {
    if (!e.key || e.key.startsWith(WINDOW_KEY)) refresh();
  });
  // The desktop shell re-electing its leader, which is this window gaining or
  // losing the right to sound and therefore to listen.
  subscribeWindowRole(() => refresh());
  window.addEventListener("pagehide", () => {
    try {
      localStorage.removeItem(`${WINDOW_KEY}${selfId}`);
    } catch {
      /* see readWindows */
    }
  });

  const tick = () => {
    // Only the desktop has a machine wide answer, and asking for it is a trip
    // through the bridge, so it is read on the poll and remembered rather than
    // awaited inside compute.
    if (isElectron()) {
      void getIdleMs(focusedAt).then((ms) => {
        osIdleMs = ms;
        refresh();
      });
    }
    refresh();
  };
  window.setInterval(tick, TICK_MS);
  tick();
}

/** The door's machine half, for `useSyncExternalStore`. A frozen object,
 *  replaced only when one of the two answers actually changes, so a component
 *  reading it wakes for a door opening and never for a poll. */
export function machineDoorNow(): MachineDoor {
  return snapshot;
}

export function subscribeMachineDoor(cb: () => void): () => void {
  install();
  watchers.add(cb);
  return () => void watchers.delete(cb);
}
