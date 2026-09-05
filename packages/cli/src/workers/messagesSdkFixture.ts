import { PayloadBudget } from './payloadBudget.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { ConvexError, convexToJson } from 'convex/values';
import { WorkerHost } from './host.js';
import { runWorker } from './runtime.js';
import { MessagesSdkBatch } from './messagesSdkClient.js';
import { runPayloadCodec, payloadStringBytes } from './payloadCodecClient.js';

if (process.argv.includes('_worker')) runWorker('ingest');
else {
  const entry = process.argv[1] ?? '';
  const args = /\.(?:js|ts)$/.test(entry) && !entry.includes('$bunfs') && !entry.includes('~BUN/') ? [entry, '_worker', 'ingest'] : ['_worker', 'ingest'];
  const host = new WorkerHost('ingest', { invocation: { command: process.execPath, args }, backoffMs: [0, 0, 0] });
  const requests: Array<{ sha256: string; length: number; headers: Record<string, string | string[] | undefined>; path: string | undefined; method: string | undefined }> = [];
  let responseStatus = 200, responseBody = '', dispatches = 0;
  const server = createServer(async (req, res) => {
    const hash = createHash('sha256'); let length = 0;
    for await (const chunk of req) { hash.update(chunk); length += chunk.length; }
    requests.push({ sha256: hash.digest('hex'), length, headers: req.headers, path: req.url, method: req.method });
    res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
    res.end(responseBody);
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}`;
    const messages = [{ message_uuid: 'fixture', role: 'assistant' as const, content: 'ordinary \ud83d\ude00\ud800', timestamp: 1, tool_calls: [{ id: 't', name: 'tool', input: '{"__proto__":"safe","constructor":"own"}' }] }];
    const rows = { messages, bytes: messages.map(row => Buffer.byteLength(JSON.stringify(row))) };
    const outcome = async (run: () => Promise<unknown>) => { try { return { value: await run() }; } catch (error) { return { error }; } };
    const checks: string[] = [];
    for (const fixture of [
      { name: 'success', status: 200, body: { status: 'success', value: convexToJson({ inserted: 1, ids: ['fixture'], typed: [123n, NaN, -0, new Uint8Array([0, 255, 17]).buffer] }), logLines: ['[INFO] ordinary log', 'malformed log'] } },
      { name: 'convex-error', status: 560, body: { status: 'error', errorMessage: 'fixture failure', errorData: convexToJson({ key: 4n, bytes: new Uint8Array([1, 2]).buffer }), logLines: [] } },
      { name: 'http-error', status: 401, body: 'not authorized' },
      { name: 'malformed-json', status: 200, body: '{bad' },
      { name: 'sdk-error', status: 200, body: { status: 'error', errorMessage: 'plain failure', logLines: [] } },
    ]) {
      responseStatus = fixture.status; responseBody = typeof fixture.body === 'string' ? fixture.body : JSON.stringify(fixture.body);
      const oldLogs: unknown[] = [], newLogs: unknown[] = [];
      const logger = Object.fromEntries(['log', 'warn', 'error', 'logVerbose'].map(method => [method, (...args: unknown[]) => oldLogs.push({ method, args })])) as any;
      const sdk = new ConvexHttpClient(url, { skipConvexDeploymentUrlCheck: true, logger });
      const old = await outcome(() => sdk.mutation('messages:addMessages' as any, { conversation_id: 'conversation', messages, api_token: 'synthetic-token' }, { skipQueue: true }));
      const batch = await MessagesSdkBatch.open(rows, 'conversation', { host, budget: new PayloadBudget(20_000) });
      const newer = await outcome(() => batch.send({ getApiToken: () => 'synthetic-token', dispatch: init => { dispatches++; return fetch(`${url}/api/mutation`, init); }, logger: log => newLogs.push(log) }));
      assert.deepEqual(newLogs, oldLogs);
      if ('error' in old) {
        assert.ok('error' in newer && newer.error instanceof Error && old.error instanceof Error);
        assert.equal(newer.error.constructor, old.error.constructor); assert.equal(newer.error.name, old.error.name); assert.equal(newer.error.message, old.error.message);
        if (old.error instanceof ConvexError) assert.deepEqual((newer.error as ConvexError<any>).data, old.error.data);
        assert.equal(batch.custody, 'unknown');
      } else { assert.deepEqual(newer, old); assert.equal(batch.custody, 'accepted'); }
      const [before, after] = requests.slice(-2);
      assert.equal(after.sha256, before.sha256); assert.equal(after.length, before.length); assert.equal(after.path, before.path); assert.equal(after.method, before.method);
      for (const key of ['content-type', 'convex-client', 'content-length', 'authorization']) assert.deepEqual(after.headers[key], before.headers[key]);
      checks.push(fixture.name);
    }
    const original = new TypeError('synthetic network failure');
    const network = await MessagesSdkBatch.open(rows, 'conversation', { host, budget: new PayloadBudget(20_000) });
    await assert.rejects(network.send({ getApiToken: () => 'synthetic-token', dispatch: async () => { throw original; } }), error => error === original);
    checks.push('network-error-identity');
    responseStatus = 200; responseBody = JSON.stringify({ status: 'success', value: { inserted: 1, ids: ['accepted'] }, logLines: ['[INFO] accepted before logger'] });
    const throwing = await MessagesSdkBatch.open(rows, 'conversation', { host, budget: new PayloadBudget(20_000) });
    const receipt: unknown[] = [];
    await assert.rejects(throwing.send({ getApiToken: () => 'synthetic-token', dispatch: init => fetch(`${url}/api/mutation`, init), onAccepted: value => { receipt.push(value); }, logger: () => { throw new Error('owned logger failure'); } }), /owned logger failure/);
    assert.equal(throwing.custody, 'accepted'); assert.deepEqual(throwing.acceptedOutcome, { value: { inserted: 1, ids: ['accepted'] } }); assert.deepEqual(receipt, [{ inserted: 1, ids: ['accepted'] }]);
    const fenced = await MessagesSdkBatch.open(rows, 'conversation', { host, budget: new PayloadBudget(20_000) });
    await assert.rejects(fenced.send({ getApiToken: () => 'synthetic-token', dispatch: init => fetch(`${url}/api/mutation`, init), onAccepted: () => { throw new Error('owned late acceptance fence'); } }), /owned late acceptance fence/);
    assert.equal(fenced.custody, 'accepted'); assert.deepEqual(fenced.acceptedOutcome, throwing.acceptedOutcome);
    checks.push('accepted-receipt-before-throwing-logger-and-fence');
    let tokenReads = 0;
    const fresh = await MessagesSdkBatch.open(rows, 'conversation', { host, budget: new PayloadBudget(20_000) });
    await fresh.send({ getApiToken: () => ++tokenReads === 1 ? 'synthetic-old' : 'synthetic-new', dispatch: init => fetch(`${url}/api/mutation`, init), logger: () => {} });
    const expectedFresh = new ConvexHttpClient(url, { skipConvexDeploymentUrlCheck: true, logger: false });
    await expectedFresh.mutation('messages:addMessages' as any, { conversation_id: 'conversation', messages, api_token: 'synthetic-new' }, { skipQueue: true });
    assert.equal(requests.at(-2)?.sha256, requests.at(-1)?.sha256);
    checks.push('fresh-token-rebuild-before-dispatch');
    const png = 'iVBORw0KGgo=';
    const facts = await runPayloadCodec({ kind: 'image', encoding: 'base64', output: 'facts' }, payloadStringBytes(png), { host, budget: new PayloadBudget(20_000) });
    assert.deepEqual(facts.value, { mediaType: 'image/png', length: 8, hash: createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex') });
    const chunks: Buffer[] = [];
    const stored = await runPayloadCodec({ kind: 'cache', operation: { action: 'store', hash: 'h', absPath: '/deleted', storageId: 's', url: 'https://synthetic.invalid/image', at: 1 } }, payloadStringBytes('{}'), { host, budget: new PayloadBudget(20_000), write: async page => { chunks.push(page); } });
    assert.ok(stored.descriptor);
    const cache = Buffer.concat(chunks);
    const found = await runPayloadCodec({ kind: 'cache', operation: { action: 'path', key: '/deleted' } }, (async function* () { yield cache; })(), { host, budget: new PayloadBudget(20_000) });
    assert.deepEqual(found.value, { storageId: 's', url: 'https://synthetic.invalid/image', at: 1 });
    checks.push('child-image-cache-codecs');
    console.log(JSON.stringify({ runtime: process.versions, executable: process.execPath, entry: import.meta.url, args, childPid: host.state.pid, checks, dispatches, requests: requests.map(({ sha256, length, path, method }) => ({ sha256, length, path, method })), noLiveDestination: true }));
  } finally { host.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
