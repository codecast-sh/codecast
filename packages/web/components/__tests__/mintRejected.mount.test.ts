import { expect, test } from "bun:test";

// ct-101490: a rejected mint shows on the account row with a way to recover.
test("a rejected token mint shows on the account row with an in-app recovery", () => {
  const run = Bun.spawnSync([process.execPath, "test", "./components/__tests__/fixtures/mintRejected.scenarios.tsx"], {
    cwd: new URL("../../", import.meta.url).pathname, env: { ...process.env, FORCE_COLOR: "0" }, timeout: 45_000,
  });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
}, 50_000);
