import { expect, test } from "bun:test";

test("daemon notices are scoped to the physical machine or an explicit session owner", () => {
  const run = Bun.spawnSync([process.execPath, "test", "./components/__tests__/fixtures/daemonHealth.scenarios.tsx"], {
    cwd: new URL("../../", import.meta.url).pathname,
    env: { ...process.env, FORCE_COLOR: "0" },
    timeout: 30_000,
  });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
}, 35_000);
