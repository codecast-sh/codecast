// The held-modifier walk through the undo history (docs/architecture/
// undo-history.md S9, doorway 4). A pure reducer: hooks/useUndoWalk feeds it
// key events and timer firings, and reads back what the timeline card should
// show (walkView) and which timer should run (walkTimer).
//
//   idle    nothing to show.
//   armed   undo or redo was pressed with the modifier held; the peek opens
//           when the modifier is still down PEEK_DELAY_MS later.
//   peek    the card narrates each further Z (undo) or Shift+Z (redo).
//   fading  the modifier was released; the card closes FADE_MS later unless
//           the pointer reaches it or H pins it first.
//   pinned  the card is interactive and owns the keyboard until it closes.
//
// Every press commits at once (the hook calls performUndo/performRedo before
// it feeds the event); the walk only decides what the card shows.

export const PEEK_DELAY_MS = 350;
export const FADE_MS = 600;
/** A second undo inside this window fires the milestone tip that names the timeline. */
export const MILESTONE_WINDOW_MS = 10_000;

export type WalkPhase = "idle" | "armed" | "peek" | "fading" | "pinned";

export type WalkState = {
  phase: WalkPhase;
  /** When the last undo press landed, for the milestone. */
  lastUndoAt: number | null;
  /** True on the state produced by the second undo within MILESTONE_WINDOW_MS. */
  milestone: boolean;
};

export type WalkEvent =
  /** ui.undo / ui.redo fired. `held` = the walk modifier is down. */
  | { type: "step"; dir: "undo" | "redo"; held: boolean; at: number }
  /** The PEEK_DELAY_MS timer fired. */
  | { type: "peekTimer" }
  /** H while the card shows: pin it interactive. */
  | { type: "pin" }
  /** The walk modifier went up. `hovered` = the pointer is over the card. */
  | { type: "release"; hovered: boolean }
  /** The pointer entered the card. */
  | { type: "pointerEnter" }
  /** The FADE_MS timer fired. */
  | { type: "fadeTimer" }
  /** Any other key: the walk ends and the key passes through. */
  | { type: "otherKey" }
  /** The card was closed from elsewhere (Esc, a row opened, the chord). */
  | { type: "closed" };

export const WALK_IDLE: WalkState = { phase: "idle", lastUndoAt: null, milestone: false };

export function walk(state: WalkState, event: WalkEvent): WalkState {
  const s = state.milestone ? { ...state, milestone: false } : state;
  switch (event.type) {
    case "step": {
      const milestone = event.dir === "undo" && s.lastUndoAt !== null && event.at - s.lastUndoAt <= MILESTONE_WINDOW_MS;
      const lastUndoAt = event.dir === "undo" ? event.at : s.lastUndoAt;
      const phase: WalkPhase = !event.held
        ? s.phase === "pinned" ? "pinned" : "idle"
        : s.phase === "idle" ? "armed"
        // A second step inside the delay opens the peek at once: the user is walking.
        : s.phase === "armed" || s.phase === "fading" ? "peek"
        : s.phase;
      return { phase, lastUndoAt, milestone };
    }
    case "peekTimer":
      return s.phase === "armed" ? { ...s, phase: "peek" } : s;
    case "pin":
      return s.phase === "peek" || s.phase === "fading" ? { ...s, phase: "pinned" } : s;
    case "release":
      if (s.phase === "armed") return { ...s, phase: "idle" };
      if (s.phase === "peek") return { ...s, phase: event.hovered ? "pinned" : "fading" };
      return s;
    case "pointerEnter":
      return s.phase === "fading" ? { ...s, phase: "pinned" } : s;
    case "fadeTimer":
      return s.phase === "fading" ? { ...s, phase: "idle" } : s;
    case "otherKey":
      // A pinned card owns its keys; anything earlier ends the walk.
      return s.phase === "pinned" || s.phase === "idle" ? s : { ...s, phase: "idle" };
    case "closed":
      return s.phase === "idle" ? s : { ...s, phase: "idle" };
  }
}

/** What the timeline card shows for a walk state. */
export function walkView(state: WalkState): { open: false } | { open: true; mode: "peek" | "interactive" } {
  switch (state.phase) {
    case "peek":
    case "fading":
      return { open: true, mode: "peek" };
    case "pinned":
      return { open: true, mode: "interactive" };
    default:
      return { open: false };
  }
}

/** The one timer a walk state runs, and the event it feeds back. */
export function walkTimer(state: WalkState): { ms: number; event: WalkEvent } | null {
  if (state.phase === "armed") return { ms: PEEK_DELAY_MS, event: { type: "peekTimer" } };
  if (state.phase === "fading") return { ms: FADE_MS, event: { type: "fadeTimer" } };
  return null;
}
