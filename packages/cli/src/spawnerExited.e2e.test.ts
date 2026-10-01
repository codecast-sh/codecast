import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function resolvedParent(fixture: string): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), "cast-spawn-"));
  try {
    await run(process.execPath, [join(import.meta.dir, "test-helpers", fixture), dir], { env: { ...process.env, HOME: dir, NODE_ENV: "test" }, timeout: 120_000, killSignal: "SIGKILL" });
    return JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).parent;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.skipIf(process.platform === "win32")("a spawned child that exits before its conversation exists still resolves its parent", async () => {
  expect(await resolvedParent("exitedSpawnFixture.ts")).toBe("parent-conversation");
}, 130_000);

// `cast exec` reviews landed as loose inbox cards (jx7a46g, 2026-09-30): a
// headless claude has no tty and keeps no handle on its transcript.
test.skipIf(process.platform === "win32")("a headless claude child that holds no transcript handle resolves its parent through its pid registry", async () => {
  expect(await resolvedParent("headlessClaudeSpawnFixture.ts")).toBe("parent-conversation");
}, 130_000);
