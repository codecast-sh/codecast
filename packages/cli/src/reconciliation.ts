import * as fs from "fs";
import * as path from "path";
import { parseSessionFile } from "./parser.js";
import { SyncService } from "./syncService.js";
import { setPosition } from "./positionTracker.js";

const CONFIG_DIR = process.env.HOME + "/.codecast";
const RECONCILIATION_FILE = path.join(CONFIG_DIR, "last-reconciliation.json");

export interface ReconciliationResult {
  timestamp: number;
  checked: number;
  discrepancies: Array<{
    sessionId: string;
    filePath: string;
    localCount: number;
    backendCount: number;
    status: "missing_backend" | "count_mismatch" | "ok";
  }>;
  errors: string[];
}

interface LastReconciliation {
  timestamp: number;
  discrepancyCount: number;
}

function loadLastReconciliation(): LastReconciliation | null {
  try {
    if (fs.existsSync(RECONCILIATION_FILE)) {
      return JSON.parse(fs.readFileSync(RECONCILIATION_FILE, "utf-8"));
    }
  } catch {
    // ignore
  }
  return null;
}

function saveLastReconciliation(data: LastReconciliation): void {
  try {
    fs.writeFileSync(RECONCILIATION_FILE, JSON.stringify(data, null, 2));
  } catch {
    // ignore
  }
}

export function getLastReconciliation(): LastReconciliation | null {
  return loadLastReconciliation();
}

function countMessagesInFile(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const messages = parseSessionFile(content);
    return messages.length;
  } catch {
    return 0;
  }
}

function extractSessionIdFromPath(filePath: string): string {
  return path.basename(filePath, ".jsonl");
}

export async function performReconciliation(
  syncService: SyncService,
  log: (message: string, level?: "info" | "warn" | "error") => void,
  maxFiles: number = 50
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    timestamp: Date.now(),
    checked: 0,
    discrepancies: [],
    errors: [],
  };

  const claudeProjectsDir = path.join(process.env.HOME || "", ".claude", "projects");
  if (!fs.existsSync(claudeProjectsDir)) {
    return result;
  }

  // Get recently modified session files
  const recentFiles: Array<{ path: string; mtime: number }> = [];
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  const now = Date.now();

  const scanDir = (dir: string) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.name.endsWith(".jsonl") && !entry.name.startsWith("agent-")) {
          // Skip subagent files for now, focus on main sessions
          try {
            const stats = fs.statSync(fullPath);
            if (now - stats.mtimeMs < maxAgeMs) {
              recentFiles.push({ path: fullPath, mtime: stats.mtimeMs });
            }
          } catch {
            // skip
          }
        }
      }
    } catch {
      // skip
    }
  };

  scanDir(claudeProjectsDir);

  // Sort by most recently modified
  recentFiles.sort((a, b) => b.mtime - a.mtime);
  const filesToCheck = recentFiles.slice(0, maxFiles);

  if (filesToCheck.length === 0) {
    log("Reconciliation: No recent session files found");
    return result;
  }

  // Extract session IDs
  const sessionIds = filesToCheck.map(f => extractSessionIdFromPath(f.path));

  log(`Reconciliation: Checking ${sessionIds.length} sessions against backend`);

  // Query backend for message counts
  let backendCounts: Array<{
    session_id: string;
    conversation_id: string;
    message_count: number;
    updated_at: number;
  }> = [];

  try {
    backendCounts = await syncService.getMessageCountsForReconciliation(sessionIds);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Failed to query backend: ${errMsg}`);
    log(`Reconciliation error: ${errMsg}`, "error");
    return result;
  }

  // Create lookup map
  const backendMap = new Map(backendCounts.map(c => [c.session_id, c]));

  // Compare each file
  for (const file of filesToCheck) {
    const sessionId = extractSessionIdFromPath(file.path);
    const localCount = countMessagesInFile(file.path);
    const backendData = backendMap.get(sessionId);

    result.checked++;

    if (!backendData) {
      // Session not found in backend
      result.discrepancies.push({
        sessionId,
        filePath: file.path,
        localCount,
        backendCount: 0,
        status: "missing_backend",
      });
      log(`Reconciliation: Session ${sessionId.slice(0, 8)}... missing from backend (${localCount} local messages)`, "warn");
    } else if (localCount !== backendData.message_count) {
      result.discrepancies.push({
        sessionId,
        filePath: file.path,
        localCount,
        backendCount: backendData.message_count,
        status: "count_mismatch",
      });
      log(
        `Reconciliation: Session ${sessionId.slice(0, 8)}... count mismatch (local: ${localCount}, backend: ${backendData.message_count})`,
        "warn"
      );
    }
  }

  // Save reconciliation result
  saveLastReconciliation({
    timestamp: result.timestamp,
    discrepancyCount: result.discrepancies.length,
  });

  if (result.discrepancies.length === 0) {
    log(`Reconciliation: All ${result.checked} sessions match backend`);
  } else {
    log(
      `Reconciliation: Found ${result.discrepancies.length} discrepancies out of ${result.checked} sessions`,
      "warn"
    );
  }

  return result;
}

export async function repairDiscrepancies(
  discrepancies: ReconciliationResult["discrepancies"],
  log: (message: string) => void
): Promise<number> {
  let repaired = 0;
  const MAX_RESYNC_BYTES = 5 * 1024 * 1024; // 5MB max re-read to avoid hanging on large files

  for (const d of discrepancies) {
    if (d.status === "count_mismatch" && d.backendCount >= d.localCount) {
      log(`Skipping repair for ${d.sessionId.slice(0, 8)}... backend already has >= local messages (backend: ${d.backendCount}, local: ${d.localCount})`);
      continue;
    }

    if (d.status === "missing_backend" || d.status === "count_mismatch") {
      let fileSize = 0;
      try { fileSize = fs.statSync(d.filePath).size; } catch { /* ignore */ }

      if (fileSize > MAX_RESYNC_BYTES) {
        const newPosition = Math.max(0, fileSize - MAX_RESYNC_BYTES);
        setPosition(d.filePath, newPosition);
        log(`Reset sync position for ${d.sessionId.slice(0, 8)}... to ${newPosition} (tail ${MAX_RESYNC_BYTES} bytes of ${fileSize} byte file)`);
      } else {
        setPosition(d.filePath, 0);
        log(`Reset sync position for ${d.sessionId.slice(0, 8)}... to trigger full re-sync`);
      }
      repaired++;
    }
  }

  return repaired;
}
