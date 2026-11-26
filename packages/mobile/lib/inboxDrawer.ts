import { useSyncExternalStore } from 'react';

// Whether the inbox's slide-out panel is open. The panel lives in the tabs
// layout (so the tab bar slides with the inbox), and the inbox header's menu
// button opens it, so the one flag sits here where both can reach it.
let open = false;
const listeners = new Set<() => void>();

export function isInboxDrawerOpen(): boolean {
  return open;
}

export function setInboxDrawerOpen(next: boolean) {
  if (next === open) return;
  open = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useInboxDrawerOpen(): boolean {
  return useSyncExternalStore(subscribe, isInboxDrawerOpen, isInboxDrawerOpen);
}
