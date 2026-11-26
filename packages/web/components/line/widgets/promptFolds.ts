// Which of a step's instruction sections are open (ct-101553): this window's
// UI state, not data, kept the way stepDrafts.ts keeps an unsaved edit, so a
// section opened by hand is still open after switching tabs or steps. "Open
// all" / "Fold all" is one choice for every step; a section opened or folded
// by hand overrides it for that step until the next Open all / Fold all.
// Sections are named by title, so an edit above one does not lose it.
import { useSyncExternalStore } from "react";

type Folds = { openAll: boolean; byStep: Readonly<Record<string, Readonly<Record<string, boolean>>>> };

let folds: Folds = { openAll: false, byStep: {} };
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const read = () => folds;

/** Open or fold every section of every step, dropping what was set by hand. */
export function setPromptOpenAll(openAll: boolean) {
  if (folds.openAll === openAll && Object.keys(folds.byStep).length === 0) return;
  folds = { openAll, byStep: {} };
  emit();
}

/** One section opened or folded by hand. */
export function setPromptSectionOpen(stepKey: string, section: string, open: boolean) {
  const step = folds.byStep[stepKey] ?? {};
  const current = step[section] ?? folds.openAll;
  if (current === open) return;
  folds = { ...folds, byStep: { ...folds.byStep, [stepKey]: { ...step, [section]: open } } };
  emit();
}

/** Whether "Open all" is on, and what was set by hand on this step. */
export function usePromptFolds(stepKey: string) {
  const f = useSyncExternalStore(subscribe, read, read);
  return { openAll: f.openAll, byHand: f.byStep[stepKey] };
}
