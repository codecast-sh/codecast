import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import { ConvexHttpClient } from 'convex/browser';
import { MessagesSdkBatch } from './messagesSdkClient.js';
import { MessagesSdkCursors } from './messagesSdkCursors.js';
import { PayloadBudget } from './payloadBudget.js';
import { validMessagesSdkPage, validMessagesSdkPayload, type MessagesSdkPage, type SdkReceipt } from './messagesSdkTypes.js';
import { WorkerUnavailable, type WorkerHost } from './host.js';

const emit = (value: unknown) => writeSync(1, JSON.stringify(value) + '\n');
const observe = async (run: () => Promise<unknown>) => {
  try { return { value: await run() }; }
  catch (error) { return { error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack, cause: error.cause instanceof Error ? { name: error.cause.name, message: error.cause.message, stack: error.cause.stack } : error.cause } : String(error) }; }
};

test('bounded SDK receipt validates every identity field without accepting optional garbage', () => {
  const receipt = { plan: 'plan', attempt: 'attempt', workerGeneration: 1, messageCount: 25 };
  const page = { cursor: 'cursor', generation: 'generation', sequence: 3, stage: 'outcome', receipt };
  expect(validMessagesSdkPage(page)).toBe(true);
  for (const [field, values] of Object.entries({ plan: ['', 1, 'x'.repeat(97)], attempt: ['', false], workerGeneration: [0, -1, NaN, '1'], messageCount: [-1, 1.5, 1_000_001, false] })) {
    for (const value of values) expect(validMessagesSdkPage({ ...page, receipt: { ...receipt, [field]: value } })).toBe(false);
    const missing: Record<string, unknown> = { ...receipt }; delete missing[field];
    expect(validMessagesSdkPage({ ...page, receipt: missing })).toBe(false);
  }
  expect(validMessagesSdkPage({ ...page, receipt: { ...receipt, accepted: true } })).toBe(false);
  expect(validMessagesSdkPage({ ...page, receipt: undefined })).toBe(false);
  expect(validMessagesSdkPage({ ...page, stage: 'ready' })).toBe(false);
});

test('actual SDK receipt precedes log transfer and survives only later local failures', async () => {
  const scenarios = ['success', 'deadline-after-receipt', 'authority-after-receipt', 'logger-failure', 'receipt-callback-failure', 'cleanup-failure', 'duplicate-observation', 'unreceived-expired', 'wrong-cursor', 'wrong-generation', 'wrong-plan', 'wrong-attempt', 'wrong-worker', 'wrong-count', 'missing-receipt', 'malformed-receipt'] as const;
  const lines = Array.from({ length: 40 }, (_, i) => `[INFO] ${i} ${'x'.repeat(8192)}`);
  const wireResult = { inserted: 0, ids: [] };
  const body = JSON.stringify({ status: 'success', value: wireResult, logLines: lines });
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const hash = createHash('sha256');
    for await (const chunk of request) hash.update(chunk);
    requests.push(hash.digest('hex'));
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const reports: Array<Record<string, any>> = [];
  try {
    const oldLogs: unknown[] = [];
    const sdk = new ConvexHttpClient(url, { skipConvexDeploymentUrlCheck: true, logger: { log: (...args: unknown[]) => { oldLogs.push({ method: 'log', args }); }, warn: () => {}, error: () => {}, logVerbose: () => {} } });
    const baseline = await observe(() => sdk.mutation('messages:addMessages' as any, { conversation_id: 'synthetic', messages: [], api_token: 'synthetic-only' }, { skipQueue: true }));
    emit({ event: 'receipt-baseline', url, baseline, logs: oldLogs.length, request: requests[0], responseBytes: Buffer.byteLength(body), responseSha256: createHash('sha256').update(body).digest('hex'), runtime: process.versions });
    for (const scenario of scenarios) {
      const cursors = new MessagesSdkCursors();
      const state = { generation: 1, closed: false, pid: null as number | null };
      let now = 0, valuePages = 0, offered = 0;
      let actualReceipt: SdkReceipt | undefined;
      const events: unknown[] = [], logs: unknown[] = [];
      const host = { state, request: async (_operation: string, payload: unknown) => {
        if (!validMessagesSdkPayload(payload)) throw new Error('fixture invalid request');
        let page = await cursors.request(payload, 'receipt-cursor');
        events.push({ action: payload.action, sequence: page.sequence, stage: page.stage });
        if (payload.action === 'outcomeNext') valuePages++;
        if (payload.action === 'waitOutcome') {
          if (page.stage !== 'outcome' || !page.receipt) throw new Error('actual SDK receipt missing');
          actualReceipt = page.receipt;
          if (scenario === 'unreceived-expired') throw new WorkerUnavailable('worker deadline');
          if (scenario === 'deadline-after-receipt') now = 5001;
          if (scenario === 'authority-after-receipt') state.generation++;
          if (scenario === 'wrong-cursor') page = { ...page, cursor: 'wrong' };
          if (scenario === 'wrong-generation') page = { ...page, generation: 'wrong' };
          const fields = { 'wrong-plan': { plan: 'wrong' }, 'wrong-attempt': { attempt: 'wrong' }, 'wrong-worker': { workerGeneration: 2 }, 'wrong-count': { messageCount: 1 } };
          if (scenario in fields) page = { ...page, receipt: { ...actualReceipt, ...fields[scenario as keyof typeof fields] } } as MessagesSdkPage;
          if (scenario === 'missing-receipt') page = { cursor: page.cursor, generation: page.generation, sequence: page.sequence, stage: 'outcome' };
          if (scenario === 'malformed-receipt') page = { ...page, receipt: { ...actualReceipt, extra: true } } as unknown as MessagesSdkPage;
        }
        return page;
      } } as unknown as WorkerHost;
      const batch = await MessagesSdkBatch.open({ messages: [], bytes: [] }, 'synthetic', { host, budget: new PayloadBudget(5000, undefined, () => now) });
      const internals = batch as unknown as { receiveReceipt: (receipt: SdkReceipt, notify: (receipt: SdkReceipt) => void) => void; dispose: () => Promise<void> };
      if (scenario === 'cleanup-failure') {
        const dispose = internals.dispose.bind(batch);
        internals.dispose = async () => { await dispose(); throw new Error('owned cleanup failure'); };
      }
      const onReceipt = (_receipt: SdkReceipt) => {
        offered++; events.push({ event: 'receipt-offered', valuePages });
        if (scenario === 'duplicate-observation') internals.receiveReceipt(actualReceipt!, onReceipt);
        if (scenario === 'receipt-callback-failure') throw new Error('owned receipt callback failure');
      };
      const result = await observe(() => batch.send({ getApiToken: () => 'synthetic-only', dispatch: init => fetch(`${url}/api/mutation`, init), onReceipt, logger: log => {
        events.push({ event: 'log', offered });
        if (scenario === 'logger-failure') throw new Error('owned logger failure');
        logs.push(log);
      } }));
      const owner = cursors as unknown as { cursors: Map<string, unknown>; close: (key: string) => void };
      for (const key of owner.cursors.keys()) owner.close(key);
      const report = { scenario, result, offered, custody: batch.custody, receipt: batch.acceptedReceipt, valuePages, logs: logs.length, logParity: JSON.stringify(logs) === JSON.stringify(oldLogs), request: requests.at(-1), events, cursors: cursors.size };
      reports.push(report); emit({ event: 'receipt-case', ...report });
    }
    for (const report of reports) {
      const accepted = ['success', 'deadline-after-receipt', 'authority-after-receipt', 'logger-failure', 'receipt-callback-failure', 'cleanup-failure', 'duplicate-observation'].includes(report.scenario);
      expect(report.custody).toBe(accepted ? 'accepted' : 'unknown');
      expect(report.offered).toBe(accepted ? 1 : 0);
      expect(!!report.receipt).toBe(accepted);
      expect(report.cursors).toBe(0); expect(report.request).toBe(requests[0]);
      const success = ['success', 'duplicate-observation'].includes(report.scenario);
      if (success) { expect(report.result).toEqual(baseline); expect(report.valuePages).toBeGreaterThan(1); expect(report.logParity).toBe(true); }
      else expect(report.result).toHaveProperty('error');
      if (accepted) expect(report.events.find((event: any) => event.event === 'receipt-offered')).toEqual({ event: 'receipt-offered', valuePages: 0 });
    }
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    emit({ event: 'receipt-cleanup', url, listening: server.listening, requests: requests.length, cases: reports.length });
  }
});
