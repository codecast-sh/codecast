import { expect, it } from "bun:test";

it("restores cached messages without rewriting them and yields between live cache writes", () => {
  const result = Bun.spawnSync([process.execPath, `${import.meta.dir}/fixtures/messageCache.ts`], { stdout: "pipe", stderr: "pipe", timeout: 10000 });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toContain("close flush verified");
}, 15000);
