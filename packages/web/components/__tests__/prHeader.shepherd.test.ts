import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("PR header requires explicit shepherd opt-in and keeps the session link", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/prHeaderShepherd.tsx", import.meta.url))], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", timeout: 120_000,
  });
  expect(result.error).toBeUndefined();
  expect({ status: result.status, signal: result.signal, stderr: result.stderr }).toEqual({ status: 0, signal: null, stderr: "" });
  expect(result.stdout + result.stderr).toContain("PR shepherd default, explicit toggle and session link verified");
}, 130_000);
