import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(import.meta.dir, '../../..');

// Runs `cast trigger add` against a stub backend and returns what it printed.
async function triggerAdd(args: string[]) {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ task_id: 'task-abcdefgh', short_id: 'tr-7' }),
  });
  const home = mkdtempSync(join(tmpdir(), 'trigger-add-cli-'));
  mkdirSync(join(home, '.codecast'));
  writeFileSync(
    join(home, '.codecast', 'config.json'),
    JSON.stringify({ auth_token: 'test-token', convex_url: `http://127.0.0.1:${server.port}` }),
  );
  try {
    const child = Bun.spawn(
      [process.execPath, '--no-env-file', join(root, 'packages/cli/src/main.ts'), 'trigger', 'add', 'Check the build', '--parent', 'jx7297y', ...args],
      { env: { PATH: process.env.PATH!, HOME: home, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe', timeout: 20_000, killSignal: 'SIGKILL' },
    );
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, out: out.replace(/\x1b\[[0-9;]*m/g, ''), err };
  } finally {
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}

test('trigger add --at confirms the time it will run, not "queued now"', async () => {
  const r = await triggerAdd(['--at', '2099-01-02T03:04:00Z']);
  expect(r.code).toBe(0);
  expect(r.out).not.toContain('queued now');
  expect(r.out).toContain('Trigger tr-7 at ');
  expect(r.out).toMatch(/Trigger tr-7 at .*2099.*: Check the build/);
});

test('trigger add --in and a bare add keep their confirmations', async () => {
  expect((await triggerAdd(['--in', '2h'])).out).toContain('Trigger tr-7 in 2h:');
  expect((await triggerAdd([])).out).toContain('Trigger tr-7 queued now:');
});
