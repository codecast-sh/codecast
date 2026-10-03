import { expect, test } from "bun:test";

// The walk's keys go through the real capture-phase dispatcher, which binds to
// the window when @platform/keys first loads. Run in a process of its own so
// that load happens after the fixture installs its DOM. The child loads the
// whole shortcut graph, which takes about a minute on a loaded machine.
test("the held undo walk through the real shortcut dispatcher", () => {
  const run = Bun.spawnSync([process.execPath, "test", "./hooks/__tests__/fixtures/undoWalkKeys.tsx"], {
    cwd: new URL("../", import.meta.url).pathname,
    env: { ...process.env, FORCE_COLOR: "0" },
    timeout: 240_000,
  });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
}, 250_000);
