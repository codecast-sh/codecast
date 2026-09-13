import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runFixture(name: string, timeout: number): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "pending-input-"));
  const resultPath = join(directory, "result");
  try {
    const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/${name}.ts`, resultPath], {
      stdout: "pipe", stderr: "pipe", timeout,
    });
    const [exitCode, , stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    return readFileSync(resultPath, "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("pending input survives follower-window and interrupted-storage lifecycles", async () => {
  expect(await runFixture("pendingInput", 30_000)).toBe("web storage assertions completed");
}, 35_000);

test("native saves pending input synchronously before returning to the composer", async () => {
  expect(await runFixture("pendingInput.native", 15_000)).toBe("native storage assertions completed");
}, 20_000);
