// Resolves a keydown to a suggestion pill index (0-2), or -1. Ctrl+Shift+digit
// only: bare Ctrl+digit is macOS Mission Control's Space switcher (dead at the
// OS level on any machine with Spaces), Alt+digit is workbench switching,
// Meta+digit is the browser's tab switcher — every lighter chord is owned by
// someone who gets it before us.
export function suggestionChordIndex(e: {
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  code: string;
}): number {
  if (!e.ctrlKey || !e.shiftKey || e.metaKey || e.altKey) return -1;
  return ["Digit1", "Digit2", "Digit3"].indexOf(e.code);
}
