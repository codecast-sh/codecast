import { test, expect } from 'bun:test';
import path from 'node:path';
import { loadScaledMs } from '../test-helpers/machineLoad.js';
import { productionHome, runProduction, settled, resultRow, records, releaseProductionHome, mutantCopy } from './fixtures/productionRun.js';

for (const scenario of [{mutant:false,client:undefined},{mutant:true,client:'claude'},{mutant:true,client:'gemini'},{mutant:true,client:'cursorDb'}]) for (const enabled of [false, true]) test(`emission known receipt clock recovery worker=${enabled} mutant=${scenario.mutant} client=${scenario.client??'all'}`, async () => {
  const {mutant,client}=scenario;
  const home = productionHome('f3-review-control-');
  try {
    const mutation = mutant ? mutantCopy(home.root, path.join(import.meta.dir, 'ingestJobs.ts'), 'result.receiptSignatures.push(ingestReceiptSignature(message,source));', "result.receiptSignatures.push(createHash('sha256').update(JSON.stringify(message)).digest('hex'));", 'ingestJobs-generated-clock.ts') : undefined;
    const producer = mutation?.file;
    const result = await settled(runProduction(home, [String(enabled), 'emission-review'], {
      env: { F3_FIXTURE_EMISSION_CLIENT: client, F3_FIXTURE_PHYSICAL_TASKKEY: mutant ? '1' : '0', F3_FIXTURE_INGEST_PRODUCER: producer },
      timeoutMs: 30_000,
    }));
    const workerSources = records(home.root, /^worker-source-\d+\.json$/);
    const invocations = records(home.root, /^invocations-\d+\.jsonl$/, { lines: true });
    console.log(JSON.stringify({ enabled, mutant, client, productionSha256: mutation?.originalSha256, scratchSha256: mutation?.scratchSha256, outcome: result, workerSources, invocations }));
    expect(workerSources.length).toBe(enabled?1:0);
    const copiedSource = result.stderr.split('\n').find((line:string)=>line.startsWith('F3_DAEMON_SOURCE '));
    expect(copiedSource).toBeDefined();
    const sourceReceipt=JSON.parse(copiedSource!.slice('F3_DAEMON_SOURCE '.length));
    expect(sourceReceipt.originalDaemonSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceReceipt.copiedDaemonSha256).toMatch(/^[0-9a-f]{64}$/);
    if (mutation) {
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('known receipt must not resend generated timestamp occurrences');
      expect(invocations.length).toBeGreaterThan(0);
      expect(invocations.every(row => row.sha256 === mutation.scratchSha256 && row.producer === producer)).toBe(true);
      const pids = new Set(invocations.map(row => row.pid));
      const supervisor = records(home.root, /^producer-\d+\.json$/).find(row => row.ppid === process.pid);
      expect(supervisor).toBeDefined(); expect(pids.size).toBe(1); expect(pids.has(supervisor.pid)).toBe(!enabled);
    } else {
      expect(result.ok).toBe(true);
      const row = resultRow(result.stdout);
      expect(row.review).toEqual({ formats: 3, clockReread: true, nativeTextChange: true, identicalOccurrences: true, filtered: true, toolsImages: true, queuedShiftedWindow: true, cursorDbCountWindow: true });
      if (enabled) { expect(row.parentParses).toBe(0); expect(row.workerPid).toBeGreaterThan(0); }
    }
  } finally {
    await releaseProductionHome(home.root);
  }
}, loadScaledMs(40_000));
