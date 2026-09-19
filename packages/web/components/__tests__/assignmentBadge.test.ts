import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("assignment header permissions, machine visibility and ownership interaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assignment-badge-"));
  try {
    const error = await new Promise<Error | null>((resolve) => {
      execFile("bash", ["-c", 'exec "$@" > "$TEST_OUT" 2> "$TEST_ERR"', "child", process.execPath, "test", `${import.meta.dir}/fixtures/assignmentBadge.tsx`], {
        env: { ...process.env, TEST_OUT: join(dir, "stdout"), TEST_ERR: join(dir, "stderr") },
        timeout: 60_000,
      }, (error) => resolve(error));
    });
    const stderr = await readFile(join(dir, "stderr"), "utf8");
    // The child run passing is the point; the exact count moves whenever a case
  // is added to the fixture.
  expect(stderr).toContain("0 fail");
  expect(stderr).toMatch(/[1-9]\d* pass/);
    expect(stderr).toContain("0 fail");
    expect(error).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 65_000);
