import * as fs from "fs";
import * as path from "path";
import { CachedJsonStore } from "./cachedJsonStore.js";
import { walkFiles } from "./fsWalk.js";

const CONFIG_DIR = process.env.HOME + "/.codecast";
const LEDGER_FILE = path.join(CONFIG_DIR, "sync-ledger.json");
const POSITIONS_FILE = path.join(CONFIG_DIR, "positions.json");

// Load legacy positions.json for backward compatibility — a one-time fallback for
// ledger entries that predate the ledger. The file is never written anymore, so read
// it once and cache: findUnsyncedFiles runs on every sweep and getSyncRecord on every
// synced file, and re-parsing a legacy blob from disk each call is pure event-loop tax.
let cachedPositions: Record<string, number> | null = null;
function loadPositions(): Record<string, number> {
  if (cachedPositions) return cachedPositions;
  try {
    if (fs.existsSync(POSITIONS_FILE)) {
      cachedPositions = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf-8"));
      return cachedPositions!;
    }
  } catch {
    /* ignore */
  }
  cachedPositions = {};
  return cachedPositions;
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

// First top-level `timestamp` found in a chunk of JSONL, as epoch ms. Lines
// without one (agent-name rows, truncated tails) are skipped; content-embedded
// timestamps can't match because only the parsed line's own field is read.
export function oldestTimestampInChunk(chunk: string): number | null {
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    try {
      const t = Date.parse(JSON.parse(line)?.timestamp);
      if (Number.isFinite(t)) return t;
    } catch {
      /* not a complete JSON line — skip */
    }
  }
  return null;
}

// Age of the oldest unsynced content: read the lines just past the synced
// position and return the first timestamp. Distinguishes "content has been
// waiting for ages" (a wedged sync) from "a quiet file just burst back to life"
// (a resumed session the sync loop simply hasn't drained yet). Null when the
// file can't be read or no timestamped line exists in the window.
export function readOldestUnsyncedTimestamp(
  filePath: string,
  position: number,
  windowBytes: number = 64 * 1024
): number | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(windowBytes);
    const bytes = fs.readSync(fd, buf, 0, buf.length, Math.max(0, position));
    return oldestTimestampInChunk(buf.toString("utf-8", 0, bytes));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
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

// The one decision both walkers share: does this .jsonl file have unsynced content?
// JSONL session files are append-only, so size > lastSyncedPosition is the only real
// signal of unsynced content. We surface those regardless of age — otherwise a sync
// that wedged 8+ days ago never recovers (the age filter, applied unconditionally,
// used to hide them forever). An mtime newer than lastSyncedAt is NOT a reliable
// proxy for new content (touch, compact-in-place, or just clock skew can update
// mtime without appending bytes); using it here surfaces dozens of false-positive
// "pending" files that the sync loop can't drain because size == position is a no-op.
function isUnsynced(
  fullPath: string,
  stats: { size: number; mtimeMs: number },
  now: number,
  maxAgeMs: number,
  ledger: SyncLedger,
  positions: Record<string, number>,
): boolean {
  const record = ledger[fullPath];
  if (record) return stats.size > record.lastSyncedPosition;

  const legacyPosition = positions[fullPath];
  if (legacyPosition !== undefined) return stats.size > legacyPosition;

  return now - stats.mtimeMs <= maxAgeMs;
}

export function findUnsyncedFiles(
  baseDir: string,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
  includeFile?: (filePath: string) => boolean,
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
          if (includeFile && !includeFile(fullPath)) continue;
          try {
            const stats = fs.statSync(fullPath);
            if (isUnsynced(fullPath, stats, now, maxAgeMs, ledger, positions)) {
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

// Async twin of findUnsyncedFiles for the daemon's hot paths. The sync walk holds
// the event loop for the whole ~3.5k-file scan of ~/.claude/projects (readdirSync +
// statSync per file); at that scale it reads as a multi-second freeze that starves
// heartbeats and message delivery. This version rides fsWalk's promise-based,
// batched walk, so a sweep interleaves with live work.
export async function findUnsyncedFilesAsync(
  baseDir: string,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
  includeFile?: (filePath: string) => boolean,
  // Which directories to enter (fsWalk semantics). The daemon passes the
  // watcher's rule so a sweep skips every tool-results/memory/checkpoint dir
  // instead of reading and discarding them (3947 dirs for 7918 files on one
  // machine, most of them out of scope).
  dirFilter?: (relativeDirPath: string) => boolean,
): Promise<string[]> {
  const ledger = store.getAll();
  const positions = loadPositions();
  const now = Date.now();
  const unsynced: string[] = [];
  await walkFiles(
    baseDir,
    {
      dirFilter,
      fileFilter: (rel) => rel.endsWith(".jsonl") && (!includeFile || includeFile(path.join(baseDir, rel))),
    },
    (f) => {
      if (isUnsynced(f.path, f.stat, now, maxAgeMs, ledger, positions)) unsynced.push(f.path);
    },
  );
  return unsynced;
}
