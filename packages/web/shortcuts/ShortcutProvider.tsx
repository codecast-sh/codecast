"use client";

// Codecast's binding of the @platform/keys provider. The dispatch mechanics —
// capture-phase listener, decline semantics, input/modal guards — live in the
// package; this file supplies what is codecast's: the catalog, the tips
// milestone callback, and the surfaces with special keyboard ownership
// (keyOwnership.ts).

import { createShortcutRuntime } from "./runtime";
import { shortcutCatalog } from "./registry";
import { KEY_OWNERSHIP } from "./keyOwnership";
import { onShortcutUsed } from "../tips/useTips";
import { useTabActive } from "../hooks/usePagePresence";
import type { ShortcutAction } from "./registry";
import { track } from "../lib/analytics";
import { TRACKED_SHORTCUTS } from "@codecast/shared/analytics";

const trackedShortcuts = new Set<string>(TRACKED_SHORTCUTS);

const usedListeners = new Set<(action: ShortcutAction) => void>();

/** Hear every action a key dispatched, after its handler ran. A handled key
 *  stops at the capture-phase dispatcher, so a window keydown listener never
 *  sees it; this is how such a listener learns the key was pressed. */
export function subscribeShortcutUsed(fn: (action: ShortcutAction) => void): () => void {
  usedListeners.add(fn);
  return () => { usedListeners.delete(fn); };
}

const runtime = createShortcutRuntime(shortcutCatalog, {
  ...KEY_OWNERSHIP,
  onShortcutUsed: (action: ShortcutAction) => {
    onShortcutUsed(action);
    if (trackedShortcuts.has(action)) track("shortcut_used", { action: action as (typeof TRACKED_SHORTCUTS)[number] });
    for (const fn of [...usedListeners]) fn(action);
  },
}, import.meta.hot?.data.shortcutRuntime);

if (import.meta.hot) import.meta.hot.data.shortcutRuntime = runtime;

const kit = runtime.kit;

export const ShortcutProvider = kit.ShortcutProvider;
export const useShortcuts = kit.useShortcuts;
export const useShortcutAction = kit.useShortcutAction;
export const useShortcutContext = kit.useShortcutContext;

/** A shortcut that acts on the pane it is mounted in. Visited tabs stay
 *  mounted hidden and a split shows several panes, so every copy of a page
 *  registers; only the copy in the active pane may answer, the rest decline. */
export function usePaneShortcutAction(action: ShortcutAction, handler: () => boolean | void): void {
  const active = useTabActive();
  useShortcutAction(action, () => (active ? handler() : false));
}
