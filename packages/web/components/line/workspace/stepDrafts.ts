// A step's unsaved prompt edit and the drawer tab a view asks for
// (line-workspace.md LW1, LW4). Both are this window's UI state, not data:
// nothing here reaches the store or the server. They live outside the step
// drawer so a view can read the edit (Replay re-runs a case with it) and open
// the drawer where the person means to work (the prompt in edit, Ask an agent).
import { useSyncExternalStore } from "react";

export type DrawerTab = "prompt" | "decisions" | "try" | "ask";
/** A view's ask: open `step` on `tab`, editing the prompt when `edit`. `n` makes a repeat ask a new one. */
export type DrawerRequest = { step: string; tab: DrawerTab; edit: boolean; n: number };

let drafts: Readonly<Record<string, string>> = {};
let request: DrawerRequest | null = null;
let asks = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Set a step's unsaved text; null drops it. */
export function setStepDraft(stepId: string, text: string | null) {
  if (text == null) {
    if (!(stepId in drafts)) return;
    const { [stepId]: _, ...rest } = drafts;
    drafts = rest;
  } else {
    if (drafts[stepId] === text) return;
    drafts = { ...drafts, [stepId]: text };
  }
  emit();
}

/** Every step's unsaved text, by step id. */
export const useStepDrafts = () => useSyncExternalStore(subscribe, () => drafts, () => drafts);
/** One step's unsaved text, or null. */
export const useStepDraft = (stepId: string | null | undefined) =>
  useSyncExternalStore(subscribe, () => (stepId ? drafts[stepId] ?? null : null), () => null);

/** Ask the drawer to open on a tab; the caller selects the step itself (select({ step })). */
export function requestDrawerTab(step: string, tab: DrawerTab, opts: { edit?: boolean } = {}) {
  request = { step, tab, edit: !!opts.edit, n: ++asks };
  emit();
}
export const useDrawerRequest = () => useSyncExternalStore(subscribe, () => request, () => null);
