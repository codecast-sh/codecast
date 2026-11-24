import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(import.meta.dir, '../../..');

// ct-100734: a line station's script has no session of its own, so the comments it posted (`cast task comment`,
// `done -m`, `drop -m`) read as the person's own words and were relayed into the task's working session as theirs.
// Runs one command against a stub backend and returns what it posted, by path.
async function cast(args: string[], env: Record<string, string>) {
  const posts: Array<{ path: string; body: any }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path.startsWith('/cli/work/')) posts.push({ path, body: await req.json() });
      return Response.json({ id: 'comment-1' });
    },
  });
  const home = mkdtempSync(join(tmpdir(), 'task-comment-cli-'));
  mkdirSync(join(home, '.codecast'));
  writeFileSync(
    join(home, '.codecast', 'config.json'),
    JSON.stringify({ auth_token: 'test-token', convex_url: `http://127.0.0.1:${server.port}` }),
  );
  try {
    const child = Bun.spawn(
      [process.execPath, '--no-env-file', join(root, 'packages/cli/src/main.ts'), 'task', ...args],
      { cwd: home, env: { PATH: process.env.PATH!, HOME: home, NODE_ENV: 'test', CODECAST_NO_AUTOSTART: '1', ...env }, stdout: 'pipe', stderr: 'pipe', timeout: 20_000, killSignal: 'SIGKILL' },
    );
    const [code] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, comment: posts.find((p) => p.path === '/cli/work/comment')?.body, update: posts.find((p) => p.path === '/cli/work/update')?.body };
  } finally {
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}

const inStation = { CODECAST_RUN_CONVERSATION_ID: 'conv_run' };

test("a line station's comment signs as its run, so it is no person's words", async () => {
  const r = await cast(['comment', 'ct-7', 'Shipped: merged', '-t', 'progress'], inStation);
  expect(r.code).toBe(0);
  expect(r.comment).toMatchObject({ short_id: 'ct-7', comment_type: 'progress', conversation_id: 'conv_run' });
});

test('an agent session inside a station still signs as itself', async () => {
  const r = await cast(['comment', 'ct-7', 'Progress: halfway'], { ...inStation, CLAUDE_CODE_SESSION_ID: 'sess-1' });
  expect(r.code).toBe(0);
  expect(r.comment?.conversation_id).toBe('sess-1');
});

test("done -m and drop -m in a station sign their comment as the run, and never bind the run to the task", async () => {
  for (const args of [['done', 'ct-7', '-m', 'Dissolved: the miss did not reproduce.'], ['drop', 'ct-7', '-m', 'Dropped at the gate.']]) {
    const r = await cast(args, inStation);
    expect(r.code).toBe(0);
    expect(r.comment).toMatchObject({ short_id: 'ct-7', conversation_id: 'conv_run' });
    expect(r.update).toBeDefined();
    expect(r.update.conversation_id).not.toBe('conv_run');
  }
});
