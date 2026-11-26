import { expect, test } from "bun:test";

// ct-102050: the daemon pill's click-to-copy must give visible feedback.
// The scenarios run in a process of their own (jsdom globals, like daemonStatusChip.mount.test.tsx).
test("the daemon pill's copy click is visibly confirmed, and a refused copy shows the command", () => {
  const run = Bun.spawnSync([process.execPath, "test", "./components/__tests__/fixtures/daemonPillCopy.scenarios.tsx"], {
    cwd: new URL("../../", import.meta.url).pathname,
    env: { ...process.env, FORCE_COLOR: "0" },
    timeout: 30_000,
  });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
}, 35_000);
