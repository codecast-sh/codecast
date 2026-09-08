import { PayloadBudget } from './payloadBudget.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from '../proc.js';
import { writeSync } from 'node:fs';
import { ConvexHttpClient } from 'convex/browser';
import { ConvexError, convexToJson } from 'convex/values';
import { WorkerHost } from './host.js';
import { runWorker } from './runtime.js';
import { MessagesSdkBatch } from './messagesSdkClient.js';
import { runPayloadCodec, payloadStringBytes } from './payloadCodecClient.js';
import type { PreparedWireMessage } from '../messagePreparation.js';

const emit = (event: unknown) => writeSync(1, JSON.stringify(event) + '\n');
const observe = async (run: () => Promise<unknown>) => { try { return { value: await run() }; } catch (error) { return { error }; } };
const describe = (result: Awaited<ReturnType<typeof observe>>) => 'error' in result ? {
  kind: 'error', type: typeof result.error, constructor: result.error instanceof Error ? result.error.constructor.name : null,
  name: result.error instanceof Error ? result.error.name : null, message: result.error instanceof Error ? result.error.message : String(result.error),
  ...(result.error instanceof ConvexError ? { data: convexToJson(result.error.data) } : {}),
} : { kind: 'success', value: convexToJson(result.value as any) };
const hashBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

if (process.argv.includes('_worker')) {
  writeSync(2, JSON.stringify({ event: 'child-entry', pid: process.pid, ppid: process.ppid, executable: process.execPath, args: process.argv, entry: import.meta.url, runtime: process.versions }) + '\n');
  runWorker('ingest');
}
else {
  const entry = process.argv[1] ?? '';
  const args = /\.(?:js|ts)$/.test(entry) && !entry.includes('$bunfs') && !entry.includes('~BUN/') ? [entry, '_worker', 'ingest'] : ['_worker', 'ingest'];
  const children: Array<{ pid?: number; closed: Promise<void> }> = [];
  const host = new WorkerHost('ingest', { invocation: { command: process.execPath, args }, backoffMs: [0, 0, 0], spawnChild: (command, childArgs, env) => {
    const child = spawn(command, childArgs, { env, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    emit({ event: 'child-spawn', pid: child.pid, command, args: childArgs });
    let diagnostics = 0;
    child.stderr.on('data', (bytes: Buffer) => {
      const retained = bytes.subarray(0, Math.max(0, 8192 - diagnostics)); diagnostics += bytes.length;
      emit({ event: 'child-stderr', pid: child.pid, length: bytes.length, base64: retained.toString('base64'), truncated: retained.length !== bytes.length });
    });
    child.on('exit', (code, signal) => emit({ event: 'child-exit', pid: child.pid, code, signal }));
    child.on('error', error => emit({ event: 'child-error', pid: child.pid, message: error.message }));
    children.push({ pid: child.pid, closed: new Promise<void>(resolve => child.once('close', () => { emit({ event: 'child-close', pid: child.pid }); resolve(); })) });
    return child;
  } });
  const requests: Array<{ sha256: string; length: number; headers: Record<string, string | string[] | undefined>; path: string | undefined; method: string | undefined }> = [];
  let responseStatus = 200, responseBody = '', dispatches = 0, port = 0;
  const server = createServer(async (req, res) => {
    const hash = createHash('sha256'); let length = 0;
    for await (const chunk of req) { hash.update(chunk); length += chunk.length; }
    requests.push({ sha256: hash.digest('hex'), length, headers: req.headers, path: req.url, method: req.method });
    emit({ event: 'http-request', index: requests.length - 1, ...requests[requests.length - 1] });
    res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
    res.end(responseBody);
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}`;
    const messages = [{ message_uuid: 'fixture', role: 'assistant' as const, content: 'ordinary \ud83d\ude00\ud800', timestamp: 1, tool_calls: [{ id: 't', name: 'tool', input: '{"__proto__":"safe","constructor":"own"}' }] }];
    const rows = { messages: messages as PreparedWireMessage[], bytes: messages.map(row => Buffer.byteLength(JSON.stringify(row))) };
    emit({ event: 'start', pid: process.pid, runtime: process.versions, executable: process.execPath, entry: import.meta.url, args, port, fixtureInputSha256: hashBytes(Buffer.from(JSON.stringify(rows))), noLiveDestination: true });
    const checks: string[] = [];
    for (const fixture of [
      { name: 'success', status: 200, body: { status: 'success', value: convexToJson({ inserted: 1, ids: ['fixture'], typed: [123n, NaN, -0, new Uint8Array([0, 255, 17]).buffer] }), logLines: ['[INFO] ordinary log', 'malformed log'] } },
      { name: 'convex-error', status: 560, body: { status: 'error', errorMessage: 'fixture failure', errorData: convexToJson({ key: 4n, bytes: new Uint8Array([1, 2]).buffer }), logLines: [] } },
      { name: 'http-error', status: 401, body: 'not authorized' },
      { name: 'malformed-json', status: 200, body: '{bad' },
      { name: 'sdk-error', status: 200, body: { status: 'error', errorMessage: 'plain failure', logLines: [] } },
      ...[200, 204, 401, 560].map(status => ({ name: `empty-${status}`, status, body: '' })),
    ]) {
      responseStatus = fixture.status; responseBody = typeof fixture.body === 'string' ? fixture.body : JSON.stringify(fixture.body);
      emit({ event: 'case-input', case: fixture.name, status: responseStatus, responseBytes: [...Buffer.from(responseBody)], responseSha256: hashBytes(Buffer.from(responseBody)) });
      const oldLogs: unknown[] = [], newLogs: unknown[] = [];
      const logger = Object.fromEntries(['log', 'warn', 'error', 'logVerbose'].map(method => [method, (...args: unknown[]) => oldLogs.push({ method, args })])) as any;
      const sdk = new ConvexHttpClient(url, { skipConvexDeploymentUrlCheck: true, logger });
      const old = await observe(() => sdk.mutation('messages:addMessages' as any, { conversation_id: 'conversation', messages, api_token: 'synthetic-token' }, { skipQueue: true }));
      const batch = await MessagesSdkBatch.open(rows, 'conversation', { host, budget: new PayloadBudget(20_000) });
      const newer = await observe(() => batch.send({ getApiToken: () => 'synthetic-token', dispatch: init => { dispatches++; return fetch(`${url}/api/mutation`, init); }, logger: log => newLogs.push(log) }));
      emit({ event: 'case-outcome', case: fixture.name, before: describe(old), after: describe(newer), oldLogs, newLogs, custody: batch.custody, acceptedReceipt: batch.acceptedReceipt, acceptedOutcome: batch.acceptedOutcome ? convexToJson(batch.acceptedOutcome as any) : null, requests: requests.slice(-2), child: host.state });
      assert.deepEqual(newLogs, oldLogs);
      if ('error' in old) {
        assert.ok('error' in newer && newer.error instanceof Error && old.error instanceof Error);
        assert.equal(newer.error.constructor, old.error.constructor); assert.equal(newer.error.name, old.error.name); assert.equal(newer.error.message, old.error.message);
        if (old.error instanceof ConvexError) assert.deepEqual((newer.error as ConvexError<any>).data, old.error.data);
        assert.equal(batch.custody, 'unknown');
      } else { assert.deepEqual(newer, old); assert.equal(batch.custody, 'accepted'); assert.ok(batch.acceptedReceipt); }
      const [before, after] = requests.slice(-2);
      assert.equal(after.sha256, before.sha256); assert.equal(after.length, before.length); assert.equal(after.path, before.path); assert.equal(after.method, before.method);
      for (const key of ['content-type', 'convex-client', 'content-length', 'authorization']) assert.deepEqual(after.headers[key], before.headers[key]);
      checks.push(fixture.name);
    }
    const original = new TypeError('synthetic network failure');
    const network = await MessagesSdkBatch.open(rows, 'conversation', { host, budget: new PayloadBudget(20_000) });
    const networkResult = await observe(() => network.send({ getApiToken: () => 'synthetic-token', dispatch: async () => { throw original; } }));
    emit({ event: 'case-outcome', case: 'network-error-identity', result: describe(networkResult), sameError: 'error' in networkResult && networkResult.error === original, custody: network.custody, child: host.state });
    assert.ok('error' in networkResult && networkResult.error === original); assert.equal(network.custody, 'unknown');
    checks.push('network-error-identity');
    responseStatus = 200; responseBody = JSON.stringify({ status: 'success', value: { inserted: 1, ids: ['accepted'] }, logLines: ['[INFO] accepted before logger'] });
    const throwing = await MessagesSdkBatch.open(rows, 'conversation', { host, budget: new PayloadBudget(20_000) });
    const receipt: unknown[] = [], earlyReceipt: unknown[] = [];
    const throwingResult = await observe(() => throwing.send({ getApiToken: () => 'synthetic-token', dispatch: init => fetch(`${url}/api/mutation`, init), onReceipt: value => { earlyReceipt.push(value); }, onAccepted: value => { receipt.push(value); }, logger: () => { throw new Error('owned logger failure'); } }));
    emit({ event: 'case-outcome', case: 'throwing-logger', result: describe(throwingResult), receipt, earlyReceipt, custody: throwing.custody, acceptedOutcome: throwing.acceptedOutcome, child: host.state });
    assert.ok('error' in throwingResult && throwingResult.error instanceof Error && throwingResult.error.message === 'owned logger failure');
    assert.equal(earlyReceipt.length, 1); assert.deepEqual(earlyReceipt[0], throwing.acceptedReceipt);
    assert.equal(throwing.custody, 'accepted'); assert.deepEqual(throwing.acceptedOutcome, { value: { inserted: 1, ids: ['accepted'] } }); assert.deepEqual(receipt, [{ inserted: 1, ids: ['accepted'] }]);
    const fenced = await MessagesSdkBatch.open(rows, 'conversation', { host, budget: new PayloadBudget(20_000) });
    const fencedResult = await observe(() => fenced.send({ getApiToken: () => 'synthetic-token', dispatch: init => fetch(`${url}/api/mutation`, init), onAccepted: () => { throw new Error('owned late acceptance fence'); } }));
    emit({ event: 'case-outcome', case: 'throwing-acceptance-fence', result: describe(fencedResult), custody: fenced.custody, acceptedOutcome: fenced.acceptedOutcome, child: host.state });
    assert.ok('error' in fencedResult && fencedResult.error instanceof Error && fencedResult.error.message === 'owned late acceptance fence');
    assert.equal(fenced.custody, 'accepted'); assert.deepEqual(fenced.acceptedOutcome, throwing.acceptedOutcome);
    checks.push('accepted-receipt-before-throwing-logger-and-fence');
    let tokenReads = 0;
    const fresh = await MessagesSdkBatch.open(rows, 'conversation', { host, budget: new PayloadBudget(20_000) });
    await fresh.send({ getApiToken: () => ++tokenReads === 1 ? 'synthetic-old' : 'synthetic-new', dispatch: init => fetch(`${url}/api/mutation`, init), logger: () => {} });
    const expectedFresh = new ConvexHttpClient(url, { skipConvexDeploymentUrlCheck: true, logger: false });
    await expectedFresh.mutation('messages:addMessages' as any, { conversation_id: 'conversation', messages, api_token: 'synthetic-new' }, { skipQueue: true });
    emit({ event: 'case-outcome', case: 'fresh-token-rebuild', tokenReads, requests: requests.slice(-2), custody: fresh.custody, acceptedOutcome: fresh.acceptedOutcome, child: host.state });
    assert.equal(requests.at(-2)?.sha256, requests.at(-1)?.sha256);
    checks.push('fresh-token-rebuild-before-dispatch');
    const png = 'iVBORw0KGgo=';
    const facts = await runPayloadCodec({ kind: 'image', encoding: 'base64', output: 'facts' }, payloadStringBytes(png), { host, budget: new PayloadBudget(20_000) });
    emit({ event: 'case-outcome', case: 'image-codec', facts, child: host.state });
    assert.deepEqual(facts.value, { mediaType: 'image/png', length: 8, hash: createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex') });
    const chunks: Buffer[] = [];
    const stored = await runPayloadCodec({ kind: 'cache', operation: { action: 'store', hash: 'h', absPath: '/deleted', storageId: 's', url: 'https://synthetic.invalid/image', at: 1 } }, payloadStringBytes('{}'), { host, budget: new PayloadBudget(20_000), write: async page => { chunks.push(page); } });
    emit({ event: 'case-outcome', case: 'cache-store-codec', stored, child: host.state });
    assert.ok(stored.descriptor);
    const cache = Buffer.concat(chunks);
    const found = await runPayloadCodec({ kind: 'cache', operation: { action: 'path', key: '/deleted' } }, (async function* () { yield cache; })(), { host, budget: new PayloadBudget(20_000) });
    emit({ event: 'case-outcome', case: 'cache-path-codec', found, child: host.state });
    assert.deepEqual(found.value, { storageId: 's', url: 'https://synthetic.invalid/image', at: 1 });
    checks.push('child-image-cache-codecs');
    emit({ event: 'complete', runtime: process.versions, executable: process.execPath, entry: import.meta.url, args, childPid: host.state.pid, checks, dispatches, requests: requests.map(({ sha256, length, path, method }) => ({ sha256, length, path, method })), noLiveDestination: true });
  } finally {
    host.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(children.map(child => child.closed)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('owned SDK fixture children did not close')), 2000); })]);
    } finally { clearTimeout(timer); emit({ event: 'cleanup', pid: process.pid, port, listening: server.listening, children: children.map(child => child.pid), host: host.state, requests: requests.length }); }
  }
}
