import { expect, test } from "bun:test";

test("account controls resolve the physical machine and survive discovery failures", () => {
  const run = Bun.spawnSync([process.execPath, "test", "./components/__tests__/fixtures/accountLocalMachine.scenarios.tsx"], {
    cwd: new URL("../../", import.meta.url).pathname,
    env: { ...process.env, FORCE_COLOR: "0" },
    timeout: 45_000,
  });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
}, 50_000);
