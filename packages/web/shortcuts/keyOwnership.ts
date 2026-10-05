// Which focused surfaces the global shortcut dispatcher must leave alone.
// Kept apart from ShortcutProvider so tests can run the real guards through
// createKeydownHandler without mounting the provider's app dependencies.
import type { KeydownOptions } from "@platform/keys";

// An overlay that owns the keyboard while it holds focus (the undo timeline
// card) claims its keys in the app's first key listener: a claimed key stops
// there, so no shortcut and no page listener (window or document, capture or
// bubble, useEventListener or a React handler) can act on it underneath.
// Pages need no check of their own for such an overlay.
export { claimKeys } from "@platform/keys";
import type { ShortcutAction } from "./registry";

// Focused regions that own their plain keys. Window key listeners outside the
// dispatcher (GenericListView) honour the same selector.
export const OWNS_KEYS_SELECTOR = '[data-review-region="active"], [data-owns-keys]';

type KeyTarget = { closest?: (selector: string) => unknown } | null | undefined;

/**
 * Focus sits in a region that owns its plain keys (the branch map, the vault
 * explorer, an active review), and that region is not `ownRoot` (the
 * surface asking). The dispatcher skips such focus through KEY_OWNERSHIP;
 * every window key listener outside it asks the same question here.
 */
export function keysOwnedElsewhere(
  target: KeyTarget | EventTarget,
  ownRoot?: { contains: (node: any) => boolean } | null,
): boolean {
  const t = target as KeyTarget;
  return !!t?.closest?.(OWNS_KEYS_SELECTOR) && !ownRoot?.contains(t);
}

/**
 * A page's window key listener leaves this key alone: focus is in a text
 * field, or in a region that owns its keys (keysOwnedElsewhere).
 */
export function keyBelongsElsewhere(target: EventTarget | null | undefined): boolean {
  const el = target as HTMLElement | null | undefined;
  if (!el) return false;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) return true;
  return keysOwnedElsewhere(el);
}

/** The chords that keep working while focus is inside the undo timeline
 *  card. The card claims its keys ahead of the dispatcher and hands these on
 *  by name; its keyboard-owner entry allows them too, so the desktop Edit
 *  menu (which asks the same ownership question) reaches them as well. */
export const UNDO_CARD_CHORDS: ShortcutAction[] = ["ui.undo", "ui.redo", "ui.undoHistory"];

export const KEY_OWNERSHIP: Pick<KeydownOptions<ShortcutAction>, "inputLikeSelector" | "keyboardOwners"> = {
  // Some regions own their own single-letter keys and must not leak them to the
  // global conversation shortcuts (h/t/d/r, and critically y/n which approve or
  // deny a live permission prompt). A region opts in either with the inline
  // review marker (data-review-region="active") or the generic data-owns-keys
  // (e.g. the branch map). Treating a focus inside such a region like an input
  // makes the dispatcher skip those shortcuts; the region's own keydown handler
  // still receives the key.
  inputLikeSelector: OWNS_KEYS_SELECTOR,
  keyboardOwners: [
    // The integrated terminal owns the keyboard harder than any input: a shell
    // lives on Ctrl chords (Ctrl+C/L/P/R/K...), and the capture-phase window
    // listener runs BEFORE xterm, so any match would silently eat the key from
    // the shell. Only the panel toggle may act; everything else falls through.
    { selector: "[data-terminal-panel]", allow: ["terminal.toggle"] },
    // The focused undo timeline card claims its plain keys and its own undo
    // chords outright (claimKeys); of the chords left, only the palette may
    // act on the page behind it. Its own chords stay allowed so the desktop
    // Edit menu's hand-back of them is not refused here.
    { selector: '[data-undo-timeline="interactive"]', allow: ["palette.toggle", ...UNDO_CARD_CHORDS] },
  ],
};
