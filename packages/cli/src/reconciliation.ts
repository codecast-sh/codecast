import * as fs from "fs";
import * as path from "path";
import { walkFiles } from "./fsWalk.js";
import { extractCwd, parseSessionFile } from "./parser.js";
import { SyncService } from "./syncService.js";
import { setPosition } from "./positionTracker.js";
import { updateSyncRecord } from "./syncLedger.js";
import {
  isPathExcluded,
  isProjectAllowedToSync,
  isTestScratchPath,
} from "./syncScope.js";
import type { Config } from "./config/types.js";

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

async function countMessagesInFile(filePath: string): Promise<number> {
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    const messages = parseSessionFile(content);
    return messages.length;
  } catch {
    return 0;
  }
}

function extractSessionIdFromPath(filePath: string): string {
  return path.basename(filePath, ".jsonl");
}

function readTranscriptCwd(filePath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    let head = buffer.toString("utf-8", 0, bytes);
    // A bounded read can end halfway through a large JSONL record. The parser
    // correctly reports malformed lines, but diagnostics should not emit a
    // wall of false parse errors merely because their own read was truncated.
    if (bytes === buffer.length) {
      const lastCompleteLine = head.lastIndexOf("\n");
      head = lastCompleteLine >= 0 ? head.slice(0, lastCompleteLine + 1) : "";
    }
    return head ? extractCwd(head) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Match the daemon's selected-project and exclusion gates before diagnostics,
 * repair, or a manual sync can treat a transcript as expected backend data.
 */
export function isTranscriptFileInSyncScope(
  filePath: string,
  config?: Config,
): boolean {
  if (isTestScratchPath(filePath)) return false;
  if (!config) return true;

  const recordedCwd = readTranscriptCwd(filePath);
  // A selected-project configuration must fail closed when a new/partial file
  // has not recorded its cwd yet. The live watcher can reconsider it once the
  // cwd row arrives; diagnostics must not "repair" it into a zombie ledger row.
  if (!recordedCwd) return config.sync_mode !== "selected";
  return isProjectAllowedToSync(recordedCwd, config)
    && !isPathExcluded(recordedCwd, config.excluded_paths);
}

export async function performReconciliation(
  syncService: SyncService,
  log: (message: string, level?: "info" | "warn" | "error") => void,
  conversationCache: Record<string, string> = {},
  maxFiles: number = 50,
  config?: Config,
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

  // Skip subagent files for now, focus on main sessions. More importantly,
  // honor the exact same selected/excluded scope as the sync loop: an
  // out-of-scope transcript is correctly absent from the backend and must never
  // be "repaired" into a zombie ledger entry. Async walk: the tree holds tens of
  // thousands of files, and a sync scan pinned the loop for the whole read.
  await walkFiles(
    claudeProjectsDir,
    { fileFilter: (rel) => { const name = path.basename(rel); return name.endsWith(".jsonl") && !name.startsWith("agent-"); } },
    (f) => {
      if (now - f.stat.mtimeMs >= maxAgeMs) return;
      if (!isTranscriptFileInSyncScope(f.path, config)) return;
      recentFiles.push({ path: f.path, mtime: f.stat.mtimeMs });
    },
  );

  // Sort by most recently modified
  recentFiles.sort((a, b) => b.mtime - a.mtime);
  const filesToCheck = recentFiles.slice(0, maxFiles);

  if (filesToCheck.length === 0) {
    log("Reconciliation: No recent session files found");
    return result;
  }

  // Extract session IDs
  const sessionIds = filesToCheck.map(f => extractSessionIdFromPath(f.path));

  // Build daemon-side hints: for any local JSONL UUID the daemon already
  // mapped to a conversation (typically because the file was resumed and the
  // conversation's primary session_id is some older UUID), tell the backend
  // which conversation to look at instead of relying on the by_session_id
  // index. Without this, every resumed session is falsely flagged as
  // `missing_backend` and triggers a position reset → watchdog storm.
  const conversationIdHints = sessionIds
    .filter(sid => Boolean(conversationCache[sid]))
    .map(sid => ({ session_id: sid, conversation_id: conversationCache[sid] }));
  const hintedSessions = new Set(conversationIdHints.map(h => h.session_id));

  log(
    `Reconciliation: Checking ${sessionIds.length} sessions against backend ` +
    `(${conversationIdHints.length} via local conv mapping)`
  );

  // Query backend for message counts
  let backendCounts: Array<{
    session_id: string;
    conversation_id: string;
    message_count: number;
    updated_at: number;
  }> = [];

  try {
    backendCounts = await syncService.getMessageCountsForReconciliation(
      sessionIds,
      conversationIdHints
    );
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
    const localCount = await countMessagesInFile(file.path);
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
    } else if (hintedSessions.has(sessionId)) {
      // Resolved via local conv mapping → backend `message_count` is the
      // conversation total across all linked JSONLs, NOT this file's count.
      // Comparing the two is meaningless; trust that the daemon has been
      // syncing this file (it knows the convId) and skip the mismatch flag.
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
        updateSyncRecord(d.filePath, { lastSyncedPosition: newPosition });
        log(`Reset sync position for ${d.sessionId.slice(0, 8)}... to ${newPosition} (tail ${MAX_RESYNC_BYTES} bytes of ${fileSize} byte file)`);
      } else {
        setPosition(d.filePath, 0);
        updateSyncRecord(d.filePath, { lastSyncedPosition: 0 });
        log(`Reset sync position for ${d.sessionId.slice(0, 8)}... to trigger full re-sync`);
      }
      repaired++;
    }
  }

  return repaired;
}
