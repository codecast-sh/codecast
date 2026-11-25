import { expect, test } from "bun:test";

test("a wrong-account mint rejection offers a step that can succeed (ct-101468)", () => {
  const run = Bun.spawnSync([process.execPath, "test", "./components/__tests__/fixtures/mintTokenRetry.scenarios.tsx"], {
    cwd: new URL("../../", import.meta.url).pathname, env: { ...process.env, FORCE_COLOR: "0" }, timeout: 45_000,
  });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
}, 50_000);
