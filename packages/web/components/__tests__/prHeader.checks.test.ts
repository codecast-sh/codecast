import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("PR header's checks read as loading only until the page's read of the pull request answers", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/prHeaderChecks.tsx", import.meta.url))], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", timeout: 120_000,
  });
  expect(result.error).toBeUndefined();
  expect({ status: result.status, signal: result.signal, stderr: result.stderr }).toEqual({ status: 0, signal: null, stderr: "" });
  expect(result.stdout + result.stderr).toContain("PR checks figure: loading until read, then none or the checks");
}, 130_000);
