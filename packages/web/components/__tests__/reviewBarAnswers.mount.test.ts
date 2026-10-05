import { expect, test } from "bun:test";

test("the composer's tray with proposal answers and quotes", () => {
  const run = Bun.spawnSync([process.execPath, "test", "./components/__tests__/fixtures/reviewBarAnswers.tsx"], {
    cwd: new URL("../../", import.meta.url).pathname,
    env: { ...process.env, FORCE_COLOR: "0" },
    timeout: 90_000,
  });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
}, 100_000);
