// A composer's dictation: the shared controller (createDictation) bound to
// one text box and the web's microphone. The composer hands in a field
// adapter (textareaField, editorField) that writes through its own setter, so
// drafts, autosave and send see dictated words as typed ones.
import { useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { useConvex } from "convex/react";
import { createDictation, DICTATION_IDLE, type Dictation, type DictationField, type DictationState } from "@codecast/shared/contracts";
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
};

/** The recordings running in this window. One at most (the controller's rule);
 *  a set so a stale entry can never hide a live one. */
const recording = new Set<Dictation>();

/** True while some box in this window is dictating: a surface that owns Esc in
 *  the capture phase (a dialog, the palette) stands down so Esc cancels it. */
export function isDictating(): boolean {
  return recording.size > 0;
}

export type DictationControls = {
  state: DictationState;
  active: boolean;
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

export function useDictation(field: DictationFieldAdapter): DictationControls {
  const convex = useConvex();
  const convexRef = useRef(convex);
  convexRef.current = convex;
  const fieldRef = useRef(field);
  fieldRef.current = field;
  const [state, setState] = useState<DictationState>(DICTATION_IDLE);
  const ctl = useRef<Dictation | null>(null);

  // Made on the first press and dropped on unmount, so a remount (StrictMode
  // included) never holds a disposed controller.
  const controller = (): Dictation => {
    if (ctl.current) return ctl.current;
    const proxy: DictationField = {
      getValue: () => fieldRef.current.getValue(),
      getSelection: () => fieldRef.current.getSelection(),
      setValue: (value, caret) => fieldRef.current.setValue(value, caret),
    };
    const made = createDictation(proxy, dictationHost(() => convexRef.current as any), (next) => {
      if (next.phase === "idle") {
        recording.delete(made);
        fieldRef.current.end?.();
      } else recording.add(made);
      setState(next);
    });
    ctl.current = made;
    return made;
  };

  useMountEffect(() => () => {
    const c = ctl.current;
    ctl.current = null;
    if (c) {
      recording.delete(c);
      c.dispose();
    }
  });

  return {
    state,
    active: state.phase !== "idle",
    start: () => {
      const c = controller();
      if (c.active) return;
      fieldRef.current.begin?.();
      c.start();
      fieldRef.current.focus?.();
    },
    finish: () => ctl.current?.finish() ?? Promise.resolve(),
    cancel: () => ctl.current?.cancel(),
    keyDown: (e, submit, isSubmitKey = plainEnter) => {
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
    setValue: (value, caret) => {
      flushSync(() => write(value));
      const ta = el();
      if (ta && ta.ownerDocument.activeElement === ta) ta.setSelectionRange(caret, caret);
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
