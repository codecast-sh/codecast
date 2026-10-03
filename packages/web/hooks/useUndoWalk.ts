"use client";
// Owns ui.undo and ui.redo, and drives the held-modifier peek of the undo
// timeline (docs/architecture/undo-history.md S9, doorway 4). Each press
// commits at once; the pure reducer in lib/undoWalk decides what the card
// shows. The modifier is tracked with window key listeners, the way
// useRecentSwitcher tracks Control: Meta on mac, Control elsewhere.
import { useCallback, useEffect, useRef } from "react";
import { useEventListener } from "./useEventListener";
import { subscribeShortcutUsed, useShortcutAction, useShortcuts } from "../shortcuts/ShortcutProvider";
import { isEditableTarget, shortcutAllowedAt } from "@platform/keys";
import { getShortcutsForAction, isMac, matchShortcut, type ShortcutAction } from "../shortcuts/registry";
import { KEY_OWNERSHIP } from "../shortcuts/keyOwnership";
import { bridge, isElectron } from "../lib/desktop";
import { getUndoHistory, performRedo, performUndo } from "../store/undoStack";
import * as undoTimeline from "../lib/undoTimelineOpen";
import { fireUndoHistoryMilestone } from "../lib/undoHistory";
import { WALK_IDLE, fieldOwnsStep, walk, walkTimer, walkView, type WalkEvent, type WalkState } from "../lib/undoWalk";

const CARD_SELECTOR = "[data-undo-timeline]";
/** The shortcut context live while the card peeks or fades: it routes H to
 *  undoWalk.pin ahead of every other H binding. */
const WALK_CONTEXT = "undoWalk";
/** Actions that are part of the walk; any other dispatched action ends it. */
const WALK_ACTIONS: ReadonlySet<ShortcutAction> = new Set(["ui.undo", "ui.redo", "undoWalk.pin"]);

function walkModifier(): "Meta" | "Control" {
  return isMac ? "Meta" : "Control";
}

/** The keydown is an undo/redo chord the dispatcher let through (a held
 *  chord's auto-repeat, or a press with nothing to take back). */
function isStepChord(e: KeyboardEvent): boolean {
  return (["ui.undo", "ui.redo"] as const).some((a) => getShortcutsForAction(a).some((d) => matchShortcut(e, d)));
}

/** The top of the stack a step in `dir` moves entries onto. */
function landingTop(dir: "undo" | "redo"): string | undefined {
  const h = getUndoHistory();
  return (dir === "undo" ? h.redoOrder : h.undoOrder)[0];
}

const CAPTURE: AddEventListenerOptions = { capture: true };

function pointerOverCard(): boolean {
  const card = typeof document !== "undefined" ? document.querySelector(CARD_SELECTOR) : null;
  return !!card?.matches(":hover");
}

export function useUndoWalk(): void {
  const state = useRef<WalkState>(WALK_IDLE);
  const held = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { setContext } = useShortcuts();
  // When each text field was last edited, for fieldOwnsStep.
  const fieldEdits = useRef(new WeakMap<Element, number>());

  const feed = useCallback((event: WalkEvent) => {
    const prev = state.current;
    const next = walk(prev, event);
    state.current = next;
    if (next.milestone) fireUndoHistoryMilestone(walkView(next).open);
    if (next.phase === prev.phase) return;

    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const t = walkTimer(next);
    if (t) timer.current = setTimeout(() => { timer.current = null; feed(t.event); }, t.ms);

    const before = walkView(prev);
    const after = walkView(next);
    setContext(WALK_CONTEXT, after.open && after.mode === "peek");
    if (after.open) {
      if (!before.open || before.mode !== after.mode) undoTimeline.open(after.mode);
    } else if (before.open) {
      undoTimeline.close();
    }
  }, [setContext]);

  // A press commits first, then tells the walk. A card some other doorway
  // opened (the palette, the chord, a toast) is left as it is: the walk only
  // drives a card it opened itself.
  const step = useCallback((dir: "undo" | "redo") => {
    // The chords reach here from an empty text field too. One whose own
    // history is newer than the entry declines, so the browser's undo runs.
    const focus = typeof document !== "undefined" ? document.activeElement : null;
    if (isEditableTarget(focus) && fieldOwnsStep(dir, fieldEdits.current.get(focus!), getUndoHistory())) return false;
    const landed = landingTop(dir);
    const done = dir === "undo" ? performUndo() : performRedo();
    // Only a press that took something back is a step. One with nothing to
    // take back is declined; in the desktop app it comes back through the Edit
    // menu and must not count twice. A conflict or a confirm entry is handled
    // (the key is consumed and a notice shows) but moved nothing, so it
    // neither arms the peek, which would take that notice down, nor counts
    // toward the milestone.
    if (!done) return false;
    if (landingTop(dir) === landed) return done;
    const foreignCard = undoTimeline.isOpen() && state.current.phase === "idle";
    feed({ type: "step", dir, held: held.current && !foreignCard, at: Date.now() });
    return done;
  }, [feed]);

  useShortcutAction("ui.undo", useCallback(() => step("undo"), [step]));
  useShortcutAction("ui.redo", useCallback(() => step("redo"), [step]));

  // H while the card peeks or fades pins it. The binding exists only in the
  // walk's context, so it never takes an H from anyone else.
  useShortcutAction("undoWalk.pin", useCallback(() => {
    const phase = state.current.phase;
    if (phase !== "peek" && phase !== "fading") return false;
    feed({ type: "pin" });
    return true;
  }, [feed]));

  // A key the dispatcher handled (⌘K, j/k, ...) never reaches the window
  // listener below, so it is heard here: it ends the walk and has already
  // reached whoever owns it.
  useEffect(() => subscribeShortcutUsed((action) => {
    if (!WALK_ACTIONS.has(action)) feed({ type: "otherKey" });
  }), [feed]);

  // In the desktop app the Edit menu takes ⌘Z before the page and hands the
  // press back here when focus is not in a text field. It passes the same
  // guards the dispatcher applies to the key (a modal, a key-owning region,
  // a keyboard owner like the terminal), so a press the browser would decline
  // takes nothing back in the desktop app either.
  useEffect(() => {
    if (!isElectron()) return;
    return bridge("onAppEditCommand")?.((dir) => {
      const focus = document.activeElement;
      const action = dir === "undo" ? "ui.undo" : "ui.redo";
      if (getShortcutsForAction(action).some((d) => shortcutAllowedAt(focus, d, KEY_OWNERSHIP))) step(dir);
    });
  }, [step]);

  // Esc, an opened row or the chord closed the card: the walk is over.
  useEffect(() => undoTimeline.subscribe(() => {
    if (!undoTimeline.isOpen()) feed({ type: "closed" });
  }), [feed]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    setContext(WALK_CONTEXT, false);
  }, [setContext]);

  // Keys no shortcut handled. The modifier is tracked here; anything else
  // ends the walk and reaches whoever owns it.
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === walkModifier()) { held.current = true; return; }
    if (e.key === "Shift" || e.key === "Alt" || e.key === "Meta" || e.key === "Control") return;
    const phase = state.current.phase;
    if (phase === "idle" || phase === "pinned") return;
    if (isStepChord(e)) return;
    feed({ type: "otherKey" });
  });

  useEventListener("keyup", (e: KeyboardEvent) => {
    if (e.key !== walkModifier()) return;
    held.current = false;
    feed({ type: "release", hovered: pointerOverCard() });
  });

  useEventListener("input", (e: Event) => {
    if (e.target instanceof Element) fieldEdits.current.set(e.target, Date.now());
  }, undefined, CAPTURE);

  // Leaving the window drops the key state with it.
  useEventListener("blur", () => {
    if (!held.current) return;
    held.current = false;
    feed({ type: "release", hovered: false });
  });

  useEventListener("pointerover", (e: PointerEvent) => {
    if (state.current.phase !== "fading") return;
    if ((e.target as Element | null)?.closest?.(CARD_SELECTOR)) feed({ type: "pointerEnter" });
  });
}
