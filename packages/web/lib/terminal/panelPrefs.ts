// Terminal panel open/height prefs.
//
// Deliberately localStorage, not clientState.ui: the terminal only exists on
// the machine whose daemon is loopback-reachable, so its open state is
// per-browser-profile by nature — syncing it through the server prefs bag
// would fight other devices (a phone has no terminal to open) and rides a
// reconcile path that can bounce a fresh toggle. Height rides along for the
// same reason.

import { useSyncExternalStore } from "react";

const KEY = "cast_term_panel";
export const DEFAULT_TERMINAL_HEIGHT = 280;

interface PanelPrefs {
  open: boolean;
  height: number;
}

let prefs: PanelPrefs = load();
const listeners = new Set<() => void>();

function load(): PanelPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        open: !!parsed.open,
        height: typeof parsed.height === "number" ? parsed.height : DEFAULT_TERMINAL_HEIGHT,
      };
    }
  } catch {}
  return { open: false, height: DEFAULT_TERMINAL_HEIGHT };
}

function save(next: PanelPrefs): void {
  prefs = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  for (const l of listeners) l();
}

export function getTerminalPanelPrefs(): PanelPrefs {
  return prefs;
}

export function setTerminalOpen(open: boolean): void {
  if (prefs.open !== open) save({ ...prefs, open });
}

export function toggleTerminalOpen(): void {
  save({ ...prefs, open: !prefs.open });
}

export function setTerminalHeight(height: number): void {
  if (prefs.height !== height) save({ ...prefs, height });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTerminalPanelPrefs(): PanelPrefs {
  return useSyncExternalStore(subscribe, getTerminalPanelPrefs, getTerminalPanelPrefs);
}
