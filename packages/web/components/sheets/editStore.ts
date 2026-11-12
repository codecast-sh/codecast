// The cell being edited, held outside React state so a keystroke re-renders
// only the in-cell editor and the formula bar, never the grid.
import { useSyncExternalStore } from "react";
import { completeDateInput, isFormula, refText, tokenize } from "./sheetCore";

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
  /** Why the formula can't be committed yet (it doesn't parse); clears on the next keystroke. */
  error?: string;
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
  // A month and day without a year ("Nov 5") is a date this year.
  if (!(text.length > 1 && text[0] === "=")) return completeDateInput(text);
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

/** F4: the reference at the caret, cycled A1 -> $A$1 -> A$1 -> $A1 -> A1. */
export function cycleAnchors(text: string, caret: number): { text: string; caret: number } | null {
  if (!isFormula(text)) return null;
  let toks;
  try {
    toks = tokenize(text.slice(1));
  } catch {
    return null;
  }
  const at = caret - 1;
  const t = toks.find((x) => x.type === "ref" && at >= x.start && at <= x.end) as Extract<ReturnType<typeof tokenize>[number], { type: "ref" }> | undefined;
  if (!t || t.shape === "cols" || t.shape === "rows") return null;
  const next = (p: { absCol: boolean; absRow: boolean }) =>
    !p.absCol && !p.absRow ? { absCol: true, absRow: true } : p.absCol && p.absRow ? { absCol: false, absRow: true } : !p.absCol && p.absRow ? { absCol: true, absRow: false } : { absCol: false, absRow: false };
  const a = { ...t.a, ...next(t.a) };
  const b = t.b ? { ...t.b, ...next(t.a) } : undefined;
  const body = refText({ ...t, a, b });
  const out = "=" + text.slice(1, 1 + t.start) + body + text.slice(1 + t.end);
  return { text: out, caret: 1 + t.start + body.length };
}
