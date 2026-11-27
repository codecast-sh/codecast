// A composer's dictation: the shared controller (createDictation) bound to
// one text box and the web's microphone. The composer hands in a field
// adapter (textareaField, editorField) that writes through its own setter, so
// drafts, autosave and send see dictated words as typed ones.
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { useConvex } from "convex/react";
import { createDictation, dictationRunning, DICTATION_IDLE, type Dictation, type DictationField, type DictationState } from "@codecast/shared/contracts";
import { useMountEffect } from "../../hooks/useMountEffect";
import { dictationHost } from "./host";

/** A field plus the bookkeeping a box that is not a plain string needs. */
export type DictationFieldAdapter = DictationField & {
  /** Called before a recording reads the field. */
  begin?(): void;
  /** Called when a recording has ended, however it ended. */
  end?(): void;
  /** Put the keyboard in the box, so Enter and Esc reach the recording. */
  focus?(): void;
  /** Whether a key's target is this box. */
  holds?(target: EventTarget | null): boolean;
};

/** The boxes in this window that have a recorder, so a key can be told
 *  whether it was pressed in the one recording. Whether a recording runs is
 *  the controller's to say (dictationRunning), never this list's. */
const boxes = new Map<Dictation, { current: DictationFieldAdapter }>();

/** True when `target` is in the box that is recording: a surface that owns
 *  Esc ahead of the box (a dialog, the palette, a comment box) stands down for
 *  that key alone, so Esc cancels the recording; anywhere else it is theirs. */
export function dictatingIn(target: EventTarget | null): boolean {
  if (!dictationRunning()) return false;
  for (const [ctl, field] of boxes) if (ctl.active && field.current.holds?.(target)) return true;
  return false;
}

export type DictationControls = {
  state: DictationState;
  /** React's view of the recording, for drawing. Decide with `running()`. */
  active: boolean;
  /** The controller's own live answer: true from the press until its last
   *  words are in. React's `active` lags it by a render. */
  running(): boolean;
  start(): void;
  finish(): Promise<void>;
  cancel(): void;
  /**
   * The box's keydown while recording: Esc cancels, the submit key (Enter by
   * default) waits for the last words and then calls `submit`. Returns true
   * when it took the key; when nothing is recording it takes nothing.
   */
  keyDown(e: KeyboardEvent, submit: () => void, isSubmitKey?: (e: KeyboardEvent) => boolean): boolean;
};

const plainEnter = (e: KeyboardEvent) => e.key === "Enter" && !e.shiftKey;

/** `field` is read on every call through a ref, so a caller may pass a fresh
 *  one, but a stable one (useState) keeps the box's renders free of it. The
 *  controls returned are stable while the recording's state holds still. */
export function useDictation(field: DictationFieldAdapter): DictationControls {
  const convex = useConvex();
  const convexRef = useRef(convex);
  convexRef.current = convex;
  const fieldRef = useRef(field);
  fieldRef.current = field;
  const [state, setState] = useState<DictationState>(DICTATION_IDLE);
  const ctl = useRef<Dictation | null>(null);

  const [methods] = useState(() => {
    // Made on the first press and dropped on unmount, so a remount (StrictMode
    // included) never holds a disposed controller.
    const controller = (): Dictation => {
      if (ctl.current) return ctl.current;
      const proxy: DictationField = {
        getValue: () => fieldRef.current.getValue(),
        getSelection: () => fieldRef.current.getSelection(),
        setValue: (value, caret, anchor) => fieldRef.current.setValue(value, caret, anchor),
      };
      const made = createDictation(proxy, dictationHost(() => convexRef.current as any), (next) => {
        if (next.phase === "idle") fieldRef.current.end?.();
        setState(next);
      });
      ctl.current = made;
      boxes.set(made, fieldRef);
      return made;
    };
    const running = () => ctl.current?.active === true;
    return {
      running,
      start: () => {
        const c = controller();
        if (c.active) return;
        fieldRef.current.begin?.();
        c.start();
        fieldRef.current.focus?.();
      },
      finish: () => ctl.current?.finish() ?? Promise.resolve(),
      cancel: () => ctl.current?.cancel(),
      keyDown: (e: KeyboardEvent, submit: () => void, isSubmitKey: (e: KeyboardEvent) => boolean = plainEnter) => {
        const c = ctl.current;
        if (!c?.active) return false;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          c.cancel();
          return true;
        }
        if (isSubmitKey(e) && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          void c.finish().then(submit);
          return true;
        }
        return false;
      },
    };
  });

  useMountEffect(() => () => {
    const c = ctl.current;
    ctl.current = null;
    if (c) {
      boxes.delete(c);
      c.dispose();
    }
  });

  return useMemo(() => ({ ...methods, state, active: state.phase !== "idle" }), [methods, state]);
}

/**
 * A plain textarea as the field. `write` is the composer's own setter; it runs
 * inside flushSync, so the box has committed (and a submit right after reads
 * the new text) before the caret is placed. The value is read off the box
 * itself, which a keystroke has already changed by the time React hears of it.
 */
export function textareaField(
  el: () => HTMLTextAreaElement | null,
  fallbackValue: () => string,
  write: (value: string) => void,
): DictationFieldAdapter {
  return {
    getValue: () => el()?.value ?? fallbackValue(),
    getSelection: () => {
      const ta = el();
      // An unfocused box has no cursor the person placed: words go at the end.
      if (!ta || ta.ownerDocument.activeElement !== ta) return null;
      return [ta.selectionStart, ta.selectionEnd];
    },
    setValue: (value, caret, anchor = caret) => {
      flushSync(() => write(value));
      const ta = el();
      if (ta && ta.ownerDocument.activeElement === ta) {
        ta.setSelectionRange(Math.min(anchor, caret), Math.max(anchor, caret), anchor > caret ? "backward" : "forward");
      }
    },
    holds: (target) => {
      const ta = el();
      return !!ta && target === ta;
    },
    focus: () => {
      const ta = el();
      if (!ta || ta.ownerDocument.activeElement === ta) return;
      ta.focus();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
    },
  };
}
