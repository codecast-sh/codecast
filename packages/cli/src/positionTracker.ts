import * as fs from "fs";
import { rebindingStore } from "./cachedJsonStore.js";
import { codecastPath } from "./codecastDir.js";

// Cached, debounced store. Reads hit memory; writes coalesce into a background
// flush instead of synchronously rewriting the whole (formerly multi-megabyte,
// monotonically-growing) file on every sync. Dead transcripts are pruned on load
// so the file can't bloat unbounded — the root cause of the daemon falling behind.
//
// Rebinding, not a plain store: the file lives under CODECAST_DIR, which a test
// redirects after this module is imported (ct-49597).
const store = rebindingStore<number>(() => codecastPath("positions.json"), {
  keepOnLoad: (filePath) => {
    try {
      return fs.existsSync(filePath);
    } catch {
      return true; // transient stat failure — keep the entry rather than lose position
    }
  },
});

export function getPosition(filePath: string): number {
  return store().get(filePath) || 0;
}

export function setPosition(filePath: string, offset: number): void {
  store().set(filePath, offset);
}

export function clearPosition(filePath: string): void {
  store().delete(filePath);
}
