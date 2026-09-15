// The agent's cursor over the live browser stream: what the arrow, the click
// ring and the typed caption should show, derived from the action frames the
// daemon sends (lib/browserWatch.ts WatchActionFrame).
//
// Two pure functions and a tiny store. `applyGhostAction` folds one frame
// into the state; `ghostView` says what is visible at a given moment, so the
// fades (the arrow after a few still seconds, the caption a couple of seconds
// after the last keystroke) are a question of time, not of timers scattered
// through a component. The store exists so the stream can feed frames in
// from the socket while only the overlay re-renders: a move burst is up to
// 25 frames a second, and nothing else in the stream needs to hear about it.

import type { WatchActionFrame } from "./browserWatch";

/** The arrow fades once the agent has been still this long. Matches the
 *  extension's in page arrow (background.js __castPointer). */
export const GHOST_IDLE_MS = 4000;
/** The typed caption fades this long after the last keystroke. */
export const GHOST_CAPTION_MS = 2000;
/** How long a press ring is drawn. */
export const GHOST_RIPPLE_MS = 420;
/** The caption is a glance at what is being typed, not a transcript. */
export const GHOST_CAPTION_CHARS = 40;
/** What the caption says over a password, code or card field. */
export const GHOST_SECRET_CAPTION = "typing (hidden)";

export interface GhostState {
  /** Where the arrow points, 0..1 of the page viewport; null before any action. */
  point: { x: number; y: number } | null;
  /** When the agent last moved, pressed, typed or scrolled. */
  lastAt: number;
  /** Bumped on every press: the ring element is keyed on it so it restarts. */
  press: number;
  pressAt: number;
  /** What is being typed, and when the last keystroke landed. */
  caption: { text: string; at: number } | null;
  /** The last main frame navigation. */
  nav: { url: string; at: number } | null;
}

export const GHOST_EMPTY: GhostState = { point: null, lastAt: 0, press: 0, pressAt: 0, caption: null, nav: null };

/** The last characters of what was typed, with a lead when it was cut. */
export function captionText(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > GHOST_CAPTION_CHARS ? `…${flat.slice(-GHOST_CAPTION_CHARS)}` : flat;
}

/**
 * Fold one action into the state. Time never runs backwards: a replayed
 * burst on connect arrives in order, but a late frame behind a fresh one
 * must not pull the arrow back to where it was.
 */
export function applyGhostAction(state: GhostState, a: WatchActionFrame): GhostState {
  if (a.kind === "nav") {
    return a.url ? { ...state, nav: { url: a.url, at: a.at } } : state;
  }
  if (a.at < state.lastAt) return state;
  const next: GhostState = { ...state, point: { x: a.x, y: a.y }, lastAt: a.at };
  if (a.kind === "down") {
    next.press = state.press + 1;
    next.pressAt = a.at;
  } else if (a.kind === "type") {
    next.caption = { text: a.secret ? GHOST_SECRET_CAPTION : captionText(a.text ?? ""), at: a.at };
  }
  return next;
}

export interface GhostView {
  /** The arrow is drawn: there is a point and the agent acted recently. */
  visible: boolean;
  point: { x: number; y: number } | null;
  /** The press ring to draw, keyed by `press`, or null once it has run out. */
  ripple: number | null;
  /** The caption to draw beside the arrow, or null once it has faded. */
  caption: string | null;
  /** When the next fade is due, so a component can wake exactly then. */
  nextChangeAt: number | null;
}

/** What is on screen at `now`. Pure: the same state and clock give the same picture. */
export function ghostView(state: GhostState, now: number): GhostView {
  const visible = state.point !== null && now - state.lastAt < GHOST_IDLE_MS;
  const ripple = state.press > 0 && now - state.pressAt < GHOST_RIPPLE_MS ? state.press : null;
  const caption = visible && state.caption && now - state.caption.at < GHOST_CAPTION_MS ? state.caption.text : null;
  const dues: number[] = [];
  if (visible) dues.push(state.lastAt + GHOST_IDLE_MS);
  if (ripple !== null) dues.push(state.pressAt + GHOST_RIPPLE_MS);
  if (caption !== null) dues.push(state.caption!.at + GHOST_CAPTION_MS);
  return { visible, point: visible ? state.point : null, ripple, caption, nextChangeAt: dues.length ? Math.min(...dues) : null };
}

export interface GhostStore {
  /** useSyncExternalStore's pair. */
  subscribe: (fn: () => void) => () => void;
  getSnapshot: () => GhostState;
  push: (a: WatchActionFrame) => void;
  /** Forget everything: a new tab, a new dial. */
  reset: () => void;
}

/** One store per stream. Listeners are told only when the state changed. */
export function createGhostStore(): GhostStore {
  let state = GHOST_EMPTY;
  const listeners = new Set<() => void>();
  const set = (next: GhostState) => {
    if (next === state) return;
    state = next;
    for (const fn of listeners) fn();
  };
  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSnapshot: () => state,
    push: (a) => set(applyGhostAction(state, a)),
    reset: () => set(GHOST_EMPTY),
  };
}
