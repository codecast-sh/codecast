// Buffers for files that do not exist yet: `:e newfile.ts`, or file.open on a
// missing path, opens an empty buffer under that name, and the first save
// creates the file (fileSync.writeBuffer). This set is the one place that fact
// lives; saving reads it, and the tab follows it to show its "new" state.

import { useSyncExternalStore } from "react";

const keys = new Set<string>();
const listeners = new Set<() => void>();

const changed = () => {
  for (const l of [...listeners]) l();
};

export function isNewFile(key: string): boolean {
  return keys.has(key);
}

export function markNewFile(key: string): void {
  if (keys.has(key)) return;
  keys.add(key);
  changed();
}

/** The file now exists (saved, or found on disk), or its buffer is gone. */
export function clearNewFile(key: string): void {
  if (keys.delete(key)) changed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useIsNewFile(key: string): boolean {
  return useSyncExternalStore(subscribe, () => keys.has(key), () => false);
}
