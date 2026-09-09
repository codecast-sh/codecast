import fs from 'node:fs';
import path from 'node:path';
import { getAllSyncRecords, readOldestUnsyncedTimestamp, type SyncRecord } from './syncLedger.js';
import { getPosition } from './positionTracker.js';
import { isClaudeTranscriptOutOfWatchScope, isTestArtifactPath } from './syncScope.js';
import { isAppServerManagedCodexSessionHead } from './codexWatcher.js';

export const STUCK_SYNC_THRESHOLD_MS = 5 * 60_000;
const STUCK_SYNC_MIN_BYTES = 4096;

export type StuckSync = {
  filePath: string;
  sessionId: string;
  unsyncedBytes: number;
  fileSize: number;
  lastSyncedAt: number;
  pendingSince: number;
  conversationId?: string;
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
    const unsyncedBytes = stats.size - record.lastSyncedPosition;
    if (unsyncedBytes < STUCK_SYNC_MIN_BYTES || stats.mtimeMs <= record.lastSyncedAt) continue;
    if (filePath.includes('/.codex/sessions/')) {
      if (stats.size <= getPosition(filePath)) continue;
      if (await isAppServerManagedRollout(filePath).catch(() => false)) continue;
    }
    const bornAt = readOldestUnsyncedTimestamp(filePath, record.lastSyncedPosition);
    const pendingSince = Math.max(record.lastSyncedAt, bornAt ?? 0);
    if (now - pendingSince < STUCK_SYNC_THRESHOLD_MS) continue;
    const base = path.basename(filePath, '.jsonl');
    const match = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    out.push({ filePath, sessionId: match?.[0] ?? base, unsyncedBytes, fileSize: stats.size,
      lastSyncedAt: record.lastSyncedAt, pendingSince, conversationId: record.conversationId });
  }
  return out.sort((a, b) => b.unsyncedBytes - a.unsyncedBytes);
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
