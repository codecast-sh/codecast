import { expect, test } from 'bun:test';

test('huddle gestures raise their hosting window without changing media or calling the server', async () => {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/huddleWindowFocus.ts`], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(stdout).toContain('scenarios passed');
}, 30_000);
