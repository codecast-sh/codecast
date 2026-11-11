import { expect, test } from "bun:test";

test("chat popups wait for the line's stored row and name its sender", () => {
  const run = Bun.spawnSync([process.execPath, "test", "./components/__tests__/fixtures/chatToastAuthors.tsx"], {
    cwd: new URL("../", import.meta.url).pathname,
    env: { ...process.env, FORCE_COLOR: "0" },
    timeout: 60_000,
  });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
}, 65_000);
