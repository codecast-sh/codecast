import { expect, it } from "bun:test";

// The measurement runs in its own process (fixtures/inboxPlacementRetention.ts):
// a full collection there walks the store alone, not the whole suite's heap.
it("bounds retained placement results and input states across recomputations", () => {
  const run = Bun.spawnSync([process.execPath, `${import.meta.dir}/fixtures/inboxPlacementRetention.ts`], { stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
  const alive = JSON.parse(new TextDecoder().decode(run.stdout).trim().split("\n").at(-1)!);
  expect(alive.states).toBeLessThanOrEqual(8);
  expect(alive.results).toBeLessThanOrEqual(8);
}, 25_000);
