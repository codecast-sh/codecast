// Which focused surfaces the global shortcut dispatcher must leave alone.
// Kept apart from ShortcutProvider so tests can run the real guards through
// createKeydownHandler without mounting the provider's app dependencies.
import type { KeydownOptions } from "@platform/keys";
import type { ShortcutAction } from "./registry";

// Focused regions that own their plain keys. Window key listeners outside the
// dispatcher (GenericListView) honour the same selector.
export const OWNS_KEYS_SELECTOR = '[data-review-region="active"], [data-owns-keys]';

type KeyTarget = { closest?: (selector: string) => unknown } | null | undefined;

/**
 * Focus sits in a region that owns its plain keys (the undo timeline, the
 * branch map, an active review), and that region is not `ownRoot` (the
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
    // The focused undo timeline card: Esc must close the card, never clear a
    // message selection or a /changes story behind it (both are skipInputCheck
    // Escape bindings). The card hands its own undo chords on by name.
    { selector: '[data-undo-timeline="interactive"]', allow: ["palette.toggle"] },
  ],
};
