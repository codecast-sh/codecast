import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WorkerHost } from './host.js';
import { runWorker } from './runtime.js';
import { MessagePreparation } from './preparationClient.js';
import { beginMessagePreparation, finishPreparationMessage } from '../messagePreparation.js';
import { PreparationCursors } from './preparationCursors.js';

if (process.argv.includes('_worker')) {
  const delay = Number(process.env.PREPARATION_REPLY_DELAY_MS ?? 0);
  if (delay) {
    const request = PreparationCursors.prototype.request;
    PreparationCursors.prototype.request = async function (...args) {
      await new Promise(resolve => setTimeout(resolve, delay));
      return request.apply(this, args);
    };
  }
  runWorker('ingest');
}
else {
  const entry = process.argv[1] ?? '';
  const args = /\.(?:js|ts)$/.test(entry) && !entry.includes('$bunfs') && !entry.includes('~BUN/') ? [entry, '_worker', 'ingest'] : ['_worker', 'ingest'];
  const host = new WorkerHost('ingest', { invocation: { command: process.execPath, args }, backoffMs: [0,0,0] });
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  const size = Number(process.env.PREPARATION_FIXTURE_MIB ?? 2) * 1024 * 1024;
  const content = 'ordinary transcript text '.repeat(Math.ceil(size / 25)).slice(0, size);
  const raw = [{ uuid: 'fixture', role: 'assistant', content, timestamp: 1, toolCalls: [{ id: 't', name: 'tool', input: { text: 'TOKEN=synthetic0123456789secret' } }] }];
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const expected = beginMessagePreparation(raw, 'transcript').map(finishPreparationMessage);
    let previous = performance.now(), maxGap = 0;
    timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; }, 1);
    await new Promise(resolve => setTimeout(resolve, 5));
    const start = performance.now();
    const prep = await MessagePreparation.open(raw, 'transcript', { host });
    const opened = performance.now();
    await assert.rejects(MessagePreparation.open(raw, 'transcript', { host }), /unavailable/);
    assert.deepEqual(await prep.paths(0), []);
    const result = await prep.finish();
    const finished = performance.now();
    await new Promise(resolve => setTimeout(resolve, 5));
    clearInterval(timer); timer = undefined;
    assert.deepEqual(JSON.parse(JSON.stringify(result.messages)), JSON.parse(JSON.stringify(expected)));
    assert.deepEqual(result.bytes, expected.map(msg => Buffer.byteLength(JSON.stringify(msg))));
    assert.ok(host.state.pid && host.state.pid !== process.pid);
    const pid = host.state.pid;
    await prep.close();
    const reused = await MessagePreparation.open([{ uuid: 'reuse', role: 'user', content: 'next', timestamp: 2 }], 'transcript', { host });
    assert.equal((await reused.finish()).messages[0].message_uuid, 'reuse');
    await reused.close();
    assert.equal(host.state.pid, pid);
    console.log(JSON.stringify({ runtime: process.versions, rawHash: hash(content), size, pid, prepareMs: opened - start, finishMs: finished - opened, maxGap, maxPageBytes: prep.maxPageBytes, maxWorkerRss: prep.maxWorkerRss, peakWorkerRss: prep.peakWorkerRss, parentRss: process.memoryUsage().rss, exact: true, admission: true, reused: true }));
  } finally { if (timer) clearInterval(timer); host.close(); }
}
