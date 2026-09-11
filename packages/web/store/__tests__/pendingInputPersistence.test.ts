import { expect, test } from "bun:test";

test("pending input survives follower-window and interrupted-storage lifecycles", () => {
  const result = Bun.spawnSync([process.execPath, `${import.meta.dir}/fixtures/pendingInput.ts`], {
    stdout: "pipe", stderr: "pipe", timeout: 30_000,
  });
  console.error("SPAWN DEBUG", process.execPath, import.meta.dir, result.exitCode, result.stdout.length, result.stderr.toString());
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain("account isolation verified");
}, 35_000);

test("native saves pending input synchronously before returning to the composer", () => {
  const result = Bun.spawnSync([process.execPath, `${import.meta.dir}/fixtures/pendingInput.native.ts`], {
    stdout: "pipe", stderr: "pipe", timeout: 15_000,
  });
  console.error("SPAWN DEBUG", process.execPath, import.meta.dir, result.exitCode, result.stdout.length, result.stderr.toString());
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain("stale replay verified");
}, 20_000);
