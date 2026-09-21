import { expect, test } from "bun:test";

test("staged reply navigation and offscreen indicators", () => {
  const run = Bun.spawnSync([process.execPath, "test", "./components/__tests__/fixtures/reviewNavigation.tsx"], {
    cwd: new URL("../../", import.meta.url).pathname,
    env: { ...process.env, FORCE_COLOR: "0" },
    timeout: 45_000,
  });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
}, 50_000);
