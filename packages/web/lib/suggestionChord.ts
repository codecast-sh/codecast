// Resolves a keydown to a suggestion pill index (0-2), or -1. Desktop app
// only: in a browser every digit chord is spoken for upstream — the Mac OS
// takes ⌃digit (Mission Control's Space switcher), Chrome takes ⌘digit on Mac
// and Ctrl+digit on Windows/Linux (tab switching, page can't override), and
// the app itself takes ⌥digit (workbench layouts). Electron has no tab bar,
// so the platform's ordinary "pick item N" chord — ⌘digit on Mac, Ctrl+digit
// elsewhere — is free there, and the web surface stays click-only.
export function suggestionChordIndex(
  e: {
    ctrlKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    code: string;
  },
  env: { desktop: boolean; mac: boolean },
): number {
  if (!env.desktop || e.shiftKey || e.altKey) return -1;
  if (env.mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return -1;
  return ["Digit1", "Digit2", "Digit3"].indexOf(e.code);
}
