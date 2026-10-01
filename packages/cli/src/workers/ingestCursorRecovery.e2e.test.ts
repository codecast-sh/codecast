import { expect, test } from 'bun:test';
import { loadScaledMs } from '../test-helpers/machineLoad.js';
import { productionHome, runProduction, resultRow, releaseProductionHome } from './fixtures/productionRun.js';

for (const enabled of [false, true]) test(`production ingest recovers a cursor inside a rewritten record worker=${enabled}`, async () => {
  const home = productionHome('f3-cursor-recovery-');
  try {
    const result = await runProduction(home, [String(enabled), 'cursor-recovery'], { timeoutMs: 30_000 });
    const row = resultRow(result.stdout);
    expect(row.recovered).toBe(3);
    if (enabled) {
      expect(row.parentParses).toBe(0);
      expect(row.workerPid).toBeGreaterThan(0);
    }
    expect(result.stderr).toContain('"remaining":false');
  } finally {
    await releaseProductionHome(home.root);
  }
}, loadScaledMs(40_000));
