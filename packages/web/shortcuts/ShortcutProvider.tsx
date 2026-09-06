"use client";

// Codecast's binding of the @platform/keys provider. The dispatch mechanics —
// capture-phase listener, decline semantics, input/modal guards — live in the
// package; this file supplies what is codecast's: the catalog, the tips
// milestone callback, and the surfaces with special keyboard ownership.

import { createShortcutRuntime } from "./runtime";
import { shortcutCatalog } from "./registry";
import { onShortcutUsed } from "../tips/useTips";

const runtime = createShortcutRuntime(shortcutCatalog, {
  // Some regions own their own single-letter keys and must not leak them to the
  // global conversation shortcuts (h/t/d/r, and critically y/n which approve or
  // deny a live permission prompt). A region opts in either with the inline
  // review marker (data-review-region="active") or the generic data-owns-keys
  // (e.g. the branch map). Treating a focus inside such a region like an input
  // makes the dispatcher skip those shortcuts; the region's own keydown handler
  // still receives the key.
  inputLikeSelector: '[data-review-region="active"], [data-owns-keys]',
  // The integrated terminal owns the keyboard harder than any input: a shell
  // lives on Ctrl chords (Ctrl+C/L/P/R/K...), and the capture-phase window
  // listener runs BEFORE xterm — so any match would silently eat the key from
  // the shell. Only the panel toggle may act; everything else falls through.
  keyboardOwners: [{ selector: "[data-terminal-panel]", allow: ["terminal.toggle"] }],
  onShortcutUsed,
}, import.meta.hot?.data.shortcutRuntime);

if (import.meta.hot) import.meta.hot.data.shortcutRuntime = runtime;

const kit = runtime.kit;

export const ShortcutProvider = kit.ShortcutProvider;
export const useShortcuts = kit.useShortcuts;
export const useShortcutAction = kit.useShortcutAction;
export const useShortcutContext = kit.useShortcutContext;
