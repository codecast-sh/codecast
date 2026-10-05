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
//   hovered the pointer is over the card: it stays open as a peek, taking no
//           focus and no keys, until the pointer leaves (back to fading) or a
//           press on it pins it. A pointer resting where the card opened is
//           not a request to type into it.
//   pinned  the card is interactive and owns the keyboard until it closes.
//
// Every press commits at once (the hook calls performUndo/performRedo before
// it feeds the event); the walk only decides what the card shows.

import { undoKeyboardSince } from "@platform/engine";

export const PEEK_DELAY_MS = 350;
export const FADE_MS = 600;
/** A second undo inside this window fires the milestone tip that names the timeline. */
export const MILESTONE_WINDOW_MS = 10_000;

export type WalkPhase = "idle" | "armed" | "peek" | "fading" | "hovered" | "pinned";

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
  /** The pointer left the card. */
  | { type: "pointerLeave" }
  /** A press on the card, or the history chord while it shows: the explicit request to use it. */
  | { type: "cardPress" }
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
      // Not from hovered: that peek takes no keys, so only a press pins it.
      return s.phase === "peek" || s.phase === "fading" ? { ...s, phase: "pinned" } : s;
    case "release":
      if (s.phase === "armed") return { ...s, phase: "idle" };
      if (s.phase === "peek") return { ...s, phase: event.hovered ? "hovered" : "fading" };
      return s;
    case "pointerEnter":
      return s.phase === "fading" ? { ...s, phase: "hovered" } : s;
    case "pointerLeave":
      return s.phase === "hovered" ? { ...s, phase: "fading" } : s;
    case "cardPress":
      return s.phase === "peek" || s.phase === "fading" || s.phase === "hovered" ? { ...s, phase: "pinned" } : s;
    case "fadeTimer":
      return s.phase === "fading" ? { ...s, phase: "idle" } : s;
    case "otherKey":
      // A pinned card owns its keys; anything earlier ends the walk.
      return s.phase === "pinned" || s.phase === "idle" ? s : { ...s, phase: "idle" };
    case "closed":
      return s.phase === "idle" ? s : { ...s, phase: "idle" };
  }
}

/** Whether the card takes the pin key: a peek the keyboard opened, not one a resting pointer holds. */
export function walkTakesPinKey(state: WalkState): boolean {
  return state.phase === "peek" || state.phase === "fading";
}

/** What the timeline card shows for a walk state. */
export function walkView(state: WalkState): { open: false } | { open: true; mode: "peek" | "interactive" } {
  switch (state.phase) {
    case "peek":
    case "fading":
    case "hovered":
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

/**
 * Whether a press from an empty text field belongs to the field rather than
 * the app. The undo chords fire app undo from an empty field (the triage
 * chords act from an empty composer and leave focus there), but a field
 * edited after the entry the press would reach was recorded (undo) or taken
 * back (redo) holds the newer history: clearing a draft and pressing ⌘Z
 * brings the draft back.
 */
type StepHistory = {
  items: readonly { id: string; ts: number; undoneAt?: number; redoneAt?: number }[];
  undoOrder: readonly string[];
  redoOrder: readonly string[];
};

export function fieldOwnsStep(dir: "undo" | "redo", lastEditAt: number | undefined, history: StepHistory): boolean {
  if (lastEditAt === undefined) return false;
  const id = (dir === "undo" ? history.undoOrder : history.redoOrder)[0];
  const entry = id ? history.items.find((i) => i.id === id) : undefined;
  if (!entry) return true;
  const since = dir === "undo" ? undoKeyboardSince(entry) : (entry.undoneAt ?? entry.ts);
  return lastEditAt > since;
}

/**
 * fieldOwnsStep over the fields' edit times, which it keeps. A declined press
 * goes to the browser, and the browser may have nothing left to take back
 * (the field's edits are all undone). Then the press is the app's after all,
 * and the field's edit time is dropped so later presses go straight there.
 *
 * `nativeCan` is the browser's own answer (a rich editor's history, or
 * Chromium's queryCommandEnabled, which the desktop app needs: its declined
 * key reaches the native undo through the main process, later than any
 * timer). Chromium answers for the whole frame, not the field: any field
 * typed in and still mounted makes it true. So only `false` is taken as the
 * field's own answer, and a press is kept only by a field this page saw
 * edited. A kept press whose browser undo lands in another field (heard as
 * that field's input) shows the declining field had nothing left, and its
 * edit record goes. Without an answer, a native undo or redo always fires an
 * input, so when none arrived by the next task the browser had nothing and
 * `fallback` runs the app's step.
 */
export function createFieldUndoGuard(opts: { now: () => number; defer: (fn: () => void) => void }) {
  const edits = new WeakMap<object, number>();
  // Fields with a check already waiting: one key press can reach the step
  // more than once (each binding it matches), and gets one fallback.
  const checking = new WeakSet<object>();
  let inputs = 0;
  // The field the last press was kept for, until the next input says where
  // the browser's step landed.
  let kept: object | null = null;
  return {
    edited(field: object): void {
      inputs += 1;
      if (kept && kept !== field) edits.delete(kept);
      kept = null;
      edits.set(field, opts.now());
    },
    /** True when the press is the field's; `fallback` runs if the field turns out to have nothing. */
    declines(
      dir: "undo" | "redo",
      field: object,
      history: StepHistory,
      fallback: () => void,
      nativeCan?: boolean,
    ): boolean {
      if (!fieldOwnsStep(dir, edits.get(field), history)) return false;
      return fieldHasStep(field, fallback, nativeCan);
    },
    /**
     * The same question for a field holding text, which keeps its own undo
     * whatever the entries' ages, as long as it has one. Text the app put
     * there (a draft seeded on mount, a value set from code) and nobody
     * edited has none: the browser's undo would do nothing, so the press is
     * the app's, whatever the frame-wide `nativeCan` says.
     */
    keepsWithText(field: object, fallback: () => void, nativeCan?: boolean): boolean {
      if (!edits.has(field)) return false;
      return fieldHasStep(field, fallback, nativeCan);
    },
  };

  function fieldHasStep(field: object, fallback: () => void, nativeCan: boolean | undefined): boolean {
    if (nativeCan === false) {
      edits.delete(field);
      return false;
    }
    kept = field;
    if (nativeCan === true || checking.has(field)) return true;
    checking.add(field);
    const seen = inputs;
    opts.defer(() => {
      checking.delete(field);
      if (inputs !== seen) return;
      edits.delete(field);
      fallback();
    });
    return true;
  }
}

/** Input types that hold no text of their own (no caret, no edit history):
 *  ⌘Z from one of them is the app's, never the browser's. The desktop main
 *  process asks the same question (packages/electron/editUndo.js
 *  EDITABLE_PROBE); undoWalk.test pins the two answers together. */
const NON_TEXT_INPUT = /^(button|checkbox|radio|submit|reset|range|color|file|image|hidden|date|time|datetime-local|month|week)$/i;

type ControlLike = { tagName?: string; type?: string; readOnly?: boolean; disabled?: boolean; isContentEditable?: boolean };

/**
 * A focused control that edits text and so keeps its own undo: a writable
 * text input or textarea, a contenteditable, or a frame (whose document keeps
 * its own keys). A checkbox, radio, date, range or read-only field is not one,
 * whatever the browser's frame-wide undo says.
 */
export function isTextEditingControl(el: EventTarget | null | undefined): boolean {
  const f = el as ControlLike | null | undefined;
  if (!f) return false;
  if (f.isContentEditable === true || f.tagName === "IFRAME") return true;
  if (f.tagName === "TEXTAREA") return !f.readOnly && !f.disabled;
  if (f.tagName === "INPUT") return !f.readOnly && !f.disabled && !NON_TEXT_INPUT.test(f.type ?? "");
  return false;
}

/** Whether a focused text-editing control holds text, as the key dispatcher
 *  judges a field empty; null for anything with no text to read (a non-text
 *  control, a frame). */
export function fieldHoldsText(el: Element): boolean | null {
  const f = el as { tagName?: string; isContentEditable?: boolean; value?: string; textContent?: string | null };
  if (!isTextEditingControl(el)) return null;
  if (f.tagName === "INPUT" || f.tagName === "TEXTAREA") return (f.value ?? "") !== "";
  if (f.isContentEditable) return !!(f.textContent ?? "").trim();
  return null;
}

/**
 * A rich editor that keeps its own history and edits its DOM itself:
 * select-all+Backspace runs in its keymap and fires no input event, and its
 * own undo fires none either. The field guard dates such a field from the
 * editor's `update` and asks the editor, not the browser, whether it has a
 * step left. TipTap (over ProseMirror) hangs its editor off its
 * contenteditable as `.editor`; any other such editor (CodeMirror in the
 * vault) registers the same shape on its editable element.
 */
export type RichEditor = {
  on(event: "update", fn: () => void): unknown;
  can(): { undo?: () => boolean; redo?: () => boolean };
};

const registeredEditors = new WeakMap<object, RichEditor>();

/** Declare `el` an editor with its own history. Returns the unregister. */
export function registerRichEditor(el: Element, editor: RichEditor): () => void {
  registeredEditors.set(el, editor);
  return () => {
    if (registeredEditors.get(el) === editor) registeredEditors.delete(el);
  };
}

export function richEditorOf(el: unknown): RichEditor | null {
  if (el && typeof el === "object") {
    const registered = registeredEditors.get(el);
    if (registered) return registered;
  }
  const ed = (el as { editor?: Partial<RichEditor> } | null)?.editor;
  return ed && typeof ed.on === "function" && typeof ed.can === "function" ? (ed as RichEditor) : null;
}

/** The editor's own answer to "is there a step left", when it gives one. */
export function richEditorCanStep(ed: RichEditor, dir: "undo" | "redo"): boolean | undefined {
  try {
    const can = ed.can()[dir];
    return typeof can === "function" ? !!can() : undefined;
  } catch {
    return undefined;
  }
}
