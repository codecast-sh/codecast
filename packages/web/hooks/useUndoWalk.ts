"use client";
// Owns ui.undo and ui.redo, and drives the held-modifier peek of the undo
// timeline (docs/architecture/undo-history.md S9, doorway 4). Each press
// commits at once; the pure reducer in lib/undoWalk decides what the card
// shows. The modifier is tracked with window key listeners, the way
// useRecentSwitcher tracks Control: Meta on mac, Control elsewhere.
import { useCallback, useEffect, useRef } from "react";
import { useEventListener } from "./useEventListener";
import { subscribeShortcutUsed, useShortcutAction, useShortcuts } from "../shortcuts/ShortcutProvider";
import { isEditableTarget, shortcutAllowedAt, type DispatchSource } from "@platform/keys";
import { getShortcutsForAction, isMac, matchShortcut, type ShortcutAction } from "../shortcuts/registry";
import { KEY_OWNERSHIP } from "../shortcuts/keyOwnership";
import { bridge, isElectron } from "../lib/desktop";
import { getUndoHistory, performRedo, performUndo } from "../store/undoStack";
import * as undoTimeline from "../lib/undoTimelineOpen";
import { fireUndoHistoryMilestone } from "../lib/undoHistory";
import { WALK_IDLE, createFieldUndoGuard, fieldHoldsText, richEditorCanStep, richEditorOf, walk, walkTimer, walkView, type RichEditor, type WalkEvent, type WalkState } from "../lib/undoWalk";

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

/** Whether the field has an undo (redo) of its own left, where that can be
 *  said reliably: a rich editor answers from its own history, and Chromium
 *  answers queryCommandEnabled from the browser's undo stack. */
function nativeCanStep(dir: "undo" | "redo", field: Element): boolean | undefined {
  const editor = richEditorOf(field);
  if (editor) return richEditorCanStep(editor, dir);
  if (typeof document === "undefined" || typeof navigator === "undefined") return undefined;
  if (!isElectron() && !/\bChrom(e|ium)\//.test(navigator.userAgent)) return undefined;
  try {
    return document.queryCommandEnabled(dir);
  } catch {
    return undefined;
  }
}

function pointerOverCard(): boolean {
  const card = typeof document !== "undefined" ? document.querySelector(CARD_SELECTOR) : null;
  return !!card?.matches(":hover");
}

export function useUndoWalk(): void {
  const state = useRef<WalkState>(WALK_IDLE);
  const held = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { setContext } = useShortcuts();
  // When each text field was last edited, and whether a press it declined
  // found anything to take back there.
  const fields = useRef<ReturnType<typeof createFieldUndoGuard> | null>(null);
  fields.current ??= createFieldUndoGuard({ now: Date.now, defer: (fn) => setTimeout(fn, 0) });

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
  const step = useCallback((dir: "undo" | "redo", source: DispatchSource): boolean => {
    // The chords reach here from an empty text field too. One whose own
    // history is newer than the entry declines, so the browser's undo runs;
    // when the browser finds nothing left in the field, the press comes back
    // here. A named step (the palette's row, typed into its input) is no edit
    // of the field it was picked from, so it never defers.
    // A field holding text keeps its own undo while it has one; text the app
    // put there that nobody edited (a draft seeded as a triage step lands on
    // its session) has none, so the press is the app's. A region with no value
    // to read keeps the chord.
    const focus = typeof document !== "undefined" ? document.activeElement : null;
    if (source === "key" && focus && isEditableTarget(focus)) {
      const fallback = () => {
        if (document.activeElement === focus) step(dir, source);
      };
      const text = fieldHoldsText(focus);
      if (text === null) return false;
      const declined = text
        ? fields.current!.keepsWithText(focus, fallback, nativeCanStep(dir, focus))
        : fields.current!.declines(dir, focus, getUndoHistory(), fallback, nativeCanStep(dir, focus));
      if (declined) return false;
    }
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

  useShortcutAction("ui.undo", useCallback((source: DispatchSource) => step("undo", source), [step]));
  useShortcutAction("ui.redo", useCallback((source: DispatchSource) => step("redo", source), [step]));

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
      if (getShortcutsForAction(action).some((d) => shortcutAllowedAt(focus, d, KEY_OWNERSHIP))) step(dir, "key");
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
    if (e.target instanceof Element) fields.current!.edited(e.target);
  }, undefined, CAPTURE);

  // A rich editor edits without input events (richEditorOf): it reports its
  // own changes, heard from the first time it takes focus. Only a change made
  // while the user's key, paste, cut or drop on that field is in flight is
  // the user's edit; a draft seeded from the store or a collaborator's edit
  // is not, as a value set from code is no edit of a plain field.
  const watched = useRef(new WeakSet<RichEditor>());
  const userEvent = useRef<Node | null>(null);
  useEffect(() => {
    const mark = (e: Event) => {
      const target = e.target instanceof Node ? e.target : null;
      userEvent.current = target;
      setTimeout(() => { if (userEvent.current === target) userEvent.current = null; }, 0);
    };
    const kinds = ["keydown", "beforeinput", "paste", "cut", "drop"] as const;
    for (const k of kinds) window.addEventListener(k, mark, CAPTURE);
    return () => { for (const k of kinds) window.removeEventListener(k, mark, CAPTURE); };
  }, []);
  useEventListener("focusin", (e: FocusEvent) => {
    const field = e.target;
    const editor = richEditorOf(field);
    if (!editor || !(field instanceof Element) || watched.current.has(editor)) return;
    watched.current.add(editor);
    editor.on("update", () => {
      if (userEvent.current && field.contains(userEvent.current)) fields.current!.edited(field);
    });
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
