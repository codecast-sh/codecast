import { expect, test } from "bun:test";

test("chat arrivals pin the mounted list without pulling edits or history to the bottom", () => {
  const run = Bun.spawnSync([process.execPath, "test", "./components/__tests__/fixtures/chatArrival.tsx"], {
    cwd: new URL("../../", import.meta.url).pathname,
    env: { ...process.env, FORCE_COLOR: "0" },
    timeout: 45_000,
  });
  const output = new TextDecoder().decode(run.stderr);
  expect(run.exitCode, output).toBe(0);
  expect(output).not.toContain("flushSync was called");
}, 50_000);
