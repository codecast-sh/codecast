// A step's unsaved instructions edit (line-workspace.md LW1, LW4): this
// window's UI state, not data; nothing here reaches the store or the server.
// It lives outside the step page so an edit survives leaving the step and
// coming back.
import { useSyncExternalStore } from "react";

let drafts: Readonly<Record<string, string>> = {};
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

/** One step's unsaved text, or null. */
export const useStepDraft = (stepId: string | null | undefined) =>
  useSyncExternalStore(subscribe, () => (stepId ? drafts[stepId] ?? null : null), () => null);
