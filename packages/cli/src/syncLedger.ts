import * as fs from "fs";
import * as path from "path";

const CONFIG_DIR = process.env.HOME + "/.codecast";
const LEDGER_FILE = path.join(CONFIG_DIR, "sync-ledger.json");
const POSITIONS_FILE = path.join(CONFIG_DIR, "positions.json");

// Load legacy positions.json for backward compatibility
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

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadLedger(): SyncLedger {
  try {
    if (fs.existsSync(LEDGER_FILE)) {
      return JSON.parse(fs.readFileSync(LEDGER_FILE, "utf-8"));
    }
  } catch {
    /* ignore parse errors, start fresh */
  }
  return {};
}

function saveLedger(ledger: SyncLedger): void {
  ensureConfigDir();
  const tempFile = LEDGER_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(ledger, null, 2));
  fs.renameSync(tempFile, LEDGER_FILE);
}

export function getSyncRecord(filePath: string): SyncRecord | null {
  const ledger = loadLedger();
  if (ledger[filePath]) {
    return ledger[filePath];
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
  const ledger = loadLedger();
  const existing = ledger[filePath] || {
    lastSyncedAt: 0,
    lastSyncedPosition: 0,
    messageCount: 0,
  };
  ledger[filePath] = { ...existing, ...update };
  saveLedger(ledger);
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
  return loadLedger();
}

export function getStaleFiles(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): string[] {
  const ledger = loadLedger();
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
  const ledger = loadLedger();
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

            // Skip files older than maxAge
            if (fileAge > maxAgeMs) continue;

            const record = ledger[fullPath];
            const legacyPosition = positions[fullPath];

            if (record) {
              // Check against sync ledger
              if (stats.mtimeMs > record.lastSyncedAt || stats.size > record.lastSyncedPosition) {
                unsynced.push(fullPath);
              }
            } else if (legacyPosition !== undefined) {
              // Fallback to legacy positions.json
              if (stats.size > legacyPosition) {
                unsynced.push(fullPath);
              }
              // If size == position, file is fully synced in legacy system
            } else {
              // Never synced in either system
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
