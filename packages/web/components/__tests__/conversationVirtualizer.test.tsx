import { expect, test } from "bun:test";

test("transcript resizing preserves geometry and progress without redundant renders", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "test", "--timeout=60000", `${import.meta.dir}/fixtures/conversationVirtualizer.tsx`], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 240_000,
    killSignal: "SIGKILL",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
  expect(stderr).toContain("4 pass");
}, 250_000);
