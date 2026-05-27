import * as fs from "fs";
import * as path from "path";
import { CachedJsonStore } from "./cachedJsonStore.js";

const CONFIG_DIR = process.env.HOME + "/.codecast";
const POSITIONS_FILE = path.join(CONFIG_DIR, "positions.json");

// Cached, debounced store. Reads hit memory; writes coalesce into a background
// flush instead of synchronously rewriting the whole (formerly multi-megabyte,
// monotonically-growing) file on every sync. Dead transcripts are pruned on load
// so the file can't bloat unbounded — the root cause of the daemon falling behind.
const store = new CachedJsonStore<number>({
  filePath: POSITIONS_FILE,
  keepOnLoad: (filePath) => {
    try {
      return fs.existsSync(filePath);
    } catch {
      return true; // transient stat failure — keep the entry rather than lose position
    }
  },
});

export function getPosition(filePath: string): number {
  return store.get(filePath) || 0;
}

export function setPosition(filePath: string, offset: number): void {
  store.set(filePath, offset);
}

export function clearPosition(filePath: string): void {
  store.delete(filePath);
}
