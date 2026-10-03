// Which focused surfaces the global shortcut dispatcher must leave alone.
// Kept apart from ShortcutProvider so tests can run the real guards through
// createKeydownHandler without mounting the provider's app dependencies.
import type { KeydownOptions } from "@platform/keys";
import type { ShortcutAction } from "./registry";

export const KEY_OWNERSHIP: Pick<KeydownOptions<ShortcutAction>, "inputLikeSelector" | "keyboardOwners"> = {
  // Some regions own their own single-letter keys and must not leak them to the
  // global conversation shortcuts (h/t/d/r, and critically y/n which approve or
  // deny a live permission prompt). A region opts in either with the inline
  // review marker (data-review-region="active") or the generic data-owns-keys
  // (e.g. the branch map). Treating a focus inside such a region like an input
  // makes the dispatcher skip those shortcuts; the region's own keydown handler
  // still receives the key.
  inputLikeSelector: '[data-review-region="active"], [data-owns-keys]',
  keyboardOwners: [
    // The integrated terminal owns the keyboard harder than any input: a shell
    // lives on Ctrl chords (Ctrl+C/L/P/R/K...), and the capture-phase window
    // listener runs BEFORE xterm, so any match would silently eat the key from
    // the shell. Only the panel toggle may act; everything else falls through.
    { selector: "[data-terminal-panel]", allow: ["terminal.toggle"] },
    // The focused undo timeline card: Esc must close the card, never clear a
    // message selection or a /changes story behind it (both are skipInputCheck
    // Escape bindings). The card hands its own undo chords on by name.
    { selector: '[data-undo-timeline="interactive"]', allow: ["palette.toggle"] },
  ],
};
