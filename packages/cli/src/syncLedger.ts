import * as fs from "fs";
import * as path from "path";
import { CachedJsonStore } from "./cachedJsonStore.js";

const CONFIG_DIR = process.env.HOME + "/.codecast";
const LEDGER_FILE = path.join(CONFIG_DIR, "sync-ledger.json");
const POSITIONS_FILE = path.join(CONFIG_DIR, "positions.json");

// Load legacy positions.json for backward compatibility. Read straight from disk:
// this is only a one-time fallback for ledger entries that predate the ledger, so
// staleness relative to the live position tracker doesn't matter.
function loadPositions(): Record<string, number> {
  try {
    if (fs.existsSync(POSITIONS_FILE)) {
      return JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf-8"));
    }
  } catch {
    /* ignore */
  }
  return {};
}

export interface SyncRecord {
  lastSyncedAt: number;
  lastSyncedPosition: number;
  messageCount: number;
  conversationId?: string;
  isLegacyFallback?: boolean;
}

interface SyncLedger {
  [filePath: string]: SyncRecord;
}

// Cached, debounced store. Replaces the old full-file read-modify-write on every
// markSynced (which on a 1MB+ ledger blocked the daemon event loop ~15ms per sync
// and grew without bound). Dead transcripts are pruned on load.
const store = new CachedJsonStore<SyncRecord>({
  filePath: LEDGER_FILE,
  keepOnLoad: (filePath) => {
    try {
      return fs.existsSync(filePath);
    } catch {
      return true; // transient stat failure — keep the entry rather than re-sync from 0
    }
  },
});

export function getSyncRecord(filePath: string): SyncRecord | null {
  const record = store.get(filePath);
  if (record) {
    return record;
  }

  // Fallback to legacy positions.json
  const positions = loadPositions();
  if (positions[filePath] !== undefined) {
    return {
      lastSyncedAt: 0,
      lastSyncedPosition: positions[filePath],
      messageCount: 0,
      isLegacyFallback: true,
    };
  }

  return null;
}

export function updateSyncRecord(
  filePath: string,
  update: Partial<SyncRecord>
): void {
  const existing = store.get(filePath) || {
    lastSyncedAt: 0,
    lastSyncedPosition: 0,
    messageCount: 0,
  };
  store.set(filePath, { ...existing, ...update });
}

export function markSynced(
  filePath: string,
  position: number,
  messageCount: number,
  conversationId?: string
): void {
  updateSyncRecord(filePath, {
    lastSyncedAt: Date.now(),
    lastSyncedPosition: position,
    messageCount,
    conversationId,
  });
}

export function getAllSyncRecords(): SyncLedger {
  return store.getAll();
}

export function getStaleFiles(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): string[] {
  const ledger = store.getAll();
  const now = Date.now();
  const stale: string[] = [];

  for (const [filePath, record] of Object.entries(ledger)) {
    if (!fs.existsSync(filePath)) continue;

    try {
      const stats = fs.statSync(filePath);
      const fileAge = now - stats.mtimeMs;

      // Skip files older than maxAge
      if (fileAge > maxAgeMs) continue;

      // File modified after last sync = needs re-sync
      if (stats.mtimeMs > record.lastSyncedAt) {
        stale.push(filePath);
      }
    } catch {
      // Can't stat file, skip
    }
  }

  return stale;
}

export function findUnsyncedFiles(
  baseDir: string,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000
): string[] {
  const ledger = store.getAll();
  const positions = loadPositions(); // Fallback to legacy positions.json
  const now = Date.now();
  const unsynced: string[] = [];

  if (!fs.existsSync(baseDir)) return unsynced;

  const scanDir = (dir: string) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.name.endsWith(".jsonl")) {
          try {
            const stats = fs.statSync(fullPath);
            const fileAge = now - stats.mtimeMs;

            const record = ledger[fullPath];
            const legacyPosition = positions[fullPath];

            if (record) {
              // JSONL session files are append-only, so size > lastSyncedPosition
              // is the only real signal of unsynced content. We surface those
              // regardless of age — otherwise a sync that wedged 8+ days ago
              // never recovers (the age filter, applied unconditionally, used to
              // hide them forever). An mtime newer than lastSyncedAt is NOT a
              // reliable proxy for new content (touch, compact-in-place, or just
              // clock skew can update mtime without appending bytes); using it
              // here surfaces dozens of false-positive "pending" files that the
              // sync loop can't drain because size == position is a no-op.
              if (stats.size > record.lastSyncedPosition) {
                unsynced.push(fullPath);
              }
            } else if (legacyPosition !== undefined) {
              if (stats.size > legacyPosition) {
                unsynced.push(fullPath);
              }
            } else {
              if (fileAge > maxAgeMs) continue;
              unsynced.push(fullPath);
            }
          } catch {
            // Can't stat file, skip
          }
        }
      }
    } catch {
      // Can't read directory, skip
    }
  };

  scanDir(baseDir);
  return unsynced;
}
