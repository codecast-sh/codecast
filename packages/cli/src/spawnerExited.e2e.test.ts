import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
test.skipIf(process.platform === "win32")("a spawned child that exits before its conversation exists still resolves its parent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cast-spawn-exited-"));
  try {
    await run(process.execPath, [join(import.meta.dir, "test-helpers/exitedSpawnFixture.ts"), dir], { env: { ...process.env, HOME: dir, NODE_ENV: "test" }, timeout: 120_000, killSignal: "SIGKILL" });
    expect(JSON.parse(readFileSync(join(dir, "result.json"), "utf8"))).toEqual({ parent: "parent-conversation" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 130_000);
