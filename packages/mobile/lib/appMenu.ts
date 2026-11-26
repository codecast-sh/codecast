import { useSyncExternalStore } from 'react';

// Whether the app menu (the slide-out with the places that are not tabs and
// the inbox's labels, projects and view) is open. The panel lives in the tabs
// layout, every tab's menu button opens it, and a conversation's panel opens
// it on the way out, so the one flag sits here where all of them can reach it.
let open = false;
const listeners = new Set<() => void>();

export function isAppMenuOpen(): boolean {
  return open;
}

export function setAppMenuOpen(next: boolean) {
  if (next === open) return;
  open = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useAppMenuOpen(): boolean {
  return useSyncExternalStore(subscribe, isAppMenuOpen, isAppMenuOpen);
}
