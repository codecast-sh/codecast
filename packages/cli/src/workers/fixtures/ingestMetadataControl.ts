import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from "../../proc.js";
import { type ChildProcess } from "../../proc.js";
import { createHash } from 'node:crypto';
import { mock } from 'bun:test';
import { EventEmitter } from 'node:events';

const home = process.env.HOME!;
const root = process.env.F3_METADATA_ROOT!;
const token = process.env.F3_METADATA_TOKEN!;
const mode = process.argv[2];
assert.equal(fs.realpathSync(home), fs.realpathSync(root));
assert.equal(fs.realpathSync(process.env.TMUX_TMPDIR!), fs.realpathSync(path.join(root, 'tmux')));
assert.match(token, /^[0-9a-f]{32}$/);
assert.ok(mode === 'current' || mode === 'old-tail');
const workerDir = path.resolve(import.meta.dir, '..');
const source = (file: string) => ({ file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
const save = (name: string, value: unknown) => fs.writeFileSync(path.join(home, name + '.json'), JSON.stringify(value, null, 2) + '\n');
save('fixture-process-' + process.pid, { pid: process.pid, ppid: process.ppid, token, mode, source: source(import.meta.path) });
const producerPath = path.join(workerDir, 'ingestJobs.ts');
const producerPreimage = fs.readFileSync(producerPath, 'utf8');
let loadedProducer = producerPath;
if (mode === 'old-tail') {
  const current = "      checkpoint();\n      meta.summaryTitle = extractSummaryTitle(content);\n      checkpoint();\n      if (!meta.summaryTitle) meta.summaryTitle = await readMetadataTitle(job,before,checkpoint,meta.warnings);";
  const old = "      const tail = await optional(() => readPart(job.file,4096,true),meta.warnings,'title');\n      meta.summaryTitle = extractSummaryTitle(content+'\\n'+(tail ?? ''));";
  assert.equal(producerPreimage.split(current).length, 2);
  const altered = producerPreimage.replace(current, old)
    .replace(/from (['"])(\.[^'"]+)\1/g, (_whole, quote, name) => `from ${quote}${path.resolve(workerDir, name)}${quote}`)
    .replace(/import\((['"])(\.[^'"]+)\1\)/g, (_whole, quote, name) => `import(${quote}${path.resolve(workerDir, name)}${quote})`);
  loadedProducer = path.join(home, 'old-tail-producer.ts');
  fs.writeFileSync(loadedProducer, altered);
}
const producerReceipt = { original: source(producerPath), loaded: source(loadedProducer), mode, mutation: mode === 'old-tail' ? 'original clipped title tail plus mechanical import paths' : null };
save('producer-source', producerReceipt);
const entry = path.join(home, 'worker-entry.ts');
fs.writeFileSync(entry, `import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { mock } from 'bun:test';
import { EventEmitter } from 'node:events';
const home = process.env.HOME;
const token = process.env.F3_METADATA_TOKEN;
const producerFile = ${JSON.stringify(loadedProducer)};
const sha256 = createHash('sha256').update(fs.readFileSync(producerFile)).digest('hex');
fs.writeFileSync(home + '/worker-source-' + process.pid + '.json', JSON.stringify({pid:process.pid,ppid:process.ppid,token,source:producerFile,sha256}));
const producer = await import(producerFile);
const readIngestJob = producer.readIngestJob;
mock.module(${JSON.stringify(producerPath)}, () => ({...producer, readIngestJob: async (...args) => {
  fs.writeFileSync(home + '/producer-invocation-' + process.pid + '.json', JSON.stringify({pid:process.pid,ppid:process.ppid,token,source:producerFile,sha256}));
  return readIngestJob(...args);
}}));
const { runWorker } = await import(${JSON.stringify(path.join(workerDir, 'runtime.ts'))});
runWorker('ingest');
`);
const parserPath = path.resolve(workerDir, '../parser.ts');
const parser = await import(parserPath);
let supervisorParses = 0;
const refuse = () => { supervisorParses++; throw new Error('supervisor transcript parse'); };
mock.module(parserPath, () => ({ ...parser, parseTranscriptFor: refuse, parseSessionFile: refuse, parseCodexSessionFile: refuse }));
const { configureDaemonWorkers, closeDaemonWorkers, ingestWorkerHost } = await import('../bridge.js');
const { readTranscriptIngest } = await import('../ingestClient.js');
const children: ChildProcess[] = [];
let stderrBytes = 0;
const digest = createHash('sha256');
const prefix = Buffer.alloc(16384);
let prefixLength = 0;
await configureDaemonWorkers(true, {}, {}, {
  invocation: { command: process.execPath, args: [entry] },
  spawnChild: (command, args, env) => {
    assert.equal(children.length, 0, 'only one owned ingest child');
    const child = spawn(command, args, { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    save('spawn-' + child.pid, { pid: child.pid, ppid: process.pid, token, command, args, entry: source(entry) });
    console.error('F3_METADATA_CHILD ' + JSON.stringify({ pid: child.pid, ppid: process.pid, token, mode, producerReceipt }));
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      digest.update(chunk);
      const copied = Math.min(prefix.length - prefixLength, chunk.length);
      chunk.copy(prefix, prefixLength, 0, copied);
      prefixLength += copied;
    });
    return child;
  },
});
const host = ingestWorkerHost()!;
const failures: Array<{ type: string; message: string; stderrBytes: number; generation: number; dispatchedPid: number | null }> = [];
const request = host.request.bind(host);
host.request = (...args: Parameters<typeof host.request>) => {
  const pending = request(...args);
  const dispatched = host.state;
  return pending.catch((error: Error) => {
    failures.push({ type: error.constructor.name, message: error.message, stderrBytes, generation: host.state.generation, dispatchedPid: dispatched.pid });
    save('request-failures', failures);
    throw error;
  });
};
let stopping = false;
const stop = () => { stopping = true; closeDaemonWorkers(); };
process.on('SIGTERM', stop);
const file = path.join(home, 'metadata-tail-diagnostic.jsonl');
const text = Array.from({ length: 16 }, (_, i) => JSON.stringify({ type: 'assistant', uuid: 'diagnostic-' + i, timestamp: '2026-09-05T12:00:00Z', message: { content: 'x'.repeat(1000) } }) + '\n').join('');
fs.writeFileSync(file, text);
save('native-source', { ...source(file), bytes: Buffer.byteLength(text), completeRows: 16 });
let completed = 0;
let caught: unknown;
let remaining: number[] = [];
try {
  for (let i = 0; i < 32; i++) {
    assert.equal(stopping, false);
    const result = await readTranscriptIngest({ client: 'claude', file, sessionId: 'metadata-tail-diagnostic', offset: 0 }, { timeoutMs: 5000 });
    assert.equal(result.messages.length, 16);
    assert.equal(result.bytesConsumed, Buffer.byteLength(text));
    completed++;
    if (completed === 1) {
      const pid = children[0].pid!;
      const identity = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,uid=,lstart=,command='], { encoding: 'utf8', timeout: 1000 });
      save('worker-live-identity', { pid, token, identity });
      const fields = identity.trim().split(/\s+/);
      assert.equal(Number(fields[0]), pid);
      assert.equal(Number(fields[1]), process.pid);
      assert.equal(Number(fields[2]), pid);
      assert.ok(identity.includes(entry));
    }
  }
} catch (error) { caught = error; }
finally {
  closeDaemonWorkers();
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };
  const deadline = performance.now() + 2000;
  while (children.some(child => child.pid && alive(child.pid)) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  remaining = children.flatMap(child => child.pid && alive(child.pid) ? [child.pid] : []);
  save('metadata-outcome', { pid: process.pid, token, mode, completed, failures, supervisorParses, children: children.map(child => child.pid), remaining, stderrBytes, stderrSha256: digest.digest('hex'), stderrPrefix: prefix.toString('utf8', 0, prefixLength), caught: caught instanceof Error ? { type: caught.constructor.name, message: caught.message } : String(caught), producerReceipt });
  console.error('F3_METADATA_OUTCOME ' + fs.readFileSync(path.join(home, 'metadata-outcome.json'), 'utf8'));
  EventEmitter.prototype.removeListener.call(process, 'SIGTERM', stop);
}
assert.deepEqual(remaining, []);
assert.equal(children.length, 1);
const invocation = JSON.parse(fs.readFileSync(path.join(home, 'producer-invocation-' + children[0].pid + '.json'), 'utf8'));
assert.equal(invocation.pid, children[0].pid);
assert.equal(invocation.sha256, producerReceipt.loaded.sha256);
assert.equal(invocation.source, loadedProducer);
if (mode === 'current') {
  assert.equal(caught, undefined);
  assert.equal(completed, 32);
  assert.equal(supervisorParses, 0);
  assert.equal(stderrBytes, 0);
  assert.deepEqual(failures, []);
} else {
  assert.ok(caught instanceof Error && caught.message === 'supervisor transcript parse');
  assert.equal(supervisorParses, 1);
  assert.ok(completed > 0 && completed < 32);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].type, 'WorkerUnavailable');
  assert.equal(failures[0].message, 'worker diagnostic limit');
  assert.ok(failures[0].stderrBytes > 8192);
  assert.equal(failures[0].dispatchedPid, children[0].pid!);
}
