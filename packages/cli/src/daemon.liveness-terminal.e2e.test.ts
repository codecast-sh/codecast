import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// reconcileSessionLiveness runs on darwin only.
test.skipIf(process.platform !== "darwin")("a liveness fill keeps the terminal the session's own claim names", async () => {
  const fixture = fileURLToPath(new URL("./test-helpers/livenessTerminal.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, fixture], { stdout: "inherit", stderr: "inherit" });
  try {
    expect(await child.exited).toBe(0);
  } finally {
    child.kill();
  }
}, 60_000);
