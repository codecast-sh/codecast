// Formula help state while typing, shared by the in-cell editor and the
// formula bar: the function names matching the word at the caret and the
// call the caret sits in. FormulaAssist.tsx draws it.
import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { FUNCTION_DOCS, FUNCTION_NAMES, callAt } from "@codecast/shared/artifacts/sheets";
import { fnPrefixAt, type EditStore } from "./editStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";

type Field = HTMLInputElement | HTMLTextAreaElement;

export type FormulaAssist = {
  matches: string[];
  pick: number;
  call: { name: string; arg: number } | null;
  /** Arrow keys walk the list; Tab or Enter accepts. True when the key was handled here. */
  onKeyDown: (e: ReactKeyboardEvent<Field>) => boolean;
  /** Call from onChange / onSelect so the hint follows the caret. */
  track: (el: Field) => void;
  accept: (name: string) => void;
};

export function useFormulaAssist(edit: EditStore, text: string | null, fieldRef: RefObject<Field | null>, onCaret?: (caret: number) => void): FormulaAssist {
  const [caret, setCaret] = useState<number | null>(null);
  const at = text === null ? 0 : Math.min(caret ?? text.length, text.length);
  const prefix = text !== null ? fnPrefixAt(text, at) : null;
  const matches = useMemo(() => (prefix ? FUNCTION_NAMES.filter((n) => n.startsWith(prefix)).slice(0, 8) : []), [prefix]);
  const call = useMemo(() => (text !== null && !matches.length ? callAt(text, at) : null), [text, at, matches.length]);
  const [pick, setPick] = useState(0);
  useWatchEffect(() => setPick(0), [prefix]);

  const accept = (name: string) => {
    const el = fieldRef.current;
    const state = edit.get();
    if (!el || !state || !prefix) return;
    const end = el.selectionStart ?? state.text.length;
    const start = end - prefix.length;
    // An existing "(" right after the name is kept, not doubled.
    const rest = state.text.slice(end);
    const next = state.text.slice(0, start) + name + (rest.startsWith("(") ? "" : "(") + rest;
    const pos = start + name.length + 1;
    edit.patch({ text: next });
    setCaret(pos);
    requestAnimationFrame(() => {
      // Typing that landed before this frame keeps its own caret.
      if (el.value !== next) return;
      el.selectionStart = el.selectionEnd = pos;
      onCaret?.(pos);
    });
  };

  return {
    matches,
    pick,
    call: call && FUNCTION_DOCS[call.name] ? call : null,
    accept,
    track: (el) => setCaret(el.selectionStart ?? el.value.length),
    onKeyDown: (e) => {
      if (!matches.length) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPick((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
        return true;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.metaKey && !e.ctrlKey && matches[pick] !== prefix)) {
        e.preventDefault();
        accept(matches[pick]);
        return true;
      }
      return false;
    },
  };
}
