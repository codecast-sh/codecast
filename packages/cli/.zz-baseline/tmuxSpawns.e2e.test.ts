import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
test.skipIf(process.platform === "win32")("detached tmux transcript writer resolves its parent after registry restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cast-spawn-e2e-"));
  const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: dir, NODE_ENV: "test" };
  delete env.TMUX;
  try {
    await run(process.execPath, [join(import.meta.dir, "test-helpers/tmuxSpawnFixture.ts"), dir], { env, timeout: 20_000, killSignal: "SIGKILL" });
    expect(JSON.parse(readFileSync(join(dir, "result.json"), "utf8"))).toEqual({ parent: "parent-conversation" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 25_000);
