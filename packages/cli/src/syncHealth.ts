import fs from 'node:fs';
import path from 'node:path';
import { getAllSyncRecords, readOldestUnsyncedTimestamp, type SyncRecord } from './syncLedger.js';
import { getPosition } from './positionTracker.js';
import { isClaudeTranscriptOutOfWatchScope, isTestArtifactPath } from './syncScope.js';
import { isAppServerManagedCodexSessionHead } from './codexWatcher.js';
import { agentSessionFromTranscriptPath, decodeGrokCwdSlug } from './transcriptDirWatcher.js';

export const STUCK_SYNC_THRESHOLD_MS = 5 * 60_000;
const STUCK_SYNC_MIN_BYTES = 4096;
const UUID_IN_NAME_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export type StuckSyncReason = "byte_backlog" | "unexamined_writes";

export type StuckSync = {
  filePath: string;
  sessionId: string;
  unsyncedBytes: number;
  fileSize: number;
  fileMtimeMs: number;
  lastSyncedAt: number;
  pendingSince: number;
  conversationId?: string;
  agentType?: string;
  projectPath?: string;
  reason: StuckSyncReason;
};

async function isAppServerManagedRollout(filePath: string): Promise<boolean> {
  const file = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(2048);
    const { bytesRead } = await file.read(buf, 0, buf.length, 0);
    return isAppServerManagedCodexSessionHead(buf.toString('utf8', 0, bytesRead));
  } finally {
    await file.close();
  }
}

function isGrokUpdatesPath(filePath: string): boolean {
  return path.basename(filePath) === "updates.jsonl" && filePath.split(path.sep).includes(".grok");
}

function sessionIdentity(filePath: string, record: SyncRecord): {
  sessionId: string;
  agentType?: string;
  projectPath?: string;
} {
  const fromPath = agentSessionFromTranscriptPath(filePath);
  const sessionId = record.sourceGeneration?.sessionId
    ?? fromPath?.sessionId
    ?? (path.basename(filePath, path.extname(filePath)).match(UUID_IN_NAME_RE)?.[0]
      ?? path.basename(filePath, path.extname(filePath)));
  const agentType = record.sourceGeneration?.client ?? fromPath?.agentType
    ?? (isGrokUpdatesPath(filePath) ? "grok" : undefined);
  const projectPath = agentType === "grok"
    ? decodeGrokCwdSlug(path.basename(path.dirname(path.dirname(filePath)))) ?? undefined
    : undefined;
  return { sessionId, agentType, projectPath };
}

function grokLineMeta(line: string): { tsMs: number | null; kind: string | null } {
  try {
    const parsed = JSON.parse(line);
    const ts = parsed?.timestamp;
    let tsMs: number | null = null;
    if (typeof ts === "number") tsMs = ts < 1e12 ? ts * 1000 : ts;
    else if (typeof ts === "string") {
      const n = Date.parse(ts);
      if (Number.isFinite(n)) tsMs = n;
    }
    const update = parsed?.params?.update ?? parsed?.update;
    const kind = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : null;
    return { tsMs, kind };
  } catch {
    return { tsMs: null, kind: null };
  }
}

// Grok appends session_end/stop hook_execution lines AFTER the last message
// commit. Those bump mtime without producing messages. Combined with
// lastSyncedPosition always 0 (signature sync), a byte-delta detector then
// reported the whole file as stuck forever.
function grokGrowthIsHousekeeping(filePath: string, lastSyncedAt: number): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return false;
    const windowBytes = 64 * 1024;
    const buf = Buffer.alloc(Math.min(windowBytes, size));
    fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    let newerContent = 0;
    for (const line of buf.toString("utf-8").split("\n")) {
      if (!line.trim()) continue;
      const { tsMs, kind } = grokLineMeta(line);
      if (tsMs == null || tsMs <= lastSyncedAt) continue;
      if (kind !== "hook_execution") newerContent++;
    }
    return newerContent === 0;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function isSignatureUnit(filePath: string, record: SyncRecord): boolean {
  return record.sourceGeneration?.unit === "signatures" || isGrokUpdatesPath(filePath);
}

export async function getStuckSyncs(options: {
  records?: Record<string, SyncRecord>;
  now?: number;
} = {}): Promise<StuckSync[]> {
  const now = options.now ?? Date.now();
  const out: StuckSync[] = [];
  for (const [filePath, record] of Object.entries(options.records ?? getAllSyncRecords())) {
    if (record.lastSyncedAt <= 0 || now - record.lastSyncedAt < STUCK_SYNC_THRESHOLD_MS) continue;
    if (isTestArtifactPath(filePath) || isClaudeTranscriptOutOfWatchScope(filePath)) continue;
    const stats = await fs.promises.stat(filePath).catch(() => null);
    if (!stats) continue;
    if (stats.mtimeMs <= record.lastSyncedAt) continue;
    if (filePath.includes("/.codex/sessions/")) {
      if (stats.size <= getPosition(filePath)) continue;
      if (await isAppServerManagedRollout(filePath).catch(() => false)) continue;
    }

    const identity = sessionIdentity(filePath, record);
    const signature = isSignatureUnit(filePath, record);

    if (signature) {
      if (isGrokUpdatesPath(filePath) && grokGrowthIsHousekeeping(filePath, record.lastSyncedAt)) continue;
      const pendingSince = record.lastSyncedAt;
      if (now - pendingSince < STUCK_SYNC_THRESHOLD_MS) continue;
      out.push({
        filePath, ...identity, unsyncedBytes: 0, fileSize: stats.size, fileMtimeMs: stats.mtimeMs,
        lastSyncedAt: record.lastSyncedAt, pendingSince, conversationId: record.conversationId,
        reason: "unexamined_writes",
      });
      continue;
    }

    const unsyncedBytes = stats.size - record.lastSyncedPosition;
    if (unsyncedBytes < STUCK_SYNC_MIN_BYTES) continue;
    const bornAt = readOldestUnsyncedTimestamp(filePath, record.lastSyncedPosition);
    const pendingSince = Math.max(record.lastSyncedAt, bornAt ?? 0);
    if (now - pendingSince < STUCK_SYNC_THRESHOLD_MS) continue;
    out.push({
      filePath, ...identity, unsyncedBytes, fileSize: stats.size, fileMtimeMs: stats.mtimeMs,
      lastSyncedAt: record.lastSyncedAt, pendingSince, conversationId: record.conversationId,
      reason: "byte_backlog",
    });
  }
  return out.sort((a, b) => (b.unsyncedBytes - a.unsyncedBytes) || (b.fileSize - a.fileSize));
}

export function createStuckSyncReader(scan = getStuckSyncs, now = Date.now) {
  let nextCheck = 0;
  let result: Promise<StuckSync[]> | undefined;
  return () => {
    if (!result || now() >= nextCheck) {
      nextCheck = now() + 30_000;
      result = scan();
    }
    return result;
  };
}

export const readStuckSyncs = createStuckSyncReader();
