import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

for (const layout of ["queue", "clipped"]) {
  test.skipIf(!Bun.which("tmux"))(`Codex ${layout} delivery preserves the active turn and every report`, async () => {
    const fixture = fileURLToPath(new URL("./test-helpers/codexQueuedDelivery.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, fixture, layout], { stdout: "pipe", stderr: "pipe" });
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
    } finally {
      child.kill();
    }
  }, 35_000);
}
