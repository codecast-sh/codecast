import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// reconcileSessionLiveness runs on darwin only.
test.skipIf(process.platform !== "darwin")("a liveness fill keeps the terminal the session's own claim names", async () => {
  const fixture = fileURLToPath(new URL("./test-helpers/livenessTerminal.ts", import.meta.url));
  // The daemon reads CODECAST_DIR once, at module load, so the scratch config
  // dir is handed to the fixture process in its environment.
  const dir = mkdtempSync(join(tmpdir(), "liveness-terminal-"));
  const child = Bun.spawn([process.execPath, fixture], { stdout: "inherit", stderr: "inherit", env: { ...process.env, CODECAST_DIR: dir } });
  try {
    expect(await child.exited).toBe(0);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
