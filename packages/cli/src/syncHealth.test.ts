import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStuckSyncReader, getStuckSyncs, STUCK_SYNC_THRESHOLD_MS } from './syncHealth.js';
import { RetryQueue } from './retryQueue.js';
import type { SyncRecord } from './syncLedger.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function transcript(now: number, age: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-health-'));
  dirs.push(dir);
  const file = path.join(dir, '044a5a51-0000-4000-8000-000000000001.jsonl');
  const content = JSON.stringify({ timestamp: new Date(now - age).toISOString(), content: 'x'.repeat(5000) }) + '\n';
  fs.writeFileSync(file, content);
  const record: SyncRecord = { lastSyncedAt: now - 86_400_000, lastSyncedPosition: 0, messageCount: 1, conversationId: 'conv' };
  return { file, record, content };
}

test('a stuck transcript degrades health even with no network retries, then clears after recovery', async () => {
  const now = Date.now(), { file, record, content } = transcript(now, STUCK_SYNC_THRESHOLD_MS + 1000);
  const records = { [file]: record };
  const stuck = await getStuckSyncs({ records, now });
  expect(stuck).toHaveLength(1);
  expect(stuck[0].unsyncedBytes).toBe(Buffer.byteLength(content));
  expect(stuck[0].pendingSince).toBe(now - STUCK_SYNC_THRESHOLD_MS - 1000);
  const queue = new RetryQueue();
  try {
    const health = queue.getHealth(stuck);
    expect(health).toMatchObject({ ops: 0, pending: 1, messages: 0, conversations: 1 });
    expect(health.oldestPendingMs).toBeGreaterThanOrEqual(STUCK_SYNC_THRESHOLD_MS);
    // A stuck file counts as no progress since it last advanced, whatever the
    // (empty, fresh) queue says.
    expect(health.noProgressMs).toBeGreaterThanOrEqual(86_400_000);
    record.lastSyncedPosition = Buffer.byteLength(content);
    expect(queue.getHealth(await getStuckSyncs({ records, now }))).toEqual({ ops: 0, pending: 0, messages: 0, conversations: 0, oldestPendingMs: 0, noProgressMs: 0 });
  } finally { queue.stop(); }
});

test('resumed sessions, missing files, untouched files, and never-synced entries do not produce phantom stalls', async () => {
  const now = Date.now(), { file, record } = transcript(now, 1000);
  expect(await getStuckSyncs({ records: { [file]: record }, now })).toEqual([]);
  expect(await getStuckSyncs({ records: { [file]: { ...record, lastSyncedAt: 0 } }, now })).toEqual([]);
  fs.utimesSync(file, new Date(record.lastSyncedAt - 1000), new Date(record.lastSyncedAt - 1000));
  expect(await getStuckSyncs({ records: { [file]: record }, now })).toEqual([]);
  fs.unlinkSync(file);
  expect(await getStuckSyncs({ records: { [file]: record }, now })).toEqual([]);
});

test('transcript and network backlogs count an affected conversation only once', () => {
  const queue = new RetryQueue();
  try {
    queue.add('addMessages', { conversationId: 'conv', messages: [{ messageUuid: 'one' }] });
    const pendingSince = Date.now() - STUCK_SYNC_THRESHOLD_MS;
    expect(queue.getHealth([
      { conversationId: 'conv', sessionId: 'one', pendingSince },
      { conversationId: 'conv', sessionId: 'one', pendingSince },
      { sessionId: 'new', pendingSince },
    ])).toMatchObject({ ops: 1, pending: 2, messages: 1, conversations: 2 });
  } finally { queue.stop(); }
});

test('heartbeat paths share a scan and refresh the result after thirty seconds', async () => {
  let now = 1000, calls = 0;
  const read = createStuckSyncReader(async () => { calls++; return []; }, () => now);
  const first = read();
  expect(read()).toBe(first);
  await first;
  now += 29_999;
  expect(read()).toBe(first);
  now++;
  expect(read()).not.toBe(first);
  expect(calls).toBe(2);
});

const GROK_ID = '01a0a5e8-0951-7f13-a251-1200846e2fe9';

function grokLine(tsSec: number, kind: string) {
  return JSON.stringify({
    timestamp: tsSec,
    method: '_x.ai/session/update',
    params: { sessionId: GROK_ID, update: { sessionUpdate: kind } },
  }) + '\n';
}

function grokSession(now: number, lines: string[], lastSyncedAt: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-health-grok-'));
  dirs.push(dir);
  const sessionDir = path.join(dir, '.grok', 'sessions', '%2FUsers%2Fashot%2Fsrc%2Fcodecast', GROK_ID);
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, 'updates.jsonl');
  fs.writeFileSync(file, lines.join(''));
  const mtimeSec = now / 1000;
  fs.utimesSync(file, mtimeSec, mtimeSec);
  const record: SyncRecord = {
    lastSyncedAt,
    lastSyncedPosition: 0,
    messageCount: 1,
    conversationId: 'jx75dz2dmvyhnktcnr2qj6crtd8eegwp',
    sourceGeneration: {
      client: 'grok', sessionId: GROK_ID, dev: 1, ino: 1, birthtimeMs: lastSyncedAt,
      unit: 'signatures', watermark: 'abc', prefixProven: true,
    },
  };
  return { file, record };
}

test('a grok hook-only tail after last ingest is not a stuck sync', async () => {
  const now = Date.now();
  const lastSyncedAt = now - 11 * 3_600_000;
  const lastSyncedSec = Math.floor(lastSyncedAt / 1000);
  const { file, record } = grokSession(now, [
    grokLine(lastSyncedSec - 10, 'user_message_chunk'),
    grokLine(lastSyncedSec - 5, 'agent_message_chunk'),
    grokLine(lastSyncedSec + 60, 'hook_execution'),
    grokLine(lastSyncedSec + 61, 'hook_execution'),
  ], lastSyncedAt);
  expect(await getStuckSyncs({ records: { [file]: record }, now })).toEqual([]);
});

test('a grok session with real writes after last ingest is stuck under its uuid, not "updates"', async () => {
  const now = Date.now();
  const lastSyncedAt = now - 11 * 3_600_000;
  const lastSyncedSec = Math.floor(lastSyncedAt / 1000);
  const { file, record } = grokSession(now, [
    grokLine(lastSyncedSec - 10, 'user_message_chunk'),
    grokLine(lastSyncedSec + 60, 'user_message_chunk'),
    grokLine(lastSyncedSec + 120, 'hook_execution'),
  ], lastSyncedAt);
  const stuck = await getStuckSyncs({ records: { [file]: record }, now });
  expect(stuck).toHaveLength(1);
  expect(stuck[0].sessionId).toBe(GROK_ID);
  expect(stuck[0].agentType).toBe('grok');
  expect(stuck[0].projectPath).toBe('/Users/ashot/src/codecast');
  expect(stuck[0].reason).toBe('unexamined_writes');
  expect(stuck[0].unsyncedBytes).toBe(0);
  expect(stuck[0].sessionId).not.toBe('updates');
});
