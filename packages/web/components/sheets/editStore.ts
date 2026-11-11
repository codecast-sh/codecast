// The cell being edited, held outside React state so a keystroke re-renders
// only the in-cell editor and the formula bar, never the grid.
import { useSyncExternalStore } from "react";

export type EditState = {
  /** The tab the edit belongs to: a commit always writes there, whatever tab is showing by then. */
  tab: string;
  col: number;
  row: number;
  text: string;
  /** "enter": typed over the cell, arrows commit and move. "edit": F2 / double-click / formula bar, arrows move the caret. */
  mode: "enter" | "edit";
  /** Where the person is typing: the in-cell editor or the formula bar. */
  surface: "cell" | "bar";
};

export type EditStore = {
  get: () => EditState | null;
  set: (next: EditState | null) => void;
  patch: (p: Partial<EditState>) => void;
  subscribe: (fn: () => void) => () => void;
};

export function createEditStore(): EditStore {
  let state: EditState | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const fn of listeners) fn();
  };
  return {
    get: () => state,
    set: (next) => {
      state = next;
      emit();
    },
    patch: (p) => {
      if (!state) return;
      state = { ...state, ...p };
      emit();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export function useEditState(store: EditStore): EditState | null {
  return useSyncExternalStore(store.subscribe, store.get, () => null);
}

/** Whether the caret sits where a clicked cell should insert a reference: after an operator, "(" or ",". */
export function wantsReference(text: string, caret: number): boolean {
  if (!text.startsWith("=")) return false;
  const before = text.slice(0, caret).trimEnd();
  return /[=+\-*/^&,(<>:]$/.test(before);
}

/** The function name being typed at the caret ("=SU|" -> "SU"), for autocomplete. */
export function fnPrefixAt(text: string, caret: number): string | null {
  if (!text.startsWith("=")) return null;
  const m = text.slice(0, caret).match(/(?:^=|[=+\-*/^&,(<>\s])([A-Za-z][A-Za-z0-9.]*)$/);
  return m ? m[1].toUpperCase() : null;
}

/** Auto-close an open string and parentheses on a formula; text inside strings does not count. */
export function finishInput(text: string): string {
  if (!(text.length > 1 && text[0] === "=")) return text;
  let depth = 0;
  let inStr = false;
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" && !inStr) {
      // A quoted tab name ('Costs (draft)'!A1): skip to its closing quote ('' escapes one).
      let j = i + 1;
      while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1;
      i = j;
    } else if (ch === '"') {
      if (inStr && text[i + 1] === '"') i++;
      else inStr = !inStr;
    } else if (!inStr && ch === "(") depth++;
    else if (!inStr && ch === ")") depth = Math.max(0, depth - 1);
  }
  return text + (inStr ? '"' : "") + ")".repeat(depth);
}

