import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MirrorTranscript, mirrorMetaJson } from '../cloudAgents/transcript.js';
import { readIngestJob, ingestIdentity } from './ingestJobs.js';
import type { IngestJob } from './ingestTypes.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

/** A mirror on disk as the watcher writes it: <root>/<id>/<id>.jsonl beside its meta.json. */
function mirrorFile(id: string, transcript: string, meta: Parameters<typeof mirrorMetaJson>[0]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-mirror-'));
  roots.push(root);
  const file = path.join(root, id, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, transcript);
  fs.writeFileSync(path.join(root, id, 'meta.json'), mirrorMetaJson(meta));
  return file;
}

function job(client: IngestJob['client'], file: string, sessionId: string, mirror?: boolean): IngestJob {
  return { client, file, sessionId, offset: 0, generation: randomUUID(), identity: ingestIdentity(fs.statSync(file)), ...(mirror ? { mirror } : {}) };
}

test('a mirror syncs under any agent type: its messages, its place from meta.json, its parent, settled by turn_ended', async () => {
  const tx = new MirrorTranscript(1_000);
  tx.message({ uuid: 'u1', role: 'user', content: 'fix it', timestamp: 1_000 });
  tx.message({ uuid: 'r1', role: 'assistant', content: '', thinking: 'Read the test.', timestamp: 2_000 });
  tx.message({ uuid: 'c1', role: 'assistant', content: '', timestamp: 3_000, toolCalls: [{ id: 'c1', name: 'commandExecution', input: { command: 'bun test' } }], toolResults: [{ toolUseId: 'c1', content: 'ok' }] });
  tx.turnEnded();
  const file = mirrorFile('task_e_1', tx.toString(), { cwd: '/src/app', title: 'fix', parentAgentId: 'task_e_0', description: 'a worker' });
  const result = await readIngestJob(job('codex', file, 'task_e_1', true));
  expect(result.messages.map((m) => [m.uuid, m.role, m.content, m.thinking, m.toolCalls?.length, m.toolResults?.length])).toEqual([
    ['task_e_1:u1', 'user', 'fix it', undefined, undefined, undefined],
    ['task_e_1:r1', 'assistant', '', 'Read the test.', undefined, undefined],
    ['task_e_1:c1', 'assistant', '', undefined, 1, 1],
  ]);
  expect(result.metadata).toMatchObject({ cwd: '/src/app', parentSessionId: 'task_e_0', agentName: 'a worker', turn: 'idle' });
  expect(result.bytesConsumed).toBe(0);
});

test('a Cursor mirror reads the same through the mirror route as through Cursor\'s own reader', async () => {
  const tx = new MirrorTranscript(1_000);
  tx.user('p1', '<user_query>\nhello\n</user_query>');
  tx.appendText('e1', 'Hi.');
  tx.breakSegment();
  const file = mirrorFile('bc-1', tx.toString(), { cwd: '/cursor-cloud/acme/app' });
  const viaMirror = await readIngestJob(job('cursor', file, 'bc-1', true));
  const viaCursor = await readIngestJob(job('cursor', file, 'bc-1'));
  expect(viaMirror.messages).toEqual(viaCursor.messages);
  expect(viaMirror.signatures).toEqual(viaCursor.signatures);
  expect(viaMirror.receiptSignatures).toEqual(viaCursor.receiptSignatures);
  expect(viaMirror.messages.map((m) => [m.uuid, m.content])).toEqual([['bc-1:p1', 'hello'], ['bc-1:seg-e1', 'Hi.']]);
  expect(viaMirror.metadata).toMatchObject({ cwd: '/cursor-cloud/acme/app', turn: 'active' });
});
