import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

for (const mode of ["liveness", "empty-cache"]) {
  test.skipIf(!Bun.which("tmux") || (mode === "liveness" && process.platform !== "darwin"))(`${mode} retains the terminal route and delivers continue once`, async () => {
    const fixture = fileURLToPath(new URL("./test-helpers/processTerminalDelivery.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, fixture, mode], { stdout: "inherit", stderr: "inherit" });
    try {
      expect(await child.exited).toBe(0);
    } finally {
      child.kill();
    }
  }, 120_000);
}
