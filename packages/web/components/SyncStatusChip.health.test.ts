import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

test('the rendered sync indicator reflects daemon stalls even when the browser is caught up', async () => {
  const { stdout } = await promisify(execFile)(process.execPath,
    [path.join(import.meta.dir, '__tests__/fixtures/syncStatusHealth.tsx')],
    { timeout: 15000, maxBuffer: 1024 * 1024 });
  expect(stdout).toContain('sync indicator failure and recovery verified');
}, 20000);
